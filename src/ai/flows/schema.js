/**
 * Flow graph validation (BOT-CONNECTION.md §2). Errors block publishing;
 * warnings are shown in the builder.
 *
 *   validate(graph, { tools: [{ name, enabled }] }) → { ok, errors[], warnings[] }
 */

const { varsUsed } = require('./template');

/** Node type → { ports, sets?(data) → vars written, waits (asks the visitor) } */
const NODE_TYPES = {
  start: { ports: ['next'] },
  message: { ports: ['next'] },
  // Static options: one output per option. Options from a tool: `picked` (any of them) and `other` (typed).
  choice: { ports: (d) => (d.options && !Array.isArray(d.options) && d.options.source === 'tool' ? ['picked', 'other'] : [...optionValues(d), 'other']), sets: (d) => [d.var, `${d.var}Label`, `${d.var}Item`], waits: true },
  input: { ports: ['ok', 'invalid'], sets: (d) => [d.var], waits: true },
  date: { ports: ['next'], sets: (d) => (d.range ? [d.varFrom || 'checkIn', d.varTo || 'checkOut'] : [d.var || 'date']), waits: true },
  guests: { ports: ['next'], sets: (d) => [d.var || 'pax'], waits: true },
  tool: { ports: ['ok', 'empty', 'error'], sets: (d) => [d.var] },
  cards: { ports: ['next'] },
  condition: { ports: (d) => (Array.isArray(d.cases) && d.cases.length ? [...d.cases.map((c) => c.port), 'else'] : ['true', 'false']) },
  set: { ports: ['next'], sets: (d) => Object.keys(d.assign || {}) },
  ai: { ports: ['answered', 'handoff'] },
  knowledge: { ports: ['next'] },
  link: { ports: ['next'] },
  handoff: { ports: ['done'] },
  query: { ports: ['ok', 'error'], sets: () => ['queryId'] },
  jump: { ports: [] },
  end: { ports: [] },
};

function optionValues(d) {
  return Array.isArray(d?.options) ? d.options.map((o) => String(o.value)) : [];
}

function portsOf(node) {
  const t = NODE_TYPES[node.type];
  if (!t) return [];
  return typeof t.ports === 'function' ? t.ports(node.data || {}) : t.ports;
}

const KEY = /^[a-z][a-z0-9-]{1,40}$/;
const ID = /^[A-Za-z][\w-]{0,40}$/;
// Variables the engine provides itself (memory slots, the visitor's last text).
const BUILTIN = new Set(['island', 'destination', 'checkIn', 'checkOut', 'date', 'pax', 'adults', 'childAges', 'text', 'today', 'user', 'name', 'email']);

