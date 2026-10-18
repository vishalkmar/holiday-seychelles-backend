/**
 * Conversation memory around the orchestrator (MEMORY-DESIGN.md).
 *
 *   runTurn({ visitorId, userId?, sessionId?, message }) →
 *     load or create the session (scoped to this visitor) →
 *     window = last 8 turns after the summary point, trimmed to ~1,500 tokens →
 *     memory text = summary + known trip details + last shown results →
 *     "the second one" resolved against last shown results →
 *     orchestrator.handleTurn → save both messages, slots, lastResults →
 *     summarise when more than 8 turns are not yet summarised (bounded, no PII)
 *
 * Dependencies are injectable (store, orchestrator, llm, now) for tests.
 */

const defaultStore = require('./store');
const slotsLib = require('./slots');
const { mask } = require('./pii');
const { estimateTokens } = require('../llm/tokens');

const WINDOW_TURNS = 8;

/** For a hotel card, the ids hotels.details needs (so "rooms at the second one" works). */
function toolHint(ref) {
  if (!ref?.url || !/^\/hotel-details\?/.test(ref.url)) return '';
  const q = new URLSearchParams(ref.url.split('?')[1]);
  const args = { hotelId: q.get('hotelid'), searchId: q.get('searchId') || undefined, offerId: q.get('offerId') || undefined };
  return ` For its rooms or details call hotels_details with ${JSON.stringify(args)}.`;
}
const WINDOW_TOKENS = 1500;
const SUMMARY_AFTER = 8; // un-summarised turns before a summary is made
const SUMMARY_WORDS = 120;

function todayInSeychelles(now) {
  return new Date(now.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Last N user+assistant pairs, newest kept, within the token budget. */
function windowOf(msgs, { turns = WINDOW_TURNS, tokens = WINDOW_TOKENS } = {}) {
  const pairs = msgs.slice(-turns * 2);
  const out = [];
  let used = 0;
  for (let i = pairs.length - 1; i >= 0; i -= 1) {
    const t = estimateTokens(pairs[i].content) + 4;
    if (used + t > tokens) break;
    out.unshift({ role: pairs[i].role, content: pairs[i].content });
    used += t;
  }
  return out;
}

const SUMMARY_PROMPT = `Update the running summary of a chat between a visitor and the Holidays Seychelles travel assistant.
Keep: travel facts (islands, dates, party size, budget, interests), what was shown or decided, and open questions.
Drop: greetings, small talk, and ANY personal data (names, emails, phone numbers, payment or passport details).
Write at most ${SUMMARY_WORDS} words, plain sentences, in English. Return only the summary.`;

async function summarise({ llm, previous, turns, sessionId }) {
  const transcript = turns.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Visitor'}: ${mask(m.content).slice(0, 800)}`).join('\n');
  const r = await llm.chat({
    purpose: 'summary',
    sessionId,
    temperature: 0,
    maxTokens: 700,
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: `Current summary:\n${previous || '(none)'}\n\nNew turns:\n${transcript}` },
    ],
  });
  // Bounded and masked even if the model ignores the rules.
  const words = mask(r.text || '').split(/\s+/).filter(Boolean);
  return words.slice(0, SUMMARY_WORDS + 20).join(' ');
}

/**
 * input: { visitorId, userId?, sessionId?, message, ipHash?, userAgent?, audience? }
 * → { sessionId, reply, trace, state }
 */
