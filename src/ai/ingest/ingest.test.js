const { test } = require('node:test');
const assert = require('node:assert/strict');
const { basic, removeRepeatedLines, fromHtml } = require('./clean');
const { paragraphs, headings, records, chunkContent } = require('./chunk');

test('clean: zero-width chars, CRLF, trailing spaces, hyphenated line breaks, blank runs', () => {
  const out = basic('Mahé​ is great \r\nexcur-\nsions\n\n\n\nnext ');
  assert.equal(out, 'Mahé is great\nexcursions\n\nnext');
});

test('clean: headers and footers repeated on most pages are removed', () => {
  // Body lines that differ only by a number (room lists, rates) must survive.
  const pages = [1, 2, 3, 4].map(
    (n) => `Holidays Seychelles Rate Sheet\nIntro for section ${n}.\nPraslin note.\nRoom ${n} costs 100 euros.\nRoom ${n + 10} costs 120 euros.\nMore text ${n}.\nAnother line.\nPage ${n} of 4`
  );
  const out = removeRepeatedLines(pages);
  assert.ok(!out.includes('Rate Sheet'));
  assert.ok(!/Page \d of 4/.test(out));
  assert.ok(out.includes('Room 13 costs 120 euros.'), 'body line kept');
});

test('clean: HTML keeps headings and list items as text', () => {
  const out = fromHtml('<h2>Getting there</h2><p>Ferry &amp; plane</p><ul><li>Cat Cocos</li><li>Air Seychelles</li></ul><script>x()</script>');
  assert.equal(out, '## Getting there\nFerry & plane\n- Cat Cocos\n- Air Seychelles');
});

test('paragraphs: chunks stay near the target and consecutive chunks overlap', () => {
  const text = Array.from({ length: 40 }, (_, i) => `Fact number ${i} about the islands is described here in one sentence.`).join('\n\n');
  const chunks = paragraphs(text, { targetTokens: 120, overlapPct: 20 });
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.tokens <= 150), 'no chunk far above target');
  // overlap: the last fact of chunk 0 starts chunk 1
  const lastOfFirst = chunks[0].text.split('\n\n').pop();
  assert.ok(chunks[1].text.startsWith(lastOfFirst));
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
});

test('headings: heading path on every chunk; small sections merge; long ones split', () => {
  const md = `# Praslin\n\nIntro line.\n\n## Getting there\n\nFerry one hour.\n\n## Beaches\n\n${'Anse Lazio is a famous beach. '.repeat(80)}`;
  const chunks = headings(md, { targetTokens: 200, overlapPct: 10 });
  assert.ok(chunks[0].text.includes('Getting there'), 'small section merged into the first chunk');
  const beach = chunks.filter((c) => c.heading === 'Praslin › Beaches');
  assert.ok(beach.length >= 2, 'long section split');
  assert.ok(beach.every((c) => c.text.startsWith('Praslin › Beaches')), 'heading path prefixed');
});

test('headings: plain-text documents with Title Case headings are understood', () => {
  const text = 'Best Time To Visit\nApril and October are calm.\n\nGetting Around\nBuses and taxis on Mahé.';
  const chunks = headings(text, { targetTokens: 300 });
  assert.ok(chunks.some((c) => (c.heading || '').includes('Best Time To Visit')));
});

test('records: header row → "Header: value" lines, blanks dropped, context prefixed, groups capped', () => {
  const rows = [['Hotel', 'Island', 'Price'], ...Array.from({ length: 45 }, (_, i) => [`Hotel ${i}`, 'Mahé', i % 3 ? 100 + i : ''])];
  const chunks = records(rows, { context: 'Rates › 2026', rowsPerChunk: 20 });
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].text.startsWith('Rates › 2026\nHotel: Hotel 0; Island: Mahé'));
  assert.ok(!chunks[0].text.includes('Price: ;'));
});

test('chunkContent: records format with sheets; markdown detection', () => {
  const content = JSON.stringify({ sheets: [{ name: 'Transfers', rows: [{ From: 'Airport', To: 'Victoria', Price: 49 }] }] });
  const r = chunkContent({ format: 'records', content }, { context: 'Price list' });
  assert.equal(r[0].text, 'Price list › Transfers\nFrom: Airport; To: Victoria; Price: 49');
  const m = chunkContent({ format: 'text', content: '# Title\n\nBody text.' });
  assert.equal(m[0].heading, 'Title');
});

test('maxChunks caps output', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} with some words in it to make it long enough.`).join('\n\n');
  assert.equal(paragraphs(text, { targetTokens: 50, overlapPct: 0, maxChunks: 7 }).length, 7);
});
