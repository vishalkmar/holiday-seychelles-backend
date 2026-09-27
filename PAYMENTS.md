# Payments — Holiday Seychelles

Written for: whoever configures and operates the payment gateway.

## How a payment works now

```
Pay Now (React)
   └─> POST /api/payments/orders          backend prices the booking against
                                          TourVisio and stores a payment_orders row
   └─> GET  /api/payments/checkout/:ref   backend builds the SIGNED CyberSource
                                          form from that row, auto-submits it
   └─> CyberSource hosted page            customer enters card, 3-D Secure runs here
   └─> POST /api/payments/receipt         signature verified, then:
                                            • payment_attempts row  (always)
                                            • payment_orders -> paid (atomic claim)
                                            • bookings row          (once)
                                            • voucher PDF + email
   └─> redirect to /BookingPage?status=ACCEPT&order=…
```

The browser never carries the amount. It only carries an order reference.

## Status

Verified working against the CyberSource **test** environment on 2026-09-25: a
full card payment ran through Billing → Payment → Review, the signed receipt
was verified, and the booking, payment_attempt and voucher were all written.

## Turning on the real gateway

All three values come from the **Business Center**
(`ebc2.cybersource.com` → **Payment Configuration → Secure Acceptance →**
your *Hosted Checkout* profile → **Security Keys** → create/view key):

```ini
CS_SA_PROFILE_ID=...     # the profile's Profile ID (a GUID)
CS_SA_ACCESS_KEY=...     # 32-char hex from the security key
CS_SA_SECRET_KEY=...     # long base64-looking string from the same key
CS_SA_LIVE=false         # false = testsecureacceptance..., true = secureacceptance...
```

The moment those three are non-empty the local simulator switches off
automatically and real cards are used. Nothing else changes.

**Make sure you have the right kind of key.** CyberSource issues two unrelated
credential types and they are not interchangeable:

| | Secure Acceptance (what this needs) | REST API (refunds only) |
|---|---|---|
| Where | Payment Configuration → Secure Acceptance Settings → profile → **Security** tab | Key Management |
| Access/Key id | 32-char hex | GUID |
| Secret | 256-char hex | base64, in a `.pem` |
| Delivery | shown on screen once, no download | `.pem` file download |

If the file you were handed is a `.pem` containing `Key:` and
`Shared Secret Key:` wrapped in `-----BEGIN PUBLIC KEY-----`, that is a REST key
— it belongs in `CYBERSOURCE_API_KEY` / `CYBERSOURCE_SECRET_KEY`, not here.

Also set the receipt URL to the **new** route — the legacy value silently
overrides the default and sends results to the old unverified handler:

```ini
CS_SA_RECEIPT_URL=https://<your-api-host>/api/payments/receipt
```

### Reading CyberSource's reply when testing the handoff

| Response to `POST /pay` | Meaning |
|---|---|
| `302 → /billing` | Credentials and signature accepted |
| `403 Forbidden` | Access key not recognised, or profile not Activated |
| `200` with an error page | Signature mismatch |

A deliberately wrong access key returns the same 403, so a 403 never points at
the signing code.

Two settings inside the Secure Acceptance profile must match this deployment:

| Profile setting | Value |
|---|---|
| Custom Receipt Page | `https://<your-api-host>/api/payments/receipt` |
| Custom Cancel Page | `https://<your-api-host>/api/payments/receipt` |

CyberSource must be able to reach that URL from the public internet. For local
testing use an ngrok tunnel and set `CS_SA_RECEIPT_URL` to the tunnel URL.

### Test cards (CAS / test environment)

`4111 1111 1111 1111`, any future expiry, CVN `123`.

**The sandbox decides the outcome from the AMOUNT, not the card.** Measured on
this account 2026-09-25, holding the card, address and expiry constant:

| Amount | Result |
|---|---|
| 1, 2, 5, 9, 10, 11, 20, 50, 59, 59.99 | ACCEPT |
| **60.00** | **DECLINED** |
| 60.01, 61, 99, 100, 101, 160, 260, 500, 1000, 1060 | ACCEPT |

So "Your order was declined. Please verify your information." on a 60.00 test
payment is the sandbox simulating a decline on purpose - it is not a fault in
the integration, the credentials or the billing address. Test with any other
amount. Billing country, city, postcode and expiry made no difference.

Verified at the same time: a declined transaction correctly leaves the order
unpaid and creates **no** booking row.

## About the Cardinal → Visa Data Centre migration notice

**No code change is required for this integration.**

