/**
 * TourVisio for tools: one read call, the currency retry the website uses,
 * and errors mapped to what the assistant should say.
 *
 *   SUPPLIER_DOWN — connection failed, 5xx, or not configured ("try again shortly")
 *   NO_RESULTS    — PriceNotFound and friends (not an error: "nothing for those dates")
 *   SUPPLIER_ERROR — TourVisio answered with another error message
 *
 * `client` is injectable so tests run on canned responses.
 */

const { tourvisio } = require('../ports');

const NO_RESULT_CODES = new Set(['PriceNotFound', 'NoAvailability', 'NoResult', 'NoResults', 'HotelNotFound', 'ProductNotFound']);
const CURRENCIES = ['EUR', 'USD', 'GBP', null];

class ToolError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

function makeSupplier(client = tourvisio) {
  let workingCurrency = null;

  async function call(path, body) {
    if (client.configured && !client.configured()) throw new ToolError('SUPPLIER_DOWN', 'The booking supplier is not configured on this server.');
    let r;
    try {
      r = await client.call(path, body);
    } catch (err) {
      throw new ToolError('SUPPLIER_DOWN', 'The booking supplier is temporarily unavailable. Please try again in a moment.', err.message);
    }
    if (r.status >= 500) throw new ToolError('SUPPLIER_DOWN', 'The booking supplier is temporarily unavailable. Please try again in a moment.', `HTTP ${r.status}`);
    const m = r.messages?.[0] || r.data?.header?.messages?.[0];
    const code = String(m?.code || '');
    if (r.ok && r.data?.header?.success !== false) return { body: r.data?.body || {}, code };
    if (NO_RESULT_CODES.has(code)) return { body: {}, code, empty: true };
    const err = new ToolError('SUPPLIER_ERROR', m?.message || m?.description || 'The supplier could not answer this request.', code);
    err.supplierCode = code;
    throw err;
  }

  /** pricesearch with the currency fallback; returns { body, currency, empty }. */
  async function priceSearch(body, preferred) {
    // Known-good currency first, then EUR/USD/GBP, then none (account default) last.
    const order = [...new Set([preferred || workingCurrency, ...CURRENCIES].filter((c, i) => c || i > 0))];
    let last = null;
    for (const currency of order) {
      const b = { ...body };
      if (currency) b.currency = currency;
      else delete b.currency;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await call('/productservice/pricesearch', b);
        if (!r.empty) workingCurrency = currency || workingCurrency;
        return { ...r, currency: currency || r.body.currency || 'EUR' };
      } catch (err) {
        if (err.code === 'SUPPLIER_ERROR' && /currency/i.test(err.supplierCode || '')) { last = err; continue; }
        throw err;
      }
    }
    throw last || new ToolError('SUPPLIER_ERROR', 'No currency is configured for this account.');
  }

  return { call, priceSearch };
}

module.exports = { makeSupplier, ToolError, defaultSupplier: makeSupplier() };
