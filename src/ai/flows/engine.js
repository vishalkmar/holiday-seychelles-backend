/**
 * Flow engine (BOT-CONNECTION.md §2 "Runtime").
 *
 *   run({ graph, state, input, deps }) → { reply, state, done, trace }
 *
 * state: { key, version, nodeId, waiting, vars }   (kept in the chat session)
 * input: { text } or { action } — actions from the widget:
 *   { type: 'choice', node, value, label }  { type: 'dates', node, from, to }
 *   { type: 'date', node, date }            { type: 'guests', node, adults, childAges }
 *
 * Runs nodes until one needs the visitor (choice, input, date, guests) or the
 * flow ends, at most 25 steps per turn. A pending node with free text that
 * doesn't answer it is a side question: the AI answers, then the node is asked
 * again. Prices only ever come from tool results (cards are built from them).
 *
 * deps: { tools, ai(text, opts), knowledge(query), loadFlow(key), startChips,
 *         today, userId, links }
 */

const { resolve, resolveValue, evaluate } = require('./template');
const { portsOf } = require('./schema');
const { findDates, findGuests } = require('../orchestrator/rules');
const { cardsFrom } = require('../orchestrator/cards');

const MAX_STEPS = 25;

const HANDOFF_CHIP = { label: 'Contact our team', action: { type: 'handoff', url: '/dashboard?tab=queries' } };

function nextOf(graph, nodeId, port) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const p = port || (node ? portsOf(node)[0] : undefined);
  const e = graph.edges.find((x) => x.from === nodeId && (x.port || portsOf(node)[0]) === p);
  return e ? e.to : null;
}

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[-_]+/g, ' ').toLowerCase().trim();

/** Choice options: static, or from a tool ({ source:'tool', tool, input, map:{label,value}, limit }). */
async function optionsFor(node, vars, deps) {
  const d = node.data || {};
  if (Array.isArray(d.options)) return d.options.map((o) => ({ label: resolve(o.label, vars), value: String(o.value) }));
  if (d.options?.source === 'tool') {
    const r = await deps.tools.run(d.options.tool, resolveValue(d.options.input || {}, vars), { audience: 'public', userId: deps.userId });
    const items = r.ok ? r.data.items || [] : [];
    const map = d.options.map || { label: 'name', value: 'id' };
    return items.slice(0, d.options.limit || 12).map((it) => ({ label: String(it[map.label] ?? ''), value: String(it[map.value] ?? ''), item: it })).filter((o) => o.label && o.value);
  }
  return [];
}

function matchOption(options, text) {
  const t = norm(text).replace(/[.!?]+$/, '');
  if (!t) return null;
  const exact = options.find((o) => norm(o.value) === t || norm(o.label) === t);
  if (exact) return exact;
  const partial = options.find((o) => t.length >= 3 && (norm(o.label).includes(t) || t.includes(norm(o.label))));
  if (partial) return partial;
  // "the international airport" → "SEYCHELLES INTERNATIONAL AIRPORT": every meaningful word appears.
  const words = t.split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
  return words.length ? options.find((o) => words.every((w) => norm(o.label).includes(w))) || null : null;
}
const STOP = new Set(['the', 'and', 'for', 'from', 'to', 'my', 'our', 'please', 'one', 'at', 'in', 'on']);

const isQuestion = (t) => /\?\s*$/.test(t) || /^(what|which|how|is|are|can|do|does|where|when|why|tell me)\b/i.test(String(t).trim());

/**
 * A visitor's answer to the pending node → { port } when it answers it, or
 * { side: true } when it's something else.
 */
