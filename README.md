# Holiday Seychelles Backend

A complete Node.js/Express backend API for Holiday Seychelles platform with PostgreSQL database, user authentication via email OTP, admin panel, and booking management.

## Features

- **User Authentication**
  - Passwordless login with email OTP
  - Auto-submit OTP verification
  - Complete profile after login (first name, last name, etc.)
  - Profile management with multiple fields (passport, nationality, etc.)
  - Secure token management and logout

- **Admin Panel**
  - Email + password-based admin login
  - User management (view all, search, update status)
  - Booking management (list, details, status updates)
  - PDF voucher generation for bookings
  - Blog management (CRUD operations)
  - Query/contact form management

- **Booking System**
  - Create bookings after payment success
  - Track booking status and payment status
  - Store product details and traveller information
  - Generate downloadable PDF vouchers

- **Blogs**
  - Public blog listing and detail pages
  - Admin blog management (draft/publish)
  - Auto slug generation
  - View tracking

- **Contact Forms**
  - Customer query submission
  - Admin query tracking and management
  - Status workflow (new → in_progress → resolved/closed)

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js 4.x
- **Database**: PostgreSQL 12+
- **Authentication**: JWT + Email OTP
- **Validation**: Express Validator
- **Security**: Helmet, CORS, bcryptjs
- **Email**: Nodemailer
- **PDF**: PDFKit

## Project Structure

```
src/
├── index.js                 # Main entry point
├── config/
│   ├── db.js               # PostgreSQL connection pool
│   ├── jwt.js              # JWT configuration
│   └── mailer.js           # SMTP email configuration
├── migrations/
│   ├── 001_users.sql       # Users table
│   ├── 002_admins.sql      # Admins table
│   ├── 003_otps.sql        # Email OTPs table
│   ├── 004_auth_tokens.sql # Token tracking
│   ├── 005_bookings.sql    # Bookings table
│   ├── 006_blogs.sql       # Blogs table
│   ├── 007_queries.sql     # Contact queries table
│   ├── 008_migrations_log.sql
│   └── runner.js           # Migration runner
├── middleware/
│   ├── errorHandler.js     # Error handling
│   ├── userAuth.js         # User JWT middleware
│   └── adminAuth.js        # Admin JWT middleware
├── utils/
│   ├── otp.js              # OTP generation & verification
│   ├── password.js         # Password hashing
│   ├── jwt.js              # JWT signing & verification
│   ├── mailer.js           # Email sending
│   ├── response.js         # Standardized responses
│   └── seedAdmin.js        # Admin seeding script
└── routes/
    ├── user/
    │   ├── auth.js         # OTP, verify, complete profile
    │   ├── profile.js      # Get & update profile
    │   ├── trips.js        # Bookings list & detail
    │   └── queries.js      # Submit & view queries
    ├── admin/
    │   ├── auth.js         # Admin login & logout
    │   ├── users.js        # User management
    │   ├── bookings.js     # Booking management & vouchers
    │   ├── blogs.js        # Blog CRUD
    │   └── queries.js      # Query management
    └── public/
        ├── blogs.js        # Public blog listing
        └── bookings.js     # Booking creation & detail
```

## Setup Instructions

### 1. Prerequisites

- Node.js 18+ installed
- PostgreSQL 12+ running locally or accessible
- npm or yarn package manager

### 2. Environment Setup

Copy `.env.example` to `.env` and update values:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Server
NODE_ENV=development
PORT=5000
CORS_ORIGIN=http://localhost:5173

# PostgreSQL
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=your_password
PGDATABASE=holiday_seychelles

# JWT Secrets (generate random strings)
JWT_USER_SECRET=your-long-random-user-secret-key
JWT_ADMIN_SECRET=your-long-random-admin-secret-key

# OTP Settings
OTP_TTL_MINUTES=10
OTP_MAX_ATTEMPTS=5
OTP_RESEND_SECONDS=60

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM="Holiday Seychelles <no-reply@holidayseychelles.com>"

# Admin Seed
ADMIN_SEED_EMAIL=admin@holidayseychelles.com
ADMIN_SEED_PASSWORD=ChangeMe@123
ADMIN_SEED_NAME=Super Admin
```

### 3. Database Setup

Create database:

```bash
createdb holiday_seychelles
```

Run migrations:

```bash
npm run migrate
```

This will create all tables: users, admins, email_otps, auth_tokens, bookings, blogs, queries.

### 4. Install Dependencies

```bash
npm install
```

### 5. Seed Admin User

```bash
npm run seed:admin
```

This creates an admin account with credentials from `.env` (default: admin@holidayseychelles.com / ChangeMe@123)

### 6. Start Development Server

```bash
npm run dev
```

Server will run on `http://localhost:5000` (or PORT from .env)

## API Endpoints

### Health Check

