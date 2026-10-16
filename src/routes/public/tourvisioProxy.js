const express = require('express');
const router = express.Router();
const { proxyRequest } = require('../../services/tourvisioProxyRequest');

const TARGET = 'https://service.espacelimited.com';

router.all('/*', async (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/api\/tourvisio/, '');
  const targetUrl = `${TARGET}${targetPath}`;

  try {
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
    res.status(upstream.status).set('Content-Type', upstream.contentType).send(upstream.text);
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
