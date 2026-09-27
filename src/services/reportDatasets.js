/**
 * What a report can be built from.
 *
 * One definition per dataset, used by the preview, the CSV, the PDF and the
 * scheduled email alike. That is the whole point: a preview showing 12 rows and
 * an export containing 40 would make every report untrustworthy, so there is
 * exactly one place where a dataset's columns, filters and SQL live.
 *
 * Nothing here interpolates a client value into SQL. Columns are chosen from a
 * fixed list by key, filters are whitelisted, and sorting comes from a map — a
 * report builder is otherwise a very polite way to ask for SQL injection.
 */

const { pool } = require('../config/db');
const { runLimited } = require('../utils/concurrency');

/** Hard ceiling. A report is for reading, not for cloning the database. */
const MAX_ROWS = Number(process.env.REPORT_MAX_ROWS || 10000);
const PREVIEW_ROWS = 25;

const money = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2));
const plain = (v) => (v === null || v === undefined ? '' : String(v));

function isoDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

function isoDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19).replace('T', ' ') : '';
}

/**
 * Resolve a named range to real dates.
 *
 * Named ranges are resolved at RUN time, never stored as dates — otherwise a
 * scheduled "last 30 days" would freeze on the day it was created.
 */
function resolveRange(range, from, to) {
  const today = new Date();
  const day = (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  const monthStart = (offset = 0) => {
    const d = new Date(today.getFullYear(), today.getMonth() - offset, 1);
    return d.toISOString().slice(0, 10);
  };
  const monthEnd = (offset = 0) => {
    const d = new Date(today.getFullYear(), today.getMonth() - offset + 1, 0);
    return d.toISOString().slice(0, 10);
  };

  switch (range) {
    case 'today':
      return { from: day(0), to: day(0), label: 'Today' };
    case 'yesterday':
      return { from: day(1), to: day(1), label: 'Yesterday' };
    case 'last7':
      return { from: day(6), to: day(0), label: 'Last 7 days' };
    case 'last30':
      return { from: day(29), to: day(0), label: 'Last 30 days' };
    case 'last90':
      return { from: day(89), to: day(0), label: 'Last 90 days' };
    case 'this_month':
      return { from: monthStart(0), to: day(0), label: 'This month' };
    case 'last_month':
      return { from: monthStart(1), to: monthEnd(1), label: 'Last month' };
    case 'this_year':
      return { from: `${today.getFullYear()}-01-01`, to: day(0), label: 'This year' };
    case 'all':
      return { from: null, to: null, label: 'All time' };
    case 'custom':
      return { from: from || null, to: to || null, label: `${from || 'start'} to ${to || 'now'}` };
    default:
      return { from: day(29), to: day(0), label: 'Last 30 days' };
  }
}

const RANGES = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_year', label: 'This year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range…' },
];

// ── Datasets ─────────────────────────────────────────────────────────────────