```
GET /api/health
```

### User Authentication

```
POST /api/user/auth/send-otp
Body: { "email": "user@example.com" }
Response: { "status": "success", "data": { "message": "OTP sent to your email" } }

POST /api/user/auth/verify-otp
Body: { "email": "user@example.com", "otp": "123456" }
Response: { "status": "success", "data": { "token": "...", "userId": 1 } }

POST /api/user/auth/complete-profile
Headers: { "Authorization": "Bearer <token>" }
Body: { "first_middle_name": "John", "last_name": "Doe" }

POST /api/user/auth/logout
Headers: { "Authorization": "Bearer <token>" }
```

### User Profile

```
GET /api/user/profile
Headers: { "Authorization": "Bearer <token>" }

PUT /api/user/profile
Headers: { "Authorization": "Bearer <token>" }
Body: { "gender": "male", "mobile_number": "+919876543210", ... }
```

### User Trips & Queries

```
GET /api/user/trips
GET /api/user/trips/:bookingId
POST /api/user/queries
GET /api/user/queries
```

### Admin Authentication

```
POST /api/admin/auth/login
Body: { "email": "admin@example.com", "password": "password123" }
Response: { "status": "success", "data": { "token": "...", "adminId": 1 } }

POST /api/admin/auth/logout
Headers: { "Authorization": "Bearer <token>" }
```

### Admin Users Management

```
GET /api/admin/users?page=1&limit=20&search=email
GET /api/admin/users/:userId
PATCH /api/admin/users/:userId/status
Body: { "status": "active|inactive|suspended" }
```

### Admin Bookings Management

```
GET /api/admin/bookings?page=1&limit=20&status=confirmed&booking_type=hotel
GET /api/admin/bookings/:bookingId
PATCH /api/admin/bookings/:bookingId
Body: { "status": "confirmed|cancelled|refunded|pending", "admin_notes": "..." }

POST /api/admin/bookings/:bookingId/voucher
Response: { "voucherPath": "voucher-BS-xxx.pdf" }
```

### Admin Blogs Management

```
GET /api/admin/blogs?page=1&limit=20&status=published
GET /api/admin/blogs/:blogId
POST /api/admin/blogs
Body: { "title": "...", "content": "...", "excerpt": "...", "tags": "...", "status": "draft|published" }
PUT /api/admin/blogs/:blogId
Body: { "title": "...", "content": "...", ... }
DELETE /api/admin/blogs/:blogId
```

### Admin Queries Management

```
GET /api/admin/queries?page=1&limit=20&status=new&category=hotel
GET /api/admin/queries/:queryId
PATCH /api/admin/queries/:queryId
Body: { "status": "new|in_progress|resolved|closed", "admin_notes": "..." }
DELETE /api/admin/queries/:queryId
```

### Public APIs

```
GET /api/blogs?page=1&limit=10          # Published blogs only
GET /api/blogs/:slug                    # Blog detail by slug
POST /api/bookings                      # Create booking (from payment gateway)
GET /api/bookings/:bookingReference     # Get booking by reference
```

## Cookie/Token Management

- **User Token**: Stored in `userToken` cookie (30 days expiry)
- **Admin Token**: Stored in `adminToken` cookie (1 day expiry)
- Tokens are validated server-side via `auth_tokens` table
- Logout revokes tokens by setting `revoked_at`

## Error Handling

All endpoints return standardized response format:

```json
{
  "status": "success|error",
  "message": "...",
  "data": {}
}
```

## Development Tips

1. **Check OTP in console**: In development mode with no SMTP configured, OTPs print to console
2. **Database queries**: Use `psql` to inspect tables:
   ```bash
   psql holiday_seychelles
   SELECT * FROM users;
   SELECT * FROM bookings;
   ```
3. **Reset admin**: Re-run `npm run seed:admin` to reset admin credentials
4. **Voucher files**: Generated PDFs stored in `/uploads` directory

## Production Deployment

1. Set `NODE_ENV=production` in `.env`
2. Use strong JWT secrets (32+ characters)
3. Configure real SMTP credentials
4. Use environment variables for all sensitive data
5. Enable HTTPS in production
6. Set secure cookies: `secure: true, sameSite: 'Strict'`
7. Use database backups
8. Monitor error logs

## Troubleshooting

**OTP not sending?**
- Check SMTP credentials in `.env`
- Check email spam folder
- Ensure "Less secure app access" enabled for Gmail

**Database connection failed?**
- Verify PostgreSQL is running
- Check PGHOST, PGPORT, PGUSER, PGPASSWORD
- Run `createdb holiday_seychelles` if database doesn't exist

**Port 5000 already in use?**
- Change PORT in `.env`
- Or kill process: `lsof -i :5000` then `kill -9 <PID>`

## License

Private - Holiday Seychelles
