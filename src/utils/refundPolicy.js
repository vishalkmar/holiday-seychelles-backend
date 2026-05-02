/**
 * Refund eligibility helper.
 *
 * Rules:
 *   - is_refundable === false           → never refundable
 *   - refund_window_hours > 0           → eligible if (now - paid_at) <= window
 *   - refund_window_hours === 0         → never refundable (post-purchase)
 *   - already refunded / cancelled      → not eligible
 *
 * `paidAt` falls back to created_at because that's when CyberSource confirmed
 * the charge in our flow.
 */
function evaluateRefund(booking, now = new Date()) {
  if (!booking) return { eligible: false, reason: 'Booking not found' };

  if (booking.payment_status === 'refunded' || booking.status === 'refunded') {
    return { eligible: false, reason: 'Already refunded', alreadyRefunded: true };
  }
  if (booking.status === 'cancelled') {
    return { eligible: false, reason: 'Booking already cancelled' };
  }
  if (booking.payment_status !== 'paid') {
    return { eligible: false, reason: `Only paid bookings can be refunded (current: ${booking.payment_status || 'pending'})` };
  }
  if (booking.is_refundable === false) {
    return { eligible: false, reason: 'Item marked non-refundable at booking time' };
  }

  const windowHours = Number(booking.refund_window_hours ?? 24);
  if (windowHours <= 0) {
    return { eligible: false, reason: 'Refund window is 0 hours for this booking' };
  }

  const paidAt = booking.created_at ? new Date(booking.created_at) : null;
  if (!paidAt) {
    // Conservative: if we don't know when it was paid, allow admin to override.
    return { eligible: true, reason: 'No paid_at timestamp; admin discretion', windowHours, hoursElapsed: null };
  }

  const hoursElapsed = (now.getTime() - paidAt.getTime()) / (1000 * 60 * 60);
  if (hoursElapsed > windowHours) {
    return {
      eligible: false,
      reason: `Refund window expired (${hoursElapsed.toFixed(1)}h elapsed > ${windowHours}h limit)`,
      windowHours,
      hoursElapsed,
      expired: true,
    };
  }

  return { eligible: true, windowHours, hoursElapsed };
}

module.exports = { evaluateRefund };