async function answer(node, input, state, deps) {
  const d = node.data || {};
  const vars = state.vars;
  const a = input.action;
  const text = String(input.text || a?.label || '').trim();
  const forThis = a && (!a.node || a.node === node.id);

  if (node.type === 'choice') {
    const options = await optionsFor(node, vars, deps);
    let pick = forThis && a.type === 'choice' ? options.find((o) => o.value === String(a.value)) || (a.value ? { value: String(a.value), label: a.label || String(a.value) } : null) : null;
    if (!pick && text) pick = matchOption(options, text);
    if (pick) {
      vars[d.var] = pick.value;
      vars[`${d.var}Label`] = pick.label;
      if (pick.item) vars[`${d.var}Item`] = pick.item; // e.g. {{fromItem.type}} for transfers
      const fromTool = d.options && !Array.isArray(d.options);
      return { port: options.some((o) => o.value === pick.value) ? (fromTool ? 'picked' : pick.value) : 'other' };
    }
    if (d.allowOther !== false && text && !isQuestion(text) && text.length <= 60) {
      vars[d.var] = text;
      return { port: 'other' };
    }
    return { side: true };
  }
  if (node.type === 'date') {
    if (d.range) {
      let from = forThis && a.type === 'dates' ? a.from : null;
      let to = forThis && a.type === 'dates' ? a.to : null;
      if (!from && text) [from, to] = findDates(text, deps.today);
      if (from && to && to > from && from >= deps.today) {
        vars[d.varFrom || 'checkIn'] = from;
        vars[d.varTo || 'checkOut'] = to;
        return { port: 'next' };
      }
    } else {
      let day = forThis && a.type === 'date' ? a.date : null;
      if (!day && text) [day] = findDates(text, deps.today);
      if (day && day >= deps.today) {
        vars[d.var || 'date'] = day;
        return { port: 'next' };
      }
    }
    return { side: true };
  }
  if (node.type === 'guests') {
    let pax = forThis && a.type === 'guests' ? { adults: Number(a.adults) || 2, childAges: (a.childAges || []).map(Number).filter((x) => x >= 0 && x < 18) } : null;
    if (!pax && text) {
      const g = findGuests(text);
      if (g.adults || /^\d{1,2}$/.test(text)) pax = { adults: g.adults || Number(text), childAges: g.childAges || [] };
    }
    if (pax && pax.adults >= 1 && pax.adults <= 20) {
      vars[d.var || 'pax'] = pax;
      return { port: 'next' };
    }
    return { side: true };
  }
  if (node.type === 'input') {
    if (!text || (isQuestion(text) && !d.acceptQuestions)) return { side: true };
    const rule = d.validate;
    const ok = !rule || (rule === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) : rule === 'phone' ? /^\+?[\d\s()-]{7,20}$/.test(text) : rule === 'number' ? /^-?\d+(\.\d+)?$/.test(text) : new RegExp(rule).test(text));
    if (!ok) return { port: 'invalid', invalid: true };
    vars[d.var] = rule === 'number' ? Number(text) : text;
    return { port: 'ok' };
  }
  return { side: true };
}

/** Skip a node whose value is already known (pre-filled from what the visitor said). */
async function prefilled(node, vars, deps) {
  const d = node.data || {};
  if (d.alwaysAsk) return null;
  if (node.type === 'choice' && vars[d.var] !== undefined && vars[d.var] !== '') {
    const options = await optionsFor(node, vars, deps);
    const hit = matchOption(options, vars[d.var]);
    if (hit) { vars[d.var] = hit.value; vars[`${d.var}Label`] = hit.label; if (hit.item) vars[`${d.var}Item`] = hit.item; return hit.item ? 'picked' : hit.value; }
    return null;
  }
  if (node.type === 'date') {
    if (d.range ? vars[d.varFrom || 'checkIn'] && vars[d.varTo || 'checkOut'] : vars[d.var || 'date']) return 'next';
    return null;
  }
  if (node.type === 'guests' && vars[d.var || 'pax']?.adults) return 'next';
  if (node.type === 'input' && vars[d.var] !== undefined && vars[d.var] !== '') return 'ok';
  return null;
}

/** What to show for a node that waits for the visitor. */
async function prompt(node, vars, deps, out) {
  const d = node.data || {};
  if (d.text) out.texts.push(resolve(d.text, vars));
  if (node.type === 'choice') {
    const options = await optionsFor(node, vars, deps);
    out.chips = [...out.chips, ...options.map((o) => ({ label: o.label, action: { type: 'choice', node: node.id, value: o.value, label: o.label } }))];
  } else if (node.type === 'date') {
    out.input = d.range ? { type: 'dateRange', node: node.id, min: deps.today } : { type: 'date', node: node.id, min: deps.today };
    if (!d.text) out.texts.push(d.range ? 'When are you travelling?' : 'Which date?');
  } else if (node.type === 'guests') {
    out.input = { type: 'guests', node: node.id, max: d.max || 12, children: d.children !== false };
    if (!d.text) out.texts.push('Who’s coming?');
  } else if (node.type === 'input') {
    out.input = { type: 'text', node: node.id, validate: d.validate || null };
  }
}

