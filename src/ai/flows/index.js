/**
 * Flows in a chat turn (Phase 16): continue the running flow, or start one
 * from a trigger, or return null so the AI orchestrator answers.
 *
 * Triggers (no model call needed):
 *   - a chip/action naming the flow: { type: 'flow', flow: 'hotels' }
 *   - chip label equal to one of triggers.chips ("Hotels")
 *   - keywords in a request ("find a hotel on Praslin 10–13 Nov for 2") — not
 *     in a plain question ("which hotel has the best beach?"), which the AI answers
 *
 * Starting a flow pre-fills its variables from memory and from this message
 * (island, dates, guests), so nodes that are already answered are skipped.
 */

const store = require('./store');
const engine = require('./engine');
const { prepass } = require('../orchestrator/rules');
const { islandSlug } = require('../memory/slots');
const { links } = require('../tools/catalog/site');

const QUESTION = /\?\s*$|^(what|which|how|is|are|can|do|does|where|when|why|tell me)\b/i;
const REQUEST = /\b(find|search|book|show|looking for|need|want|get me|check)\b/i;

/** Where the first of these keywords appears in the text (-1 = none). */
function firstHit(text, keywords = []) {
  const t = ` ${String(text).toLowerCase()} `;
  let best = -1;
  for (const k of keywords) {
    const m = new RegExp(`\\b${String(k).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).exec(t);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  return best;
}

/** Which published flow, if any, this input starts. */
async function match({ text, action }) {
  const flows = await store.published();
  if (!flows.length) return null;
  if (action?.type === 'flow' && action.flow) return flows.find((f) => f.key === action.flow) || null;
  const label = String(action?.label || text || '').trim().toLowerCase();
  const byChip = flows.find((f) => (f.graph.triggers?.chips || []).some((c) => c.toLowerCase() === label));
  if (byChip) return byChip;
  if (!text || (QUESTION.test(text) && !REQUEST.test(text))) return null;
  // The flow whose keyword comes first wins: "book a taxi to my hotel" is a transfer.
  let best = null;
  for (const f of flows) {
    const at = firstHit(text, f.graph.triggers?.keywords);
    if (at >= 0 && (!best || at < best.at)) best = { f, at };
  }
  return best ? best.f : null;
}

/** What this message already tells us (no model): island, dates, guests. */
function varsFromText(text, today) {
  const v = {};
  const r = prepass(text || '', { today });
  if (r.dates[0]) { v.checkIn = r.dates[0]; v.date = r.dates[0]; }
  if (r.dates[1]) v.checkOut = r.dates[1];
  if (r.dates[0] && !r.dates[1] && r.guests.nights) {
    v.checkOut = new Date(Date.parse(`${r.dates[0]}T00:00:00Z`) + r.guests.nights * 86400000).toISOString().slice(0, 10);
  }
  if (r.guests.adults) v.pax = { adults: r.guests.adults, childAges: r.guests.childAges || [] };
  const island = String(text || '').match(/\b(mah[eé]|praslin|la ?digue|silhouette|curieuse|bird island|denis|fr[eé]gate)\b/i);
  if (island) v.island = islandSlug(island[1]) || island[1];
  return v;
}

/**
 * → null (not a flow turn) or { reply, flowState, vars, trace }
 * ctx: { text, action, flowState, slots, today, userId, ai(text, opts), knowledge(q), startChips }
 */
/** "Talk to us": a row in the website's Queries module (+ its first message). Returns the id. */
async function createQuery(q, userId) {
  const { db } = require('../ports');
  const email = String(q.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is needed');
  const message = String(q.message || '').trim().slice(0, 4000);
  if (!message) throw new Error('The message is empty');
  const r = await db.query(
    `INSERT INTO queries (user_id, name, email, mobile, subject, category, message, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'chat_assistant')`,
    [userId || null, String(q.name || 'Website visitor').slice(0, 150), email.slice(0, 190), q.mobile ? String(q.mobile).slice(0, 30) : null, String(q.subject).slice(0, 255), q.category || 'general', message]
  );
  const id = Number(r.insertId);
  await db.query("INSERT INTO query_messages (query_id, sender_type, sender_user_id, message) VALUES ($1, 'user', $2, $3)", [id, userId || null, message]).catch(() => {});
  return id;
}

/** The signed-in customer's name and email, to pre-fill forms. */
async function userVars(userId) {
  if (!userId) return {};
  try {
    const { db } = require('../ports');
    const { rows } = await db.query('SELECT first_middle_name, last_name, email FROM users WHERE id = $1', [userId]);
    const u = rows[0];
    if (!u) return {};
    const name = [u.first_middle_name, u.last_name].filter(Boolean).join(' ').trim();
    return { user: { id: userId, name, firstName: String(u.first_middle_name || '').split(' ')[0] }, ...(name ? { name } : {}), ...(u.email ? { email: u.email } : {}) };
  } catch {
    return { user: { id: userId } };
  }
}

async function turn(ctx) {
  const deps = {
    createQuery: (q) => createQuery(q, ctx.userId),
    tools: ctx.tools || require('../tools'),
    ai: ctx.ai,
    knowledge: ctx.knowledge || ctx.ai,
    loadFlow: async (key) => (await store.published()).find((f) => f.key === key) || null,
    startChips: ctx.startChips,
    today: ctx.today,
    userId: ctx.userId,
    links,
  };
  let running = ctx.flowState;
  let flow = null;
  if (running?.key) {
    flow = await store.version(running.key, running.version);
    if (!flow) running = null; // deleted flow: drop it
  }
  // A new trigger while a flow waits ("Transfers" chip in the middle of hotels) starts the new flow.
  const fresh = await match({ text: ctx.text, action: ctx.action }).catch(() => null);
  if (fresh && (!running || fresh.key !== running.key) && (ctx.action?.type === 'flow' || !running?.waiting || ctx.action?.type === 'message')) {
    flow = fresh;
    running = null;
  }
  if (!flow) return null;

  const state = running || {
    key: flow.key,
    version: flow.version,
    nodeId: flow.graph.entry,
    waiting: false,
    vars: { ...engine.prefillVars(ctx.slots), ...varsFromText(ctx.text, ctx.today), ...(await userVars(ctx.userId)), today: ctx.today },
  };
  const input = running ? { text: ctx.text, action: ctx.action } : {};
  const r = await engine.run({ graph: flow.graph, state, input, deps });
  return { reply: r.reply, flowState: r.state, vars: r.state?.vars || state.vars, done: r.done, trace: { ...r.trace, started: !running } };
}

/**
 * Entry chips from published flows marked "show in greeting" (triggers.greeting:
 * { show, label, emoji, order }); falls back to `fallback` when none are.
 */
async function greetingChips(fallback = [], { signedIn = false } = {}) {
  const flows = await store.published().catch(() => []);
  const chips = flows
    .filter((f) => f.graph.triggers?.greeting?.show && (!f.graph.triggers.greeting.signedInOnly || signedIn))
    .sort((a, b) => (a.graph.triggers.greeting.order ?? 99) - (b.graph.triggers.greeting.order ?? 99))
    .map((f) => {
      const g = f.graph.triggers.greeting;
      const label = g.label || f.graph.triggers.chips?.[0] || f.graph.name;
      return { label: `${g.emoji ? `${g.emoji} ` : ''}${label}`, action: { type: 'flow', flow: f.key, label } };
    });
  // Flows in the greeting replace the built-in chips entirely.
  return chips.length ? chips : fallback;
}

module.exports = { turn, match, varsFromText, greetingChips, createQuery, userVars };
