/**
 * CyberSource Secure Acceptance — payment form handler + receipt handler.
 *
 * Two modes (auto-detected from env):
 *
 * REAL MODE  (CS_SA_PROFILE_ID + CS_SA_ACCESS_KEY + CS_SA_SECRET_KEY all set):
 *   POST /  → builds a signed SA form and auto-submits to CyberSource test/live.
 *             CyberSource POSTs the result back to CS_SA_RECEIPT_URL.
 *
 * SIMULATION MODE  (credentials not set — default for local dev):
 *   POST /  → renders a local payment simulator page (no real charge).
 *             Clicking a button POSTs to /receipt on this server.
 *   POST /receipt  → creates the booking row, fires voucher email, redirects
 *                    the browser to the frontend BookingPage.
 *
 * Frontend sends the form to VITE_PAYMENT_GATEWAY_URL:
 *   dev  → http://localhost:5000/api/cybersourcetest
 *   prod → http://localhost:5000/api/cybersource  (or real domain)
 * Both paths are mounted to this same router in index.js.
 */

const express = require('express');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const { generateVoucherPDF } = require('../../utils/voucher');
const { sendVoucherEmail }   = require('../../utils/mailer');

const router = express.Router();

// CyberSource Secure Acceptance profile credentials
const CS_SA_PROFILE_ID  = process.env.CS_SA_PROFILE_ID  || '';
const CS_SA_ACCESS_KEY  = process.env.CS_SA_ACCESS_KEY  || '';
const CS_SA_SECRET_KEY  = process.env.CS_SA_SECRET_KEY  || '';
const hasRealCredentials = !!(CS_SA_PROFILE_ID && CS_SA_ACCESS_KEY && CS_SA_SECRET_KEY);

// ── helpers ──────────────────────────────────────────────────────────────────

function signFields(fields, secretKey) {
  const names = fields.signed_field_names.split(',');
  const data  = names.map(n => `${n}=${fields[n] || ''}`).join(',');
  return crypto.createHmac('sha256', secretKey).update(data).digest('base64');
}

