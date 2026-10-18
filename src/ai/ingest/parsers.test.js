const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures');
const { detect, parse, sniffDelimiter, decodeText } = require('./parsers');
const { fromHtml } = require('./clean');
const { chunkContent } = require('./chunk');

test('detect: by content, not by file name', async () => {
  assert.equal(detect(await fixtures.pdf(), 'anything.txt').kind, 'pdf');
  assert.equal(detect(await fixtures.docx(), 'guide.docx').kind, 'word');
  assert.equal(detect(await fixtures.xlsx(), 'rates.xlsx').kind, 'excel');
  assert.equal(detect(fixtures.csv(), 'list.csv').kind, 'csv');
  assert.equal(detect(fixtures.txt(), 'notes.txt').kind, 'text');
});

test('detect: refuses old .doc/.xls with a "save as" message, binaries and empty files', () => {
  const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.throws(() => detect(ole, 'old.doc'), /Save as.*\.docx/);
  assert.throws(() => detect(ole, 'old.xls'), /Save as.*\.xlsx/);
  assert.throws(() => detect(Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]), 'evil.pdf'), /Unsupported file type/);
  assert.throws(() => detect(Buffer.alloc(0), 'x.txt'), /empty/);
});

test('pdf: text per page, repeated header/footer removed, not flagged for OCR', async () => {
  const p = await parse(await fixtures.pdf(), 'pdf');
  assert.equal(p.pages, 3);
  assert.equal(p.ocrNeeded, false);
  assert.ok(p.content.includes('Cat Cocos ferry'));
  assert.ok(!p.content.includes('Island Guide'), 'header removed');
  assert.ok(!/Page \d of 3/.test(p.content), 'footer removed');
});

test('word: headings become markdown; tables become one line per row', async () => {
  const p = await parse(await fixtures.docx(), 'word');
  const text = fromHtml(p.content);
  assert.ok(text.startsWith('# Cancellation Policy'));
  assert.ok(text.includes('## Late cancellations'));
  assert.ok(text.includes('Notice | Refund'));
  assert.ok(text.includes('8–29 days | 50%'));
});

test('excel: visible sheets only, rows become records', async () => {
  const p = await parse(await fixtures.xlsx(), 'excel');
  const parsed = JSON.parse(p.content);
  assert.deepEqual(parsed.sheets.map((s) => s.name), ['Transfers'], 'hidden sheet skipped');
  const chunks = chunkContent({ format: 'records', content: p.content }, { context: 'Rates' });
  assert.ok(chunks[0].text.includes('From: Praslin Jetty; To: Anse Lazio; Vehicle: Sedan; Price (EUR): 40'));
});

test('csv: BOM, semicolons and quoted delimiters handled', async () => {
  const p = await parse(fixtures.csv(), 'csv', { fileName: 'excursions.csv' });
  const rows = JSON.parse(p.content).sheets[0].rows;
  assert.deepEqual(rows[0], ['Excursion', 'Island', 'Duration', 'Price']);
  assert.equal(rows[2][0], 'Sunset cruise; catamaran');
  assert.equal(rows[1][0], 'Vallée de Mai walk');
});

test('csv helpers: delimiter sniffing and Latin-1 fallback', () => {
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(sniffDelimiter('a,b\n1,2'), ',');
  assert.equal(decodeText(Buffer.from([0x4d, 0x61, 0x68, 0xe9])), 'Mahé');
});

test('text: cleaned plain text; a CSV with only a header is refused', async () => {
  const p = await parse(fixtures.txt(), 'text');
  assert.ok(p.content.startsWith('Visitor permits'));
  await assert.rejects(parse(Buffer.from('a,b,c\n'), 'csv'), /header row and at least one data row/);
});

test('a broken file of a known kind gives a readable error', async () => {
  await assert.rejects(parse(Buffer.from('%PDF-1.4 not really a pdf'), 'pdf'), /Could not read this PDF file/);
});
