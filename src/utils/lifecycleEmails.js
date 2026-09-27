/**
 * Lifecycle emails: the ones that fire on a schedule rather than on an action.
 *
 *   payment_pending    checkout was started but never completed
 *   trip_reminder_2d   two days before departure / check-in
 *   trip_today         the morning of the trip
 *   post_stay          the day after it ends - thank you + review nudge
 *
 * Every one of these goes to the address the booking was made with. Sending is
 * logged by the caller (services/notifications.js) so a guest never receives
 * the same reminder twice.
 *
 * These are the FALLBACK wording. If an enabled row exists in `email_templates`
 * for the same key, services/emailTemplates.js renders that instead - so an
 * admin edit changes the real email, and a missing or broken template row is
 * never an outage.
 */

const {
  DARK,
  frontendUrl,
  fmtDate,
  money,
  guestName,
  layout,
  detailTable,
  referenceBlock,
  deliver,
} = require('./emailLayout');

/** Checkout started, payment never finished. */
async function sendPendingPaymentEmail(order) {
  const resumeUrl = `${frontendUrl()}/dashboard?tab=transactions&resume=${encodeURIComponent(
    order.order_reference
  )}`;

  const body = `
    <p style="margin:0 0 16px; font-size:15px; color:${DARK};">Hi <strong>${guestName(order)}</strong>,</p>
    <p style="margin:0 0 6px; font-size:14px; color:#334155; line-height:1.6;">
      You started booking <strong>${order.product_title || 'a trip'}</strong> with us but the payment
      wasn't completed, so nothing has been charged and the booking isn't held yet.
    </p>
    ${referenceBlock('Order reference', order.order_reference)}
    ${detailTable([
      ['Item', order.product_title],
      ['Travel date', fmtDate(order.check_in_date || order.travel_date)],
      ['Amount', money(order.amount, order.currency)],
    ])}
    <p style="margin:18px 0 0; font-size:13px; color:#64748b;">
      Prices and availability can change, so it's worth finishing soon.
    </p>`;

  return deliver(
    {
      to: order.lead_email,
      subject: `Your booking is waiting · ${order.product_title || 'Holiday Seychelles'}`,
      html: layout({
        subheading: 'Incomplete payment',
        heading: 'You left something behind',
        body,
        cta: { href: resumeUrl, label: 'Complete payment' },
        accent: '#D97706',
      }),
      text:
        `Hi ${guestName(order)},\n\n` +
        `Your booking for ${order.product_title} was not completed and no payment was taken.\n` +
        `Order: ${order.order_reference}\nAmount: ${money(order.amount, order.currency)}\n\n` +
        `Complete it here: ${resumeUrl}\n\nHoliday Seychelles`,
    },
    'pending payment reminder',
    order.lead_email
  );
}

/** Two days to go. */
async function sendTripReminderEmail(booking, { daysToGo }) {
  const when = fmtDate(booking.check_in_date || booking.travel_date);
  const isToday = daysToGo === 0;

  const body = `
    <p style="margin:0 0 16px; font-size:15px; color:${DARK};">Hi <strong>${guestName(booking)}</strong>,</p>
    <p style="margin:0 0 6px; font-size:14px; color:#334155; line-height:1.6;">
      ${
        isToday
          ? `Today's the day — your booking with us starts today. We hope you have a wonderful time.`
          : `Just a reminder that your trip is coming up in <strong>2 days</strong>.`
      }
    </p>
    ${referenceBlock('Booking reference', booking.booking_reference)}
    ${detailTable([
      ['Item', booking.product_title],
      [isToday ? 'Starts' : 'Check-in', when],
      ['Check-out', fmtDate(booking.check_out_date)],
      ['Travellers', booking.total_travellers],
      ['Supplier reference', booking.supplier_reference],
    ])}
    <p style="margin:18px 0 0; font-size:13px; color:#64748b;">
      Please carry your voucher — you can download it any time from your dashboard.
    </p>`;

  return deliver(
    {
      to: booking.lead_email,
      subject: isToday
        ? `Today: ${booking.product_title || 'your trip'} · ${booking.booking_reference}`
        : `In 2 days: ${booking.product_title || 'your trip'} · ${booking.booking_reference}`,
      html: layout({
        subheading: isToday ? 'Your trip starts today' : 'Trip reminder',
        heading: isToday ? 'Your trip starts today' : 'Your trip is in 2 days',
        body,
        cta: { href: `${frontendUrl()}/dashboard?tab=trips`, label: 'View my trip' },
      }),
      text:
        `Hi ${guestName(booking)},\n\n` +
        `${isToday ? 'Your trip starts today.' : 'Your trip is in 2 days.'}\n` +
        `Booking: ${booking.booking_reference}\nItem: ${booking.product_title}\nDate: ${when}\n\n` +
        `Holiday Seychelles`,
    },
    isToday ? 'trip-today reminder' : 'trip 2-day reminder',
    booking.lead_email
  );
}

/** The day after it ends. */
async function sendPostStayEmail(booking) {
  const body = `
    <p style="margin:0 0 16px; font-size:15px; color:${DARK};">Hi <strong>${guestName(booking)}</strong>,</p>
    <p style="margin:0 0 6px; font-size:14px; color:#334155; line-height:1.6;">
      We hope you had a wonderful time at <strong>${booking.product_title || 'your stay'}</strong>.
      Thank you for choosing Holiday Seychelles — it was a pleasure having you with us.
    </p>
    ${referenceBlock('Booking reference', booking.booking_reference, '#059669')}
    ${detailTable([
      ['Item', booking.product_title],
      ['Stayed', `${fmtDate(booking.check_in_date)}${booking.check_out_date ? ' → ' + fmtDate(booking.check_out_date) : ''}`],
    ])}
    <p style="margin:18px 0 0; font-size:14px; color:#334155; line-height:1.6;">
      If you have a moment, we'd love to hear how it went — and we'd be delighted to help plan
      your next trip to the islands.
    </p>`;

  return deliver(
    {
      to: booking.lead_email,
      subject: `Thank you for travelling with us · ${booking.booking_reference}`,
      html: layout({
        subheading: 'Thank you',
        heading: 'Thank you for travelling with us',
        body,
        cta: { href: `${frontendUrl()}/dashboard?tab=queries`, label: 'Share your feedback' },
        accent: '#059669',
      }),
      text:
        `Hi ${guestName(booking)},\n\n` +
        `We hope you had a wonderful time at ${booking.product_title}.\n` +
        `Booking: ${booking.booking_reference}\n\n` +
        `Thank you for choosing Holiday Seychelles.`,
    },
    'post-stay thank you',
    booking.lead_email
  );
}

module.exports = {
  sendPendingPaymentEmail,
  sendTripReminderEmail,
  sendPostStayEmail,
};
