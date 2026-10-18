/**
 * L3 manifest (DESIGN.md §3.7): a short, generated description of what the
 * assistant can draw on — published knowledge by kind, and the live tools that
 * are on. Never document contents: those are retrieved per question (L4).
 * Rebuilt at most once a minute, and at once after a publish (invalidate()).
 */

const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const tools = require('../tools');

const TTL_MS = 60 * 1000;
let cached = null;

const KIND = {
  destination: 'island and place guides',
  faq: 'approved answers to common questions',
  document: 'company documents',
  manual: 'notes written by the team',
  sample: 'test knowledge',
};

/** Pure: rows + tool list → { text, knowledge[], tools[] } */
function compose({ sourceRows = [], destinationTitles = [], toolList = [] }) {
  const knowledge = sourceRows
    .filter((r) => r.type !== 'sample' && Number(r.n) > 0)
    .map((r) => `${KIND[r.type] || r.type} (${r.n})`);
  const places = destinationTitles.length ? `Places covered: ${destinationTitles.slice(0, 30).join(', ')}${destinationTitles.length > 30 ? ', …' : ''}.` : '';
  const live = toolList.filter((t) => t.enabled).map((t) => `${t.title}${t.permission === 'user' ? ' (signed-in visitors only)' : ''}`);
  const text = [
    knowledge.length ? `Knowledge: ${knowledge.join('; ')}.` : 'Knowledge: none published yet.',
    places,
    live.length ? `Live tools: ${live.join('; ')}.` : 'Live tools: none switched on.',
  ].filter(Boolean).join('\n');
  return { text, knowledge, tools: live };
}

async function build() {
  await ensureAiTables();
  const { rows: sourceRows } = await db.query("SELECT type, COUNT(*) AS n FROM rag_sources WHERE status = 'published' GROUP BY type ORDER BY type");
  const { rows: dest } = await db.query("SELECT title FROM rag_sources WHERE status = 'published' AND type = 'destination' ORDER BY title");
  const toolList = await tools.list().catch(() => []);
  return { ...compose({ sourceRows, destinationTitles: dest.map((d) => d.title.replace(/\s*\(.*\)$/, '')), toolList }), generatedAt: new Date() };
}

async function get({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = await build();
  cached = { at: Date.now(), value };
  return value;
}

function invalidate() {
  cached = null;
}

module.exports = { get, invalidate, compose };
