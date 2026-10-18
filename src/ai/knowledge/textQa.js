/**
 * Questions and answers from a plain text file, for the bulk import:
 *
 *   == Islands ==                      a category for the questions below
 *   Q: Which is the largest island?    (also "Question:", "1. Q:", "Sawal:")
 *   A: Mahé is the largest island…     (also "Answer:", "Jawab:"; may run over several lines)
 *   Also asked: Biggest island? | …    (also "Variations:")
 *
 * Headings may also be "# Islands", "[Islands]" or an upper-case line between
 * "====" rules ("ISLANDS (25)"). A file without Q:/A: labels works too: each
 * block separated by a blank line whose first line ends with "?" is a question
 * and the rest of the block its answer.
 *
 * → rows: [[question, answer, variations, category], …]
 */

const Q = /^\s*(?:\d+[.)]\s*)?(?:q|question|sawal|sawaal|prashn)\s*[:.)-]\s*/i;
const A = /^\s*(?:a|answer|jawab|jawaab|uttar)\s*[:.)-]\s*/i;
const V = /^\s*(?:also asked|variations?|other ways?|similar)\s*:\s*/i;
const RULE = /^\s*[=\-_*#~]{4,}\s*$/;

function heading(line, prev, next) {
  let m = line.match(/^\s*={2,}\s*(.+?)\s*={2,}\s*$/) || line.match(/^\s*#{1,3}\s+(.+?)\s*#*\s*$/) || line.match(/^\s*\[(.+)\]\s*$/);
  if (m) return m[1];
  // "OVERVIEW (25)" between two rules
  if (RULE.test(prev || '') && RULE.test(next || '') && /[A-Z]/.test(line) && line === line.toUpperCase()) {
    return line.replace(/\(\d+\)\s*$/, '').trim();
  }
  return null;
}

const tidyCategory = (c) => {
  const s = String(c).trim();
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s&/-])\p{L}/gu, (x) => x.toUpperCase()) : s;
};

function parseLabelled(lines) {
  const rows = [];
  let category = '';
  let cur = null;
  let field = null;
  const push = () => {
    if (cur && (cur.q.trim() || cur.a.trim())) rows.push([cur.q.trim(), cur.a.trim(), cur.v.join(' | '), cur.c]);
    cur = null;
    field = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (RULE.test(line)) continue;
    const h = heading(line, lines[i - 1], lines[i + 1]);
    if (h) { push(); category = tidyCategory(h); continue; }
    if (Q.test(line)) { push(); cur = { q: line.replace(Q, ''), a: '', v: [], c: category }; field = 'q'; continue; }
    if (!cur) continue;
    if (A.test(line)) { cur.a = line.replace(A, ''); field = 'a'; continue; }
    if (V.test(line)) { cur.v.push(...line.replace(V, '').split('|').map((x) => x.trim()).filter(Boolean)); field = 'v'; continue; }
    if (!line.trim()) { if (field === 'a' || field === 'v') field = 'gap'; continue; }
    if (field === 'q') cur.q += ` ${line.trim()}`;
    else if (field === 'a') cur.a += ` ${line.trim()}`;
    else if (field === 'gap' && cur.a) push(); // text after the block that isn't a new question
  }
  push();
  return rows;
}

function parseBlocks(text) {
  const rows = [];
  let category = '';
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l && !RULE.test(l));
    if (!lines.length) continue;
    const h = lines.length === 1 && heading(lines[0], '====', '====');
    if (h && !/\?\s*$/.test(lines[0])) { category = tidyCategory(h); continue; }
    if (!/\?\s*$/.test(lines[0]) || lines.length < 2) continue;
    rows.push([lines[0].replace(/^\d+[.)]\s*/, ''), lines.slice(1).join(' '), '', category]);
  }
  return rows;
}

function parseTextQa(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n');
  const labelled = lines.some((l) => Q.test(l)) && lines.some((l) => A.test(l));
  return labelled ? parseLabelled(lines) : parseBlocks(clean);
}

module.exports = { parseTextQa };
