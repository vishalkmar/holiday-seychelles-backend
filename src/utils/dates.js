/**
 * Calendar-day formatting.
 *
 * `new Date('2026-11-10T00:00:00').toISOString().slice(0,10)` yields 2026-11-09
 * anywhere east of UTC, because the timestamp is parsed as local time and then
 * rendered as UTC. Check-in dates are calendar days, not instants, so they must
 * never round-trip through UTC.
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Format a Date/string as YYYY-MM-DD using its own calendar day. */
function toDateOnly(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

  const str = String(value);
  // Already a date-only prefix - take it verbatim, no parsing, no shifting.
  const direct = str.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];

  const d = new Date(str);
  if (!Number.isFinite(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = { toDateOnly };
