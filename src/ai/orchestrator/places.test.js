/**
 * Place names → intro + chips (no model). Pure parts only: no database, no supplier.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { placeQuery, findKnown, excerpt, chipsFor } = require('./places');

const LIST = [
  { key: 'seychelles', names: ['seychelles', 'the seychelles'], name: 'Seychelles', kind: 'country' },
  { key: 'mahe', slug: 'mahe', names: ['mahe island', 'mahe'], name: 'Mahé', kind: 'island', island: 'Mahé' },
  { key: 'la-digue', slug: 'la-digue', names: ['la digue island', 'la digue', 'ladigue'], name: 'La Digue', kind: 'island', island: 'La Digue' },
  { key: 'beau-vallon', slug: 'beau-vallon', names: ['beau vallon'], name: 'Beau Vallon', kind: 'area', island: 'Mahé' },
  { key: 'anse-lazio', slug: 'anse-lazio', names: ['anse lazio'], name: 'Anse Lazio', kind: 'area', island: 'Praslin' },
];

test('placeQuery: bare names and "tell me about X" are places; requests and questions are not', () => {
  assert.deepStrictEqual(placeQuery('mahe'), { query: 'mahe', more: false });
  assert.deepStrictEqual(placeQuery('Praslin?'), { query: 'Praslin', more: false });
  assert.strictEqual(placeQuery('tell me about la digue island').query, 'la digue');
  assert.strictEqual(placeQuery('I want to visit Beau Vallon').query, 'Beau Vallon');
  assert.strictEqual(placeQuery('More about Mahé').more, true);
  assert.strictEqual(placeQuery('mahe ke baare mein batao').query, 'mahe');
  for (const m of ['hotels in mahe', 'best time to visit praslin', 'transfer to la digue', '2 adults', 'which island is best?', 'how much is the ferry', 'a very long message that keeps going on and on about many things at once'])
    assert.strictEqual(placeQuery(m), null, m);
});

test('findKnown: exact, accents, aliases and small typos', () => {
  assert.strictEqual(findKnown(LIST, 'Mahé').key, 'mahe');
  assert.strictEqual(findKnown(LIST, 'mahee').key, 'mahe');
  assert.strictEqual(findKnown(LIST, 'ladigue').key, 'la-digue');
  assert.strictEqual(findKnown(LIST, 'beau valon').key, 'beau-vallon');
  assert.strictEqual(findKnown(LIST, 'Seychelles').key, 'seychelles');
  assert.strictEqual(findKnown(LIST, 'paris'), null);
  assert.strictEqual(findKnown(LIST, 'mah'), null); // too short to guess
});

test('excerpt: tagline line + first paragraphs', () => {
  const ex = excerpt('Beaches & charm\n\nFirst paragraph here.\n\nSecond one.\n\nThird.', 35);
  assert.strictEqual(ex.tagline, 'Beaches & charm');
  assert.strictEqual(ex.body, 'First paragraph here.\n\nSecond one.');
});

test('chips: flows start with the place filled in; a beach uses its island', () => {
  const area = chipsFor({ ...LIST[3], hotelArea: 'Beau Vallon Bay' });
  assert.deepStrictEqual(area[0].action, { type: 'flow', flow: 'hotels', label: 'Hotels', vars: { island: 'Beau Vallon Bay' } });
  assert.deepStrictEqual(area[1].action.vars, { island: 'Mahé' });
  const beach = chipsFor(LIST[4]);
  assert.strictEqual(beach[0].label, '🏨 Hotels in Praslin');
  assert.ok(beach.some((c) => c.label === '📖 More about Anse Lazio'));
  const country = chipsFor(LIST[0]);
  assert.deepStrictEqual(country.map((c) => c.action.flow), ['hotels', 'excursions', 'transfers', 'islands']);
});
