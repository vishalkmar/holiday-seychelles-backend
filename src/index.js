require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const { pool } = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const { startScheduler } = require('./services/notifications');
const { startCampaignScheduler } = require('./services/emailCampaigns');
const { startBlogScheduler } = require('./services/blogScheduler');
const { startReportScheduler } = require('./services/reportSchedules');

const userAuthRoutes = require('./routes/user/auth');
const userProfileRoutes = require('./routes/user/profile');
const userTripsRoutes = require('./routes/user/trips');
const userQueriesRoutes = require('./routes/user/queries');
const userTransactionsRoutes = require('./routes/user/transactions');
const userOverviewRoutes = require('./routes/user/overview');

const publicBlogsRoutes = require('./routes/public/blogs');
const publicBookingsRoutes = require('./routes/public/bookings');
const paymentsRoutes = require('./routes/public/payments');
const publicSiteRoutes = require('./routes/public/site');

const tourvisioProxyRoutes = require('./routes/public/tourvisioProxy');

const adminAuthRoutes = require('./routes/admin/auth');
const adminSecurityRoutes = require('./routes/admin/security');
const adminOverviewRoutes = require('./routes/admin/overview');
const adminTransactionsRoutes = require('./routes/admin/transactions');
const adminRevenueRoutes = require('./routes/admin/revenue');
const adminCustomersRoutes = require('./routes/admin/customers');
const adminEmailsRoutes = require('./routes/admin/emails');
const adminDocumentsRoutes = require('./routes/admin/documents');
const adminReportsRoutes = require('./routes/admin/reports');
const adminTeamRoutes = require('./routes/admin/team');
const adminWebsiteRoutes = require('./routes/admin/website');
const adminAuthMiddleware = require('./middleware/adminAuth');
const { guardFor } = require('./middleware/routeGuards');
const unsubscribeRoutes = require('./routes/public/unsubscribe');
const adminUsersRoutes = require('./routes/admin/users');
const adminBookingsRoutes = require('./routes/admin/bookings');
const adminBlogsRoutes = require('./routes/admin/blogs');
const adminQueriesRoutes = require('./routes/admin/queries');

const app = express();

app.use(helmet());

app.use(
  cors({
    origin:
      (process.env.CORS_ORIGIN || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean).length > 0
        ? (process.env.CORS_ORIGIN || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : true,
    credentials: true,
  })
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Website hero media is shown by the public site, which lives on another
// origin. helmet's default Cross-Origin-Resource-Policy (same-origin) would make
// the browser refuse those images and videos, so this folder alone opts out.
app.use(
  '/uploads/site',
  express.static(path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'site'), {
    setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
  })
);

app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads'))
);

app.get('/api/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW() as now');
    res.json({ status: 'ok', db_time: r.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// User-facing routes
app.use('/api/user/auth', userAuthRoutes);
app.use('/api/user/profile', userProfileRoutes);
app.use('/api/user/trips', userTripsRoutes);
app.use('/api/user/queries', userQueriesRoutes);
app.use('/api/user/transactions', userTransactionsRoutes);
app.use('/api/user/overview', userOverviewRoutes);

// Public website routes
app.use('/api/blogs', publicBlogsRoutes);
app.use('/api/bookings', publicBookingsRoutes);

// Tourvisio / Espacelimited proxy
app.use('/api/tourvisio', tourvisioProxyRoutes);

// Payment gateway routes
// Current flow: server-priced orders + Secure Acceptance hosted checkout.
app.use('/api/payments', paymentsRoutes);

// Website configuration the public pages read (home hero, logo).
app.use('/api/site', publicSiteRoutes);
app.use('/api/destinations', require('./routes/public/destinations'));

// Admin routes
// Permissions are enforced at the mount by guardFor(), so a route added to
// one of these files is covered by that section's policy by default.
// /api/admin/auth is the sign-in endpoint and cannot require a session.
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/security', adminAuthMiddleware, guardFor('security'), adminSecurityRoutes);
app.use('/api/admin/overview', adminAuthMiddleware, guardFor('overview'), adminOverviewRoutes);
app.use('/api/admin/transactions', adminAuthMiddleware, guardFor('transactions'), adminTransactionsRoutes);
app.use('/api/admin/revenue', adminAuthMiddleware, guardFor('revenue'), adminRevenueRoutes);
app.use('/api/admin/customers', adminAuthMiddleware, guardFor('customers'), adminCustomersRoutes);
app.use('/api/admin/emails', adminAuthMiddleware, guardFor('emails'), adminEmailsRoutes);
app.use('/api/admin/documents', adminAuthMiddleware, guardFor('documents'), adminDocumentsRoutes);
app.use('/api/admin/reports', adminAuthMiddleware, guardFor('reports'), adminReportsRoutes);
app.use('/api/admin/website', adminAuthMiddleware, guardFor('website'), adminWebsiteRoutes);
app.use('/api/admin/website/destinations', adminAuthMiddleware, guardFor('website'), require('./routes/admin/destinations'));
app.use('/api/admin/team', adminTeamRoutes);
app.use('/api/unsubscribe', unsubscribeRoutes);
app.use('/api/admin/users', adminAuthMiddleware, guardFor('users'), adminUsersRoutes);
app.use('/api/admin/bookings', adminAuthMiddleware, guardFor('bookings'), adminBookingsRoutes);
app.use('/api/admin/blogs', adminAuthMiddleware, guardFor('blogs'), adminBlogsRoutes);
app.use('/api/admin/queries', adminAuthMiddleware, guardFor('queries'), adminQueriesRoutes);

app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Holiday Seychelles backend running on :${PORT}`);
  if (process.env.DISABLE_SCHEDULERS === 'true') return;
  // Morning sweep for trip reminders, abandoned-checkout nudges and thank-yous.
  startScheduler();
  // ...and a five-minute tick that picks up campaigns whose send time arrived.
  startCampaignScheduler();
  // ...and one that publishes posts whose scheduled time arrived.
  startBlogScheduler();
  // ...and one that emails saved reports on their cadence.
  startReportScheduler();
});
