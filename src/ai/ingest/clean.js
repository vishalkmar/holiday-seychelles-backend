/**
 * Text cleaning before chunking (DESIGN.md §3.3). Pure functions.
 *
 * Keeps what carries meaning — headings, list markers, table rows (lines with
 * | or tabs) — and removes what only adds noise: zero-width characters, stray
 * whitespace, page headers/footers repeated on every page, and words broken
 * across lines by hyphenation.
 */

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

function basic(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    // "exam-\nple" → "example" (only lowercase continuations, so "Mahé -\nPraslin" lists survive)
    .replace(/([a-z])-\n([a-z])/g, '$1$2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove lines that repeat on many pages (headers, footers, "Page 3 of 9").
 * pages: string[] (e.g. a PDF split on form feeds). Returns the joined text.
 */
function removeRepeatedLines(pages, { minPages = 3, share = 0.5, edge = 3 } = {}) {
  const list = pages.map((p) => basic(p));
  if (list.length < minPages) return list.join('\n\n');
  // Numbers are ignored so "Page 3 of 9" matches "Page 4 of 9" — which is why
  // only the first and last few lines of a page are considered: in the body,
  // lines that differ only by a number are real content (rates, room lists).
  const key = (l) => l.trim().toLowerCase().replace(/\d+/g, '#');
  const edges = (page) => {
    const lines = page.split('\n').filter((l) => l.trim());
    return new Set([...lines.slice(0, edge), ...lines.slice(-edge)]);
  };
  const counts = new Map();
  for (const page of list) {
    const seen = new Set();
    for (const line of edges(page)) {
      const k = key(line);
      if (k.length < 3 || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const limit = Math.max(minPages, Math.ceil(list.length * share));
  const drop = new Set([...counts].filter(([, n]) => n >= limit).map(([k]) => k));
  return list
    .map((page) => {
      const edge = edges(page);
      return page.split('\n').filter((l) => !(edge.has(l) && drop.has(key(l)))).join('\n');
    })
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text from HTML-ish content (rich-text editors): keep paragraph breaks and list items. */
function fromHtml(html) {
  return withoutTrailingPipes(basic(
    String(html || '')
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
      // Table cells (Word tables): "Cell | Cell" on one line per row. Word wraps
      // each cell's text in <p>, so flatten a cell's inner blocks to spaces first.
      .replace(/<\s*(td|th)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_, __, inner) =>
        `${inner.replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()} | `)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/(p|div|h[1-6]|li|tr|table|section)\s*>/gi, '\n')
      .replace(/<\s*h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
      .replace(/<\s*li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  ));
}

function withoutTrailingPipes(text) {
  return text.replace(/[ \t]*\|[ \t]*$/gm, '');
}

module.exports = { basic, removeRepeatedLines, fromHtml };
