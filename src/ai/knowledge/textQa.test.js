const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseTextQa } = require('./textQa');

test('text Q&A: labels, categories, multi-line answers, variations', () => {
  const rows = parseTextQa(`== Islands ==

Q: Which is the largest island?
A: Mahé is the largest island
and home to Victoria.
Also asked: Biggest island? | Main island?

# Getting around
1. Question: How do I get to La Digue?
Answer: By ferry from Praslin.`);
  assert.deepEqual(rows, [
    ['Which is the largest island?', 'Mahé is the largest island and home to Victoria.', 'Biggest island? | Main island?', 'Islands'],
    ['How do I get to La Digue?', 'By ferry from Praslin.', '', 'Getting around'],
  ]);
});

test('text Q&A: Hinglish labels and an upper-case heading between rules', () => {
  const rows = parseTextQa('=====\nENTRY & ARRIVAL (2)\n=====\n\nSawal: Visa chahiye?\nJawab: Nahi, Travel Authorisation chahiye.\n');
  assert.deepEqual(rows, [['Visa chahiye?', 'Nahi, Travel Authorisation chahiye.', '', 'Entry & Arrival']]);
});

test('text Q&A: no labels — a block starting with a question line', () => {
  const rows = parseTextQa('Where is Seychelles?\nIn the Indian Ocean.\n\nJust a note, not a question.\n\nWhat currency?\nThe rupee.\nCards are common.');
  assert.deepEqual(rows, [['Where is Seychelles?', 'In the Indian Ocean.', '', ''], ['What currency?', 'The rupee. Cards are common.', '', '']]);
});

test('text Q&A: the 300-question knowledge pack reads as 300 rows in 12 categories', { skip: !process.env.QA_PACK }, () => {
  const rows = parseTextQa(fs.readFileSync(path.resolve(process.env.QA_PACK || ''), 'utf8'));
  assert.equal(rows.length, 300);
  assert.equal(new Set(rows.map((r) => r[3])).size, 12);
  assert.ok(rows.every((r) => r[0].endsWith('?') && r[1].length > 10));
});
