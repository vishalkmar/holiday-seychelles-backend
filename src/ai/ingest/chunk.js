/**
 * Chunking strategies (DESIGN.md §3.3). Pure functions: text in, chunks out.
 *
 *   headings(text, opts)   — markdown / documents: split on headings, keep the
 *                            heading path on every chunk ("Praslin › Getting there")
 *   paragraphs(text, opts) — plain text: pack paragraphs up to the target size
 *   records(rows, opts)    — spreadsheets / CSV: groups of rows, each row as
 *                            "Header: value; Header: value", sheet name as context
 *
 * Every strategy packs pieces up to `targetTokens` and carries `overlapPct` of
 * the previous chunk's tail into the next, so a fact split across a boundary is
 * still found. A piece longer than the target is split on sentences, then words.
 *
 * Chunk shape: { text, tokens, heading?, index }
 */

const { estimateTokens } = require('../llm/tokens');

const DEFAULTS = { targetTokens: 500, overlapPct: 15, maxChunks: 2000 };

function sentences(text) {
  const parts = String(text).match(/[^.!?\n]+(?:[.!?]+["')\]]*\s*|\n+|$)/g) || [text];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Split one over-long piece into pieces that fit. */
function splitLong(piece, target) {
  if (estimateTokens(piece) <= target) return [piece];
  const out = [];
  let cur = '';
  for (const s of sentences(piece)) {
    if (estimateTokens(s) > target) {
      // A single huge "sentence" (e.g. a table row run): cut on words.
      const words = s.split(/\s+/);
      let w = '';
      for (const word of words) {
        if (estimateTokens(`${w} ${word}`) > target && w) {
          out.push(w.trim());
          w = '';
        }
        w += ` ${word}`;
      }
      if (w.trim()) out.push(w.trim());
      continue;
    }
    if (cur && estimateTokens(`${cur} ${s}`) > target) {
      out.push(cur.trim());
      cur = '';
    }
    cur += ` ${s}`;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The last ~overlap tokens of a chunk, cut on a sentence boundary when possible. */
function tail(text, overlapTokens) {
  if (overlapTokens <= 0) return '';
  const ss = sentences(text);
  let out = '';
  for (let i = ss.length - 1; i >= 0; i -= 1) {
    const next = `${ss[i]} ${out}`.trim();
    if (estimateTokens(next) > overlapTokens) break;
    out = next;
  }
  return out;
}

/** Pack pieces into chunks of about `target` tokens with overlap; `prefix` heads every chunk. */
function pack(pieces, { targetTokens, overlapPct, prefix = '', sep = '\n\n' }) {
  const target = Math.max(50, targetTokens - estimateTokens(prefix));
  const overlap = Math.floor((targetTokens * overlapPct) / 100);
  const chunks = [];
  let body = '';
  const flush = () => {
    if (!body.trim()) return;
    const text = prefix ? `${prefix}\n${body.trim()}` : body.trim();
    chunks.push(text);
    const carry = tail(body, overlap);
    body = carry ? `${carry}${sep}` : '';
  };
  for (const raw of pieces.flatMap((p) => splitLong(p, target))) {
    if (body.trim() && estimateTokens(`${body}${raw}`) > target) flush();
    body += `${raw}${sep}`;
  }
  // Last chunk: drop it if it is only the carried-over overlap.
  const lastCarryOnly = chunks.length && body.trim() && chunks[chunks.length - 1].endsWith(body.trim());
  if (body.trim() && !lastCarryOnly) {
    chunks.push(prefix ? `${prefix}\n${body.trim()}` : body.trim());
  }
  return chunks;
}

function finish(list, maxChunks) {
  return list.slice(0, maxChunks).map((c, index) => ({ ...c, index, tokens: estimateTokens(c.text) }));
}

function paragraphs(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return finish(pack(paras, o).map((t) => ({ text: t })), o.maxChunks);
}

const HEADING_MD = /^(#{1,6})\s+(.+?)\s*#*$/;

/** A plain-text line that looks like a heading: short, no final period, Title or UPPER case. */
function looksLikeHeading(line, next) {
  const l = line.trim();
  if (!l || l.length > 80 || /[.:;,!?]$/.test(l) || /^[-*•\d]/.test(l)) return false;
  const words = l.split(/\s+/);
  if (words.length > 10) return false;
  const upper = l === l.toUpperCase() && /[A-Z]/.test(l);
  const title = words.filter((w) => /^[A-Z]/.test(w)).length >= Math.ceil(words.length * 0.6);
  return (upper || title) && Boolean(next && next.trim());
}

function headings(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const lines = String(text).split('\n');
  const sections = [];
  const path = [];
  let cur = { path: [], lines: [] };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const md = line.match(HEADING_MD);
    const isPlain = !md && looksLikeHeading(line, lines[i + 1]) && (i === 0 || !lines[i - 1].trim());
    if (md || isPlain) {
      if (cur.lines.join('').trim()) sections.push(cur);
      const level = md ? md[1].length : Math.min(path.length + 1, 3);
      const title = (md ? md[2] : line).trim();
      path.length = Math.max(0, level - 1);
      path[level - 1] = title;
      cur = { path: path.filter(Boolean).slice(), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.lines.join('').trim()) sections.push(cur);
  if (!sections.length) return paragraphs(text, o);

  // Merge small neighbouring sections under the same top heading so we don't
  // emit dozens of 20-token chunks; keep each one's heading inline.
  // mergeSmall:false keeps one chunk per section — for structured profiles
  // (destinations), where each section answers a different question.
  const out = [];
  for (const sec of sections) {
    const heading = sec.path.join(' › ');
    const body = sec.lines.join('\n').trim();
    const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const prev = out[out.length - 1];
    const small = estimateTokens(body) < o.targetTokens * 0.35;
    if (o.mergeSmall !== false && prev && small && prev.top === sec.path[0] && estimateTokens(prev.text) + estimateTokens(body) < o.targetTokens) {
      prev.text += `\n\n${sec.path[sec.path.length - 1] || ''}\n${body}`.replace(/\n{3,}/g, '\n\n');
      continue;
    }
    for (const t of pack(paras, { ...o, prefix: heading })) out.push({ text: t, heading, top: sec.path[0] });
  }
  return finish(out.map(({ text, heading }) => ({ text, heading })), o.maxChunks);
}

/**
 * rows: array of objects ({ Header: value }) or arrays (first row = header).
 * opts.context: e.g. "Rates sheet" — prefixed to every chunk. opts.rowsPerChunk caps group size.
 */
function records(rows, opts = {}) {
  const o = { ...DEFAULTS, rowsPerChunk: 20, ...opts };
  let objs = rows;
  if (Array.isArray(rows[0])) {
    const [header, ...rest] = rows;
    const names = header.map((h, i) => String(h ?? '').trim() || `Column ${i + 1}`);
    objs = rest.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
  }
  const lines = objs
    .map((r) =>
      Object.entries(r)
        .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
        .map(([k, v]) => `${k}: ${String(v).trim()}`)
        .join('; ')
    )
    .filter(Boolean);
  const chunks = [];
  const prefix = o.context ? String(o.context) : '';
  for (let i = 0; i < lines.length; i += o.rowsPerChunk) {
    const group = lines.slice(i, i + o.rowsPerChunk);
    // Rows are atomic facts: pack without overlap, never split a row mid-way unless huge.
    for (const t of pack(group, { ...o, overlapPct: 0, prefix, sep: '\n' })) chunks.push({ text: t, heading: prefix || undefined });
  }
  return finish(chunks, o.maxChunks);
}

/**
 * An approved FAQ: one chunk for the question and one per variation, each
 * carrying the full answer, so any phrasing a visitor uses lands on the same
 * answer. (The retriever collapses chunks of the same source.) A very long
 * answer is split, with the question repeated on every part.
 */
function faq({ question, answer, variations = [] }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  const asked = [question, ...variations].map((q) => String(q || '').trim()).filter(Boolean);
  asked.forEach((q, i) => {
    const prefix = `Q: ${q}`;
    const parts = estimateTokens(`${prefix}\nA: ${answer}`) <= o.targetTokens ? [`A: ${answer}`] : pack(String(answer).split(/\n\s*\n/), { ...o, overlapPct: 0 }).map((t) => `A: ${t}`);
    parts.forEach((p) => out.push({ text: `${prefix}\n${p}`, heading: i === 0 ? question : `${question} (as: ${q})` }));
  });
  return finish(out, o.maxChunks);
}

/** Pick the strategy for a stored content format. */
function chunkContent({ format, content }, opts = {}) {
  if (format === 'faq') return faq(typeof content === 'string' ? JSON.parse(content) : content, opts);
  if (format === 'records') {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    // { sheets: [{ name, rows }] } or a plain rows array
    const sheets = Array.isArray(parsed) ? [{ name: opts.context || '', rows: parsed }] : parsed.sheets || [];
    let all = [];
    for (const sh of sheets) {
      const ctx = [opts.context, sh.name].filter(Boolean).join(' › ');
      all = all.concat(records(sh.rows || [], { ...opts, context: ctx }));
    }
    return finish(all.map(({ text, heading }) => ({ text, heading })), opts.maxChunks || DEFAULTS.maxChunks);
  }
  if (format === 'markdown') return headings(content, opts);
  return /^(#{1,6})\s/m.test(content) ? headings(content, opts) : paragraphs(content, opts);
}

module.exports = { paragraphs, headings, records, faq, chunkContent, sentences, DEFAULTS };
