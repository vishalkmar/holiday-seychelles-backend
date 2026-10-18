/**
 * A small JSON-schema subset for tool inputs — enough for flat objects, and
 * the same schema the model is shown. Pure, no dependencies.
 *
 * Supported: type object (properties, required, additionalProperties:false),
 * string (enum, pattern, format:'date', minLength, maxLength), integer/number
 * (minimum, maximum), boolean, array (items, maxItems), default.
 *
 * coerce: true turns query-string values into the declared types ("2" → 2,
 * "a,b" → ["a","b"], "true" → true) — for GET /api/chat/tools/:name.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(path, message) {
  return Object.assign(new Error(`${path}: ${message}`), { code: 'INVALID_INPUT', status: 400 });
}

function coerceValue(v, schema) {
  if (v === undefined || v === null) return v;
  switch (schema.type) {
    case 'integer':
    case 'number':
      return typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    case 'boolean':
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      return v;
    case 'array':
      return typeof v === 'string' ? (v.trim() ? v.split(',').map((x) => coerceValue(x.trim(), schema.items || {})) : []) : v;
    case 'string':
      return typeof v === 'number' ? String(v) : v;
    default:
      return v;
  }
}

function check(v, schema, path, coerce) {
  if (coerce) v = coerceValue(v, schema);
  switch (schema.type) {
    case 'string': {
      if (typeof v !== 'string') throw fail(path, 'must be text');
      const s = v.trim();
      if (schema.minLength && s.length < schema.minLength) throw fail(path, `must be at least ${schema.minLength} characters`);
      if (schema.maxLength && s.length > schema.maxLength) throw fail(path, `must be at most ${schema.maxLength} characters`);
      if (schema.enum && !schema.enum.includes(s)) throw fail(path, `must be one of ${schema.enum.join(', ')}`);
      if (schema.format === 'date' && (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)))) throw fail(path, 'must be a date YYYY-MM-DD');
      if (schema.pattern && !new RegExp(schema.pattern).test(s)) throw fail(path, 'has the wrong format');
      return s;
    }
    case 'integer':
    case 'number': {
      if (typeof v !== 'number' || Number.isNaN(v)) throw fail(path, 'must be a number');
      if (schema.type === 'integer' && !Number.isInteger(v)) throw fail(path, 'must be a whole number');
      if (schema.minimum !== undefined && v < schema.minimum) throw fail(path, `must be at least ${schema.minimum}`);
      if (schema.maximum !== undefined && v > schema.maximum) throw fail(path, `must be at most ${schema.maximum}`);
      return v;
    }
    case 'boolean':
      if (typeof v !== 'boolean') throw fail(path, 'must be true or false');
      return v;
    case 'array': {
      if (!Array.isArray(v)) throw fail(path, 'must be a list');
      if (schema.maxItems !== undefined && v.length > schema.maxItems) throw fail(path, `can have at most ${schema.maxItems} items`);
      return v.map((x, i) => check(x, schema.items || {}, `${path}[${i}]`, coerce));
    }
    case 'object':
      return validate(v, schema, { coerce, path });
    default:
      return v;
  }
}

/** Returns a cleaned copy with defaults applied, or throws { code: 'INVALID_INPUT' }. */
function validate(input, schema, { coerce = false, path = 'input' } = {}) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw fail(path, 'must be an object');
  const props = schema.properties || {};
  const out = {};
  if (schema.additionalProperties === false) {
    const extra = Object.keys(input).filter((k) => !(k in props));
    if (extra.length) throw fail(path, `unknown field ${extra[0]}`);
  }
  for (const [key, sub] of Object.entries(props)) {
    let v = input[key];
    if (v === '' && coerce) v = undefined;
    if (v === undefined || v === null) {
      if (sub.default !== undefined) out[key] = JSON.parse(JSON.stringify(sub.default));
      else if ((schema.required || []).includes(key)) throw fail(`${path}.${key}`, 'is required');
      continue;
    }
    out[key] = check(v, sub, `${path}.${key}`, coerce);
  }
  return out;
}

module.exports = { validate };
