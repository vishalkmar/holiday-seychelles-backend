const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolve, resolveValue, evaluate } = require('./template');
const { validate } = require('./schema');
const engine = require('./engine');
const flows = require('./index');
const store = require('./store');

after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

const HOTELS_FLOW = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../docs/rag-system/samples/flow-hotels.json'), 'utf8'));
const TOOLS = [{ name: 'hotels.search', enabled: true }, { name: 'destinations.list', enabled: true }, { name: 'excursions.search', enabled: false }];
const TODAY = '2026-10-16';

const fakeTools = (data = {}) => {
  const calls = [];
  return {
    calls,
    async run(name, input) {
      calls.push({ name, input });
      const d = typeof data[name] === 'function' ? data[name](input) : data[name];
      if (d instanceof Error) return { tool: name, ok: false, error: { code: 'SUPPLIER_DOWN', message: d.message } };
      return { tool: name, ok: true, data: d ?? { items: [] } };
    },
  };
};
const HOTEL_DATA = { nights: 3, url: '/hotel-listing?x', items: [{ id: '1', name: 'Le Vasseur', stars: 4, price: 1158.53, currency: 'EUR', url: '/hotel-details?1' }] };
const deps = (over = {}) => ({ tools: fakeTools({ 'hotels.search': HOTEL_DATA }), ai: async (q) => ({ text: `AI: ${q}` }), knowledge: async (q) => ({ text: `K: ${q}`, sources: [{ id: 'S1' }] }), loadFlow: async () => null, startChips: [{ label: 'Hotels' }], today: TODAY, links: require('../tools/catalog/site').links, ...over });
const start = (graph, vars = {}) => ({ key: graph.key, version: 1, nodeId: graph.entry, waiting: false, vars });

test('templates and conditions: paths, typed values, operators, no code', () => {
  const v = { island: 'Praslin', pax: { adults: 2, childAges: [5] }, hotels: { items: [1, 2] } };
  assert.equal(resolve('Stay in {{island}} for {{pax.adults}}, kids {{pax.childAges}}', v), 'Stay in Praslin for 2, kids 5');
  assert.deepEqual(resolveValue({ a: '{{pax}}', n: '{{pax.adults}}', s: 'x {{island}}' }, v), { a: v.pax, n: 2, s: 'x Praslin' });
  assert.equal(evaluate('{{hotels.items.length}} == 2 && {{pax.adults}} >= 2', v), true);
  assert.equal(evaluate("({{island}} == 'Mahé') || {{pax.childAges}} contains 5", v), true);
  assert.equal(evaluate('{{missing}} empty', v), true);
  assert.throws(() => evaluate('process.exit(1)', v), /syntax/);
  assert.throws(() => evaluate('{{island}} == ', v));
  assert.equal(resolve('{{constructor.name}}', v), '', 'no prototype access');
});

test('validator: the sample Hotels flow is valid; broken graphs are caught', () => {
  const ok = validate(HOTELS_FLOW, { tools: TOOLS });
  assert.deepEqual(ok.errors, []);
  const bad = validate({
    key: 'Bad Key', name: '', entry: 'zz',
    nodes: [{ id: 'a', type: 'choice', data: { text: 'Q' } }, { id: 'a', type: 'nope' }, { id: 'b', type: 'tool', data: { tool: 'excursions.search', var: 'x' } }, { id: 'c', type: 'condition', data: { when: 'rm -rf' } }],
    edges: [{ from: 'a', to: 'q' }, { from: 'b', port: 'banana', to: 'a' }],
  }, { tools: TOOLS });
  const all = bad.errors.join(' | ');
  for (const re of [/key/, /name/, /entry/, /share the id/, /unknown type/, /needs options/, /unknown node “q”/, /no “banana” output/, /syntax/]) assert.match(all, re);
  assert.match(bad.warnings.join(' | '), /switched off/);
});

