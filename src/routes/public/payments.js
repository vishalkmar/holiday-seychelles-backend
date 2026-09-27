/**
 * Payment routes — CyberSource Secure Acceptance (Hosted Checkout).
 *
 *   POST /api/payments/orders          create a server-priced order
 *   GET  /api/payments/checkout/:ref   auto-submit the signed form to CyberSource
 *   POST /api/payments/receipt         gateway callback -> booking
 *   GET  /api/payments/orders/:ref     order status for the success page
 *
 * Why the customer never posts straight to CyberSource any more: the amount used
 * to live in a hidden form field, so the page could be edited to pay any price.
 * Now the browser only ever carries an order reference, and the amount is read
 * from the database when the form is built.
 *
 * 3-D Secure is handled by CyberSource on their hosted page. That is also why
 * the Cardinal -> Visa Data Centre migration needs no code here: we never call
 * the Cardinal endpoints ourselves.
 */

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../../config/db');
const sa = require('../../utils/cybersourceSA');
const paymentOrders = require('../../services/paymentOrders');
const fulfilment = require('../../services/bookingFulfilment');
const { toDateOnly } = require('../../utils/dates');

const router = express.Router();

const FRONTEND_URL = (process.env.HS_FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

/**
 * The simulator stands in for CyberSource when no Secure Acceptance credentials
 * are configured. It signs its callback with a local secret so the receipt
 * handler runs the exact same verification path as a real transaction - there is
 * no "skip the signature check" branch to accidentally ship to production.
 */
const SIM_SECRET =
  process.env.PAYMENT_SIM_SECRET ||
  crypto.createHash('sha256').update(String(process.env.JWT_USER_SECRET || 'hs-dev')).digest('hex');

const simulatorEnabled = () =>
  !sa.isConfigured && String(process.env.NODE_ENV).toLowerCase() !== 'production';

function esc(val) {
  return String(val == null ? '' : val)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function publicBase(req) {
  return (process.env.PUBLIC_API_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function autoSubmitPage({ action, fields, title }) {
  const inputs = Object.entries(fields)
    .map(([k, v]) => `    <input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#334;background:#f4f6fa}</style>
</head><body>
  <p>Redirecting to secure payment&hellip;</p>
  <form id="go" method="post" action="${esc(action)}">
${inputs}
  </form>
  <script>document.getElementById('go').submit();</script>
</body></html>`;
}

// ── POST /orders ─────────────────────────────────────────────────────────────
// Body: { offerId, travellers:[{firstName,lastName,title}], contact:{...},
//         bookingType, currency, quotedAmount, checkIn, checkOut, ... }
router.post('/orders', async (req, res) => {
  try {
    const b = req.body || {};

    if (!b.contact?.email) {
      return res.status(400).json({ status: 'error', message: 'contact.email is required' });
    }
    if (!b.offerId && !b.quotedAmount) {
      return res
        .status(400)
        .json({ status: 'error', message: 'Either offerId or quotedAmount is required' });
    }
    // Without an offerId the quote is all we have, so it must at least be sane.
    if (!b.offerId && !(Number(b.quotedAmount) > 0)) {
      return res
        .status(400)
        .json({ status: 'error', message: 'quotedAmount must be a positive number' });
    }

    const order = await paymentOrders.createOrder({
      offerId: b.offerId,
      bookingType: b.bookingType || 'hotel',
      currency: b.currency || 'EUR',
      travellers: Array.isArray(b.travellers) ? b.travellers : [],
      contact: b.contact,
      userId: b.userId ? Number(b.userId) : null,
      productTitle: b.productTitle,
      productCode: b.productCode,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      totalAdults: Number(b.totalAdults) || 1,
      totalChildren: Number(b.totalChildren) || 0,
      quotedAmount: b.quotedAmount,
      clientIp: req.headers['x-forwarded-for'] || req.ip,
    });

    res.status(201).json({
      status: 'success',
      data: {
        orderReference: order.order_reference,
        amount: Number(order.amount),
        currency: order.currency,
        productTitle: order.product_title,
        checkoutUrl: `${publicBase(req)}/api/payments/checkout/${order.order_reference}`,
        expiresAt: order.expires_at,
        simulated: !sa.isConfigured,
      },
    });
  } catch (err) {
    console.error('[payments] create order error:', err.message);
    // A bad amount is the caller's fault; a supplier failure is not.
    const clientError = /amount|email|required/i.test(err.message);
    res.status(clientError ? 400 : 502).json({ status: 'error', message: err.message });
  }
});

// ── GET /checkout/:ref ───────────────────────────────────────────────────────
// Browser lands here; we build the signed form from the DB row and submit it.
router.get('/checkout/:ref', async (req, res) => {
  try {
    const order = await paymentOrders.getOrderByReference(req.params.ref);
    if (!order) return res.status(404).send('Unknown payment order.');

    if (order.status === 'paid') {
      return res.redirect(`${FRONTEND_URL}/BookingPage?status=ACCEPT&order=${order.order_reference}`);
    }
    if (order.expires_at && new Date(order.expires_at) < new Date()) {
      return res.redirect(
        `${FRONTEND_URL}/BookingPage?status=ERROR&message=${encodeURIComponent('Payment session expired, please search again.')}`
      );
    }

    await paymentOrders.markRedirected(order.order_reference);

    const receiptUrl = process.env.CS_SA_RECEIPT_URL || `${publicBase(req)}/api/payments/receipt`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (sa.isConfigured) {
      const fields = sa.buildPaymentFields(order, { receiptUrl });
      return res.send(
        autoSubmitPage({ action: sa.endpoint(), fields, title: 'Redirecting to payment' })
      );
    }

    if (!simulatorEnabled()) {
      return res
        .status(503)
        .send('Payment gateway is not configured. Set CS_SA_PROFILE_ID, CS_SA_ACCESS_KEY and CS_SA_SECRET_KEY.');
    }

    return res.send(simulatorPage(order, receiptUrl));
  } catch (err) {
    console.error('[payments] checkout error:', err.message);
    res.status(500).send('Could not start the payment.');
  }
});

// ── POST /receipt ────────────────────────────────────────────────────────────
// CyberSource (or the local simulator) posts the outcome here.
router.post('/receipt', async (req, res) => {
  const body = req.body || {};
  // undefined lets verifyResponse fall back to the real Secure Acceptance secret.
  const verifySecret = sa.isConfigured ? undefined : SIM_SECRET;
  const signatureValid = sa.verifyResponse(body, verifySecret);

  const orderReference = body.req_merchant_defined_data1 || body.req_reference_number || '';
  const decision = String(body.decision || 'ERROR').toUpperCase();
  const gatewayRef = body.transaction_id || '';
  const message = body.message || '';
  const amount = parseFloat(body.auth_amount || body.req_amount || 0) || null;
  const currency = body.req_currency || 'EUR';

  // Always audit, including rejected callbacks - an invalid signature is exactly
  // the thing you want a record of.
  let attemptId = null;
  try {
    const audit = await pool.query(
      `INSERT INTO payment_attempts
         (transaction_uuid, decision, gateway, gateway_reference,
          amount, currency, message, raw_payload, signature_valid)
       VALUES ($1,$2,'cybersource',$3,$4,$5,$6,$7,$8)`,
      [
        body.req_transaction_uuid || '',
        signatureValid ? decision : 'INVALID_SIGNATURE',
        gatewayRef,
        amount,
        currency,
        message,
        JSON.stringify(body),
        signatureValid ? 1 : 0,
      ]
    );
    attemptId = audit.insertId || null;
  } catch (e) {
    console.error('[payments] attempt audit error:', e.message);
  }

  // Link only THIS attempt to a booking, and only once we know it was genuine.
  // A forged callback must never end up attached to a real booking.
  const linkAttemptToBooking = async (bookingId) => {
    if (!attemptId || !bookingId) return;
    try {
      await pool.query('UPDATE payment_attempts SET booking_id = $1 WHERE id = $2', [
        bookingId,
        attemptId,
      ]);
    } catch (e) {
      console.error('[payments] attempt link error:', e.message);
    }
  };

  if (!signatureValid) {
    console.error(`[payments] REJECTED unsigned/forged receipt for order ${orderReference}`);
    return res.redirect(
      `${FRONTEND_URL}/BookingPage?status=ERROR&message=${encodeURIComponent('Payment could not be verified.')}`
    );
  }

  const order = await paymentOrders.getOrderByReference(orderReference);
  if (!order) {
    console.error(`[payments] receipt for unknown order: ${orderReference}`);
    return res.redirect(
      `${FRONTEND_URL}/BookingPage?status=ERROR&message=${encodeURIComponent('Unknown payment order.')}`
    );
  }

  // The signed amount must match what we priced. A mismatch means the hosted
  // page was driven with a different figure than the one we authorised.
  if (amount != null && Math.abs(amount - Number(order.amount)) > 0.01) {
    console.error(
      `[payments] amount mismatch on ${orderReference}: gateway ${amount} vs order ${order.amount}`
    );
    await paymentOrders.markFailed(orderReference, 'ERROR', {
      gatewayReference: gatewayRef,
      message: `Amount mismatch: gateway ${amount}, order ${order.amount}`,
      gatewayPayload: body,
    });
    return res.redirect(
      `${FRONTEND_URL}/BookingPage?status=ERROR&message=${encodeURIComponent('Payment amount mismatch.')}`
    );
  }

  if (decision !== 'ACCEPT') {
    await paymentOrders.markFailed(orderReference, decision, {
      gatewayReference: gatewayRef,
      message,
      gatewayPayload: body,
    });
    return res.redirect(buildRedirect(order, { decision, gatewayRef, message }));
  }

  // Exactly one caller wins this; duplicates fall through to the redirect.
  const claimed = await paymentOrders.claimForFulfilment(orderReference, {
    gatewayReference: gatewayRef,
    message,
    gatewayPayload: body,
  });

  if (claimed) {
    try {
      const fresh = await paymentOrders.getOrderByReference(orderReference);
      const result = await fulfilment.fulfil(fresh, body);
      await linkAttemptToBooking(result.bookingId);
      console.log(
        `[payments] ${orderReference} -> booking ${result.bookingReference} (supplier: ${result.supplierStatus})`
      );
    } catch (err) {
      console.error(`[payments] fulfilment failed for ${orderReference}:`, err.message);
    }
  }

  const finalOrder = await paymentOrders.getOrderByReference(orderReference);
  // A duplicate callback is still a genuine attempt worth linking.
  if (!claimed) await linkAttemptToBooking(finalOrder?.booking_id);
  return res.redirect(buildRedirect(finalOrder, { decision, gatewayRef, message }));
});

function buildRedirect(order, { decision, gatewayRef, message }) {
  const STATUS_ID = { ACCEPT: '1', CANCEL: '3', DECLINE: '11', REVIEW: '12', ERROR: '13' };
  const params = new URLSearchParams({
    status: decision,
    status_id: STATUS_ID[decision] || '13',
    order: order?.order_reference || '',
    transaction_id: gatewayRef || '',
    message: message || '',
    type: order?.booking_type || 'hotel',
  });
  // These are Date objects from MySQL; String(date).slice(0,10) would emit
  // "Mon Nov 09" and toISOString() would shift the calendar day.
  const checkin = toDateOnly(order?.check_in_date);
  const checkout = toDateOnly(order?.check_out_date);
  if (checkin) params.set('checkin', checkin);
  if (checkout) params.set('checkout', checkout);
  return `${FRONTEND_URL}/BookingPage?${params.toString()}`;
}

// ── GET /orders/:ref ─────────────────────────────────────────────────────────
// Success page polls this to show the booking reference once fulfilment lands.
router.get('/orders/:ref', async (req, res) => {
  try {
    const order = await paymentOrders.getOrderByReference(req.params.ref);
    if (!order) return res.status(404).json({ status: 'error', message: 'Order not found' });

    let booking = null;
    if (order.booking_id) {
      const { rows } = await pool.query(
        `SELECT booking_reference, status, supplier_reference, supplier_status,
                product_title, check_in_date, check_out_date, payment_amount, currency
           FROM bookings WHERE id = $1`,
        [order.booking_id]
      );
      booking = rows[0] || null;
    }

    res.json({
      status: 'success',
      data: {
        orderReference: order.order_reference,
        paymentStatus: order.status,
        decision: order.decision,
        amount: Number(order.amount),
        currency: order.currency,
        message: order.gateway_message,
        booking,
      },
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ── local simulator ──────────────────────────────────────────────────────────
function simulatorPage(order, receiptUrl) {
  const base = {
    decision: 'ACCEPT',
    message: 'Request was processed successfully.',
    transaction_id: `SIM-${Date.now()}`,
    req_reference_number: order.order_reference,
    req_merchant_defined_data1: order.order_reference,
    req_transaction_uuid: order.transaction_uuid,
    req_amount: Number(order.amount).toFixed(2),
    auth_amount: Number(order.amount).toFixed(2),
    req_currency: order.currency,
    req_bill_to_forename: order.lead_first_name || '',
    req_bill_to_surname: order.lead_last_name || '',
    req_bill_to_email: order.lead_email || '',
  };

  // One signed field-set per outcome, so each button posts a properly signed
  // payload through the real verification path.
  const variant = (decision, msg) => {
    const fields = {
      ...base,
      decision,
      message: msg,
      signed_field_names: '',
    };
    fields.signed_field_names = [...Object.keys(fields).filter((k) => k !== 'signed_field_names'), 'signed_field_names'].join(',');
    fields.signature = sa.sign(fields, SIM_SECRET);
    return fields;
  };

  const forms = [
    { id: 'ok', cls: 'success', label: '&#10003; Payment SUCCESS', fields: variant('ACCEPT', 'Request was processed successfully.') },
    { id: 'no', cls: 'decline', label: '&#10007; DECLINE', fields: variant('DECLINE', 'Decline - insufficient funds.') },
    { id: 'ca', cls: 'cancel', label: '&#8617; CANCEL', fields: variant('CANCEL', 'Transaction cancelled by the customer.') },
  ]
    .map(
      (f) => `
    <form method="post" action="${esc(receiptUrl)}" style="flex:1;min-width:150px">
${Object.entries(f.fields).map(([k, v]) => `      <input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n')}
      <button type="submit" class="btn ${f.cls}">${f.label}</button>
    </form>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Payment Simulator - Holiday Seychelles</title>
<style>
 body{font-family:system-ui,Arial,sans-serif;max-width:600px;margin:50px auto;padding:20px;background:#f4f6fa;color:#223}
 .card{background:#fff;border:1px solid #dde1ea;border-radius:12px;padding:28px 32px;box-shadow:0 2px 10px rgba(0,0,0,.07)}
 .badge{display:inline-block;background:#ff9800;color:#fff;padding:4px 11px;border-radius:5px;font-size:.72rem;font-weight:700;letter-spacing:.4px}
 h2{margin:14px 0 2px;font-size:1.35rem}
 .amount{font-size:2.1rem;font-weight:700;color:#1a237e;margin:14px 0 2px}
 .detail{color:#556;font-size:.92rem;margin:3px 0}
 .ref{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;color:#778}
 hr{border:none;border-top:1px solid #eef0f4;margin:20px 0}
 .btns{display:flex;gap:10px;flex-wrap:wrap}
 .btn{width:100%;padding:13px 0;font-size:.95rem;font-weight:600;cursor:pointer;border:none;border-radius:7px;color:#fff}
 .btn:hover{opacity:.87}
 .success{background:#28a745}.decline{background:#dc3545}.cancel{background:#6c757d}
</style></head>
<body><div class="card">
  <span class="badge">TEST MODE - no real card is charged</span>
  <h2>${esc(order.product_title || 'Booking')}</h2>
  <div class="amount">${esc(Number(order.amount).toFixed(2))} ${esc(order.currency)}</div>
  <p class="detail">Guest: ${esc(order.lead_first_name)} ${esc(order.lead_last_name)}</p>
  <p class="detail">Email: ${esc(order.lead_email)}</p>
  <p class="detail ref">Order ${esc(order.order_reference)}</p>
  <hr>
  <p class="detail">Amount comes from the server-side order, not this page.</p>
  <div class="btns">${forms}</div>
</div></body></html>`;
}

module.exports = router;