const DATASETS = {
  bookings: {
    label: 'Bookings',
    description: 'Every booking, with its money and its travel dates.',
    dateColumn: 'b.created_at',
    dateLabel: 'Booked on',
    from: `FROM bookings b LEFT JOIN users u ON u.id = b.user_id`,
    columns: [
      { key: 'reference', label: 'Reference', sql: 'b.booking_reference', format: plain },
      { key: 'booked_on', label: 'Booked on', sql: 'b.created_at', format: isoDateTime },
      { key: 'guest', label: 'Guest', sql: "TRIM(CONCAT(COALESCE(b.lead_first_name,''),' ',COALESCE(b.lead_last_name,'')))", format: plain },
      { key: 'email', label: 'Email', sql: 'b.lead_email', format: plain },
      { key: 'phone', label: 'Phone', sql: 'b.lead_mobile', format: plain },
      { key: 'product', label: 'Item', sql: 'b.product_title', format: plain },
      { key: 'type', label: 'Type', sql: 'b.booking_type', format: plain },
      { key: 'status', label: 'Status', sql: 'b.status', format: plain },
      { key: 'payment_status', label: 'Payment', sql: 'b.payment_status', format: plain },
      { key: 'amount', label: 'Amount', sql: 'b.payment_amount', format: money, numeric: true },
      { key: 'refunded', label: 'Refunded', sql: 'b.refund_amount', format: money, numeric: true },
      { key: 'currency', label: 'Currency', sql: 'b.currency', format: plain },
      { key: 'check_in', label: 'Check-in', sql: 'b.check_in_date', format: isoDate },
      { key: 'check_out', label: 'Check-out', sql: 'b.check_out_date', format: isoDate },
      { key: 'travellers', label: 'Travellers', sql: 'b.total_travellers', format: plain, numeric: true },
      { key: 'supplier_ref', label: 'Supplier ref', sql: 'b.supplier_reference', format: plain },
      { key: 'supplier_status', label: 'Supplier status', sql: 'b.supplier_status', format: plain },
      { key: 'registered', label: 'Has account', sql: "CASE WHEN u.id IS NULL THEN 'no' ELSE 'yes' END", format: plain },
    ],
    defaultColumns: ['reference', 'booked_on', 'guest', 'email', 'product', 'status', 'payment_status', 'amount', 'currency', 'check_in'],
    filters: {
      status: { label: 'Status', sql: 'b.status = ?', options: ['pending', 'confirmed', 'completed', 'cancelled', 'refunded', 'pending_supplier'] },
      payment_status: { label: 'Payment', sql: 'b.payment_status = ?', options: ['paid', 'pending', 'failed', 'refunded'] },
      booking_type: { label: 'Type', sql: 'b.booking_type = ?', options: ['hotel', 'tour', 'transfer', 'package'] },
    },
    sorts: {
      newest: 'b.created_at DESC',
      oldest: 'b.created_at ASC',
      amount: 'b.payment_amount DESC',
      travel: 'COALESCE(b.check_in_date, b.travel_date) ASC',
    },
    totals: [
      { key: 'amount', label: 'Total amount', sql: "COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.payment_amount ELSE 0 END), 0)", money: true },
      { key: 'refunded', label: 'Total refunded', sql: 'COALESCE(SUM(b.refund_amount), 0)', money: true },
      { key: 'travellers', label: 'Travellers', sql: 'COALESCE(SUM(b.total_travellers), 0)' },
    ],
  },

  transactions: {
    label: 'Payments',
    description: 'Every checkout that was started, paid or abandoned.',
    dateColumn: 'o.created_at',
    dateLabel: 'Started',
    from: `FROM payment_orders o LEFT JOIN bookings b ON b.id = o.booking_id`,
    columns: [
      { key: 'order_ref', label: 'Order', sql: 'o.order_reference', format: plain },
      { key: 'created', label: 'Started', sql: 'o.created_at', format: isoDateTime },
      { key: 'paid_at', label: 'Paid at', sql: 'o.paid_at', format: isoDateTime },
      { key: 'customer', label: 'Customer', sql: "TRIM(CONCAT(COALESCE(o.lead_first_name,''),' ',COALESCE(o.lead_last_name,'')))", format: plain },
      { key: 'email', label: 'Email', sql: 'o.lead_email', format: plain },
      { key: 'product', label: 'Item', sql: 'o.product_title', format: plain },
      { key: 'amount', label: 'Amount', sql: 'o.amount', format: money, numeric: true },
      { key: 'currency', label: 'Currency', sql: 'o.currency', format: plain },
      { key: 'status', label: 'Status', sql: 'o.status', format: plain },
      { key: 'decision', label: 'Gateway decision', sql: 'o.decision', format: plain },
      { key: 'gateway', label: 'Gateway', sql: 'o.gateway', format: plain },
      { key: 'gateway_ref', label: 'Gateway reference', sql: 'o.gateway_reference', format: plain },
      { key: 'booking_ref', label: 'Booking', sql: 'b.booking_reference', format: plain },
    ],
    defaultColumns: ['order_ref', 'created', 'customer', 'email', 'product', 'amount', 'currency', 'status', 'gateway_ref'],
    filters: {
      status: { label: 'Status', sql: 'o.status = ?', options: ['created', 'redirected', 'paid', 'declined', 'failed', 'cancelled'] },
      gateway: { label: 'Gateway', sql: 'o.gateway = ?', options: ['cybersource'] },
    },
    sorts: {
      newest: 'o.created_at DESC',
      oldest: 'o.created_at ASC',
      amount: 'o.amount DESC',
    },
    totals: [
      { key: 'paid', label: 'Paid', sql: "COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.amount ELSE 0 END), 0)", money: true },
      { key: 'abandoned', label: 'Abandoned value', sql: "COALESCE(SUM(CASE WHEN o.status IN ('created','redirected') THEN o.amount ELSE 0 END), 0)", money: true },
    ],
  },

  customers: {
    label: 'Customers',
    description: 'Registered accounts, with what each has spent.',
    dateColumn: 'u.created_at',
    dateLabel: 'Joined',
    from: `FROM users u
      LEFT JOIN (
        SELECT lead_email,
               COUNT(*) AS bookings,
               COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN payment_amount ELSE 0 END), 0) AS spend,
               MAX(created_at) AS last_booking
          FROM bookings GROUP BY lead_email
      ) bb ON bb.lead_email = u.email`,
    columns: [
      { key: 'name', label: 'Name', sql: "TRIM(CONCAT(COALESCE(u.first_middle_name,''),' ',COALESCE(u.last_name,'')))", format: plain },
      { key: 'email', label: 'Email', sql: 'u.email', format: plain },
      { key: 'mobile', label: 'Mobile', sql: "TRIM(CONCAT(COALESCE(u.mobile_country_code,''),' ',COALESCE(u.mobile_number,'')))", format: plain },
      { key: 'country', label: 'Country', sql: 'u.country', format: plain },
      { key: 'status', label: 'Status', sql: 'u.status', format: plain },
      { key: 'joined', label: 'Joined', sql: 'u.created_at', format: isoDateTime },
      { key: 'last_login', label: 'Last signed in', sql: 'u.last_login_at', format: isoDateTime },
      { key: 'bookings', label: 'Bookings', sql: 'COALESCE(bb.bookings, 0)', format: plain, numeric: true },
      { key: 'spend', label: 'Lifetime spend', sql: 'COALESCE(bb.spend, 0)', format: money, numeric: true },
      { key: 'last_booking', label: 'Last booked', sql: 'bb.last_booking', format: isoDate },
      { key: 'profile_complete', label: 'Profile complete', sql: "CASE WHEN u.is_profile_complete = 1 THEN 'yes' ELSE 'no' END", format: plain },
    ],
    defaultColumns: ['name', 'email', 'mobile', 'country', 'status', 'joined', 'bookings', 'spend'],
    filters: {
      status: { label: 'Status', sql: 'u.status = ?', options: ['active', 'suspended', 'inactive'] },
    },
    sorts: {
      newest: 'u.created_at DESC',
      spend: 'COALESCE(bb.spend, 0) DESC',
      name: 'u.first_middle_name ASC',
    },
    totals: [
      { key: 'spend', label: 'Combined spend', sql: 'COALESCE(SUM(COALESCE(bb.spend, 0)), 0)', money: true },
    ],
  },

  emails: {
    label: 'Emails',
    description: 'Everything the system has sent, and whether it was accepted.',
    dateColumn: 'n.sent_at',
    dateLabel: 'Sent',
    from: `FROM email_notifications n LEFT JOIN bookings b ON b.id = n.booking_id`,
    columns: [
      { key: 'sent_at', label: 'Sent', sql: 'n.sent_at', format: isoDateTime },
      { key: 'kind', label: 'Kind', sql: 'n.kind', format: plain },
      { key: 'recipient', label: 'To', sql: 'n.recipient', format: plain },
      { key: 'subject', label: 'Subject', sql: 'n.subject', format: plain },
      { key: 'status', label: 'Status', sql: 'n.status', format: plain },
      { key: 'error', label: 'Error', sql: 'n.error', format: plain },
      { key: 'template', label: 'Template', sql: 'n.template_key', format: plain },
      { key: 'booking_ref', label: 'Booking', sql: 'b.booking_reference', format: plain },
    ],
    defaultColumns: ['sent_at', 'kind', 'recipient', 'subject', 'status'],
    filters: {
      status: { label: 'Status', sql: 'n.status = ?', options: ['sent', 'failed'] },
      kind: { label: 'Kind', sql: 'n.kind = ?', options: ['voucher', 'payment_pending', 'trip_reminder_2d', 'trip_today', 'post_stay', 'admin_message', 'query_reply', 'campaign'] },
    },
    sorts: { newest: 'n.sent_at DESC', oldest: 'n.sent_at ASC' },
    totals: [
      { key: 'sent', label: 'Accepted', sql: "SUM(CASE WHEN n.status = 'sent' THEN 1 ELSE 0 END)" },
      { key: 'failed', label: 'Failed', sql: "SUM(CASE WHEN n.status = 'failed' THEN 1 ELSE 0 END)" },
    ],
  },

  support: {
    label: 'Support',
    description: 'Customer questions and how long they waited.',
    dateColumn: 'q.created_at',
    dateLabel: 'Opened',
    from: `FROM queries q LEFT JOIN admins a ON a.id = q.assigned_to_admin_id`,
    columns: [
      { key: 'id', label: 'Ref', sql: 'q.id', format: plain },
      { key: 'opened', label: 'Opened', sql: 'q.created_at', format: isoDateTime },
      { key: 'name', label: 'From', sql: 'q.name', format: plain },
      { key: 'email', label: 'Email', sql: 'q.email', format: plain },
      { key: 'subject', label: 'Subject', sql: 'q.subject', format: plain },
      { key: 'category', label: 'Category', sql: 'q.category', format: plain },
      { key: 'status', label: 'Status', sql: 'q.status', format: plain },
      { key: 'priority', label: 'Priority', sql: 'q.priority', format: plain },
      { key: 'assigned', label: 'Assigned to', sql: 'a.name', format: plain },
      { key: 'first_reply', label: 'First reply', sql: 'q.first_response_at', format: isoDateTime },
      { key: 'wait_minutes', label: 'Wait (minutes)', sql: 'TIMESTAMPDIFF(MINUTE, q.created_at, q.first_response_at)', format: plain, numeric: true },
      { key: 'closed', label: 'Closed', sql: 'q.closed_at', format: isoDateTime },
    ],
    defaultColumns: ['id', 'opened', 'name', 'email', 'subject', 'status', 'first_reply', 'wait_minutes'],
    filters: {
      status: { label: 'Status', sql: 'q.status = ?', options: ['new', 'in_progress', 'resolved', 'closed'] },
      priority: { label: 'Priority', sql: 'q.priority = ?', options: ['low', 'normal', 'high', 'urgent'] },
    },
    sorts: { newest: 'q.created_at DESC', oldest: 'q.created_at ASC', wait: 'q.first_response_at IS NULL DESC, q.created_at ASC' },
    totals: [
      { key: 'answered', label: 'Answered', sql: 'SUM(CASE WHEN q.first_response_at IS NOT NULL THEN 1 ELSE 0 END)' },
      { key: 'waiting', label: 'Still waiting', sql: 'SUM(CASE WHEN q.first_response_at IS NULL THEN 1 ELSE 0 END)' },
    ],
  },

  content: {
    label: 'Content',
    description: 'Blog posts and how much they are read.',
    dateColumn: 'bl.created_at',
    dateLabel: 'Created',
    from: `FROM blogs bl LEFT JOIN admins a ON a.id = bl.author_admin_id`,
    columns: [
      { key: 'title', label: 'Title', sql: 'bl.title', format: plain },
      { key: 'slug', label: 'Slug', sql: 'bl.slug', format: plain },
      { key: 'status', label: 'Status', sql: 'bl.status', format: plain },
      { key: 'category', label: 'Category', sql: 'bl.category', format: plain },
      { key: 'author', label: 'Author', sql: 'COALESCE(bl.author_name, a.name)', format: plain },
      { key: 'created', label: 'Created', sql: 'bl.created_at', format: isoDateTime },
      { key: 'published', label: 'Published', sql: 'bl.published_at', format: isoDateTime },
      { key: 'views', label: 'Views', sql: 'bl.views', format: plain, numeric: true },
      { key: 'reading_minutes', label: 'Read time (min)', sql: 'bl.reading_minutes', format: plain, numeric: true },
    ],
    defaultColumns: ['title', 'status', 'category', 'author', 'published', 'views'],
    filters: {
      status: { label: 'Status', sql: 'bl.status = ?', options: ['draft', 'scheduled', 'published', 'archived'] },
    },
    sorts: { newest: 'bl.created_at DESC', views: 'bl.views DESC', title: 'bl.title ASC' },
    totals: [{ key: 'views', label: 'Total views', sql: 'COALESCE(SUM(bl.views), 0)' }],
  },
};

