/**
 * Orchestrator scenario tests (Phase 10): scripted conversations covering every
 * route, with a fake model, fake tools and a fake retriever — no network.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { handleTurn, parseFollowUps } = require('./index');
const { prepass, findDates, findGuests } = require('./rules');
const { ground } = require('./grounding');

after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

const NOW = () => new Date('2026-10-16T08:00:00Z'); // 12:00 in Seychelles
const SETTINGS = { routerModel: 'router' };

/** Fake model. route: message → classification; answer: (messages, tools, n) → { text, toolCalls }. */
function fakeLlm({ route = {}, answer, routeFails = false, answerFails = false, toolsRejected = false }) {
  const calls = [];
  return {
    calls,
    async chat({ purpose, messages, tools }) {
      calls.push({ purpose, messages, tools });
      if (purpose === 'route') {
        if (routeFails) throw Object.assign(new Error('down'), { code: 'UNAVAILABLE' });
        const user = messages[messages.length - 1].content;
        return { text: JSON.stringify(route[user] || { intent: 'knowledge', language: 'en', slots: {} }), toolCalls: [] };
      }
      if (answerFails) throw Object.assign(new Error('down'), { code: 'UNAVAILABLE' });
      if (toolsRejected && tools) throw Object.assign(new Error('tools not supported'), { code: 'BAD_REQUEST' });
      const n = calls.filter((c) => c.purpose === 'answer').length;
      const out = answer ? answer(messages, tools, n) : { text: 'OK' };
      return { toolCalls: [], model: 'fake', latencyMs: 1, usage: { prompt_tokens: 10, completion_tokens: 5 }, ...out };
    },
  };
}

const HOTELS = { location: 'Praslin', nights: 3, total: 2, currency: 'EUR', url: '/hotel-listing?x', items: [{ id: '1', name: 'Le Vasseur', stars: 4, price: 1158.53, pricePerNight: 386.18, currency: 'EUR', board: 'Bed And Breakfast', url: '/hotel-details?1' }, { id: '2', name: 'Raffles', stars: 5, price: 4303.51, currency: 'EUR', url: '/hotel-details?2' }] };

/** Fake tools: canned data per tool, records every call. */
function fakeTools(over = {}) {
  const calls = [];
  const data = {
    'hotels.search': HOTELS,
    'hotels.details': { found: true, name: 'Le Vasseur', rooms: [{ name: 'Villa', fromPrice: 1158.53 }] },
    'excursions.search': { total: 1, url: '/excursions?x', items: [{ id: 'E1', name: 'Sun Chaser', category: 'Cruises & Boat Trips', island: 'Mahe Island', price: 120, currency: 'EUR', runsOnDate: true, nextDate: '2026-10-23', url: '/excursions?E1' }] },
    'transfers.departures': { total: 2, items: [{ id: '103', name: 'ILES DES PALMES AIRPORT - PRASLIN', type: 4 }, { id: '84', name: 'SEYCHELLES INTERNATIONAL AIRPORT', type: 4 }] },
    'transfers.arrivals': { total: 1, items: [{ id: '7', name: 'BEAU VALLON', type: 4 }] },
    'transfers.search': { total: 1, url: '/transfer-listing?x', items: [{ name: 'Private car', vehicle: 'CAR', maxPax: 3, price: 43, currency: 'EUR' }] },
    ...over,
  };
  return {
    calls,
    async run(name, input) {
      calls.push({ name, input });
      const d = typeof data[name] === 'function' ? data[name](input) : data[name];
      if (d instanceof Error) return { tool: name, ok: false, error: { code: d.code || 'ERROR', message: d.message } };
      return { tool: name, ok: true, data: d, ms: 1 };
    },
    async forModel() {
      return Object.keys(data).map((n) => ({ type: 'function', function: { name: n.replace('.', '_'), description: n, parameters: { type: 'object', properties: {} } } }));
    },
  };
}

const KNOW = { insufficient: false, bestScore: 0.6, context: '[S1] Best time\nApril–May and October–November are calm.', sources: [{ id: 'S1', sourceId: 10, title: 'Best time', type: 'faq', url: null }], hits: [{ chunkId: 1 }] };
const fakeRetriever = (r = KNOW) => {
  const calls = [];
  return { calls, async retrieve(q, o) { calls.push({ q, o }); return r; } };
};