test('Hotels flow end to end: island chip → dates → guests → live cards → next step', async () => {
  const d = deps();
  let r = await engine.run({ graph: HOTELS_FLOW, state: start(HOTELS_FLOW), input: {}, deps: d });
  assert.match(r.reply.text, /Let's find you a stay[\s\S]*Which island/);
  assert.deepEqual(r.reply.chips.map((c) => c.label), ['Mahé', 'Praslin', 'La Digue', 'Silhouette']);
  assert.deepEqual(r.reply.chips[1].action, { type: 'choice', node: 'n2', value: 'Praslin', label: 'Praslin' });
  r = await engine.run({ graph: HOTELS_FLOW, state: r.state, input: { action: r.reply.chips[1].action }, deps: d });
  assert.equal(r.reply.input.type, 'dateRange');
  r = await engine.run({ graph: HOTELS_FLOW, state: r.state, input: { action: { type: 'dates', node: 'n3', from: '2026-11-10', to: '2026-11-13' } }, deps: d });
  assert.equal(r.reply.input.type, 'guests');
  r = await engine.run({ graph: HOTELS_FLOW, state: r.state, input: { action: { type: 'guests', node: 'n4', adults: 2, childAges: [] } }, deps: d });
  assert.deepEqual(d.tools.calls[0], { name: 'hotels.search', input: { destination: 'Praslin', checkIn: '2026-11-10', checkOut: '2026-11-13', adults: 2, childAges: [] } });
  assert.equal(r.reply.cards[0].price, 1158.53, 'prices only from the tool');
  assert.match(r.reply.text, /live options in Praslin[\s\S]*What would you like to do next/);
  assert.deepEqual(r.reply.chips.map((c) => c.label), ['See all hotels', 'Change dates', 'Another island', 'Talk to an expert']);
  // "Change dates" clears the dates and asks again (a loop in the graph).
  r = await engine.run({ graph: HOTELS_FLOW, state: r.state, input: { action: { type: 'choice', node: 'n7', value: 'dates' } }, deps: d });
  assert.equal(r.reply.input.type, 'dateRange');
  assert.equal(r.state.vars.island, 'Praslin', 'other answers kept');
});

test('pre-filled answers skip their nodes ("hotels on praslin 10 to 13 november for 2 adults")', async () => {
  const d = deps();
  const vars = { ...flows.varsFromText('hotels on praslin 10 to 13 november for 2 adults', TODAY), today: TODAY };
  assert.deepEqual([vars.island, vars.checkIn, vars.checkOut, vars.pax.adults], ['praslin', '2026-11-10', '2026-11-13', 2]);
  const r = await engine.run({ graph: HOTELS_FLOW, state: start(HOTELS_FLOW, vars), input: {}, deps: d });
  assert.equal(d.tools.calls[0].input.destination, 'Praslin', 'the slug matched the option and took its value');
  assert.equal(r.reply.cards.length, 1);
  assert.ok(r.trace.nodes.includes('(skipped n2)') && r.trace.nodes.includes('(skipped n3)') && r.trace.nodes.includes('(skipped n4)'));
});

test('free text answers: option by name, dates and guests in words; a question is a side question, then re-asked', async () => {
  const d = deps();
  let r = await engine.run({ graph: HOTELS_FLOW, state: start(HOTELS_FLOW), input: {}, deps: d });
  r = await engine.run({ graph: HOTELS_FLOW, state: r.state, input: { text: 'is the sea calm in november?' }, deps: d });
  assert.match(r.reply.text, /^AI: is the sea calm in november\?\n\nWhich island/);
  assert.equal(r.state.nodeId, 'n2');
  r = await engine.run({ graph: HOTELS_FLOW, state: r.state, input: { text: 'la digue' }, deps: d });
  assert.equal(r.state.vars.island, 'La Digue');
  r = await engine.run({ graph: HOTELS_FLOW, state: r.state, input: { text: '5 to 9 dec' }, deps: d });
  assert.equal(r.state.vars.checkOut, '2026-12-09');
  r = await engine.run({ graph: HOTELS_FLOW, state: r.state, input: { text: '3 adults' }, deps: d });
  assert.equal(d.tools.calls.at(-1).input.adults, 3);
});

test('tool errors follow the error port; unconnected error → built-in message + contact chip', async () => {
  const d = deps({ tools: fakeTools({ 'hotels.search': new Error('down') }) });
  const vars = { island: 'Praslin', checkIn: '2026-11-10', checkOut: '2026-11-13', pax: { adults: 2, childAges: [] } };
  const r = await engine.run({ graph: HOTELS_FLOW, state: start(HOTELS_FLOW, vars), input: {}, deps: d });
  assert.match(r.reply.text, /travel experts/, 'error port → handoff node');
  assert.equal(r.done, true);
  const g = { key: 't', name: 'T', entry: 'a', nodes: [{ id: 'a', type: 'tool', data: { tool: 'hotels.search', var: 'h' } }, { id: 'b', type: 'end' }], edges: [{ from: 'a', port: 'ok', to: 'b' }] };
  const r2 = await engine.run({ graph: g, state: start(g), input: {}, deps: d });
  assert.match(r2.reply.text, /Live prices are unavailable/);
  assert.equal(r2.reply.chips[0].action.type, 'handoff');
});

test('condition, set, knowledge, link, ai, handoff and end nodes', async () => {
  const g = {
    key: 'misc', name: 'Misc', entry: 's',
    nodes: [
      { id: 's', type: 'set', data: { assign: { n: 5, who: 'Ana' } } },
      { id: 'c', type: 'condition', data: { cases: [{ when: '{{n}} > 10', port: 'big' }, { when: '{{n}} > 3', port: 'mid' }] } },
      { id: 'k', type: 'knowledge', data: { query: 'best time for {{who}}' } },
      { id: 'l', type: 'link', data: { page: 'island', params: { slug: 'praslin' }, label: 'Praslin page' } },
      { id: 'x', type: 'ai', data: { question: 'tips?' } },
      { id: 'h', type: 'handoff', data: {} },
      { id: 'e', type: 'end' },
      { id: 'big', type: 'end' },
    ],
    edges: [{ from: 's', to: 'c' }, { from: 'c', port: 'mid', to: 'k' }, { from: 'c', port: 'big', to: 'big' }, { from: 'k', to: 'l' }, { from: 'l', to: 'x' }, { from: 'x', port: 'answered', to: 'h' }, { from: 'h', to: 'e' }],
  };
  const r = await engine.run({ graph: g, state: start(g), input: {}, deps: deps() });
  assert.equal(r.reply.text, 'K: best time for Ana\n\nAI: tips?\n\nOur team will be happy to help. Send us a query and we’ll reply by email.');
  assert.deepEqual(r.reply.chips.map((c) => c.action.type), ['link', 'handoff']);
  assert.equal(r.reply.chips[0].action.url, '/islands/praslin');
  assert.equal(r.reply.sources.length, 1);
  assert.equal(r.done, true);
  assert.equal(r.state, null);
});

test('a looping graph stops after 25 steps', async () => {
  const g = { key: 'loop', name: 'Loop', entry: 'a', nodes: [{ id: 'a', type: 'set', data: { assign: { x: 1 } } }, { id: 'b', type: 'message', data: { text: '' } }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
  const r = await engine.run({ graph: g, state: start(g), input: {}, deps: deps() });
  assert.equal(r.trace.error, 'STEP_LIMIT');
  assert.match(r.reply.text, /start again/);
});

test('version pinning: a running conversation stays on its version after a publish', async () => {
  const v1 = HOTELS_FLOW;
  const v2 = JSON.parse(JSON.stringify(HOTELS_FLOW));
  v2.nodes.find((n) => n.id === 'n2').data.text = 'NEW WORDING: which island?';
  const saved = { published: store.published, version: store.version };
  store.published = async () => [{ key: 'hotels', version: 2, graph: v2 }];
  store.version = async (key, v) => ({ key, version: v, graph: v === 1 ? v1 : v2 });
  try {
    const running = { key: 'hotels', version: 1, nodeId: 'n2', waiting: true, vars: {} };
    const r = await flows.turn({ text: 'is it hot in november?', flowState: running, today: TODAY, ai: async () => ({ text: 'Warm.' }), tools: fakeTools() });
    assert.match(r.reply.text, /Which island would you like/, 'old wording, old version');
    assert.equal(r.flowState.version, 1);
    const fresh = await flows.turn({ text: 'Hotels', action: { type: 'message', label: 'Hotels' }, today: TODAY, ai: async () => ({}), tools: fakeTools() });
    assert.match(fresh.reply.text, /NEW WORDING/);
    assert.equal(fresh.flowState.version, 2);
    const q = await flows.turn({ text: 'which hotel has the best beach?', today: TODAY, ai: async () => ({}), tools: fakeTools() });
    assert.equal(q, null, 'a plain question goes to the AI, not the flow');
  } finally {
    Object.assign(store, saved);
  }
});

test('default flows: all valid; entry phrases start the right flow; plain questions do not', async () => {
  const seed = require('./seed');
  const defs = seed.defaults();
  assert.deepEqual(defs.map((g) => g.key).sort(), ['bookings', 'contact', 'excursions', 'hotels', 'islands', 'transfers']);
  for (const g of defs) assert.deepEqual(validate(g, { tools: [...TOOLS, { name: 'excursions.search', enabled: true }, { name: 'transfers.departures', enabled: true }, { name: 'transfers.arrivals', enabled: true }, { name: 'transfers.search', enabled: true }, { name: 'bookings.mine', enabled: true }] }).errors, [], g.key);
  const saved = store.published;
  store.published = async () => defs.map((graph) => ({ key: graph.key, version: 1, graph }));
  try {
    const cases = {
      'hotels in praslin next week': 'hotels',
      'I need a resort on La Digue for 4 nights': 'hotels',
      'need a cab from the airport': 'transfers',
      'book a taxi to my hotel': 'transfers',
      'show me snorkelling trips': 'excursions',
      'looking for a catamaran cruise tomorrow': 'excursions',
      'explore islands': 'islands',
      'I want to talk to someone': 'contact',
      'show my bookings': 'bookings',
    };
    for (const [text, key] of Object.entries(cases)) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await flows.match({ text }))?.key, key, text);
    }
    assert.equal((await flows.match({ text: 'Excursions', action: { type: 'message', label: 'Excursions' } }))?.key, 'excursions', 'chip label');
    assert.equal(await flows.match({ text: 'which hotel has the best beach?' }), null);
    assert.equal(await flows.match({ text: 'is diving good in november?' }), null);
    const chips = await flows.greetingChips([], { signedIn: false });
    assert.deepEqual(chips.map((c) => c.label), ['🏨 Hotels', '🏝 Excursions', '🚐 Transfers', '🗺 Explore islands', '💬 Talk to us']);
    assert.equal((await flows.greetingChips([], { signedIn: true })).at(-1).label, '🧳 My bookings');
  } finally {
    store.published = saved;
  }
});