async function runTurn(input, deps = {}) {
  const store = deps.store || defaultStore;
  const orchestrator = deps.orchestrator || require('../orchestrator');
  const llm = deps.llm || require('../llm');
  const now = deps.now ? deps.now() : new Date();
  const today = todayInSeychelles(now);
  if (!input.visitorId) throw Object.assign(new Error('Missing visitor'), { status: 401 });

  let session = input.sessionId ? await store.getSession({ id: input.sessionId, visitorId: input.visitorId, userId: input.userId }) : null;
  const fresh = !session;
  if (!session) session = await store.createSession({ visitorId: input.visitorId, userId: input.userId || null, ipHash: input.ipHash, userAgent: input.userAgent });

  // New session: start from the logged-in customer's saved preferences (opt-in only).
  if (fresh && input.userId) {
    const profile = await store.getProfile(input.userId).catch(() => null);
    if (profile?.consent && profile.prefs) session.slots = { ...(profile.prefs.adults ? { adults: profile.prefs.adults } : {}), ...(profile.prefs.island ? { destination: profile.prefs.island } : {}) };
    if (profile?.consent && profile.prefs?.language) session.language = profile.prefs.language;
  }
  session.slots = slotsLib.expire(session.slots || {}, today, now.getTime());

  const all = await store.messages(session.id, { afterId: session.summaryUpto });
  const history = windowOf(all);
  const ref = slotsLib.resolveReference(input.message, session.slots.lastResults, now.getTime());
  const memoryText = [
    session.summary ? `Summary of the earlier conversation: ${session.summary}` : '',
    slotsLib.describe(session.slots, now.getTime()),
    ref ? `The visitor is referring to result ${ref.n}: ${ref.title}${ref.id ? ` (id ${ref.id})` : ''}.${toolHint(ref)}` : '',
  ].filter(Boolean).join('\n');

  const { lastResults, ...slotsForTurn } = session.slots;
  // "Cheaper ones?" after priced results: search again under the middle price shown.
  const prices = (lastResults?.items || []).map((i) => i.price).filter((p) => p > 0).sort((a, b) => a - b);
  if (prices.length && /\b(cheaper|less expensive|lower price|budget|sast[aei]|kam (daam|price)|moins cher|günstiger|più economic)/i.test(input.message)) {
    slotsForTurn.budget = prices[Math.floor((prices.length - 1) / 2)];
  }
  const turnInput = {
    message: input.message,
    history,
    state: { ...(session.state || {}), slots: slotsForTurn, language: session.language || session.state?.language || 'en' },
    userId: input.userId || null,
    sessionId: session.id,
    audience: input.audience || 'public',
  };
  const orchDeps = { ...(deps.orchestratorDeps || {}), memory: memoryText, reference: ref || undefined, onToken: deps.onToken };

  // Guided flows first (Bot Connection): a running flow, or a trigger. Free
  // questions in the middle of a flow are answered by the AI, then the flow asks again.
  const flows = deps.flows === undefined ? require('../flows') : deps.flows;
  let out = null;
  if (flows) {
    const aiTrace = [];
    const ai = async (q) => {
      const r = await orchestrator.handleTurn({ ...turnInput, message: q, state: { ...turnInput.state, pending: null } }, { ...orchDeps, onToken: undefined });
      aiTrace.push(...(r.trace.llm || []));
      return r.reply;
    };
    const f = await flows.turn({
      text: input.message,
      action: input.action,
      flowState: session.state?.flow,
      slots: slotsForTurn,
      today,
      userId: input.userId || null,
      ai,
      startChips: await flows.greetingChips(orchestrator.START_CHIPS, { signedIn: Boolean(input.userId) }).catch(() => orchestrator.START_CHIPS),
      tools: deps.orchestratorDeps?.tools,
    });
    if (f) {
      const v = f.vars || {};
      out = {
        reply: f.reply,
        state: {
          slots: {
            ...slotsForTurn,
            ...(v.island ? { destination: v.islandLabel || v.island } : {}),
            ...(v.checkIn ? { checkIn: v.checkIn } : {}),
            ...(v.checkOut ? { checkOut: v.checkOut } : {}),
            ...(v.pax?.adults ? { adults: v.pax.adults, childAges: v.pax.childAges || [] } : {}),
          },
          product: session.state?.product || null,
          language: turnInput.state.language,
          flow: f.flowState,
        },
        trace: { route: 'flow', flow: f.trace, llm: aiTrace, tools: [], steps: [] },
      };
    }
  }
  if (!out) {
    const s = deps.settings || (await require('../settings').getEffective().catch(() => ({})));
    if (s.aiFreeText === false) {
      // Flows only (Phase 20 flag): the menu and the team instead of an AI answer.
      const chips = await (flows ? flows.greetingChips(orchestrator.START_CHIPS, { signedIn: Boolean(input.userId) }).catch(() => orchestrator.START_CHIPS) : orchestrator.START_CHIPS);
      out = {
        reply: { text: 'I can help with the options below. For anything else, our team is happy to help — +248 437 6666 or info@holidays-seychelles.com.', cards: [], chips: [...chips, { label: 'Contact our team', action: { type: 'handoff', url: '/dashboard?tab=queries' } }], sources: [], followUps: [] },
        state: { slots: slotsForTurn, product: session.state?.product || null, language: turnInput.state.language, flow: session.state?.flow || null },
        trace: { route: 'flows_only', llm: [], tools: [], steps: ['AI free text is off (AI Settings)'] },
      };
    } else out = await orchestrator.handleTurn(turnInput, orchDeps);
  }

  const tokensIn = (out.trace.llm || []).reduce((n, c) => n + (c.tokensIn || 0), 0);
  const tokensOut = (out.trace.llm || []).reduce((n, c) => n + (c.tokensOut || 0), 0);
  await store.addMessage({ sessionId: session.id, role: 'user', content: input.message });
  const messageId = await store.addMessage({ sessionId: session.id, role: 'assistant', content: out.reply.text, reply: out.reply, route: out.trace.route, tokens: tokensIn + tokensOut });

  const shown = slotsLib.resultsFrom(out.reply, now);
  session.slots = slotsLib.clean({ ...(out.state.slots || {}), ...(shown ? { lastResults: shown } : lastResults ? { lastResults } : {}) }, today);
  session.state = { product: out.state.product || null, pending: out.state.pending || null, flow: out.state.flow || null };
  session.language = out.state.language || session.language;
  if (input.userId && !session.userId) session.userId = input.userId;

  // Rolling summary when the un-summarised part grows past 8 turns.
  let summarised = false;
  const unsummarised = all.length + 2;
  if (unsummarised > SUMMARY_AFTER * 2) {
    const keep = WINDOW_TURNS; // keep the last few verbatim (not summarised yet)
    const fold = [...all, { role: 'user', content: input.message }, { role: 'assistant', content: out.reply.text }].slice(0, -keep);
    if (fold.length) {
      try {
        session.summary = await summarise({ llm, previous: session.summary, turns: fold, sessionId: session.id });
        const after = await store.messages(session.id, { afterId: session.summaryUpto });
        session.summaryUpto = after[after.length - 1 - keep]?.id || session.summaryUpto;
        summarised = true;
      } catch (err) {
        out.trace.steps = [...(out.trace.steps || []), `summary failed: ${err.code || err.message}`];
      }
    }
  }
  await store.saveSession(session, { tokensIn, tokensOut, turnAdded: true });

  // Opt-in preferences for logged-in customers: only coarse, non-personal facts.
  if (input.userId) {
    const profile = await store.getProfile(input.userId).catch(() => null);
    if (profile?.consent) {
      const prefs = { ...profile.prefs };
      if (session.slots.island) prefs.island = session.slots.island;
      if (session.slots.adults) prefs.adults = session.slots.adults;
      if (session.language) prefs.language = session.language;
      await store.savePrefs(input.userId, prefs).catch(() => {});
    }
  }

  return {
    sessionId: session.id,
    messageId,
    reply: out.reply,
    trace: { ...out.trace, memory: { turnsInWindow: history.length / 2, summarised, summaryChars: session.summary.length, reference: ref ? ref.n : null } },
    state: { slots: session.slots, product: session.state.product, language: session.language },
  };
}

module.exports = { runTurn, windowOf, summarise, WINDOW_TURNS, SUMMARY_AFTER };
