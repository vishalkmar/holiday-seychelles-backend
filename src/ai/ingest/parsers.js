/**
 * File → text for the Document Training Center (DESIGN.md §3.3).
 *
 *   detect(buffer, fileName) → { kind, mime, ext } or throws a friendly error
 *   parse(buffer, kind)      → { format, content, pages?, ocrNeeded? }
 *
 * The type comes from the file's bytes, not its name: a renamed .exe is
 * refused, and an old binary .doc/.xls gets a clear "save as" message instead
 * of a crash. All parsers are pure JS and work on Node 18 (checked when added;
 * pdf-parse is pinned to 1.1.1 because 2.x needs Node 20).
 */

const { removeRepeatedLines, basic } = require('./clean');

const KINDS = {
  pdf: { mime: 'application/pdf', ext: 'pdf', label: 'PDF' },
  word: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx', label: 'Word' },
  excel: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx', label: 'Excel' },
  csv: { mime: 'text/csv', ext: 'csv', label: 'CSV' },
  text: { mime: 'text/plain', ext: 'txt', label: 'Text' },
};

const MAX_ROWS_PER_SHEET = 20000;

function bad(message) {
  return Object.assign(new Error(message), { status: 400, permanent: true });
}

function isZip(b) {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
function isOle(b) {
  return b.length > 8 && b.slice(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}
/** Zip entry names are stored as plain text in the archive. */
function zipHas(b, name) {
  return b.includes(Buffer.from(name));
}
function looksLikeText(b) {
  const sample = b.slice(0, 8192);
  if (sample.includes(0)) return false;
  let ctrl = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) ctrl += 1;
  return ctrl / Math.max(1, sample.length) < 0.01;
}

function decodeText(b) {
  let buf = b;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.slice(3);
  const utf8 = buf.toString('utf8');
  // Invalid UTF-8 shows up as U+FFFD; fall back to Latin-1 (old Excel CSV exports).
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

function detect(buffer, fileName = '') {
  const ext = String(fileName).toLowerCase().split('.').pop();
  if (!buffer || !buffer.length) throw bad('The file is empty.');
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', ...KINDS.pdf };
  if (isOle(buffer)) {
    if (ext === 'xls') throw bad('Old Excel (.xls) files are not supported. Open it in Excel and "Save as" .xlsx, then upload that.');
    throw bad('Old Word (.doc) files are not supported. Open it in Word and "Save as" .docx, then upload that.');
  }
  if (isZip(buffer)) {
    if (zipHas(buffer, 'word/document.xml') || zipHas(buffer, 'word/')) return { kind: 'word', ...KINDS.word };
    if (zipHas(buffer, 'xl/workbook.xml') || zipHas(buffer, 'xl/')) return { kind: 'excel', ...KINDS.excel };
    throw bad('This ZIP-based file is not a Word (.docx) or Excel (.xlsx) document.');
  }
  if (looksLikeText(buffer)) {
    if (ext === 'csv' || ext === 'tsv') return { kind: 'csv', ...KINDS.csv };
    return { kind: 'text', ...KINDS.text };
  }
  throw bad('Unsupported file type. Upload PDF, Word (.docx), Excel (.xlsx), CSV or plain text (.txt).');
}

/**
 * The reader packages for each file type. On a server where "npm install" was
 * not run after an update, require() fails with a stack trace nobody can act
 * on; this says which package is missing and how to install it.
 */
const READERS = [
  { kind: 'pdf', label: 'PDF', module: 'pdf-parse/lib/pdf-parse.js', pkg: 'pdf-parse' },
  { kind: 'word', label: 'Word', module: 'mammoth', pkg: 'mammoth' },
  { kind: 'excel', label: 'Excel', module: 'exceljs', pkg: 'exceljs' },
  { kind: 'csv', label: 'CSV', module: 'csv-parse/sync', pkg: 'csv-parse' },
];

function reader(kind) {
  const r = READERS.find((x) => x.kind === kind);
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(r.module);
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
    throw Object.assign(new Error(`The ${r.label} reader isn't installed on the server (package "${r.pkg}"). In cPanel → Setup Node.js App, click "Run NPM Install" (or run npm install in the backend folder), restart the app, then click Retry.`), { status: 503, code: 'READER_MISSING', permanent: false });
  }
}

/** Which reader packages are installed (for the overview's health check). */
function readersStatus() {
  return READERS.map((r) => {
    try { require.resolve(r.module); return { ...r, ok: true }; } catch { return { ...r, ok: false }; }
  });
}

async function parsePdf(buffer) {
  // The package's index runs a debug self-test when required directly; use the library file.
  const pdfParse = reader('pdf');
  // pdf-parse bundles several pdf.js builds. Its default (1.10.100) fails on many
  // modern PDFs with "bad XRef entry", so the newest bundled build goes first
  // and the older ones are fallbacks for odd files.
  const VERSIONS = ['v2.0.550', 'v1.10.100', 'v1.9.426'];
  let pages = [];
  let data = null;
  let lastErr = null;
  for (const version of VERSIONS) {
    pages = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await pdfParse(buffer, {
        version,
        pagerender: (page) =>
          page.getTextContent({ normalizeWhitespace: true }).then((tc) => {
            let last;
            let text = '';
            for (const item of tc.items) {
              // A change in the y position means a new line.
              text += last && last !== item.transform[5] ? `\n${item.str}` : item.str;
              last = item.transform[5];
            }
            pages.push(text);
            return text;
          }),
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!data) throw lastErr || new Error('unreadable PDF');
  const text = removeRepeatedLines(pages.length ? pages : [data.text || '']);
  const chars = text.replace(/\s+/g, '').length;
  // A scanned PDF has pages but almost no extractable text.
  const ocrNeeded = (data.numpages || pages.length) > 0 && chars < 40 * Math.max(1, data.numpages || pages.length);
  return { format: 'text', content: text, pages: data.numpages || pages.length, ocrNeeded };
}

async function parseWord(buffer) {
  const mammoth = reader('word');
  // HTML keeps headings, lists and tables, which the cleaner turns into structured text.
  const { value } = await mammoth.convertToHtml({ buffer });
  return { format: 'html', content: value || '' };
}

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return v.result instanceof Date ? v.result.toISOString().slice(0, 10) : String(v.result);
    if (v.hyperlink) return String(v.text || v.hyperlink);
  }
  return String(cell.text ?? v);
}

async function parseExcel(buffer) {
  const ExcelJS = reader('excel');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return; // hidden helper sheets
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS_PER_SHEET) return;
      const cells = [];
      for (let c = 1; c <= ws.columnCount; c += 1) cells.push(cellText(row.getCell(c)).trim());
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.some(Boolean)) rows.push(cells);
    });
    if (rows.length) sheets.push({ name: ws.name, rows });
  });
  if (!sheets.length) throw bad('The workbook has no data in its visible sheets.');
  return { format: 'records', content: JSON.stringify({ sheets }) };
}