test('transfers: options from tools, "picked" port, ids and types kept for the search', async () => {
  const g = require('./seed').defaults().find((x) => x.key === 'transfers');
  const d = deps({
    tools: fakeTools({
      'transfers.departures': { items: [{ id: '84', name: 'SEYCHELLES INTERNATIONAL AIRPORT', type: 4 }] },
      'transfers.arrivals': (input) => ({ items: input.departureId === '84' ? [{ id: '7', name: 'BEAU VALLON', type: 4 }] : [] }),
      'transfers.search': { url: '/transfer-listing?x', items: [{ name: 'Private car', vehicle: 'CAR', maxPax: 3, price: 43, currency: 'EUR' }] },
    }),
  });
  let r = await engine.run({ graph: g, state: start(g), input: {}, deps: d });
  r = await engine.run({ graph: g, state: r.state, input: { action: r.reply.chips[0].action }, deps: d }); // Arriving
  assert.equal(r.reply.chips[0].label, 'SEYCHELLES INTERNATIONAL AIRPORT');
  r = await engine.run({ graph: g, state: r.state, input: { text: 'the international airport' }, deps: d });
  assert.equal(r.state.nodeId, 't3', 'typed name matched an option → picked → arrivals');
  assert.deepEqual(r.reply.chips.map((c) => c.label), ['BEAU VALLON']);
  r = await engine.run({ graph: g, state: r.state, input: { action: r.reply.chips[0].action }, deps: d });
  r = await engine.run({ graph: g, state: r.state, input: { action: { type: 'date', node: 't4', date: '2026-11-12' } }, deps: d });
  r = await engine.run({ graph: g, state: r.state, input: { action: { type: 'guests', node: 't5', adults: 2, childAges: [] } }, deps: d });
  const search = d.tools.calls.find((c) => c.name === 'transfers.search').input;
  assert.deepEqual([search.departureId, search.departureType, search.arrivalId, search.arrivalType, search.date, search.direction], ['84', 4, '7', 4, '2026-11-12', '1']);
  assert.equal(r.reply.cards[0].price, 43);
});

