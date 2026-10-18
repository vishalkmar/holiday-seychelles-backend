/**
 * The only doors from the AI module into the rest of the backend.
 *
 * Code under src/ai/** imports these, never `../../services/...` directly, so
 * the module can be lifted into its own service later by re-implementing this
 * one file (DESIGN.md §2).
 */

const { pool } = require('../../config/db');
const adminSecurity = require('../../services/adminSecurity');
const { getTransporter } = require('../../config/mailer');
const adminEmails = require('../../utils/adminEmails');
const tourvisio = require('../../services/tourvisio');
const { tourvisioRequest } = require('../../services/tourvisioHttp');
const adminAuth = require('../../middleware/adminAuth');
const userAuth = require('../../middleware/userAuth');

module.exports = {
  /** MySQL pool (supports $1-style placeholders). */
  db: pool,

  /** Write to the shared admin audit log. entityType is one of rag_* (DESIGN.md §4). */
  audit: (entry) => adminSecurity.audit(entry),

  /** Step-up helpers reused for prompt security (Phase 12). */
  security: adminSecurity,

  /** Mail: the shared transporter, and the admin security emails (OTP, change alerts). */
  mail: { transporter: getTransporter, admin: adminEmails },

  /** Server-side TourVisio client; every call goes through the connect-retry transport. */
  tourvisio: { ...tourvisio, request: tourvisioRequest },

  auth: { admin: adminAuth, user: userAuth },

  /** The website's island/place pages (read-only use: list(false), get(slug)). */
  destinations: require('../../services/destinations'),
};