/** Pick the delimiter that gives the most consistent column count over the first lines. */
function sniffDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length);
    if (counts[0] < 2) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const score = same * 10 + counts[0];
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

function parseCsv(buffer, fileName = 'CSV') {
  const { parse } = reader('csv');
  const text = decodeText(buffer);
  const rows = parse(text, {
    delimiter: sniffDelimiter(text),
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  }).slice(0, MAX_ROWS_PER_SHEET);
  if (rows.length < 2) throw bad('The CSV needs a header row and at least one data row.');
  return { format: 'records', content: JSON.stringify({ sheets: [{ name: String(fileName).replace(/\.[^.]+$/, ''), rows }] }) };
}

function parseText(buffer) {
  const content = basic(decodeText(buffer));
  if (!content) throw bad('The text file is empty.');
  return { format: 'text', content };
}

async function parse(buffer, kind, { fileName } = {}) {
  let out;
  try {
    if (kind === 'pdf') out = await parsePdf(buffer);
    else if (kind === 'word') out = await parseWord(buffer);
    else if (kind === 'excel') out = await parseExcel(buffer);
    else if (kind === 'csv') out = parseCsv(buffer, fileName);
    else if (kind === 'text') out = parseText(buffer);
    else throw bad(`Unknown document kind "${kind}"`);
  } catch (err) {
    if (err.permanent) throw err;
    throw bad(`Could not read this ${KINDS[kind]?.label || ''} file: ${err.message}`.replace(/\s+/g, ' '));
  }
  if (!String(out.content || '').replace(/[\s{}[\]"]/g, '') && !out.ocrNeeded) throw bad('No readable text was found in the file.');
  return out;
}

const kindFromMime = (mime) => Object.keys(KINDS).find((k) => KINDS[k].mime === mime) || 'text';

module.exports = { readersStatus, READERS, detect, parse, sniffDelimiter, decodeText, KINDS, kindFromMime };