test('Talk to us: name, email (validated), message → a query; logged-in details skip the questions', async () => {
  const g = require('./seed').defaults().find((x) => x.key === 'contact');
  const created = [];
  const d = deps({ createQuery: async (q) => { created.push(q); return 77; } });
  let r = await engine.run({ graph: g, state: start(g), input: {}, deps: d });
  assert.match(r.reply.text, /What's your name/);
  r = await engine.run({ graph: g, state: r.state, input: { text: 'Asha' }, deps: d });
  r = await engine.run({ graph: g, state: r.state, input: { text: 'not-an-email' }, deps: d });
  assert.match(r.reply.text, /doesn't look right/);
  r = await engine.run({ graph: g, state: r.state, input: { text: 'asha@example.com' }, deps: d });
  r = await engine.run({ graph: g, state: r.state, input: { text: 'Can you plan a 10-day honeymoon in March?' }, deps: d });
  assert.deepEqual(created[0], { name: 'Asha', email: 'asha@example.com', mobile: null, subject: 'From the website assistant', message: 'Can you plan a 10-day honeymoon in March?', category: 'general' });
  assert.match(r.reply.text, /Thanks, Asha! .*#77.*asha@example.com/);
  const logged = await engine.run({ graph: g, state: start(g, { name: 'Ravi', email: 'ravi@example.com' }), input: {}, deps: d });
  assert.match(logged.reply.text, /What would you like to ask/, 'name and email known → straight to the message');
});

test('a menu reached again after a loop is asked, not skipped from its old answer', async () => {
  const g = require('./seed').defaults().find((x) => x.key === 'hotels');
  const d = deps({ tools: fakeTools({ 'hotels.search': (input) => (input.maxPrice ? { nights: 3, items: [] } : HOTEL_DATA) }) });
  const vars = { island: 'Praslin', checkIn: '2026-11-10', checkOut: '2026-11-13', pax: { adults: 2, childAges: [] } };
  let r = await engine.run({ graph: g, state: start(g, vars), input: {}, deps: d });
  r = await engine.run({ graph: g, state: r.state, input: { action: { type: 'choice', node: 'n7', value: 'b1000' } }, deps: d });
  assert.match(r.reply.text, /couldn't find rooms in Praslin for those dates under €1,000[\s\S]*What would you like to do next/);
  assert.equal(r.state.nodeId, 'n7');
  assert.equal(r.trace.error, undefined, 'no step-limit loop');
});