/**
 * One turn. Returns a reply in the widget's payload shape:
 * { text, cards, chips, sources, followUps, input? }
 */
async function run({ graph, state: s0, input = {}, deps }) {
  const state = { ...s0, vars: { ...(s0.vars || {}) } };
  const out = { texts: [], cards: [], chips: [], sources: [], input: undefined };
  const trace = { flow: graph.key, version: state.version, nodes: [], side: false };
  let nodeId = state.nodeId;
  let done = false;
  if (input.text) state.vars.text = input.text;

  // 1. The visitor answers the pending node (or asks something else).
  if (state.waiting) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      done = true;
    } else {
      const r = await answer(node, input, state, deps);
      if (r.side) {
        trace.side = true;
        const side = await deps.ai(String(input.text || input.action?.label || ''), { flow: graph.name, vars: state.vars });
        if (side?.text) out.texts.push(side.text);
        out.cards.push(...(side?.cards || []));
        out.sources.push(...(side?.sources || []));
        const again = { ...(node.data || {}), text: node.data?.reask || (node.data?.text ? `${resolve(node.data.text, state.vars)}` : '') };
        await prompt({ ...node, data: again }, state.vars, deps, out);
        return finish();
      }
      if (r.invalid) {
        out.texts.push(resolve(node.data?.invalidText || 'That doesn’t look right — please try again.', state.vars));
        const to = nextOf(graph, node.id, 'invalid');
        if (!to) { await prompt(node, state.vars, deps, out); return finish(); }
        nodeId = to;
      } else {
        trace.nodes.push(`${node.id}→${r.port}`);
        nodeId = nextOf(graph, node.id, r.port) || nextOf(graph, node.id, 'other');
      }
      state.waiting = false;
      if (!nodeId) done = true;
    }
  }

  // 2. Run until a node waits or the flow ends.
  let steps = 0;
  const visited = new Set();
  while (!done && nodeId) {
    steps += 1;
    if (steps > MAX_STEPS) {
      out.texts.push('Sorry, something went wrong with this conversation. Let’s start again.');
      out.chips = [...(deps.startChips || []), HANDOFF_CHIP];
      trace.error = 'STEP_LIMIT';
      done = true;
      break;
    }
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) { done = true; break; }
    const d = node.data || {};
    const v = state.vars;
    let port = null;
    trace.nodes.push(node.id);

    switch (node.type) {
      case 'start':
      case 'message':
        if (d.text) out.texts.push(resolve(d.text, v));
        port = 'next';
        break;
      case 'choice':
      case 'input':
      case 'date':
      case 'guests': {
        // Pre-filled answers skip a step only the first time it is reached in a
        // turn; reaching it again (a loop back) means it must be asked.
        const skip = visited.has(node.id) ? null : await prefilled(node, v, deps);
        visited.add(node.id);
        if (skip) { port = skip; trace.nodes.push(`(skipped ${node.id})`); break; }
        await prompt(node, v, deps, out);
        state.waiting = true;
        state.nodeId = node.id;
        return finish();
      }
      case 'tool': {
        const r = await deps.tools.run(d.tool, resolveValue(d.input || {}, v), { audience: 'public', userId: deps.userId });
        trace.nodes.push(`${d.tool}:${r.ok ? 'ok' : r.error?.code}`);
        if (r.ok && !r.data?.error) {
          v[d.var] = { ...r.data, _tool: d.tool };
          const items = Array.isArray(r.data.items) ? r.data.items : null;
          port = items && !items.length ? 'empty' : 'ok';
          if (port === 'empty' && !nextOf(graph, node.id, 'empty')) port = 'ok';
        } else {
          port = 'error';
          if (!nextOf(graph, node.id, 'error')) {
            out.texts.push(r.data?.message || 'Live prices are unavailable right now. Please try again in a moment, or talk to our team.');
            out.chips = [HANDOFF_CHIP];
            done = true;
          }
        }
        break;
      }
      case 'cards': {
        const data = v[d.from];
        const cards = data?._tool ? cardsFrom([{ tool: data._tool, ok: true, data }]) : [];
        if (cards.length) {
          if (d.text) out.texts.push(resolve(d.text, v));
          out.cards.push(...cards.slice(0, d.limit || 8));
          if (data.url && d.seeAll !== false) out.chips.push({ label: d.seeAllLabel || 'See all on the website', action: { type: 'link', url: data.url } });
        } else {
          out.texts.push(resolve(d.empty || data?.message || 'Nothing found for that — try other dates or another island?', v));
        }
        port = 'next';
        break;
      }
      case 'condition':
        if (Array.isArray(d.cases) && d.cases.length) port = (d.cases.find((c) => evaluate(c.when, v)) || { port: 'else' }).port;
        else port = evaluate(d.when, v) ? 'true' : 'false';
        break;
      case 'set':
        for (const [k, expr] of Object.entries(d.assign || {})) v[k] = resolveValue(expr, v);
        port = 'next';
        break;
      case 'ai': {
        const r = await deps.ai(resolve(d.question || '{{text}}', v), { instructions: d.instructions, flow: graph.name, vars: v });
        if (r?.text) out.texts.push(r.text);
        out.cards.push(...(r?.cards || []));
        out.sources.push(...(r?.sources || []));
        port = r?.handoff ? 'handoff' : 'answered';
        break;
      }
      case 'knowledge': {
        const r = await deps.knowledge(resolve(d.query, v), { destination: v.island });
        if (r?.text) out.texts.push(r.text);
        out.sources.push(...(r?.sources || []));
        port = 'next';
        break;
      }
      case 'link': {
        const url = d.url ? resolve(d.url, v) : deps.links[d.page]?.(resolveValue(d.params || {}, v));
        if (d.text) out.texts.push(resolve(d.text, v));
        if (url) out.chips.push({ label: resolve(d.label || 'Open', v), action: { type: 'link', url } });
        port = 'next';
        break;
      }
      case 'query': {
        // "Talk to us": a support query in the website's Queries module (the team replies by email).
        try {
          const id = await deps.createQuery({
            name: resolve(d.name || '{{name}}', v),
            email: resolve(d.email || '{{email}}', v),
            mobile: resolve(d.mobile || '{{mobile}}', v) || null,
            subject: resolve(d.subject || 'Question from the website assistant', v),
            message: resolve(d.message || '{{message}}', v),
            category: d.category || 'general',
          });
          v.queryId = id;
          port = 'ok';
        } catch (err) {
          trace.nodes.push(`query:${err.message}`);
          port = 'error';
          if (!nextOf(graph, node.id, 'error')) {
            out.texts.push('Sorry — your message could not be sent. Please try again in a moment.');
            done = true;
          }
        }
        break;
      }
      case 'handoff':
        out.texts.push(resolve(d.text || 'Our team will be happy to help. Send us a query and we’ll reply by email.', v));
        out.chips.push(HANDOFF_CHIP);
        trace.handoff = true; // counted in the analytics' handoff rate
        port = 'done';
        break;
      case 'jump': {
        const target = await deps.loadFlow(d.flow);
        if (!target) { out.texts.push('That option isn’t available right now.'); done = true; break; }
        graph = target.graph; // eslint-disable-line no-param-reassign
        state.key = target.graph.key;
        state.version = target.version;
        nodeId = d.node || target.graph.entry;
        trace.nodes.push(`jump:${state.key}`);
        continue; // eslint-disable-line no-continue
      }
      case 'end':
      default:
        done = true;
        break;
    }
    if (done) break;
    nodeId = nextOf(graph, node.id, port);
    if (!nodeId) done = true;
  }
  return finish();

  function finish() {
    const ended = done && !state.waiting;
    if (ended && !out.chips.length && graph.endChips !== false) out.chips = [...(deps.startChips || [])];
    return {
      reply: { text: out.texts.filter(Boolean).join('\n\n'), cards: out.cards, chips: out.chips, sources: out.sources, followUps: [], ...(out.input ? { input: out.input } : {}) },
      state: ended ? null : { key: state.key, version: state.version, nodeId: state.waiting ? state.nodeId : nodeId, waiting: Boolean(state.waiting), vars: state.vars },
      done: ended,
      trace,
    };
  }
}

/** Vars a flow starts with, from what memory already knows. */
function prefillVars(slots = {}) {
  const v = {};
  if (slots.island || slots.destination) v.island = slots.island || slots.destination;
  if (slots.checkIn) v.checkIn = slots.checkIn;
  if (slots.checkOut) v.checkOut = slots.checkOut;
  if (slots.date) v.date = slots.date;
  if (slots.adults) v.pax = { adults: slots.adults, childAges: slots.childAges || [] };
  return v;
}

module.exports = { run, prefillVars, answer, nextOf, MAX_STEPS };