/** Run a scripted conversation; returns every turn's output. */
async function converse(messages, deps) {
  let state = {};
  const history = [];
  const outs = [];
  for (const message of messages) {
    // eslint-disable-next-line no-await-in-loop
    const out = await handleTurn({ message, history, state }, { now: NOW, settings: SETTINGS, business: 'TEST BUSINESS L2', manifest: 'Knowledge: test.', ...deps });
    history.push({ role: 'user', content: message }, { role: 'assistant', content: out.reply.text });
    state = out.state;
    outs.push(out);
  }
  return outs;
}

// ── Rules and grounding units ─────────────────────────────────────────────────

test('rules: dates (ranges, day-month, month-day, slashes, relative), never in the past', () => {
  const today = '2026-10-16';
  assert.deepEqual(findDates('10 to 13 november', today), ['2026-11-10', '2026-11-13']);
  assert.deepEqual(findDates('from nov 10 till nov 14', today), ['2026-11-10', '2026-11-14']);
  assert.deepEqual(findDates('arriving 5/1', today), ['2027-01-05']);
  assert.deepEqual(findDates('on 2026-12-24', today), ['2026-12-24']);
  assert.deepEqual(findDates('tomorrow', today), ['2026-10-17']);
  assert.deepEqual(findDates('du 3 au 7 mars', today), ['2027-03-03', '2027-03-07']);
  assert.deepEqual(findDates('1 october', today), ['2027-10-01'], 'a passed day means next year');
  assert.deepEqual(findDates('what may I do there', today), []);
});

test('rules: guests, nights, smalltalk and handoff', () => {
  assert.deepEqual(findGuests('2 adults and 2 kids aged 5 and 8 for 4 nights'), { adults: 2, children: 2, childAges: [5, 8], nights: 4 });
  assert.equal(findGuests('honeymoon trip').adults, 2);
  assert.equal(findGuests('we are 5 people').adults, 5);
  assert.equal(findGuests('what to do with kids').children, undefined);
  const today = '2026-10-16';
  assert.equal(prepass('Hi!', { today }).kind, 'greeting');
  assert.equal(prepass('bonjour', { today }).kind, 'greeting');
  assert.equal(prepass('hi, which island is best?', { today }).kind, null, 'a greeting with a question goes on');
  assert.equal(prepass('thanks a lot', { today }).kind, 'thanks');
  assert.equal(prepass('can I speak to a real person', { today }).kind, 'handoff');
});

test('grounding: prices only from tool output, dates only from evidence', () => {
  const toolData = [HOTELS];
  const g = ground('Le Vasseur is €1,158.53 (about €386 a night); Raffles is EUR 4303.51. Deals from €99!', { toolData });
  assert.match(g.text, /€1,158\.53/);
  assert.match(g.text, /€386/);
  assert.match(g.text, /EUR 4303\.51/);
  assert.match(g.text, /from the live price/);
  assert.deepEqual(g.removed, [{ kind: 'price', value: '€99' }]);
  const d = ground('Check in on 10 November, it also runs on 25 December.', { toolData: [], slots: { checkIn: '2026-11-10' } });
  assert.match(d.text, /10 November/);
  assert.deepEqual(d.removed.map((r) => r.value), ['25 December']);
  assert.equal(ground('The ferry costs €50.', { toolData: [] }).removed.length, 1, 'no tool output → no price survives');
});

test('follow-ups: parsed from the last line; template letters ignored', () => {
  assert.deepEqual(parseFollowUps('Answer.\n---\nFOLLOWUPS: Show hotels | Best beach?'), { text: 'Answer.', followUps: ['Show hotels', 'Best beach?'] });
  assert.deepEqual(parseFollowUps('Answer.\nFOLLOWUPS: a | b | c').followUps, []);
});

// ── Scenarios ─────────────────────────────────────────────────────────────────

