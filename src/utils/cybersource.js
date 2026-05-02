/**
 * CyberSource refund integration.
 *
 * Two modes:
 *   - SIMULATION (default, CYBERSOURCE_REFUND_LIVE not 'true'):
 *       processRefund() always succeeds with a synthetic reference. Lets the
 *       full UI / email / audit flow run end-to-end without touching real $$.
 *   - LIVE (CYBERSOURCE_REFUND_LIVE=true + creds + URL):
 *       processRefund() signs and calls the real CyberSource REST refund API
 *       per https://developer.cybersource.com/api-reference-assets/index.html
 *       (Payments → Refunds → "Refund a Payment").
 *
 * Required env in LIVE mode:
 *   CYBERSOURCE_REFUND_LIVE=true
 *   CYBERSOURCE_MERCHANT_ID=...
 *   CYBERSOURCE_API_KEY=...           (REST shared-secret key id)
 *   CYBERSOURCE_SECRET_KEY=...        (base64-encoded REST shared-secret)
 *   CYBERSOURCE_REST_HOST=apitest.cybersource.com
 *                              ^ or api.cybersource.com for production
 *
 * Refund target:
 *   We refund against the original payment_reference. CyberSource expects the
 *   "id" from the original payment response, which our PHP receipt stores as
 *   transaction_id. If your gateway integration uses a different reference,
 *   adjust paymentReference handling here.
 */

const crypto = require('crypto');
const https = require('https');

const isLive = String(process.env.CYBERSOURCE_REFUND_LIVE || 'false').toLowerCase() === 'true';

const CONFIG = {
  merchantId: process.env.CYBERSOURCE_MERCHANT_ID,
  apiKey: process.env.CYBERSOURCE_API_KEY,
  secretKey: process.env.CYBERSOURCE_SECRET_KEY,
  host: process.env.CYBERSOURCE_REST_HOST || 'apitest.cybersource.com',
};

function assertLiveConfig() {
  const missing = [];
  if (!CONFIG.merchantId) missing.push('CYBERSOURCE_MERCHANT_ID');
  if (!CONFIG.apiKey) missing.push('CYBERSOURCE_API_KEY');
  if (!CONFIG.secretKey) missing.push('CYBERSOURCE_SECRET_KEY');
  if (missing.length) {
    throw new Error(
      `CyberSource live mode is enabled but missing env: ${missing.join(', ')}. ` +
      `Either set them or set CYBERSOURCE_REFUND_LIVE=false.`
    );
  }
}

/**
 * Build the HTTP-Signature header per CyberSource REST auth.
 * https://developer.cybersource.com/docs/cybs/en-us/payments/developer/all/rest/payments/GenAuthHTTPSignature.html
 */
function buildHeaders({ method, resource, bodyJSON }) {
  const date = new Date().toUTCString();
  const digest =
    'SHA-256=' + crypto.createHash('sha256').update(bodyJSON, 'utf8').digest('base64');

  const signatureFields = ['host', 'date', '(request-target)', 'digest', 'v-c-merchant-id'];
  const signatureString =
    `host: ${CONFIG.host}\n` +
    `date: ${date}\n` +
    `(request-target): ${method.toLowerCase()} ${resource}\n` +
    `digest: ${digest}\n` +
    `v-c-merchant-id: ${CONFIG.merchantId}`;

  const secretBytes = Buffer.from(CONFIG.secretKey, 'base64');
  const signatureB64 = crypto
    .createHmac('sha256', secretBytes)
    .update(signatureString, 'utf8')
    .digest('base64');

  const signatureHeader =
    `keyid="${CONFIG.apiKey}", ` +
    `algorithm="HmacSHA256", ` +
    `headers="${signatureFields.join(' ')}", ` +
    `signature="${signatureB64}"`;

  return {
    'Host': CONFIG.host,
    'Date': date,
    'Digest': digest,
    'v-c-merchant-id': CONFIG.merchantId,
    'Signature': signatureHeader,
    'Content-Type': 'application/json;charset=utf-8',
    'Accept': 'application/hal+json;charset=utf-8',
  };
}

function httpsRequest({ method, host, path: urlPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host, path: urlPath, method, headers, timeout: 20000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          resolve({ statusCode: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

async function callCyberSourceRefund({ paymentReference, amount, currency }) {
  assertLiveConfig();
  if (!paymentReference) throw new Error('paymentReference (original CyberSource id) is required');

  const resource = `/pts/v2/payments/${encodeURIComponent(paymentReference)}/refunds`;
  const payload = {
    clientReferenceInformation: {
      code: `refund-${Date.now()}`,
    },
    orderInformation: {
      amountDetails: {
        totalAmount: Number(amount).toFixed(2),
        currency: (currency || 'EUR').toUpperCase(),
      },
    },
  };
  const bodyJSON = JSON.stringify(payload);
  const headers = buildHeaders({ method: 'POST', resource, bodyJSON });

  const response = await httpsRequest({
    method: 'POST',
    host: CONFIG.host,
    path: resource,
    headers,
    body: bodyJSON,
  });

  const ok = response.statusCode >= 200 && response.statusCode < 300;
  if (!ok) {
    const detail =
      (response.body && (response.body.message || response.body.reason || JSON.stringify(response.body))) ||
      response.raw ||
      `HTTP ${response.statusCode}`;
    throw new Error(`CyberSource refund failed: ${detail}`);
  }

  return {
    refundId: response.body?.id || response.body?.refundId || null,
    status: response.body?.status || null,
    raw: response.body,
  };
}

/**
 * Process a refund for a booking.
 * Returns { success, simulated, gatewayReference, error? }.
 */
async function processRefund({ paymentReference, amount, currency }) {
  if (!isLive) {
    return {
      success: true,
      simulated: true,
      gatewayReference: `SIM-REFUND-${Date.now()}`,
    };
  }

  try {
    const result = await callCyberSourceRefund({ paymentReference, amount, currency });
    return {
      success: true,
      simulated: false,
      gatewayReference: result.refundId,
      raw: result.raw,
    };
  } catch (err) {
    return {
      success: false,
      simulated: false,
      error: err.message || String(err),
    };
  }
}

module.exports = { processRefund, isLive };
