require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');

const { pool } = require('./config/db');
const errorHandler = require('./middleware/errorHandler');

const userAuthRoutes = require('./routes/user/auth');
const userProfileRoutes = require('./routes/user/profile');
const userTripsRoutes = require('./routes/user/trips');
const userQueriesRoutes = require('./routes/user/queries');
const publicBlogsRoutes = require('./routes/public/blogs');
const publicBookingsRoutes = require('./routes/public/bookings');

const adminAuthRoutes = require('./routes/admin/auth');
const adminUsersRoutes = require('./routes/admin/users');
const adminBookingsRoutes = require('./routes/admin/bookings');
const adminBlogsRoutes = require('./routes/admin/blogs');
const adminQueriesRoutes = require('./routes/admin/queries');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean) || true,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use('/uploads', express.static(path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads')));

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

// Public (website) routes
app.use('/api/blogs', publicBlogsRoutes);
app.use('/api/bookings', publicBookingsRoutes);

// Admin routes
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/users', adminUsersRoutes);
app.use('/api/admin/bookings', adminBookingsRoutes);
app.use('/api/admin/blogs', adminBlogsRoutes);
app.use('/api/admin/queries', adminQueriesRoutes);

app.use((req, res) => {
  res.status(404).json({ status: 'error', message: 'Route not found' });
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Holiday Seychelles backend running on :${PORT}`);
});
