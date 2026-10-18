const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, splitList, cleanInput, matchAgainst, DUPLICATE_AT, SIMILAR_AT } = require('./faqs');
const { suggestMapping } = require('./faqImport');
const { chunkContent } = require('../ingest/chunk');

// faqs.js loads ports, which creates (but never uses) the MySQL pool.
after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

test('normalize: case, accents, apostrophes and punctuation do not matter', () => {
  assert.equal(normalize("What's the best time to visit Mahé?"), 'whats the best time to visit mahe');
  assert.equal(normalize('  WHAT’S the best   time, to visit MAHE '), 'whats the best time to visit mahe');
});

test('splitList: pipes, new lines and semicolons', () => {
  assert.deepEqual(splitList('a | b\nc; d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitList(['x', ' ', 'y']), ['x', 'y']);
  assert.deepEqual(splitList(''), []);
});

test('cleanInput: question and answer required; lists split', () => {
  assert.throws(() => cleanInput({ answer: 'x' }), /Question is required/);
  assert.throws(() => cleanInput({ question: 'x' }), /Answer is required/);
  const c = cleanInput({ question: ' Visa? ', answer: 'No visa.', variations: 'Need a visa? | Entry rules', tags: 'visa; permit' });
  assert.equal(c.question, 'Visa?');
  assert.deepEqual(c.variations, ['Need a visa?', 'Entry rules']);
  assert.deepEqual(c.tags, ['visa', 'permit']);
});

test('matchAgainst: exact wording, same meaning, unrelated; best per FAQ', () => {
  assert.ok(DUPLICATE_AT > SIMILAR_AT);
  const v = (x, y) => Float32Array.from([x, y]);
  const phrasings = [
    { faqId: 1, question: 'Do I need a visa?', status: 'published', norm: 'do i need a visa', vector: v(1, 0) },
    { faqId: 1, question: 'Is a visa required?', status: 'published', norm: 'is a visa required', vector: v(0.99, 0.14) },
    { faqId: 2, question: 'Best time to visit?', status: 'draft', norm: 'best time to visit', vector: v(0, 1) },
    { faqId: 3, question: 'Visa on arrival?', status: 'draft', norm: 'visa on arrival', vector: v(0.85, 0.53) },
  ];
  const exact = matchAgainst('do i need a visa', v(0, 1), phrasings);
  assert.equal(exact[0].faqId, 1);
  assert.equal(exact[0].reason, 'Same wording');
  const hits = matchAgainst('visa needed', v(1, 0.01), phrasings);
  assert.deepEqual(hits.map((h) => [h.faqId, h.kind]), [[1, 'duplicate'], [3, 'similar']]);
  assert.equal(hits.filter((h) => h.faqId === 1).length, 1, 'one hit per FAQ');
  assert.deepEqual(matchAgainst('visa needed', v(1, 0.01), phrasings, { excludeId: 1 }).map((h) => h.faqId), [3]);
});

test('suggestMapping: guesses columns from headers, falls back to first two', () => {
  assert.deepEqual(suggestMapping(['Question', 'Answer', 'Other ways to ask', 'Topic', 'Keywords', 'Island', 'Lang']), {
    question: 0, answer: 1, variations: 2, category: 3, tags: 4, destination: 5, language: 6,
  });
  const m = suggestMapping(['Q', 'A']);
  assert.equal(m.question, 0);
  assert.equal(m.answer, 1);
  const n = suggestMapping(['col1', 'col2']);
  assert.equal(n.question, 0);
  assert.equal(n.answer, 1);
});

test('faq chunks: one per phrasing, each with the full answer', () => {
  const chunks = chunkContent({ format: 'faq', content: JSON.stringify({ question: 'Do I need a visa?', answer: 'No — a free permit on arrival.', variations: ['Is a visa required?'] }) });
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].text, /^Q: Do I need a visa\?\nA: No/);
  assert.match(chunks[1].text, /^Q: Is a visa required\?\nA: No/);
  assert.equal(chunks[1].heading, 'Do I need a visa? (as: Is a visa required?)');
});