test('S1 greeting → canned reply with start chips, no model call', async () => {
  const llm = fakeLlm({});
  const [o] = await converse(['hi'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.trace.route, 'smalltalk');
  assert.deepEqual(o.reply.chips.map((c) => c.label), ['Hotels', 'Excursions', 'Transfers', 'Which island?']);
  assert.equal(llm.calls.length, 0);
});

test('S2 greeting in French → French reply, language remembered', async () => {
  const [o] = await converse(['Bonjour'], { llm: fakeLlm({}), tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /^Bonjour/);
  assert.equal(o.state.language, 'fr');
});

test('S3 thanks and bye → canned', async () => {
  const [a, b] = await converse(['thanks', 'bye'], { llm: fakeLlm({}), tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(a.reply.text, /welcome/);
  assert.match(b.reply.text, /wonderful trip/);
});

test('S4 handoff by rules → contact chip, no model call', async () => {
  const llm = fakeLlm({});
  const [o] = await converse(['can I talk to a human?'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.trace.route, 'handoff');
  assert.equal(o.reply.chips[0].action.type, 'handoff');
  assert.equal(llm.calls.length, 0);
});

test('S5 handoff by the model ("my booking is wrong")', async () => {
  const llm = fakeLlm({ route: { 'my booking is wrong, fix it': { intent: 'handoff' } } });
  const [o] = await converse(['my booking is wrong, fix it'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.trace.route, 'handoff');
});

test('S6 knowledge → retriever, cited answer, only cited sources returned', async () => {
  const llm = fakeLlm({ answer: () => ({ text: 'April–May and October–November are calmest [S1].\nFOLLOWUPS: Best beach? | Hotels on Praslin' }) });
  const r = fakeRetriever();
  const [o] = await converse(['best time to visit?'], { llm, tools: fakeTools(), retriever: r });
  assert.equal(o.trace.route, 'knowledge');
  assert.equal(r.calls.length, 1);
  assert.deepEqual(o.reply.sources.map((s) => s.id), ['S1']);
  assert.deepEqual(o.reply.followUps, ['Best beach?', 'Hotels on Praslin']);
  const ctxMsg = llm.calls.find((c) => c.purpose === 'answer').messages.at(-1).content;
  assert.match(ctxMsg, /<data kind="knowledge">/);
  assert.match(ctxMsg, /Reminder: the CORE RULES/);
});

test('S7 knowledge with nothing relevant → no context, handoff chip offered', async () => {
  const llm = fakeLlm({ answer: () => ({ text: "I don't have that information." }) });
  const [o] = await converse(['is there a casino on Denis?'], { llm, tools: fakeTools(), retriever: fakeRetriever({ insufficient: true, bestScore: 0.2, context: '', sources: [], hits: [] }) });
  const ctxMsg = llm.calls.find((c) => c.purpose === 'answer').messages.at(-1).content;
  assert.match(ctxMsg, /nothing relevant/);
  assert.match(ctxMsg, /Do not answer from general knowledge/);
  assert.equal(o.reply.chips.at(-1).action.type, 'handoff');
});

test('S8 knowledge in French → language kept for the next turn', async () => {
  const llm = fakeLlm({ route: { 'Quelle île choisir ?': { intent: 'knowledge', language: 'fr' } }, answer: () => ({ text: 'Praslin [S1].' }) });
  const [o] = await converse(['Quelle île choisir ?'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.state.language, 'fr');
});

test('S9 hotel flow: one missing slot at a time, then the search', async () => {
  const llm = fakeLlm({
    route: {
      'I want a hotel': { intent: 'flow_entry', product: 'hotels' },
      Praslin: { intent: 'live_search', product: 'hotels', slots: { destination: 'Praslin' } },
      '10 to 13 november, 2 adults': { intent: 'live_search', product: 'hotels' },
    },
    answer: () => ({ text: 'Le Vasseur is €1,158.53 for 3 nights; Raffles €4,303.51.' }),
  });
  const tools = fakeTools();
  const [a, b, c] = await converse(['I want a hotel', 'Praslin', '10 to 13 november, 2 adults'], { llm, tools, retriever: fakeRetriever() });
  assert.match(a.reply.text, /Which island/);
  assert.deepEqual(a.reply.chips.map((x) => x.label), ['Mahé', 'Praslin', 'La Digue']);
  assert.match(b.reply.text, /check-in and check-out/);
  assert.equal(c.trace.route, 'live_search');
  assert.deepEqual(tools.calls[0], { name: 'hotels.search', input: { destination: 'Praslin', checkIn: '2026-11-10', checkOut: '2026-11-13', adults: 2, childAges: [] } });
  assert.equal(c.reply.cards.length, 2);
  assert.equal(c.reply.cards[0].price, 1158.53);
  assert.deepEqual(c.trace.grounding.removed, []);
  assert.equal(c.reply.chips[0].action.url, '/hotel-listing?x');
});

test('S10 hotel with nights → check-out computed', async () => {
  const llm = fakeLlm({ route: { 'hotel on praslin from 10 nov for 3 nights': { intent: 'live_search', product: 'hotels', slots: { destination: 'Praslin' } } } });
  const tools = fakeTools();
  await converse(['hotel on praslin from 10 nov for 3 nights'], { llm, tools, retriever: fakeRetriever() });
  assert.equal(tools.calls[0].input.checkOut, '2026-11-13');
});

test('S11 invented price is removed and "Check live price" offered', async () => {
  const llm = fakeLlm({ route: { 'hotels praslin 10-13 nov': { intent: 'live_search', product: 'hotels', slots: { destination: 'Praslin' } } }, answer: () => ({ text: 'Rooms from €199 a night, Le Vasseur €1,158.53.' }) });
  const [o] = await converse(['hotels praslin 10-13 nov'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /from the live price a night/);
  assert.match(o.reply.text, /€1,158\.53/);
  assert.equal(o.reply.chips[0].label, 'Check live price');
});

test('S12 excursions need no slots: search runs with category and island', async () => {
  const llm = fakeLlm({ route: { 'snorkelling trips on mahe next week': { intent: 'live_search', product: 'excursions', slots: { excursionCategory: 'marine', destination: 'Mahé' } } } });
  const tools = fakeTools();
  const [o] = await converse(['snorkelling trips on mahe next week'], { llm, tools, retriever: fakeRetriever() });
  assert.deepEqual(tools.calls[0].input, { adults: 2, childAges: [], date: '2026-10-23', category: 'marine', island: 'Mahé' });
  assert.equal(o.reply.cards[0].type, 'excursion');
});

test('S13 "show me excursions" (flow entry, nothing else) still searches', async () => {
  const llm = fakeLlm({ route: { 'Show me excursions': { intent: 'flow_entry', product: 'excursions' } } });
  const tools = fakeTools();
  const [o] = await converse(['Show me excursions'], { llm, tools, retriever: fakeRetriever() });
  assert.equal(tools.calls[0].name, 'excursions.search');
  assert.equal(o.trace.route, 'live_search');
});

test('S14 transfer flow asks the pick-up first, with an airport chip', async () => {
  const llm = fakeLlm({ route: { 'I need a transfer': { intent: 'flow_entry', product: 'transfers' } } });
  const [o] = await converse(['I need a transfer'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /pick you up/);
  assert.match(o.reply.chips[0].label, /International Airport/);
  assert.equal(o.state.pending, 'transferFrom');
});

test('S15 transfer: "the airport" → the international airport, arrivals from it, then prices', async () => {
  const llm = fakeLlm({ route: { 'transfer from the airport to beau vallon on 12 november': { intent: 'live_search', product: 'transfers', slots: { transferFrom: 'the airport', transferTo: 'Beau Vallon' } } } });
  const tools = fakeTools();
  const [o] = await converse(['transfer from the airport to beau vallon on 12 november'], { llm, tools, retriever: fakeRetriever() });
  const arr = tools.calls.find((c) => c.name === 'transfers.arrivals');
  assert.equal(arr.input.departureId, '84');
  const srch = tools.calls.find((c) => c.name === 'transfers.search');
  assert.deepEqual([srch.input.departureId, srch.input.arrivalId, srch.input.date], ['84', '7', '2026-11-12']);
  assert.equal(o.reply.cards[0].type, 'transfer');
});

test('S16 transfer to an unknown place → the model is told, no fake prices', async () => {
  const llm = fakeLlm({ route: { 'transfer from airport to atlantis on 12 nov': { intent: 'live_search', product: 'transfers', slots: { transferFrom: 'airport', transferTo: 'Atlantis' } } }, answer: () => ({ text: 'I could not find a transfer to Atlantis. It is usually €40.' }) });
  const tools = fakeTools({ 'transfers.arrivals': { total: 0, items: [] } });
  const [o] = await converse(['transfer from airport to atlantis on 12 nov'], { llm, tools, retriever: fakeRetriever() });
  assert.equal(tools.calls.some((c) => c.name === 'transfers.search'), false);
  assert.doesNotMatch(o.reply.text, /€40/);
});

test('S17 out of scope → fixed refusal, no answer call', async () => {
  const llm = fakeLlm({ route: { 'write python code': { intent: 'out_of_scope' } } });
  const [o] = await converse(['write python code'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /outside what I can help with/);
  assert.equal(llm.calls.filter((c) => c.purpose === 'answer').length, 0);
});

test('S18 both → retriever and the product search in one turn', async () => {
  const llm = fakeLlm({ route: { 'best island for honeymoon and hotels 10-13 nov on praslin': { intent: 'both', product: 'hotels', slots: { destination: 'Praslin' } } }, answer: () => ({ text: 'Praslin suits couples [S1]; Le Vasseur is €1,158.53.' }) });
  const tools = fakeTools();
  const r = fakeRetriever();
  const [o] = await converse(['best island for honeymoon and hotels 10-13 nov on praslin'], { llm, tools, retriever: r });
  assert.equal(r.calls.length, 1);
  assert.equal(tools.calls[0].name, 'hotels.search');
  assert.equal(o.reply.sources.length, 1);
  assert.equal(o.reply.cards.length, 2);
});

test('S19 the model calls a tool itself (hotel details) and answers from it', async () => {
  const llm = fakeLlm({
    route: { 'tell me about the rooms at Le Vasseur': { intent: 'knowledge' } },
    answer: (m, tools, n) => (n === 1 ? { text: '', toolCalls: [{ id: 'c1', name: 'hotels_details', args: { hotelId: '1' } }] } : { text: 'Le Vasseur has villas from €1,158.53.' }),
  });
  const tools = fakeTools();
  const [o] = await converse(['tell me about the rooms at Le Vasseur'], { llm, tools, retriever: fakeRetriever() });
  assert.deepEqual(tools.calls.map((c) => c.name), ['hotels.details']);
  assert.match(o.reply.text, /€1,158\.53/, 'a price from a tool the model called is kept');
  const toolMsg = llm.calls[2].messages.find((x) => x.role === 'tool');
  assert.match(toolMsg.content, /^<data kind="tool-result" tool="hotels.details">/);
});

test('S20 at most 3 tool calls per turn, then the model must answer', async () => {
  const llm = fakeLlm({ answer: (m, tools) => (tools ? { text: '', toolCalls: [{ id: `c${Math.random()}`, name: 'hotels_details', args: { hotelId: '1' } }] } : { text: 'Done.' }) });
  const tools = fakeTools();
  const [o] = await converse(['loop please'], { llm, tools, retriever: fakeRetriever() });
  assert.equal(tools.calls.length, 3);
  assert.equal(o.reply.text, 'Done.');
});

test('S21 model down, nothing fetched → canned apology + contact chip', async () => {
  const [o] = await converse(['best time?'], { llm: fakeLlm({ answerFails: true }), tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /can't answer properly/);
  assert.equal(o.reply.chips.at(-1).action.type, 'handoff');
  assert.equal(o.trace.fallback, 'canned');
});

test('S22 model down after a live search → the results still shown as cards', async () => {
  const llm = fakeLlm({ route: { 'hotels praslin 10-13 nov': { intent: 'live_search', product: 'hotels', slots: { destination: 'Praslin' } } }, answerFails: true });
  const [o] = await converse(['hotels praslin 10-13 nov'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /live options/);
  assert.equal(o.reply.cards.length, 2);
  assert.equal(o.reply.chips[0].action.url, '/hotel-listing?x');
});

test('S23 router down → still answered as a knowledge question', async () => {
  const llm = fakeLlm({ routeFails: true, answer: () => ({ text: 'Calm seas in April [S1].' }) });
  const [o] = await converse(['when is the sea calm?'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.trace.route, 'knowledge');
  assert.match(o.reply.text, /April/);
});

test('S24 tools rejected by the model → answered again without tools', async () => {
  const llm = fakeLlm({ toolsRejected: true, answer: () => ({ text: 'Answer without tools [S1].' }) });
  const [o] = await converse(['best time?'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.reply.text, 'Answer without tools [S1].');
  assert.match(o.trace.steps.join(), /retry without tools/);
});

test('S25 invented travel date removed; a date from the results kept', async () => {
  const llm = fakeLlm({ route: { 'sun chaser next week': { intent: 'live_search', product: 'excursions', slots: { excursionName: 'sun chaser' } } }, answer: () => ({ text: 'Sun Chaser runs on 23 October and 31 December.' }) });
  const [o] = await converse(['sun chaser next week'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /23 October/);
  assert.doesNotMatch(o.reply.text, /31 December/);
});

test('S26 follow-up turn keeps the product and earlier slots ("and for 4 nights?")', async () => {
  const llm = fakeLlm({
    route: {
      'hotels on praslin 10-13 nov': { intent: 'live_search', product: 'hotels', slots: { destination: 'Praslin' } },
      'and for 4 nights?': { intent: 'live_search', product: 'hotels', slots: { nights: 4 } },
    },
  });
  const tools = fakeTools();
  await converse(['hotels on praslin 10-13 nov', 'and for 4 nights?'], { llm, tools, retriever: fakeRetriever() });
  assert.deepEqual([tools.calls[1].input.destination, tools.calls[1].input.checkIn, tools.calls[1].input.checkOut], ['Praslin', '2026-11-10', '2026-11-14']);
});

test('S27 router says out_of_scope (and French) for an on-topic English question → answered in English', async () => {
  const llm = fakeLlm({ route: { 'vallée de mai tour cost': { intent: 'out_of_scope', language: 'fr' } }, answer: () => ({ text: 'Tours to the Vallée de Mai are shown live on the website.' }) });
  const [o] = await converse(['vallée de mai tour cost'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.trace.route, 'knowledge');
  assert.equal(o.state.language, 'en');
});

test('S28 a place that is not an island filters excursions by name; the visitor\'s budget may be repeated', async () => {
  const llm = fakeLlm({
    route: {
      'jet ski beau vallon price': { intent: 'live_search', product: 'excursions', slots: { destination: 'Beau Vallon', excursionName: 'jet ski' } },
      'hotel mahe under 600 euros 10-13 nov': { intent: 'live_search', product: 'hotels', slots: { destination: 'Mahé', budget: 600 } },
    },
    answer: () => ({ text: 'Both are under your €600 budget.' }),
  });
  const tools = fakeTools();
  await converse(['jet ski beau vallon price'], { llm, tools, retriever: fakeRetriever() });
  assert.deepEqual([tools.calls[0].input.island, tools.calls[0].input.name], [undefined, 'jet ski Beau Vallon']);
  const [o] = await converse(['hotel mahe under 600 euros 10-13 nov'], { llm, tools, retriever: fakeRetriever() });
  assert.match(o.reply.text, /€600/);
});

test('S29 a short answer to a pending question continues the flow, even if the router says knowledge', async () => {
  const llm = fakeLlm({
    route: {
      'I want a hotel': { intent: 'flow_entry', product: 'hotels' },
      Praslin: { intent: 'knowledge', language: 'en' },
    },
  });
  const r = fakeRetriever();
  const [, b] = await converse(['I want a hotel', 'Praslin'], { llm, tools: fakeTools(), retriever: r });
  assert.match(b.reply.text, /check-in and check-out/);
  assert.equal(b.state.slots.destination, 'Praslin');
  assert.equal(r.calls.length, 0, 'not answered as a knowledge question');
});

test('S30 after a hotel search, "Is La Digue good for cycling?" is a knowledge question, not another search', async () => {
  const llm = fakeLlm({
    route: {
      'hotels praslin 10-13 nov': { intent: 'live_search', product: 'hotels', slots: { destination: 'Praslin' } },
      'Is La Digue good for cycling?': { intent: 'live_search', product: 'hotels', slots: { destination: 'La Digue' } },
    },
    answer: () => ({ text: 'Yes, bikes are the main way around La Digue [S1].' }),
  });
  const tools = fakeTools();
  const r = fakeRetriever();
  const [, b] = await converse(['hotels praslin 10-13 nov', 'Is La Digue good for cycling?'], { llm, tools, retriever: r });
  assert.equal(tools.calls.filter((c) => c.name === 'hotels.search').length, 1);
  assert.equal(b.trace.route, 'knowledge');
  assert.equal(r.calls.length, 1);
  assert.equal(b.state.pending, null);
});

test('S31 router names the intent but forgets the product → product from the words', async () => {
  const llm = fakeLlm({ route: { 'I am looking for a hotel': { intent: 'flow_entry', product: null } } });
  const [o] = await converse(['I am looking for a hotel'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /Which island/);
  assert.equal(o.state.product, 'hotels');
});

// ── Extra track 1.3: products only from our own system ───────────────────────

test('1.3: "best 5-star resort" the router calls knowledge → our live hotel search asks for the island', async () => {
  const llm = fakeLlm({});
  const [o] = await converse(['Which is the best 5-star resort in Seychelles?'], { llm, tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.trace.route, 'flow_entry');
  assert.equal(o.state.product, 'hotels');
  assert.equal(o.reply.text, 'Which island would you like to stay on?');
  assert.ok(!llm.calls.some((c) => c.purpose === 'answer'), 'no model-written list');
});

test('1.3: a brand comparison and Hinglish "sasta hotel" are hotel requests', async () => {
  const [a] = await converse(['Is Four Seasons better than Constance Ephelia?'], { llm: fakeLlm({}), tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(a.state.product, 'hotels');
  const [b] = await converse(['mujhe la digue mein sasta hotel chahiye'], { llm: fakeLlm({}), tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(b.state.product, 'hotels');
});

test('1.3: place questions stay knowledge questions', async () => {
  const [o] = await converse(['What is the best time to visit Praslin?'], { llm: fakeLlm({ answer: () => ({ text: 'April and October are calm [S1].' }) }), tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.trace.route, 'knowledge');
});

test('1.3: names the model remembers and other booking sites are removed; our results stay', async () => {
  const route = { 'hotels on praslin 10 to 13 november for 2 adults': { intent: 'live_search', product: 'hotels', language: 'en', slots: { destination: 'Praslin', checkIn: '2026-11-10', checkOut: '2026-11-13', adults: 2 } } };
  const answer = () => ({ text: 'Le Vasseur is a good 4-star match. Constance Lemuria Resort is also lovely. You could compare on Booking.com too.' });
  const [o] = await converse(['hotels on praslin 10 to 13 november for 2 adults'], { llm: fakeLlm({ route, answer }), tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(o.reply.text, 'Le Vasseur is a good 4-star match.');
  assert.equal(o.reply.cards.length, 2);
  assert.ok(o.reply.chips.some((c) => c.label === 'Search live'));
});

test('1.3: an answer made only of outside names becomes our own-products reply', async () => {
  const answer = () => ({ text: 'Try Marie Antoinette Restaurant or the Pirates Arms Bar in Victoria.' });
  const [o] = await converse(['Where should I eat in Victoria?'], { llm: fakeLlm({ answer }), tools: fakeTools(), retriever: fakeRetriever() });
  assert.match(o.reply.text, /only recommend hotels, excursions and transfers from our own live system/);
});

test('1.3: cards follow the answer — the excursion it names comes first', async () => {
  const many = { total: 8, url: '/excursions?x', items: Array.from({ length: 8 }, (_, i) => ({ id: `E${i}`, name: i === 7 ? 'Semi-Submarine Tour' : `Jet Ski ${i}`, price: 50 + i, currency: 'EUR', runsOnDate: true, url: `/e${i}` })) };
  const route = { 'boat trips on mahe': { intent: 'live_search', product: 'excursions', language: 'en', slots: { destination: 'Mahé' } } };
  const [o] = await converse(['boat trips on mahe'], { llm: fakeLlm({ route, answer: () => ({ text: 'The Semi-Submarine Tour is a lovely pick.' }) }), tools: fakeTools({ 'excursions.search': many }), retriever: fakeRetriever() });
  assert.equal(o.reply.cards[0].title, 'Semi-Submarine Tour');
});

test('1.3: contact questions are answered from the knowledge; full-width citations become [S1]', async () => {
  assert.notEqual(prepass('What is your office address and phone number?', { today: '2026-10-16' }).kind, 'handoff');
  assert.equal(ground('Operated by ESPACE Seychelles Ltd【S1】.', {}).text, 'Operated by ESPACE Seychelles Ltd[S1].');
});

test('1.3: a non-breaking hyphen in the answer still matches the card; contact questions are on topic', async () => {
  const many = { total: 3, url: '/x', items: [{ id: 'A', name: 'Banana Boat', price: 10, currency: 'EUR', url: '/a' }, { id: 'B', name: 'Jet Ski', price: 20, currency: 'EUR', url: '/b' }, { id: 'C', name: 'Semi-Submarine Tour', price: 134, currency: 'EUR', url: '/c' }] };
  const route = { 'boat trips': { intent: 'live_search', product: 'excursions', language: 'en', slots: {} }, 'What is your office address and phone number?': { intent: 'out_of_scope', language: 'en', slots: {} } };
  const [o] = await converse(['boat trips'], { llm: fakeLlm({ route, answer: () => ({ text: 'Try the Semi\u2011Submarine Tour.' }) }), tools: fakeTools({ 'excursions.search': many }), retriever: fakeRetriever() });
  assert.equal(o.reply.cards[0].title, 'Semi-Submarine Tour');
  const [c] = await converse(['What is your office address and phone number?'], { llm: fakeLlm({ route, answer: () => ({ text: 'Au Cap, Mahé [S1].' }) }), tools: fakeTools(), retriever: fakeRetriever() });
  assert.equal(c.trace.route, 'knowledge');
});

test('rules: weekdays — "next saturday" on a Saturday is a week later; "on friday" is the coming one', () => {
  const sat = '2026-10-17'; // a Saturday
  assert.deepEqual(findDates('boat trips next saturday', sat), ['2026-10-24']);
  assert.deepEqual(findDates('on friday', sat), ['2026-10-23']);
  assert.deepEqual(findDates('this saturday', sat), ['2026-10-17']);
});

test('1.3: "boat trips" searches the cruise category even when the router leaves it out', async () => {
  const tools = fakeTools();
  const route = { 'show me boat trips on mahe next saturday': { intent: 'live_search', product: 'excursions', language: 'en', slots: { destination: 'Mahé' } } };
  await converse(['show me boat trips on mahe next saturday'], { llm: fakeLlm({ route }), tools, retriever: fakeRetriever() });
  const call = tools.calls.find((c) => c.name === 'excursions.search');
  assert.equal(call.input.category, 'cruise');
  assert.equal(call.input.date, '2026-10-17', 'today (16 Oct, a Friday) → the coming Saturday');
});

test('a tool call written as the answer text is never shown — not streamed, replaced by the fallback', async () => {
  const { createSafeStream } = require('./stream');
  const { looksLikeToolCall } = require('./grounding');
  const json = '{ "tool": "Hotel search", "arguments": { "checkIn": "2026-10-28", "destination": "Mahé", "maxPrice": 300 } }';
  assert.ok(looksLikeToolCall(json));
  assert.ok(!looksLikeToolCall('Mahé has 65 beaches. {curly} text'));
  const shown = [];
  const s = createSafeStream({ evidence: {}, emit: (x) => shown.push(x) });
  for (const piece of json.match(/.{1,12}/g)) s.push(piece);
  assert.equal(s.end(), '');
  assert.deepEqual(shown, []);
  const [o] = await converse(['can you suggest me the best hotel in seychelles under 300euro'], { llm: fakeLlm({ route: { 'can you suggest me the best hotel in seychelles under 300euro': { intent: 'knowledge', language: 'en', slots: {} } }, answer: () => ({ text: json }) }), tools: fakeTools(), retriever: fakeRetriever() });
  assert.ok(!/"tool"/.test(o.reply.text));
});

test('2.3: a matching API connector with fixed params is called and its data answers a knowledge question', async () => {
  const tools = fakeTools({ 'api.weather': { item: { temperature_2m: 27 } } });
  const conn = [{ tool: 'api.weather', params: [{ name: 'lat', value: '-4.6' }] }];
  let data = '';
  const llm = fakeLlm({ answer: (messages) => { data = messages.at(-1).content; return { text: 'It is 27 degrees on Mahé now.' }; } });
  const [o] = await converse(['what is the weather on mahe'], { llm, tools, retriever: fakeRetriever({ insufficient: true, hits: [], sources: [], context: '' }), connectors: conn });
  assert.ok(tools.calls.some((c) => c.name === 'api.weather'));
  assert.match(data, /temperature_2m/);
  assert.match(data, /Answer from the live data below/);
  assert.equal(o.reply.text, 'It is 27 degrees on Mahé now.');
});
