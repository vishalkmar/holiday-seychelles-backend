/**
 * Shared filter builder for the admin bookings screens.
 *
 * The list, the stat strip and the CSV export must never disagree about what
 * "the current view" means — if the strip says 12 bookings the export has to
 * contain 12 rows. They all build their WHERE clause from here.
 */

/** Named date ranges the UI offers, resolved to SQL dates. */
const PERIODS = {
  today: "DATE(b.created_at) = CURDATE()",
  yesterday: "DATE(b.created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)",
  last7: "b.created_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)",
  last30: "b.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)",
  this_month: "b.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
  last_month:
    "b.created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') " +
    "AND b.created_at < DATE_FORMAT(CURDATE(), '%Y-%m-01')",
  last3: "b.created_at >= DATE_SUB(CURDATE(), INTERVAL 3 MONTH)",
  last6: "b.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)",
  this_year: "YEAR(b.created_at) = YEAR(CURDATE())",
  last_year: "YEAR(b.created_at) = YEAR(CURDATE()) - 1",
};

/**
 * Saved views — one-click versions of filter combinations operators reach for
 * constantly. They are presets, not a separate query path.
 */
const SAVED_VIEWS = {
  all: {},
  awaiting_payment: { payment_status: 'unpaid' },
  needs_supplier: { supplier_status: 'problem' },
  upcoming: { travel: 'upcoming' },
  cancelled: { status: 'cancelled' },
  refunded: { status: 'refunded' },
};

/**
 * Turn query params into a WHERE clause plus ordered params.
 * Returns `{ where, params }` where `where` already includes the WHERE keyword
 * (or is an empty string).
 */
function buildBookingFilter(query = {}) {
  // A saved view just seeds the same filters the user could pick by hand.
  const view = SAVED_VIEWS[query.view] || {};
  const q = { ...view, ...stripEmpty(query) };

  const conditions = [];
  const params = [];

  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  if (q.status) {
    if (q.status === 'active') conditions.push("b.status NOT IN ('cancelled','refunded')");
    else add('b.status = ?', q.status);
  }

  if (q.payment_status) {
    if (q.payment_status === 'unpaid') conditions.push("b.payment_status <> 'paid'");
    else add('b.payment_status = ?', q.payment_status);
  }

  if (q.booking_type) add('b.booking_type = ?', q.booking_type);

  if (q.supplier_status) {
    if (q.supplier_status === 'problem') {
      conditions.push(
        "b.supplier_status IN ('commit_failed','commit_unconfirmed','awaiting_agency_payment')"
      );
    } else {
      add('b.supplier_status = ?', q.supplier_status);
    }
  }

  // Travel window, as opposed to when the booking was made.
  if (q.travel === 'upcoming') {
    conditions.push('DATE(COALESCE(b.check_in_date, b.travel_date)) >= CURDATE()');
  } else if (q.travel === 'past') {
    conditions.push(
      'DATE(COALESCE(b.check_out_date, b.check_in_date, b.travel_date)) < CURDATE()'
    );
  } else if (q.travel === 'today') {
    conditions.push('DATE(COALESCE(b.check_in_date, b.travel_date)) = CURDATE()');
  }

  // Booking date: a named period, or an explicit from/to.
  if (q.period && PERIODS[q.period]) {
    conditions.push(PERIODS[q.period]);
  }
  if (q.from) add('DATE(b.created_at) >= ?', q.from);
  if (q.to) add('DATE(b.created_at) <= ?', q.to);

  if (q.min_amount) add('b.payment_amount >= ?', Number(q.min_amount));
  if (q.max_amount) add('b.payment_amount <= ?', Number(q.max_amount));

  if (q.search) {
    const term = `%${q.search}%`;
    // One placeholder reused across the OR branches keeps the param list short.
    params.push(term);
    const p = `$${params.length}`;
    conditions.push(
      `(b.booking_reference LIKE ${p} OR b.lead_email LIKE ${p} OR b.lead_first_name LIKE ${p} ` +
        `OR b.lead_last_name LIKE ${p} OR b.lead_mobile LIKE ${p} OR b.product_title LIKE ${p} ` +
        `OR b.payment_reference LIKE ${p} OR b.supplier_reference LIKE ${p})`
    );
  }

  return {
    where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/** Whitelisted sort columns — never interpolate a client string into ORDER BY. */
const SORTS = {
  created_desc: 'b.created_at DESC',
  created_asc: 'b.created_at ASC',
  amount_desc: 'b.payment_amount DESC',
  amount_asc: 'b.payment_amount ASC',
  travel_asc: 'COALESCE(b.check_in_date, b.travel_date) ASC',
  travel_desc: 'COALESCE(b.check_in_date, b.travel_date) DESC',
};

function buildSort(sort) {
  return SORTS[sort] || SORTS.created_desc;
}

function stripEmpty(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
}

module.exports = { buildBookingFilter, buildSort, PERIODS, SAVED_VIEWS, SORTS };
