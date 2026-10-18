/**
 * Flow templates and conditions — no eval, no Function().
 *
 *   resolve('Hotels in {{island}} for {{pax.adults}}', vars)   → string
 *   resolveValue('{{pax}}', vars)                               → the value itself (object/array/number)
 *   evaluate('{{hotels.length}} == 0 || {{pax.adults}} > 4', vars) → boolean
 *
 * Conditions: comparisons (== != > >= < <=, contains, empty, notempty) joined
 * by && and ||, with parentheses. Operands are {{paths}}, numbers, 'strings',
 * "strings", true/false/null. Anything else is a syntax error (a flow can't
 * run code).
 */

const PATH = /^[A-Za-z_][\w]*(?:\.(?:[A-Za-z_]\w*|\d+|length))*$/;

function get(vars, path) {
  if (!PATH.test(path)) return undefined;
  let cur = vars;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (part === 'length' && (Array.isArray(cur) || typeof cur === 'string')) cur = cur.length;
    else if (Object.prototype.hasOwnProperty.call(Object(cur), part)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

function show(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(show).join(', ');
  if (typeof v === 'object') return v.label || v.name || v.title || JSON.stringify(v);
  return String(v);
}

/** String template: every {{path}} replaced by its value as text. */
function resolve(text, vars = {}) {
  return String(text ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => show(get(vars, p)));
}

/** "{{pax}}" alone keeps the value's type; anything else becomes a string. Objects/arrays recurse. */
function resolveValue(v, vars = {}) {
  if (typeof v === 'string') {
    const only = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(v.trim());
    if (only) return get(vars, only[1]);
    return resolve(v, vars);
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveValue(x, vars)]));
  return v;
}

// ── Conditions ───────────────────────────────────────────────────────────────

function tokenize(src) {
  const re = /\s*(\{\{\s*[^}]+?\s*\}\}|'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|==|!=|>=|<=|>|<|&&|\|\||\(|\)|contains|notempty|empty|true|false|null)/y;
  const out = [];
  let i = 0;
  const s = String(src || '').trim();
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw Object.assign(new Error(`Condition syntax error near “${s.slice(i, i + 12)}”`), { code: 'BAD_CONDITION' });
    out.push(m[1]);
    i = re.lastIndex;
    while (s[i] === ' ') i += 1;
  }
  return out;
}

function evaluate(src, vars = {}) {
  const t = tokenize(src);
  let pos = 0;
  const peek = () => t[pos];
  const take = () => t[pos++];
  const operand = () => {
    const tok = take();
    if (tok === undefined) throw Object.assign(new Error('Condition ends too early'), { code: 'BAD_CONDITION' });
    if (tok.startsWith('{{')) return get(vars, tok.slice(2, -2).trim());
    if (tok[0] === "'" || tok[0] === '"') return tok.slice(1, -1);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^-?\d/.test(tok)) return Number(tok);
    throw Object.assign(new Error(`Unexpected “${tok}” in condition`), { code: 'BAD_CONDITION' });
  };
  const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
  const comparison = () => {
    if (peek() === '(') {
      take();
      const v = or();
      if (take() !== ')') throw Object.assign(new Error('Missing “)” in condition'), { code: 'BAD_CONDITION' });
      return v;
    }
    const a = operand();
    const op = peek();
    if (op === 'empty' || op === 'notempty') { take(); return op === 'empty' ? isEmpty(a) : !isEmpty(a); }
    if (!['==', '!=', '>', '>=', '<', '<=', 'contains'].includes(op)) return Boolean(a);
    take();
    const b = operand();
    switch (op) {
      case '==': return a == b; // eslint-disable-line eqeqeq
      case '!=': return a != b; // eslint-disable-line eqeqeq
      case '>': return Number(a) > Number(b);
      case '>=': return Number(a) >= Number(b);
      case '<': return Number(a) < Number(b);
      case '<=': return Number(a) <= Number(b);
      case 'contains': return Array.isArray(a) ? a.map(String).includes(String(b)) : String(a ?? '').toLowerCase().includes(String(b).toLowerCase());
      default: return false;
    }
  };
  const and = () => {
    let v = comparison();
    while (peek() === '&&') { take(); const r = comparison(); v = v && r; }
    return v;
  };
  function or() {
    let v = and();
    while (peek() === '||') { take(); const r = and(); v = v || r; }
    return v;
  }
  const result = or();
  if (pos !== t.length) throw Object.assign(new Error(`Unexpected “${t[pos]}” in condition`), { code: 'BAD_CONDITION' });
  return Boolean(result);
}

/** Variable names a template or condition reads (for the validator). */
function varsUsed(v) {
  const out = new Set();
  const walk = (x) => {
    if (typeof x === 'string') for (const m of x.matchAll(/\{\{\s*([A-Za-z_]\w*)/g)) out.add(m[1]);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return [...out];
}

module.exports = { resolve, resolveValue, evaluate, get, varsUsed, tokenize };