function esc(val) {
  return String(val == null ? '' : val)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── POST / ────────────────────────────────────────────────────────────────────
// Receives payment form fields from PaymentWall.jsx (or PaymentWallTour.jsx).
// Builds a CyberSource SA form (real) or shows a local simulator (dev/no creds).
router.post('/', (req, res) => {
  const body        = req.body;
  const receiptUrl  = process.env.CS_SA_RECEIPT_URL ||
    `${req.protocol}://${req.get('host')}/api/cybersource/receipt`;

  if (hasRealCredentials) {
    // ── Real CyberSource Secure Acceptance ───────────────────────────────────
    const signedDateTime  = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const transactionUUID = body.transaction_uuid || uuidv4();

    const fields = {
      access_key:              CS_SA_ACCESS_KEY,
      profile_id:              CS_SA_PROFILE_ID,
      transaction_uuid:        transactionUUID,
      signed_date_time:        signedDateTime,
      locale:                  'en',
      transaction_type:        'sale',
      reference_number:        transactionUUID,
      amount:                  body.amount   || '0',
      currency:                body.currency || 'EUR',
      bill_to_forename:        body.bill_to_forename || '',
      bill_to_surname:         body.bill_to_surname  || '',
      bill_to_email:           body.bill_to_email    || '',
      bill_to_phone:           '0000000000',
      bill_to_address_line1:   'N/A',
      bill_to_address_city:    'N/A',
      bill_to_address_country: 'SC',
      override_custom_receipt_page: receiptUrl,
      // Booking metadata forwarded as merchant-defined-data so the receipt
      // handler can create the Node booking without a separate DB lookup.
      merchant_defined_data1:  body.hs_booking_type         || 'hotel',
      merchant_defined_data2:  body.hs_lead_email           || '',
      merchant_defined_data3:  body.hs_product_title        || '',
      merchant_defined_data4:  body.hs_product_code         || '',
      merchant_defined_data5:  body.hs_check_in_date        || '',
      merchant_defined_data6:  body.hs_check_out_date       || '',
      merchant_defined_data7:  body.hs_lead_first_name      || body.bill_to_forename || '',
      merchant_defined_data8:  body.hs_lead_last_name       || body.bill_to_surname  || '',
      merchant_defined_data9:  body.hs_lead_mobile          || '',
      merchant_defined_data10: body.hs_user_id              || '',
      merchant_defined_data11: body.hs_total_adults         || '1',
      merchant_defined_data12: body.hs_total_children       || '0',
      merchant_defined_data13: body.hs_is_refundable        || '1',
      merchant_defined_data14: body.hs_refund_window_hours  || '24',
    };

    const signedNames = Object.keys(fields).join(',');
    fields.signed_field_names   = signedNames;
    fields.unsigned_field_names = '';
    fields.signature = signFields({ ...fields, signed_field_names: signedNames }, CS_SA_SECRET_KEY);

    const csUrl = process.env.NODE_ENV === 'production'
      ? 'https://secureacceptance.cybersource.com/pay'
      : 'https://testsecureacceptance.cybersource.com/pay';

    const hiddenFields = Object.entries(fields)
      .map(([k, v]) => `  <input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('\n');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Redirecting to payment…</title></head>
<body>
<form id="cs" method="post" action="${esc(csUrl)}">
${hiddenFields}
</form>
<script>document.getElementById('cs').submit();</script>
</body></html>`);
  }

  // ── Simulation mode (no credentials — local development / testing) ────────
  const receiptTarget = `${req.protocol}://${req.get('host')}/api/cybersource/receipt`;
  const hiddenPassthrough = Object.entries(body)
    .map(([k, v]) => `      <input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Payment Simulator — Holiday Seychelles</title>
  <style>
    body{font-family:Arial,sans-serif;max-width:580px;margin:60px auto;padding:20px;background:#f4f6fa}
    .card{background:#fff;border:1px solid #dde1ea;border-radius:10px;padding:28px 32px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
    .badge{display:inline-block;background:#ff9800;color:#fff;padding:3px 10px;border-radius:4px;font-size:.72em;font-weight:700;margin-bottom:12px;letter-spacing:.5px}
    h2{margin:8px 0 4px;font-size:1.4em;color:#111}
    .amount{font-size:2.2em;font-weight:700;color:#1a237e;margin:12px 0 4px}
    .detail{color:#555;font-size:.93em;margin:3px 0}
    hr{border:none;border-top:1px solid #eee;margin:20px 0}
    .hint{color:#777;font-size:.87em;margin-bottom:18px}
    .btns{display:flex;gap:10px;flex-wrap:wrap}
    .btn{flex:1;padding:13px 0;font-size:.97em;font-weight:600;cursor:pointer;border:none;border-radius:6px;color:#fff;min-width:130px;transition:opacity .15s}
    .btn:hover{opacity:.86}
    .success{background:#28a745}.decline{background:#dc3545}.cancel{background:#6c757d}
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">TEST MODE — no real payment charged</span>
    <h2>Holiday Seychelles Payment Simulator</h2>
    <div class="amount">${esc(body.amount || '0')} ${esc(body.currency || 'EUR')}</div>
    <p class="detail">Guest: ${esc(body.bill_to_forename || '')} ${esc(body.bill_to_surname || '')}</p>
    <p class="detail">Email: ${esc(body.bill_to_email || '')}</p>
    <hr>
    <p class="hint">Choose a simulated payment outcome to test the full booking flow end-to-end:</p>
    <form id="sim" action="${receiptTarget}" method="post">
${hiddenPassthrough}
      <input type="hidden" name="req_transaction_uuid" value="${esc(body.transaction_uuid || '')}">
      <input type="hidden" name="req_amount"           value="${esc(body.amount || '0')}">
      <input type="hidden" name="req_currency"         value="${esc(body.currency || 'EUR')}">
      <input type="hidden" name="req_bill_to_forename" value="${esc(body.bill_to_forename || '')}">
      <input type="hidden" name="req_bill_to_surname"  value="${esc(body.bill_to_surname  || '')}">
      <input type="hidden" name="req_bill_to_email"    value="${esc(body.bill_to_email    || '')}">
      <input type="hidden" name="message"    id="msg-f"      value="Request was processed successfully.">
      <input type="hidden" name="decision"   id="decision-f" value="ACCEPT">
      <input type="hidden" name="transaction_id"       value="TEST-${Date.now()}">
      <div class="btns">
        <button type="submit" class="btn success"
          onclick="document.getElementById('decision-f').value='ACCEPT';document.getElementById('msg-f').value='Request was processed successfully.'">
          ✓ Payment SUCCESS
        </button>
        <button type="submit" class="btn decline"
          onclick="document.getElementById('decision-f').value='DECLINE';document.getElementById('msg-f').value='Decline — insufficient funds.'">
          ✗ DECLINE
        </button>
        <button type="submit" class="btn cancel"
          onclick="document.getElementById('decision-f').value='CANCEL';document.getElementById('msg-f').value='Transaction cancelled by user.'">
          ↩ CANCEL
        </button>
      </div>
    </form>
  </div>
</body>
</html>`);
});

// ── POST /receipt ─────────────────────────────────────────────────────────────
// Called by CyberSource (real mode) or the simulator (dev mode) after payment.
// Logs the attempt, creates the booking row on ACCEPT, then redirects to frontend.
router.post('/receipt', async (req, res) => {
  const body     = req.body;
  const decision = (body.decision || 'ERROR').toUpperCase();
  const txnUUID  = body.req_transaction_uuid || body.transaction_uuid || '';
  const txnId    = body.transaction_id || '';
  const amount   = parseFloat(body.req_amount || body.auth_amount || 0) || null;
  const currency = body.req_currency || 'EUR';
  const message  = body.message || '';

  // Frontend base URL for the final redirect
  const frontendUrl = (process.env.HS_FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');

  // ── 1. Audit every payment attempt ──────────────────────────────────────────
  try {
    await pool.query(
      `INSERT INTO payment_attempts
         (transaction_uuid, decision, gateway, gateway_reference,
          amount, currency, message, raw_payload)
       VALUES ($1, $2, 'cybersource', $3, $4, $5, $6, $7)`,
      [txnUUID, decision, txnId, amount, currency, message, JSON.stringify(body)]
    );
  } catch (e) {
    console.error('[cybersource receipt] payment_attempts log error:', e.message);
  }

  // ── 2. On ACCEPT: create booking row + fire-and-forget voucher email ────────
  if (decision === 'ACCEPT' && txnId) {
    try {
      // Idempotency — PHP may retry on transient errors
      const { rows: existing } = await pool.query(
        'SELECT id FROM bookings WHERE payment_reference = $1 LIMIT 1',
        [txnId]
      );

      if (existing.length === 0) {
        const leadFirst  = body.hs_lead_first_name || body.req_bill_to_forename || body.merchant_defined_data7 || 'Guest';
        const leadLast   = body.hs_lead_last_name  || body.req_bill_to_surname  || body.merchant_defined_data8 || 'Guest';
        const leadEmail  = body.hs_lead_email      || body.req_bill_to_email    || body.merchant_defined_data2 || '';
        const leadMobile = body.hs_lead_mobile     || body.merchant_defined_data9 || '0000000000';
        const bookingType= body.hs_booking_type    || body.merchant_defined_data1 || 'hotel';
        const userId     = parseInt(body.hs_user_id || body.merchant_defined_data10 || '0') || null;
        const checkIn    = body.hs_check_in_date   || body.merchant_defined_data5 || null;
        const checkOut   = body.hs_check_out_date  || body.merchant_defined_data6 || null;
        const adults     = parseInt(body.hs_total_adults   || body.merchant_defined_data11 || '1');
        const children   = parseInt(body.hs_total_children || body.merchant_defined_data12 || '0');
        const refundable = (body.hs_is_refundable   || body.merchant_defined_data13 || '1') !== '0';
        const refundHrs  = parseInt(body.hs_refund_window_hours || body.merchant_defined_data14 || '24');

        const bookingReference = `BS-${Date.now()}-${uuidv4().slice(0, 8).toUpperCase()}`;
        const { rows: inserted } = await pool.query(
          `INSERT INTO bookings (
             booking_reference, user_id, booking_type, status, payment_status,
             lead_first_name, lead_last_name, lead_email, lead_mobile,
             product_title, product_code, check_in_date, check_out_date, travel_date,
             total_travellers, total_adults, total_children,
             payment_amount, currency, payment_gateway, payment_reference,
             details, is_refundable, refund_window_hours
           ) VALUES (
             $1,$2,$3,'confirmed','paid',$4,$5,$6,$7,$8,$9,$10,$11,$12,
             $13,$14,$15,$16,$17,'cybersource',$18,$19,$20,$21
           ) RETURNING id`,
          [
            bookingReference, userId, bookingType,
            leadFirst, leadLast, leadEmail, leadMobile,
            body.hs_product_title || body.merchant_defined_data3 || 'Booking',
            body.hs_product_code  || body.merchant_defined_data4 || null,
            checkIn, checkOut,
            body.hs_travel_date || checkIn,
            adults + children, adults, children,
            amount || 0, currency, txnId,
            JSON.stringify({ gateway: 'cybersource', raw: body }),
            refundable, refundHrs,
          ]
        );

        // Fire-and-forget: generate PDF voucher and email to lead guest
        const bookingId = inserted[0].id;
        setImmediate(async () => {
          try {
            const { rows: bRows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
            if (!bRows.length) return;
            const booking = bRows[0];
            const { absolutePath, relativePath } = await generateVoucherPDF(booking);
            await pool.query(
              'UPDATE bookings SET voucher_path = $1, voucher_generated_at = NOW() WHERE id = $2',
              [relativePath, bookingId]
            );
            if (booking.lead_email) await sendVoucherEmail(booking, absolutePath);
          } catch (e) {
            console.error('[cybersource receipt] voucher/email error:', e.message);
          }
        });
      }
    } catch (e) {
      console.error('[cybersource receipt] booking create error:', e.message);
    }
  }

  // ── 3. Redirect browser to frontend result page ────────────────────────────
  const STATUS_MAP = { ACCEPT: '1', CANCEL: '3', DECLINE: '11', ERROR: '13', REVIEW: '12' };
  const params = new URLSearchParams({
    status:         decision,
    status_id:      STATUS_MAP[decision] || '13',
    transaction_id: txnId,
    message,
    type:           body.hs_booking_type || body.merchant_defined_data1 || 'hotel',
  });

  const checkInDate  = body.hs_check_in_date  || body.merchant_defined_data5;
  const checkOutDate = body.hs_check_out_date || body.merchant_defined_data6;
  if (checkInDate)  params.set('checkin',  checkInDate);
  if (checkOutDate) params.set('checkout', checkOutDate);

  res.redirect(`${frontendUrl}/BookingPage?${params.toString()}`);
});

module.exports = router;