That notice applies to merchants who run Payer Authentication themselves —
Direct/Cruise API, Songbird JS, the Mobile SDK, or Cruise Standard. This site
uses **Secure Acceptance Hosted Checkout**, so 3-D Secure runs inside
CyberSource's own hosted page. We never call `cardinaltrusted.com`, so there is
nothing to trust-list and no endpoint of ours to repoint.

Worth doing anyway: ask Cybersource support to confirm in writing which Payer
Authentication integration type is attached to the merchant ID, since their
notice said they could not determine it. If they answer anything other than
"hosted / Secure Acceptance", revisit this.

Separately, CyberSource is steering new integrations toward **Unified
Checkout**. Secure Acceptance has no announced end-of-life date, so this is a
future migration, not an urgent one.

## Supplier settlement (`TOURVISIO_AUTO_COMMIT`)

TourVisio refuses to confirm a reservation it considers unpaid —
`committransaction` on its own returns `PaymentFailure`. The only payment method
this B2C account exposes is **AGENCYCREDIT** (the agency's prepaid balance);
there is no customer-card gateway on TourVisio's side. So the money moves in two
separate legs:

1. **Customer → us**, by card, through CyberSource.
2. **Us → TourVisio**, from the agency credit balance, to confirm the booking.

`TOURVISIO_AUTO_COMMIT=false` (the default) performs leg 1 only. Paid bookings
are written with `supplier_status = awaiting_agency_payment` and
`status = pending_supplier`, for an operator to confirm.

Set it to `true` only once the agency balance is funded. Every successful card
payment will then immediately spend real agency credit and create a real
supplier reservation.

If the supplier leg fails, **the booking row is still written** — the customer's
card has already been charged, and losing that record would be worse than a
booking that needs manual follow-up. Check `supplier_status`:

| `supplier_status` | Meaning |
|---|---|
| `confirmed` | Reservation confirmed, `supplier_reference` holds the number |
| `not_applicable` | No supplier leg (tour/transfer/cart flows) |
| `awaiting_agency_payment` | `TOURVISIO_AUTO_COMMIT` is off — confirm manually |
| `commit_failed` | Supplier rejected it — **customer has paid**, needs action |
| `commit_unconfirmed` | Paid, but no reservation number came back — verify manually |

## Scheduled customer emails

One cron sweep every morning, in `services/notifications.js`:

| Job | When | Email |
|---|---|---|
| Abandoned checkout | order pending for `PENDING_REMINDER_AFTER_HOURS` (2) up to `PENDING_REMINDER_UNTIL_DAYS` (7) | "You left something behind" + Complete payment link |
| Trip in 2 days | check-in / travel date is `CURDATE() + 2` | reminder |
| Trip today | date is today | reminder |
| Post stay | day after check-out | thank-you |

Payment-success email (voucher attached) still fires inline on fulfilment, not
from the sweep.

```ini
NOTIFICATIONS_ENABLED=true
NOTIFICATIONS_CRON=0 8 * * *
NOTIFICATIONS_TZ=Indian/Mahe
```

Every send is written to `email_notifications`, which is what makes a daily job
safe to re-run: the unique keys mean a guest gets each reminder once. Trigger a
sweep by hand with:

```js
require('./src/services/notifications').runDailySweep()
```

## Price authority — known gap

The **hotel** flow sends an `offerId`, so the backend re-prices against
TourVisio `begintransaction` and ignores whatever the browser claimed. Verified:
a client claiming €1.00 is still charged the supplier's €150.

The **tour, transfer and cart** flows have no TourVisio offer id — they are
priced by the legacy Lambda APIs. For those the backend falls back to
`quotedAmount` from the client, so a crafted request could still create an order
for the wrong amount. Closing this means re-pricing server-side against those
same Lambda endpoints before the order is written.

## Operational notes

- **Order expiry** — `PAYMENT_ORDER_TTL_MINUTES` (default 25). An expired order
  cannot be paid; the customer is sent back to search.
- **Duplicate callbacks** — handled. Fulfilment is claimed with a conditional
  `UPDATE`, so only one caller ever creates the booking.
- **Forged callbacks** — rejected and recorded in `payment_attempts` with
  `decision = 'INVALID_SIGNATURE'` and `signature_valid = 0`. They are never
  linked to a booking.
- **Local simulator** — runs only when the CS keys are empty *and*
  `NODE_ENV !== 'production'`. It signs its own callbacks, so the signature
  verification path is exercised in development too; there is no "skip the
  check" branch.
- The legacy `/api/cybersource` route is still mounted but is no longer the
  entry point for any page.