// ── Building a query ─────────────────────────────────────────────────────────

/** Only columns the dataset declares, in the order the report asked for. */
function pickColumns(dataset, requested) {
  const available = DATASETS[dataset].columns;
  const byKey = Object.fromEntries(available.map((c) => [c.key, c]));
  const keys = Array.isArray(requested) && requested.length
    ? requested.filter((k) => byKey[k])
    : DATASETS[dataset].defaultColumns;
  const chosen = keys.map((k) => byKey[k]).filter(Boolean);
  return chosen.length ? chosen : available.slice(0, 6);
}

/**
 * Build the WHERE clause.
 *
 * Every filter is looked up in the dataset's own map, so an unknown one is
 * ignored rather than reaching the database.
 */
function buildWhere(dataset, { from, to, filters = {}, search = '' }) {
  const def = DATASETS[dataset];
  const conditions = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };

  if (from) add(`${def.dateColumn} >= ?`, `${from} 00:00:00`);
  if (to) add(`${def.dateColumn} <= ?`, `${to} 23:59:59`);

  for (const [key, value] of Object.entries(filters)) {
    const filter = def.filters?.[key];
    if (!filter || value === '' || value === null || value === undefined) continue;
    if (filter.options && !filter.options.includes(String(value))) continue;
    add(filter.sql, value);
  }

  if (search) {
    // Search across whatever text columns the dataset exposes, never a
    // client-supplied column name.
    const textColumns = def.columns.filter((c) => !c.numeric).slice(0, 6);
    if (textColumns.length) {
      params.push(`%${search}%`);
      const p = `$${params.length}`;
      conditions.push(`(${textColumns.map((c) => `${c.sql} LIKE ${p}`).join(' OR ')})`);
    }
  }

  return { where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', params };
}

