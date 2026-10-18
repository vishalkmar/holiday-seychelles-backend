/**
 * Permission enforcement for every admin route, declared in one place.
 *
 * The alternative was adding a guard to each of a hundred handlers across a
 * dozen files, where the one that gets forgotten is the hole. Here the whole
 * policy is a single table that can be read top to bottom and checked against
 * the permission catalogue.
 *
 * Rules are tried in order and the first match wins, so the specific ones
 * (refund, delete) come before the general ones. Every section ends with a
 * catch-all, so a route added later is covered by default rather than being
 * unguarded — **a new endpoint is protected until somebody decides otherwise**,
 * which is the right way round.
 */

const { requirePermission } = require('../services/permissions');

/**
 * `path` is matched against the URL *inside* the mount — for
 * `/api/admin/bookings/12/refund`, the guard sees `/12/refund`.
 */
const POLICY = {
  overview: [{ permission: 'dashboard.view' }],

  bookings: [
    { method: 'POST', path: /\/refund$/, permission: 'bookings.refund' },
    { method: 'GET', permission: 'bookings.view' },
    { permission: 'bookings.manage' },
  ],

  users: [
    { method: 'GET', permission: 'customers.view' },
    { permission: 'customers.manage' },
  ],

  customers: [
    { method: 'POST', path: /\/email$/, permission: 'emails.send' },
    { method: 'GET', permission: 'customers.view' },
    { permission: 'customers.manage' },
  ],

  transactions: [
    { method: 'POST', path: /\/refund$/, permission: 'transactions.refund' },
    { method: 'GET', permission: 'transactions.view' },
    { permission: 'transactions.refund' },
  ],

  revenue: [
    { method: 'GET', permission: 'revenue.view' },
    // Setting the revenue goal is a change, not a read.
    { permission: 'revenue.view' },
  ],

  emails: [
    { method: 'POST', path: /^\/templates\/[^/]+\/(test|preview)$/, permission: 'emails.view' },
    { method: 'GET', permission: 'emails.view' },
    { method: 'POST', path: /^\/segments\/preview$/, permission: 'emails.view' },
    { permission: 'emails.manage' },
  ],

  queries: [
    { method: 'GET', permission: 'support.view' },
    { method: 'POST', path: /\/(reply|note|resend-email)$/, permission: 'support.reply' },
    { permission: 'support.manage' },
  ],

  blogs: [
    { method: 'GET', permission: 'content.view' },
    { permission: 'content.manage' },
  ],

  documents: [
    { method: 'GET', permission: 'documents.view' },
    { permission: 'documents.manage' },
  ],

  website: [
    { method: 'GET', permission: 'website.view' },
    { permission: 'website.manage' },
  ],

  reports: [
    { method: 'POST', path: /^\/export/, permission: 'reports.export' },
    { method: 'POST', path: /^\/(preview|segments)/, permission: 'reports.view' },
    { method: 'GET', path: /^\/(datasets|history)/, permission: 'reports.view' },
    { method: 'GET', permission: 'reports.view' },
    { permission: 'reports.manage' },
  ],

  // AI assistant. Specific write rules first; reads need rag.view; anything
  // unmatched falls to the most restrictive key.
  rag: [
    // Settings hold the model choice and the API key: read and write both need settings.manage.
    { path: /^\/settings/, permission: 'rag.settings.manage' },
    // Original uploaded files can be internal (rate sheets): downloading needs knowledge.manage.
    { method: 'GET', path: /^\/documents\/\d+\/file/, permission: 'rag.knowledge.manage' },
    { method: 'GET', path: /^\/conversations/, permission: 'rag.conversations.view' },
    // 👎 answers carry the visitor's words, like transcripts (Phase 19).
    { method: 'GET', path: /^\/feedback/, permission: 'rag.conversations.view' },
    { method: 'GET', path: /^\/audit/, permission: 'rag.audit.view' },
    { method: 'GET', permission: 'rag.view' },
    { method: 'POST', path: /^\/(playground|tests|retrieval)/, permission: 'rag.view' },
    // Saved test cases are the admin's own checks: any AI admin may edit them.
    { path: /^\/tests/, permission: 'rag.view' },
    // Fixing feedback, drafting FAQs from unanswered questions, resolving conflicts.
    { path: /^\/(feedback|suggestions|conflicts)/, permission: 'rag.knowledge.manage' },
    { path: /^\/(sources|documents|faqs|destinations|jobs)/, permission: 'rag.knowledge.manage' },
    { path: /^\/flows/, permission: 'rag.flows.manage' },
    { path: /^\/index/, permission: 'rag.index.manage' },
    { path: /^\/tools/, permission: 'rag.tools.manage' },
    // API connectors (extra track 2.3 / 2.4): what the assistant may call.
    { path: /^\/connectors/, permission: 'rag.tools.manage' },
    { path: /^\/prompt/, permission: 'rag.prompt.edit' },
    // Step-up itself is open to any AI admin: the gated route checks its own permission
    // and the token is bound to the action. Approving or rejecting needs prompt.edit.
    { method: 'POST', path: /^\/security\/step-up/, permission: 'rag.view' },
    { path: /^\/security\/pending/, permission: 'rag.prompt.edit' },
    { permission: 'rag.settings.manage' },
  ],

  security: [
    { method: 'GET', path: /^\/audit/, permission: 'audit.view' },
    { method: 'GET', permission: 'security.manage' },
    { permission: 'security.manage' },
  ],
};

/**
 * Build the middleware for one mount.
 *
 * A section with no policy is refused outright rather than allowed: a mount
 * that nobody wrote a rule for is a mistake, and the safe reading of a mistake
 * is "no".
 */
function guardFor(section) {
  const rules = POLICY[section];

  if (!rules) {
    return function noPolicy(req, res) {
      console.error(`[permissions] no policy declared for "${section}" — refusing`);
      return res.status(403).json({
        status: 'error',
        message: 'This section has no permission policy, so access was refused.',
      });
    };
  }

  return function guard(req, res, next) {
    const path = req.path || '/';
    const match = rules.find(
      (rule) =>
        (!rule.method || rule.method === req.method) && (!rule.path || rule.path.test(path))
    );

    // Unreachable while every section ends with a catch-all, but if one loses
    // its catch-all the answer is still "no".
    if (!match) {
      return res.status(403).json({
        status: 'error',
        message: 'No permission rule matched this request, so it was refused.',
      });
    }

    return requirePermission(match.permission)(req, res, next);
  };
}

/** Exposed so a test can assert every permission named here really exists. */
function declaredPermissions() {
  return [...new Set(Object.values(POLICY).flat().map((r) => r.permission))];
}

module.exports = { POLICY, guardFor, declaredPermissions };
