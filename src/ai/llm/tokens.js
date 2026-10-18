/**
 * Fast token estimate for budgeting prompts (MEMORY-DESIGN.md §2).
 *
 * Not exact — real counts come back in each API response and are what gets
 * logged. About 4 characters per token for English, with a floor per word so
 * short, punctuation-heavy text is not under-counted.
 */

function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const byChars = Math.ceil(s.length / 4);
  const byWords = Math.ceil((s.match(/\S+/g) || []).length * 1.3);
  return Math.max(byChars, byWords);
}

function estimateMessages(messages = []) {
  // ~4 tokens of overhead per message for role and separators.
  return messages.reduce((n, m) => n + 4 + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 2);
}

/** Cut text to roughly `maxTokens`, on a word boundary. */
function trimToTokens(text, maxTokens) {
  const s = String(text || '');
  if (estimateTokens(s) <= maxTokens) return s;
  const cut = s.slice(0, Math.max(0, maxTokens * 4));
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > 0 ? cut.slice(0, lastSpace) : cut}…`;
}

module.exports = { estimateTokens, estimateMessages, trimToTokens };
