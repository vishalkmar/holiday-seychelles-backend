/**
 * The visitor's path (flows first, then the assistant, with memory) run
 * against an in-memory store, for the playground and the test suite (Phase 19):
 * nothing is written to chat_sessions / chat_messages, so admin tests never
 * show up as visitor conversations or analytics. The prompt can be the draft,
 * the published one or an older version.
 */

const crypto = require('crypto');
const memory = require('../memory');
const promptStore = require('../prompt/store');

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** A chat_sessions/chat_messages stand-in with the store's interface. */
function memStore() {
  const sessions = new Map();
  const msgs = new Map();
  let nextId = 1;
  const copy = (s) => s && JSON.parse(JSON.stringify(s));
  return {
    async createSession({ visitorId, userId = null }) {
      const s = { id: crypto.randomUUID(), visitorId, userId, language: null, slots: {}, state: {}, summary: '', summaryUpto: 0, turns: 0, status: 'open' };
      sessions.set(s.id, s);
      msgs.set(s.id, []);
      return copy(s);
    },
    async getSession({ id, visitorId }) {
      const s = sessions.get(id);
      return s && s.visitorId === visitorId ? copy(s) : null;
    },
    async saveSession(s, { turnAdded = false } = {}) {
      const prev = sessions.get(s.id) || {};
      sessions.set(s.id, { ...copy(s), turns: (prev.turns || 0) + (turnAdded ? 1 : 0) });
    },
    async addMessage({ sessionId, role, content, reply = null, route = null }) {
      const id = nextId++;
      (msgs.get(sessionId) || msgs.set(sessionId, []).get(sessionId)).push({ id, role, content: String(content), reply, route });
      return id;
    },
    async messages(sessionId, { afterId = 0 } = {}) {
      return (msgs.get(sessionId) || []).filter((m) => m.id > afterId).map((m) => ({ ...m }));
    },
    async getProfile() { return null; },
    async savePrefs() {},
  };
}

/** 'draft' | 'published' | 'v3' (a version) → L2 text and a label. */
async function businessFor(ref = 'published') {
  if (ref === 'draft') {
    const d = await promptStore.draft();
    if (!d) throw bad('There is no draft prompt — the published one is used. Choose "Published" or save a draft first.');
    return { business: d.content, label: 'draft', version: null };
  }
  if (!ref || ref === 'published') {
    const p = await promptStore.published();
    return { business: p.content, label: 'published', version: p.version };
  }
  const v = await promptStore.byRef(String(ref).replace(/^v/i, ''));
  if (!v) throw bad(`Prompt ${ref} not found`, 404);
  return { business: v.content, label: `v${v.version}`, version: v.version };
}

/** One sandbox conversation: keeps its own store, visitor and session between turns. */
function createSandbox({ promptRef = 'published', userId = null } = {}) {
  const store = memStore();
  const visitorId = crypto.randomUUID();
  let sessionId = null;
  let resolved = null;
  return {
    promptRef,
    async turn(message, { action } = {}) {
      resolved = resolved || (await businessFor(promptRef));
      const out = await memory.runTurn({ visitorId, userId, sessionId, message: String(message || '').slice(0, 2000), action, audience: 'admin' }, { store, orchestratorDeps: { business: resolved.business } });
      sessionId = out.sessionId;
      return { ...out, prompt: { label: resolved.label, version: resolved.version } };
    },
  };
}

// Playground conversations live in memory for an hour after their last turn.
const live = new Map();
const TTL = 60 * 60 * 1000;
function sandboxFor(key, opts) {
  const now = Date.now();
  for (const [k, v] of live) if (now - v.at > TTL) live.delete(k);
  let e = live.get(key);
  if (!e || opts.reset || e.box.promptRef !== (opts.promptRef || 'published')) {
    e = { box: createSandbox(opts), at: now };
    live.set(key, e);
  }
  e.at = now;
  return e.box;
}

module.exports = { memStore, createSandbox, sandboxFor, businessFor };
