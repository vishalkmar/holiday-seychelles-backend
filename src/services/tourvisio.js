/**
 * Server-side TourVisio client.
 *
 * The frontend already talks to TourVisio through /api/tourvisio, but anything
 * that decides how much money to charge has to happen here, on the server. The
 * browser is free to lie about the price; `bookingservice/begintransaction` is
 * not.
 *
 * Token handling note: TourVisio returns `TokenRequired` with HTTP *200*, not
 * 401, so a stale token cannot be detected from the status code alone. We check
 * the response body and re-login once.
 */

const { tourvisioRequest } = require('./tourvisioHttp');

const BASE_URL = (process.env.TOURVISIO_BASE_URL || 'https://service.espacelimited.com').replace(/\/$/, '');
const AGENCY = process.env.TOURVISIO_AGENCY || 'B2C';
const USER = process.env.TOURVISIO_USER || 'B2C';
const PASSWORD = process.env.TOURVISIO_PASSWORD || '';
const CULTURE = process.env.TOURVISIO_CULTURE || 'en-US';

let _token = null;
let _tokenExpiresAt = 0;

function configured() {
  return !!PASSWORD;
}

async function login(force = false) {
  if (!force && _token && Date.now() < _tokenExpiresAt) return _token;
  if (!PASSWORD) throw new Error('TOURVISIO_PASSWORD is not set');

  // Retries/connection handling: see tourvisioHttp (login is a safe read).
  const res = await tourvisioRequest(`${BASE_URL}/api/authenticationservice/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Agency: AGENCY, User: USER, Password: PASSWORD }),
  });
  let data = null;
  try { data = JSON.parse(res.text); } catch { /* not JSON */ }
  const token = data?.body?.token;
  if (!token) {
    throw new Error(`TourVisio login failed: ${JSON.stringify(data?.header?.messages || data).slice(0, 300)}`);
  }
  _token = token;
  _tokenExpiresAt = Date.now() + 20 * 60 * 1000;
  return _token;
}

function isTokenError(payload) {
  const messages = payload?.header?.messages || [];
  return messages.some((m) => String(m.code || '').toLowerCase() === 'tokenrequired');
}

/** POST to a TourVisio service, re-authenticating once on a stale token. */
async function call(path, body, { retried = false } = {}) {
  const token = await login();
  // Booking/payment paths are never re-sent once they reach TourVisio; only a
  // connection that never opened is retried (see tourvisioHttp).
  const res = await tourvisioRequest(`${BASE_URL}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

  const text = res.text;
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!retried && isTokenError(data)) {
    await login(true);
    return call(path, body, { retried: true });
  }

  const ok = res.status >= 200 && res.status < 300 && data?.header?.success !== false && !isTokenError(data);
  return { ok, status: res.status, data, messages: data?.header?.messages || [] };
}

function firstMessage(result) {
  const m = result.messages?.[0];
  return m ? `${m.code || ''}: ${m.message || ''}`.trim() : `HTTP ${result.status}`;
}

/**
 * Hold the offer and get the real, bookable price.
 * Returns the TourVisio transactionId plus the authoritative total.
 */
async function beginTransaction({ offerIds, currency = 'EUR', culture = CULTURE }) {
  const result = await call('/bookingservice/begintransaction', { offerIds, currency, culture });
  if (!result.ok) throw new Error(`begintransaction failed - ${firstMessage(result)}`);

  const body = result.data.body;
  const info = body?.reservationData?.reservationInfo || {};
  const total = info.totalPrice || info.passengerPriceToPay || info.priceToPay;

  if (!body?.transactionId) throw new Error('begintransaction returned no transactionId');
  if (!total || typeof total.amount !== 'number') {
    throw new Error('begintransaction returned no usable total price');
  }

  const mainService = (body.reservationData?.services || []).find((s) => s.isMainService)
    || body.reservationData?.services?.[0];

  return {
    transactionId: body.transactionId,
    expiresOn: body.expiresOn,
    amount: total.amount,
    currency: total.currency || currency,
    travellerCount: body.reservationData?.travellers?.length || 0,
    isRefundable: mainService?.isRefundable !== false,
    cancellationPolicies: mainService?.cancellationPolicies || [],
    beginDate: mainService?.beginDate || info.beginDate || null,
    endDate: mainService?.endDate || info.endDate || null,
    productName: mainService?.name || null,
    productCode: mainService?.code || mainService?.id || null,
    reservationData: body.reservationData,
  };
}

/**
 * Attach traveller + contact details to a held transaction.
 * `travellers` lines up with the traveller slots begintransaction returned.
 */