function validate(graph, { tools = [] } = {}) {
  const errors = [];
  const warnings = [];
  const g = graph || {};
  if (!KEY.test(String(g.key || ''))) errors.push('Flow key must be 2–41 lowercase letters, digits or dashes, starting with a letter.');
  if (!String(g.name || '').trim()) errors.push('Give the flow a name.');
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  if (!nodes.length) errors.push('The flow has no nodes.');
  if (nodes.length > 200) errors.push('A flow can have at most 200 nodes.');

  const byId = new Map();
  for (const n of nodes) {
    if (!ID.test(String(n.id || ''))) errors.push(`Node id “${n.id}” is not valid.`);
    else if (byId.has(n.id)) errors.push(`Two nodes share the id “${n.id}”.`);
    else byId.set(n.id, n);
    if (!NODE_TYPES[n.type]) errors.push(`Node ${n.id}: unknown type “${n.type}”.`);
  }
  if (!byId.has(g.entry)) errors.push('The entry node does not exist.');

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  for (const n of nodes) {
    const d = n.data || {};
    if (['choice', 'input', 'date', 'guests', 'message'].includes(n.type) && !String(d.text || '').trim() && n.type !== 'date' && n.type !== 'guests') errors.push(`Node ${n.id} (${n.type}) needs text.`);
    if (n.type === 'choice') {
      const opts = d.options;
      const toolOpts = opts && !Array.isArray(opts) && opts.source === 'tool';
      if (!d.var) errors.push(`Node ${n.id}: choose the variable the choice is saved in.`);
      if (!toolOpts && (!Array.isArray(opts) || !opts.length)) errors.push(`Node ${n.id}: a choice needs options.`);
      if (Array.isArray(opts) && new Set(opts.map((o) => String(o.value))).size !== opts.length) errors.push(`Node ${n.id}: two options share a value.`);
      if (toolOpts && !toolMap.has(opts.tool)) errors.push(`Node ${n.id}: tool “${opts.tool}” does not exist.`);
    }
    if (n.type === 'input' && !d.var) errors.push(`Node ${n.id}: choose the variable the answer is saved in.`);
    if (n.type === 'tool') {
      if (!toolMap.has(d.tool)) errors.push(`Node ${n.id}: tool “${d.tool}” does not exist.`);
      else if (!toolMap.get(d.tool).enabled) warnings.push(`Node ${n.id}: tool “${d.tool}” is switched off — this node will follow its error port.`);
      if (!d.var) errors.push(`Node ${n.id}: name the variable that keeps the results.`);
    }
    if (n.type === 'cards' && !d.from) errors.push(`Node ${n.id}: which results should the cards show?`);
    if (n.type === 'condition') {
      try {
        const { evaluate } = require('./template');
        const exprs = Array.isArray(d.cases) && d.cases.length ? d.cases.map((c) => c.when) : [d.when];
        exprs.forEach((e) => evaluate(e, {}));
      } catch (err) {
        errors.push(`Node ${n.id}: ${err.message}`);
      }
    }
    if (n.type === 'jump' && !d.flow) errors.push(`Node ${n.id}: which flow should it jump to?`);
    if (n.type === 'link' && !d.page && !d.url) errors.push(`Node ${n.id}: which page should the button open?`);
  }

  // Edges: real nodes, real ports, one edge per port.
  const seenPort = new Set();
  for (const e of edges) {
    const from = byId.get(e.from);
    if (!from) { errors.push(`An edge starts at unknown node “${e.from}”.`); continue; }
    if (!byId.has(e.to)) { errors.push(`Node ${e.from}: an edge goes to unknown node “${e.to}”.`); continue; }
    const port = e.port || portsOf(from)[0];
    if (!portsOf(from).includes(port)) errors.push(`Node ${e.from}: it has no “${port}” output.`);
    const k = `${e.from}:${port}`;
    if (seenPort.has(k)) errors.push(`Node ${e.from}: its “${port}” output is connected twice.`);
    seenPort.add(k);
  }
  for (const n of nodes) {
    if (['end', 'jump'].includes(n.type)) continue;
    const ports = portsOf(n);
    const connected = ports.filter((p) => seenPort.has(`${n.id}:${p}`));
    if (!connected.length && ports.length) warnings.push(`Node ${n.id} has no outgoing connection — the flow ends there.`);
    if (n.type === 'tool' && !seenPort.has(`${n.id}:error`)) warnings.push(`Node ${n.id}: the error output is not connected — the built-in “live prices unavailable” message is used.`);
  }

  // Reachability from the entry.
  if (byId.has(g.entry)) {
    const next = new Map();
    for (const e of edges) next.set(e.from, [...(next.get(e.from) || []), e.to]);
    const seen = new Set([g.entry]);
    const queue = [g.entry];
    while (queue.length) for (const to of next.get(queue.shift()) || []) if (!seen.has(to)) { seen.add(to); queue.push(to); }
    for (const n of nodes) if (!seen.has(n.id)) warnings.push(`Node ${n.id} can't be reached from the start.`);
  }

  // Variables read before anything sets them.
  const defined = new Set([...BUILTIN, ...Object.keys(g.vars || {})]);
  for (const n of nodes) (NODE_TYPES[n.type]?.sets?.(n.data || {}) || []).filter(Boolean).forEach((v) => defined.add(v));
  for (const n of nodes) for (const v of varsUsed(n.data || {})) if (!defined.has(v)) warnings.push(`Node ${n.id} uses {{${v}}}, which nothing sets.`);

  // Triggers.
  const tr = g.triggers || {};
  if (!['chips', 'keywords', 'products'].some((k) => Array.isArray(tr[k]) && tr[k].length)) warnings.push('No triggers: the flow only starts from a jump or a chip that names it.');

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validate, NODE_TYPES, portsOf };
