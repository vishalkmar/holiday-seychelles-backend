const express = require('express');
const router = express.Router();

const TARGET = 'http://service.espacelimited.com';

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

    const upstream = await fetch(targetUrl, fetchOptions);
    const contentType = upstream.headers.get('content-type') || 'application/json';
    const text = await upstream.text();

    res.status(upstream.status).set('Content-Type', contentType).send(text);
  } catch (err) {
    console.error(`[tourvisio-proxy] ${req.method} ${req.originalUrl} →`, err.message);
    res.status(502).json({ error: 'proxy_error', message: err.message });
  }
});

module.exports = router;