async function setReservationInfo({ transactionId, reservationData, travellers = [], contact = {}, culture = CULTURE }) {
  const slots = reservationData?.travellers || [];

  const filled = slots.map((slot, idx) => {
    const t = travellers[idx] || travellers[0] || {};
    const isMrs = t.title === 'Mrs' || t.title === 'Ms';
    return {
      ...slot,
      title: isMrs ? 3 : 1,
      name: t.firstName || slot.name,
      surname: t.lastName || slot.surname,
      isLeader: idx === 0,
      address: {
        ...(slot.address || {}),
        email: contact.email || slot.address?.email || '',
        phone: contact.phone || slot.address?.phone || '',
      },
    };
  });

  const result = await call('/bookingservice/setreservationinfo', {
    transactionId,
    travellers: filled,
    customerInfo: {
      isCompany: false,
      title: 1,
      name: contact.firstName || filled[0]?.name || '',
      surname: contact.lastName || filled[0]?.surname || '',
      email: contact.email || '',
      phone: contact.phone || '',
    },
    reservationNote: contact.note || '',
    culture,
  });

  if (!result.ok) throw new Error(`setreservationinfo failed - ${firstMessage(result)}`);
  return result.data.body;
}

/** Payment methods available for a held transaction. */
async function getPaymentOptions({ transactionId }) {
  const result = await call('/agencyservice/getpaymentoptions', { transactionId });
  if (!result.ok) throw new Error(`getpaymentoptions failed - ${firstMessage(result)}`);
  return result.data.body?.options || [];
}

/**
 * Settle the supplier side from the agency's prepaid balance.
 *
 * This is the agency paying TourVisio - it is NOT the customer's card payment.
 * The customer pays us through CyberSource; this draws down the agency credit
 * that TourVisio requires before it will confirm a reservation. (The B2C account
 * exposes only AGENCYCREDIT - option 2, paymentTypeId 1 - with no third-party
 * card gateway, so there is no alternative route here.)
 *
 * `makeCommitTransactionAfterPayment` asks TourVisio to confirm the reservation
 * in the same call, which avoids a window where money moved but the booking was
 * never committed.
 */
async function payWithAgencyCredit({ transactionId, currency = 'EUR', culture = CULTURE, commitAfterPayment = true }) {
  const result = await call('/paymentservice/beginpaymenttransaction', {
    transactionId,
    paymentOption: 2,
    paymentTypeId: '1',
    installment: 1,
    makeCommitTransactionAfterPayment: commitAfterPayment,
    makeCommitTransactionAfterPaymentAsync: false,
    currency,
    culture,
  });

  if (!result.ok) throw new Error(`beginpaymenttransaction failed - ${firstMessage(result)}`);

  const body = result.data.body || {};
  return {
    paymentTransactionId: body.paymentTransactionId || null,
    paymentTransactionType: body.paymentTransactionType,
    reservationNumber:
      body.reservationNumber || body.reservationData?.reservationInfo?.bookingNumber || null,
    raw: body,
  };
}

/** Confirm an individual payment outcome. */
async function checkPayment({ paymentTransactionId }) {
  const result = await call('/paymentservice/checkpayment', { paymentTransactionId });
  if (!result.ok) throw new Error(`checkpayment failed - ${firstMessage(result)}`);
  return result.data.body;
}

/** Poll an async transaction until processStatus settles. */
async function getTransactionStatus({ transactionId }) {
  const result = await call('/transactionservice/gettransactionstatus', { transactionId });
  if (!result.ok) throw new Error(`gettransactionstatus failed - ${firstMessage(result)}`);
  return result.data.body;
}

/** Confirm the held reservation. Only ever called after money has cleared. */
async function commitTransaction({ transactionId }) {
  const result = await call('/bookingservice/committransaction', { transactionId });
  if (!result.ok) throw new Error(`committransaction failed - ${firstMessage(result)}`);

  const body = result.data.body;
  return {
    reservationNumber:
      body?.reservationNumber || body?.reservationData?.reservationInfo?.bookingNumber || null,
    raw: body,
  };
}

async function getReservationDetail({ reservationNumber }) {
  const result = await call('/bookingservice/getreservationdetail', { reservationNumber });
  if (!result.ok) throw new Error(`getreservationdetail failed - ${firstMessage(result)}`);
  return result.data.body;
}

module.exports = {
  configured,
  login,
  call,
  beginTransaction,
  setReservationInfo,
  getPaymentOptions,
  payWithAgencyCredit,
  checkPayment,
  getTransactionStatus,
  commitTransaction,
  getReservationDetail,
  BASE_URL,
};
