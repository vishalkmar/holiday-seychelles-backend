/**
 * CyberSource Secure Acceptance — request signing and response verification.
 *
 * Algorithm (same in both directions):
 *   dataToSign = "name1=value1,name2=value2,..."   in the EXACT order given by
 *                the signed_field_names field
 *   signature  = base64( HMAC-SHA256( dataToSign, secretKey ) )
 *
 * Two rules that are easy to get wrong and silently break every transaction:
 *   1. signed_field_names must list ITSELF and unsigned_field_names. Omitting
 *      them produces a signature CyberSource rejects.
 *   2. The Secure Acceptance secret key is used as a raw UTF-8 string. (The
 *      REST API secret is base64-decoded first — different product, different
 *      rule. See utils/cybersource.js for the REST side.)
 *
 * Docs: developer.cybersource.com → Secure Acceptance → Checkout API →
 *       "Creating the Signature".
 */

const crypto = require('crypto');

const PROFILE_ID = process.env.CS_SA_PROFILE_ID || '';
const ACCESS_KEY = process.env.CS_SA_ACCESS_KEY || '';
const SECRET_KEY = process.env.CS_SA_SECRET_KEY || '';

/** True when real Secure Acceptance credentials are present. */
const isConfigured = !!(PROFILE_ID && ACCESS_KEY && SECRET_KEY);

/** Test endpoint unless CS_SA_LIVE=true, regardless of NODE_ENV. */
function endpoint() {
  const live = String(process.env.CS_SA_LIVE || 'false').toLowerCase() === 'true';
  return live
    ? 'https://secureacceptance.cybersource.com/pay'
    : 'https://testsecureacceptance.cybersource.com/pay';
}

function buildDataToSign(fields) {
  const names = String(fields.signed_field_names || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return names.map((n) => `${n}=${fields[n] === undefined || fields[n] === null ? '' : fields[n]}`).join(',');
}

function sign(fields, secretKey = SECRET_KEY) {
  return crypto
    .createHmac('sha256', secretKey)
    .update(buildDataToSign(fields), 'utf8')
    .digest('base64');
}

/**
 * Verify a Secure Acceptance response POST.
 * Returns false for anything we cannot positively verify — a missing signature,
 * a missing signed_field_names, or no configured secret. Never returns true by
 * default: an unverified receipt must not be able to mark an order paid.
 */
function verifyResponse(body, secretKey = SECRET_KEY) {
  if (!secretKey) return false;
  if (!body || !body.signature || !body.signed_field_names) return false;

  const expected = sign(body, secretKey);
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(body.signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** CyberSource wants ISO-8601 with no milliseconds: 2026-09-16T05:26:20Z */
function signedDateTime(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the full set of signed Secure Acceptance fields for a payment order.
 *
 * Every money-bearing value here comes from the `order` row loaded from the
 * database, never from request input.
 */
function buildPaymentFields(order, { receiptUrl, cancelUrl }) {
  const fields = {
    access_key: ACCESS_KEY,
    profile_id: PROFILE_ID,
    transaction_uuid: order.transaction_uuid,
    signed_date_time: signedDateTime(),
    locale: 'en',
    transaction_type: 'sale',
    reference_number: order.order_reference,
    amount: Number(order.amount).toFixed(2),
    currency: String(order.currency || 'EUR').toUpperCase(),

    bill_to_forename: order.lead_first_name || 'Guest',
    bill_to_surname: order.lead_last_name || 'Guest',
    bill_to_email: order.lead_email || '',
    bill_to_phone: (order.lead_mobile || '').replace(/[^\d+]/g, '') || '0000000000',
    bill_to_address_line1: order.bill_address_line1 || 'N/A',
    bill_to_address_city: order.bill_address_city || 'Victoria',
    bill_to_address_country: order.bill_address_country || 'SC',
    bill_to_address_postal_code: order.bill_address_postal_code || '00000',

    override_custom_receipt_page: receiptUrl,
    override_custom_cancel_page: cancelUrl || receiptUrl,
  };

  // The order reference is the only thing we need echoed back — everything else
  // is re-read from the database in the receipt handler.
  fields.merchant_defined_data1 = order.order_reference;

  const signedNames = [...Object.keys(fields), 'signed_field_names', 'unsigned_field_names'];
  fields.signed_field_names = signedNames.join(',');
  fields.unsigned_field_names = '';
  fields.signature = sign(fields);

  return fields;
}

module.exports = {
  isConfigured,
  endpoint,
  sign,
  verifyResponse,
  buildDataToSign,
  buildPaymentFields,
  signedDateTime,
  PROFILE_ID,
  ACCESS_KEY,
};
