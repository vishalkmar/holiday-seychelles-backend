const { tourvisioRequest } = require('./tourvisioHttp');

/**
 * Forward one browser request to TourVisio.
 *
 * Retry rules live in tourvisioHttp: dropped connects are retried for every
 * request; reads (product/common services, login) are also retried after a
 * send; booking and payment calls are never sent twice.
 */
async function proxyRequest(url, options, opts = {}) {
  return tourvisioRequest(url, options, opts);
}

module.exports = { proxyRequest };
