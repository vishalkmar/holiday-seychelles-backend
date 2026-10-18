const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { proxyRequest } = require('../../services/tourvisioProxyRequest');
const cache = require('../../services/cache');

const TARGET = 'https://service.espacelimited.com';

/**
 * Read-only supplier calls are cached (extra track 2.5), keyed on the path and
 * the request body — never on the token. Seconds per endpoint; anything not
 * listed (login, booking, payment, offer details and availability right before
 * booking) always goes to the supplier.
 */
const CACHE_SECONDS = {
  '/api/productservice/getarrivalautocomplete': 3600,
  '/api/productservice/getdepartureautocomplete': 3600,
  '/api/productservice/getdepartures': 3600,
  '/api/productservice/getarrivals': 3600,
  '/api/productservice/getproductcategories': 3600,
  '/api/productservice/getcurrencies': 3600,
  '/api/commonservice/getcurrencies': 3600,
  '/api/productservice/getcheckindates': 1800,
  '/api/productservice/getproductinfo': 6 * 3600,
  // Prices and availability move: short.
  '/api/productservice/pricesearch': 180,
  '/api/productservice/getoffers': 120,
};

function cacheSeconds(req, targetPath) {
  if (req.method !== 'POST') return 0;
  return CACHE_SECONDS[targetPath.split('?')[0].toLowerCase()] || 0;
}

/** Only a successful supplier answer is worth keeping. */
function cacheable(up) {
  if (up.status !== 200 || !/json/i.test(up.contentType || '')) return false;
  try {
    return JSON.parse(up.text)?.header?.success !== false;
  } catch {
    return false;
  }
}

router.all('/*', async (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/api\/tourvisio/, '');
  const targetUrl = `${TARGET}${targetPath}`;
  const ttl = cacheSeconds(req, targetPath);
  const key = ttl ? `tv:${targetPath.toLowerCase()}:${crypto.createHash('sha1').update(JSON.stringify(req.body || {})).digest('hex')}` : null;

  try {
    if (key) {
      const hit = await cache.get(key).catch(() => null);
      if (hit) {
        return res.status(hit.status).set({ 'Content-Type': hit.contentType, 'X-Cache': 'HIT' }).send(hit.text);
      }
    }

    const fetchOptions = {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
      },
    };

    if (req.headers.authorization) {
      fetchOptions.headers.Authorization = req.headers.authorization;
    }

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const upstream = await proxyRequest(targetUrl, fetchOptions);
    if (key && cacheable(upstream)) {
      cache.set(key, { status: upstream.status, contentType: upstream.contentType, text: upstream.text }, ttl).catch(() => {});
    }
    res.status(upstream.status).set({ 'Content-Type': upstream.contentType, ...(key ? { 'X-Cache': 'MISS' } : {}) }).send(upstream.text);
  } catch (err) {
    console.error(`[tourvisio-proxy] ${req.method} ${req.originalUrl} →`, err.message);
    const timedOut = err.name === 'TimeoutError';
    const message = timedOut
      ? 'The hotel supplier took too long to respond. Please try again.'
      : 'The hotel supplier is temporarily unavailable. Please try again.';
    res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'upstream_timeout' : 'proxy_error',
      message,
      header: { success: false, messages: [{ code: 'SupplierUnavailable', message }] },
    });
  }
});

module.exports = router;
module.exports.CACHE_SECONDS = CACHE_SECONDS;
