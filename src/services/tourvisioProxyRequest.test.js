const { test } = require('node:test');
const assert = require('node:assert/strict');
const { proxyRequest } = require('./tourvisioProxyRequest');

const read = 'https://example.test/api/productservice/getproductinfo';
const options = { method: 'POST', headers: { Authorization: 'Bearer test' }, body: '{"product":"298798"}' };
const ok = (status = 200, text = '{"header":{"success":true}}') => ({ status, contentType: 'application/json', text });
const err = (phase, extra = {}) => Object.assign(new Error('fetch failed'), { phase, ...extra });
const noDelay = async () => {};

test('recovers a dropped read and preserves the request', async () => {
  let calls = 0;
  const result = await proxyRequest(read, options, {
    delay: noDelay,
    requestImpl: async (_, init) => {
      assert.equal(init.body, options.body);
      assert.equal(init.headers.Authorization, options.headers.Authorization);
      if (++calls === 1) throw err('response');
      return ok();
    },
  });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(result.text).header.success, true);
});

test('retries temporary gateways on reads, but not application errors', async () => {
  for (const status of [502, 503, 504, 400, 404]) {
    let calls = 0;
    const result = await proxyRequest(read, options, { delay: noDelay, requestImpl: async () => { calls++; return ok(status, '{}'); } });
    assert.equal(calls, status >= 500 ? 4 : 1);
    assert.equal(result.status, status);
  }
});

test('search, offers and autocomplete are reads too', async () => {
  for (const ep of ['productservice/pricesearch', 'productservice/getoffers', 'productservice/getarrivalautocomplete', 'commonservice/getcurrencies']) {
    let calls = 0;
    await proxyRequest(`https://example.test/api/${ep}`, options, {
      delay: noDelay,
      requestImpl: async () => { if (++calls < 3) throw err('response'); return ok(); },
    });
    assert.equal(calls, 3, ep);
  }
});

test('booking and payment calls are never repeated once sent', async () => {
  for (const ep of ['bookingservice/begintransaction', 'paymentservice/beginpaymenttransaction']) {
    let calls = 0;
    await assert.rejects(proxyRequest(`https://example.test/api/${ep}`, options, { delay: noDelay, requestImpl: async () => { calls++; throw err('response'); } }));
    assert.equal(calls, 1, ep);
  }
});

test('booking calls ARE retried when the connection never opened', async () => {
  let calls = 0;
  let fresh;
  const result = await proxyRequest('https://example.test/api/bookingservice/begintransaction', options, {
    delay: noDelay,
    requestImpl: async (_, __, o) => { fresh = o.fresh; if (++calls < 3) throw err('connect', { code: 'ECONNECT_TIMEOUT' }); return ok(); },
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 200);
  assert.equal(fresh, true, 'bookings use their own connection, not a pooled one');
});

test('gives up after four attempts and keeps the last error', async () => {
  let calls = 0;
  await assert.rejects(
    proxyRequest(read, options, { delay: noDelay, requestImpl: async () => { calls++; throw Object.assign(err('response'), { name: 'TimeoutError' }); } }),
    { name: 'TimeoutError' }
  );
  assert.equal(calls, 4);
});
