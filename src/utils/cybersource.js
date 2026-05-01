/**
 * CyberSource refund integration.
 *
 * IMPORTANT: This module ships with a SIMULATION mode by default. It does NOT
 * call the real CyberSource API unless `CYBERSOURCE_REFUND_LIVE=true` is set in
 * the environment AND the credentials below are present.
 *
 * To enable real refunds:
 *   1. Add to .env:
 *        CYBERSOURCE_REFUND_LIVE=true
 *        CYBERSOURCE_MERCHANT_ID=...
 *        CYBERSOURCE_API_KEY=...
 *        CYBERSOURCE_SECRET_KEY=...
 *        CYBERSOURCE_REST_HOST=apitest.cybersource.com   (or api.cybersource.com for production)
 *   2. Implement the actual REST call in `callCyberSourceRefund` below using the
 *      CyberSource REST SDK or signed HTTP request.
 *   3. Test in sandbox first.
 *
 * Until then, refunds are recorded locally and the booking row is marked as
 * refunded so the rest of the flow (UI, email, audit trail) works end-to-end.
 */

const isLive = String(process.env.CYBERSOURCE_REFUND_LIVE || 'false').toLowerCase() === 'true';

async function callCyberSourceRefund(/* { paymentReference, amount, currency } */) {
  // TODO: replace with real CyberSource REST refund call.
  // Reference: https://developer.cybersource.com/api-reference-assets/index.html
  // Throw an error here so production deploys can't accidentally succeed without
  // a real implementation when LIVE mode is on.
  throw new Error(
    'CyberSource live refund call is not yet implemented. ' +
    'Either implement callCyberSourceRefund() or set CYBERSOURCE_REFUND_LIVE=false.'
  );
}

/**
 * Process a refund for a booking.
 * Returns { success, simulated, gatewayReference, error? }.
 *
 * In simulation mode (default): always succeeds with a synthetic reference.
 * In live mode: delegates to callCyberSourceRefund().
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
      gatewayReference: result.refundId || result.id || null,
      raw: result,
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
