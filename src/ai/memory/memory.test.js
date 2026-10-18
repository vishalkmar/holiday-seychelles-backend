const { test, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.RAG_SECRET_KEY = process.env.RAG_SECRET_KEY || 'a'.repeat(64);
const identity = require('./identity');
const slots = require('./slots');
const { mask } = require('./pii');
const { runTurn, windowOf } = require('./index');

after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

const NOW = new Date('2026-10-16T08:00:00Z');
const TODAY = '2026-10-16';

test('identity: signed visitor token; forged or other tokens refused', () => {
  const { visitorId, token } = identity.issue();
  assert.equal(identity.verify(token), visitorId);
  const other = identity.issue();
  assert.equal(identity.verify(`v1.${visitorId}.${other.token.split('.')[2]}`), null, 'someone else’s signature');
  assert.equal(identity.verify(token.replace(visitorId, other.visitorId)), null, 'swapping the id breaks the signature');
  assert.equal(identity.verify(''), null);
  assert.equal(identity.verify('v1.not-a-uuid.xxx'), null);
  assert.notEqual(identity.ipHash('1.2.3.4'), '1.2.3.4');
});

test('slots: validation, island slug, no contact data; expiry drops past dates and old results', () => {
  const c = slots.clean({ checkIn: '2026-10-01', checkOut: '2026-11-13', adults: 0, destination: 'Praslin Island', email: 'x@y.z' }, TODAY);
  assert.deepEqual(c, { checkOut: '2026-11-13', destination: 'Praslin Island', island: 'praslin' });
  assert.equal(slots.clean({ checkIn: '2026-11-13', checkOut: '2026-11-10' }, TODAY).checkOut, undefined);
  const old = { lastResults: { type: 'hotels', at: new Date(NOW.getTime() - 31 * 60000).toISOString(), items: [] } };
  assert.equal(slots.expire(old, TODAY, NOW.getTime()).lastResults, undefined);
});

test('references: ordinals in several languages, "cheapest", names, numbers; nothing after 30 minutes', () => {
  const lr = { type: 'hotels', at: NOW.toISOString(), items: [{ n: 1, title: 'Le Vasseur Eco Resort', price: 1158 }, { n: 2, title: 'Raffles Seychelles', price: 4303 }, { n: 3, title: 'Coco de Mer Hotel', price: 900 }] };
  const at = NOW.getTime();
  assert.equal(slots.resolveReference('tell me about the second one', lr, at).n, 2);
  assert.equal(slots.resolveReference('doosra wala dikhao', lr, at).n, 2);
  assert.equal(slots.resolveReference('la deuxième', lr, at).n, 2);
  assert.equal(slots.resolveReference('the last one', lr, at).n, 3);
  assert.equal(slots.resolveReference('option 1 please', lr, at).n, 1);
  assert.equal(slots.resolveReference('the cheapest', lr, at).n, 3);
  assert.equal(slots.resolveReference('rooms at Raffles?', lr, at).n, 2);
  assert.equal(slots.resolveReference('what is the weather', lr, at), null);
  assert.equal(slots.resolveReference('the second one', lr, at + 31 * 60000), null);
});

test('PII masking: emails, phones, cards', () => {
  assert.equal(mask('mail me at a.b@c.com or +248 2 512 345, card 4111 1111 1111 1111'), 'mail me at [email] or [phone], card [card]');
  assert.equal(mask('10 to 13 november for 2 adults'), '10 to 13 november for 2 adults');
});

test('window: last 8 turns, newest kept within the token budget', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i} ${'w '.repeat(50)}` }));
  const w = windowOf(msgs);
  assert.equal(w.length, 16);
  assert.match(w.at(-1).content, /^m29/);
  assert.ok(windowOf(msgs, { tokens: 200 }).length < 16);
});

// ── 15-turn scripted conversation (Phase 13 "done when") ────────────────────

function memoryStore() {
  const sessions = new Map();
  const msgs = [];
  let id = 0;
  return {
    sessions,
    async createSession({ visitorId, userId }) {
      const s = { id: `s${sessions.size + 1}`, visitorId, userId: userId || null, slots: {}, state: {}, summary: '', summaryUpto: 0, turns: 0 };
      sessions.set(s.id, s);
      return { ...s };
    },
    async getSession({ id: sid, visitorId }) {
      const s = sessions.get(sid);
      return s && s.visitorId === visitorId ? JSON.parse(JSON.stringify(s)) : null;
    },
    async saveSession(s) { sessions.set(s.id, JSON.parse(JSON.stringify(s))); },
    async addMessage({ sessionId, role, content }) { id += 1; msgs.push({ id, sessionId, role, content }); return id; },
    async messages(sessionId, { afterId = 0 } = {}) { return msgs.filter((m) => m.sessionId === sessionId && m.id > afterId); },
    async getProfile() { return { consent: false, prefs: {} }; },
  };
}

const HOTELS = (dest) => ({
  location: dest, nights: 3, total: 3, currency: 'EUR', url: '/hotel-listing?x',
  items: [
    { id: '1', name: `${dest} Inn`, stars: 3, price: 600, currency: 'EUR', url: '/hotel-details?hotelid=1&searchId=S&offerId=o1' },
    { id: '2', name: `${dest} Resort`, stars: 5, price: 2400, currency: 'EUR', url: '/hotel-details?hotelid=2&searchId=S&offerId=o2' },
    { id: '3', name: `${dest} Lodge`, stars: 4, price: 1100, currency: 'EUR', url: '/hotel-details?hotelid=3&searchId=S&offerId=o3' },
  ],
});

test('15-turn conversation keeps the trip context; prompt size stays flat once summarised', async () => {
  const ROUTES = {
    'I want a hotel': { intent: 'flow_entry', product: 'hotels' },
    Praslin: { intent: 'live_search', product: 'hotels', slots: { destination: 'Praslin' } },
    '10 to 13 november, 2 adults': { intent: 'live_search', product: 'hotels' },
    'cheaper ones?': { intent: 'live_search', product: 'hotels' },
    'tell me about the second one': { intent: 'knowledge' },
    'what about La Digue for the same dates?': { intent: 'live_search', product: 'hotels', slots: { destination: 'La Digue' } },
  };
  const toolCalls = [];
  const summaries = [];
  const promptTokens = [];
  const llm = {
    async chat({ purpose, messages }) {
      if (purpose === 'route') {
        const user = messages.at(-1).content;
        return { text: JSON.stringify(ROUTES[user] || { intent: 'knowledge', language: 'en' }), toolCalls: [] };
      }
      if (purpose === 'summary') {
        summaries.push(messages[1].content);
        return { text: 'Visitor plans a hotel stay 10–13 Nov for 2 adults, looked at Praslin then La Digue, asked general questions.', toolCalls: [] };
      }
      return { text: `Answer about the trip. ${'detail '.repeat(40)}`, toolCalls: [], usage: { prompt_tokens: 100, completion_tokens: 50 } };
    },
  };
  const tools = {
    async run(name, input) { toolCalls.push({ name, input }); return { tool: name, ok: true, data: HOTELS(input.destination), ms: 1 }; },
    async forModel() { return []; },
  };
  const retriever = { async retrieve() { return { insufficient: false, bestScore: 0.6, context: '[S1] Guide\nSome facts.', sources: [{ id: 'S1', title: 'Guide' }], hits: [] }; } };
  const store = memoryStore();
  const { visitorId } = identity.issue();
  const script = [
    'I want a hotel', 'Praslin', '10 to 13 november, 2 adults', 'cheaper ones?', 'tell me about the second one',
    'what about La Digue for the same dates?', 'is la digue good for cycling?', 'best beach there?', 'how do I get there from Praslin?',
    'what about food?', 'any tips for kids?', 'is it safe?', 'what currency?', 'do I need a visa?', 'thanks, what else should I know?',
  ];
  let sessionId;
  const outs = [];
  for (const message of script) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runTurn({ visitorId, sessionId, message }, {
      store, llm, now: () => NOW, flows: null,
      orchestratorDeps: { llm, tools, retriever, now: () => NOW, settings: { routerModel: 'r' }, business: 'L2', manifest: '' },
    });
    sessionId = r.sessionId;
    outs.push(r);
    promptTokens.push(r.trace.prompt?.tokens || 0);
  }

  // Context kept: the hotel searches used the remembered dates and party.
  const searches = toolCalls.filter((c) => c.name === 'hotels.search');
  assert.deepEqual(searches.map((s) => [s.input.destination, s.input.checkIn, s.input.checkOut, s.input.adults]), [
    ['Praslin', '2026-11-10', '2026-11-13', 2],
    ['Praslin', '2026-11-10', '2026-11-13', 2],
    ['La Digue', '2026-11-10', '2026-11-13', 2],
  ]);
  assert.equal(searches[1].input.maxPrice, 1100, '"cheaper" searched under the middle price shown');
  assert.equal(outs[4].trace.memory.reference, 2, '"the second one" resolved');
  const final = store.sessions.get(sessionId);
  assert.equal(final.slots.checkIn, '2026-11-10');
  assert.equal(final.slots.island, 'la-digue');
  assert.equal(final.slots.lastResults.items.length, 3);

  // Summary kicked in, without personal data, and the prompt stopped growing.
  assert.ok(summaries.length >= 1, 'summarised');
  assert.ok(final.summary.startsWith('Visitor plans'));
  const firstSummaryTurn = outs.findIndex((o) => o.trace.memory.summarised);
  assert.ok(firstSummaryTurn > 0 && firstSummaryTurn < 12, `summary at turn ${firstSummaryTurn + 1}`);
  const tail = promptTokens.slice(firstSummaryTurn + 1);
  const spread = Math.max(...tail) - Math.min(...tail);
  assert.ok(spread < 250, `prompt tokens flat after the summary: ${tail.join(', ')}`);
  assert.ok(Math.max(...promptTokens.slice(firstSummaryTurn + 1)) <= Math.max(...promptTokens.slice(0, firstSummaryTurn + 1)) + 150, `no growth: ${promptTokens.join(', ')}`);

  // Another visitor cannot open this session.
  const stranger = identity.issue();
  const other = await runTurn({ visitorId: stranger.visitorId, sessionId, message: 'hi' }, { store, llm, now: () => NOW, flows: null, orchestratorDeps: { llm, tools, retriever, now: () => NOW, settings: {}, business: 'L2', manifest: '' } });
  assert.notEqual(other.sessionId, sessionId, 'a stranger gets a new, empty session');
});

test('flows only (AI free text off): no AI answer, the menu and the team instead', async () => {
  const store = require('../insights/sandbox').memStore();
  let asked = false;
  const out = await runTurn({ visitorId: 'v-flag', message: 'what is the capital?' }, {
    store,
    settings: { aiFreeText: false },
    flows: { turn: async () => null, greetingChips: async (c) => c },
    orchestrator: { START_CHIPS: [{ label: 'Hotels', action: { type: 'message', text: 'hotel' } }], handleTurn: async () => { asked = true; return {}; } },
  });
  assert.equal(asked, false);
  assert.equal(out.trace.route, 'flows_only');
  assert.deepEqual(out.reply.chips.map((c) => c.label), ['Hotels', 'Contact our team']);
});