/**
 * Run a report.
 *
 * `limit` is always applied and always capped — the preview asks for 25, an
 * export for MAX_ROWS. Nothing here can be asked for "everything".
 */
async function runReport(spec) {
  const dataset = DATASETS[spec.dataset] ? spec.dataset : 'bookings';
  const def = DATASETS[dataset];
  const range = resolveRange(spec.dateRange, spec.dateFrom, spec.dateTo);
  const columns = pickColumns(dataset, spec.columns);
  const { where, params } = buildWhere(dataset, {
    from: range.from,
    to: range.to,
    filters: spec.filters,
    search: spec.search,
  });

  const order = def.sorts[spec.sort] || Object.values(def.sorts)[0];
  const limit = Math.min(Math.max(Number(spec.limit) || PREVIEW_ROWS, 1), MAX_ROWS);

  const select = columns.map((c, i) => `${c.sql} AS c${i}`).join(', ');

  // Bounded rather than Promise.all - this host times out on bursts of new
  // connections, and a report is not worth reintroducing that.
  const [rows, count, totals] = await runLimited([
    () => pool.query(`SELECT ${select} ${def.from} ${where} ORDER BY ${order} LIMIT ${limit}`, params),
    () => pool.query(`SELECT COUNT(*) AS total ${def.from} ${where}`, params),
    () =>
      def.totals?.length
        ? pool.query(
            `SELECT ${def.totals.map((t, i) => `${t.sql} AS t${i}`).join(', ')} ${def.from} ${where}`,
            params
          )
        : Promise.resolve({ rows: [{}] }),
  ]);

  const total = Number(count.rows[0]?.total || 0);

  return {
    dataset,
    datasetLabel: def.label,
    period: range.label,
    from: range.from,
    to: range.to,
    columns: columns.map((c) => ({ key: c.key, label: c.label, numeric: Boolean(c.numeric) })),
    rows: rows.rows.map((row) => columns.map((c, i) => c.format(row[`c${i}`]))),
    total,
    returned: rows.rows.length,
    // Said plainly rather than left for somebody to discover: the file holds
    // what the row count says, not necessarily everything that matched.
    truncated: total > rows.rows.length,
    limit,
    maxRows: MAX_ROWS,
    totals: (def.totals || []).map((t, i) => ({
      key: t.key,
      label: t.label,
      value: t.money
        ? Number(Number(totals.rows[0]?.[`t${i}`] || 0).toFixed(2))
        : Number(totals.rows[0]?.[`t${i}`] || 0),
      money: Boolean(t.money),
    })),
  };
}

/** The builder's own options, so the UI never hard-codes a dataset. */
function describeDatasets() {
  return Object.entries(DATASETS).map(([key, def]) => ({
    key,
    label: def.label,
    description: def.description,
    dateLabel: def.dateLabel,
    columns: def.columns.map((c) => ({ key: c.key, label: c.label, numeric: Boolean(c.numeric) })),
    defaultColumns: def.defaultColumns,
    filters: Object.entries(def.filters || {}).map(([k, f]) => ({
      key: k,
      label: f.label,
      options: f.options || [],
    })),
    sorts: Object.keys(def.sorts),
  }));
}

module.exports = {
  DATASETS,
  RANGES,
  MAX_ROWS,
  PREVIEW_ROWS,
  resolveRange,
  runReport,
  describeDatasets,
  pickColumns,
};
