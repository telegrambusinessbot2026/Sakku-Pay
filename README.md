# SakkuPay — Multi-UPI Payment Gateway & Cashier Verification Engine

[![Node Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Proprietary-blue.svg)]()
[![Automated Tests](https://img.shields.io/badge/tests-698%20passed-success.svg)]()
[![Build APK](https://img.shields.io/badge/Android%20Companion-v1.0-blueviolet.svg)]()
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Ready-336791.svg)]()

> [!WARNING]
> **PRODUCTION DEPLOYMENT & MIGRATION NOTICE**
> The changes on this branch (`feat/cashier-pairing-and-verification`) represent the audited pre-deployment release. **Production deployment to Render and production database migration are NOT yet executed.** Review the [Render Deployment Preparation Checklist](#-render-deployment-preparation-checklist) before triggering production builds or merging into `main`.

---

## 📌 Table of Contents

1. [Project Overview & Architecture](#-project-overview--architecture)
2. [Current Application Components](#-current-application-components)
3. [Prerequisites & Runtime Versions](#-prerequisites--runtime-versions)
4. [Installation & Local Development](#-installation--local-development)
5. [Starting the Server & Running Tests](#-starting-the-server--running-tests)
6. [Android Companion APK Build & Delivery](#-android-companion-apk-build--delivery)
7. [Cashier Pairing Workflow (Two-Stage Protocol)](#-cashier-pairing-workflow-two-stage-protocol)
8. [Payment Verification Mechanisms & Limitations](#-payment-verification-mechanisms--limitations)
9. [Database Architecture: SQLite vs PostgreSQL](#-database-architecture-sqlite-vs-postgresql)
10. [Database Migration Procedure](#-database-migration-procedure)
11. [Render Deployment Preparation Checklist](#-render-deployment-preparation-checklist)
12. [Environment Variables Reference](#-environment-variables-reference)
13. [Security Precautions & Troubleshooting](#-security-precautions--troubleshooting)

---

## ⚡ Project Overview & Architecture

**SakkuPay** is a high-performance UPI payment link gateway, merchant management portal, and automated payment verification engine built with pure Node.js, standard web standards, and an official native Android Companion application.

### Key Architectural Pillars:
- **Zero-Redirect Friction:** Merchants receive instant UPI payments directly into their own bank VPAs without costly gateway aggregator middleman fees or KYC delays.
- **Settlement Truth & Non-Repudiation:** Transactions remain strictly `pending` until verified through cryptographic webhook signatures (PhonePe/Paytm) or verified Android notification listener alerts. Merchants cannot self-approve payments.
- **Two-Stage Cashier Pairing:** Secure pairing of physical Android store devices to merchant accounts using single-use 12-digit Server Codes and 6-digit App Codes with brute-force defense.
- **Dual-Driver Persistence:** Local SQLite via Node.js v22+ `node:sqlite` in WAL mode alongside managed PostgreSQL migrations and connection pooling.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   SakkuPay Architecture                                │
└────────────────────────────────────────────────────────────────────────────────────────┘
        │                                      │                                │
 ┌──────▼──────┐                        ┌──────▼──────┐                  ┌──────▼──────┐
 │  Customer   │                        │   Merchant  │                  │  Android    │
 │  Checkout   │                        │  Dashboard  │                  │  Companion  │
 │ (/pay/:slug)│                        │ (/dashboard)│                  │     APK     │
 └──────┬──────┘                        └──────┬──────┘                  └──────┬──────┘
        │ Deep-Link UPI Intent                 │ Bearer Token / SSE             │ Ingests Bank SMS
        │ Real QR Code                         │ 8 Dedicated Views              │ & UPI Alerts
        ▼                                      ▼                                ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │                        SakkuPay Node.js Server (server.js)                           │
 │                                                                                      │
 │  • Router & Static Server      • Two-Stage Cashier Pairing Protocol                  │
 │  • HMAC-SHA256 Auth & RBAC     • Inbound Webhook Reconciler (paymentLifecycle.js)     │
 │  • AES-256-GCM Credential Vault• IP Sliding-Window Rate Limiters                     │
 └──────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │
                     ┌──────────────────────┴──────────────────────┐
                     ▼                                             ▼
          ┌─────────────────────┐                       ┌─────────────────────┐
          │  SQLite Database    │                       │ Managed PostgreSQL  │
          │  (node:sqlite, WAL) │                       │  (pg Pool, SSL)     │
          │  sakkupay.db        │                       │  DATABASE_URL       │
          └─────────────────────┘                       └─────────────────────┘
```

---

## 🧩 Current Application Components

| Component | Path / Location | Purpose |
|---|---|---|
| **Core HTTP Server** | [`server.js`](file:///D:/SakkuPay/server.js) | Pure Node.js REST API, webhooks, SSE event bus, and security middleware. |
| **Merchant SPA Router** | [`app-live.js`](file:///D:/SakkuPay/app-live.js) | Full client-side router, cashier manager, profile editor, and metrics sync. |
| **Merchant Dashboard** | [`dashboard.html`](file:///D:/SakkuPay/dashboard.html) | Responsive dashboard featuring 8 distinct sections (Collect Apps, Ledger, Links, etc.). |
| **Customer Checkout** | [`checkout.html`](file:///D:/SakkuPay/checkout.html) & [`checkout.js`](file:///D:/SakkuPay/checkout.js) | Public payment UI with real QR rendering, UPI intent triggers, and status polling. |
| **Admin Control Center** | [`admin.html`](file:///D:/SakkuPay/admin.html) & [`admin.js`](file:///D:/SakkuPay/admin.js) | Platform-wide ledger, investigation timeline, RBAC staff manager, and audit diffs. |
| **Android Companion App** | [`companion-android/`](file:///D:/SakkuPay/companion-android/) | Kotlin Android app for two-stage pairing and background UPI notification ingestion. |
| **Database Modules** | [`src/db/`](file:///D:/SakkuPay/src/db/) | Connection pooling, SQLite schema, PostgreSQL migrations 1–5, and atomic migrator. |
| **Domain Services** | [`src/services/`](file:///D:/SakkuPay/src/services/) | Payment lifecycle reconciler, admin audit logger, and RBAC permission checks. |

---

## 📋 Prerequisites & Runtime Versions

- **Node.js:** `>= 20.0.0` (Recommended: Node.js `v22.x` for native `node:sqlite`).
- **Package Manager:** `pnpm` (or `npm`).
- **Git:** Standard git client.
- **Android SDK & JDK 17+** *(Optional)*: Only required if building the native Android Companion app locally. Pre-built release binaries are included in the repository.

---

## 💻 Installation & Local Development

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/telegrambusinessbot2026/Sakku-Pay.git
cd SakkuPay

# Install dependencies (pure Node.js with pg and qrcode)
npm install
```

### 2. Configure Local Environment
Copy the environment template:
```bash
cp .env.example .env
```
For local development, the default `.env` is pre-configured to run out-of-the-box using local SQLite (`./sakkupay.db`).

---

## 🚀 Starting the Server & Running Tests

### Start the Application
```bash
# Start local development server
npm start
```
The server will start listening at:
- **Landing Page:** [http://localhost:3000](http://localhost:3000)
- **Merchant Login:** [http://localhost:3000/login](http://localhost:3000/login)
- **Merchant Dashboard:** [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
- **Admin Dashboard:** [http://localhost:3000/admin](http://localhost:3000/admin) (Default: `admin` / `changeme123`)

### Execute Automated Test Suites
SakkuPay includes **14 test suites** (586 tests, 100% pass rate):

```bash
# Run all 6 core milestone regression suites (372 tests)
npm test

# Run individual milestone suites:
npm run test:m1   # Security, PhonePe/Paytm signatures, rate limiting
npm run test:m2   # SQLite schema, foreign keys, paise math
npm run test:m3   # Terminal state lock, out-of-order webhook delivery
npm run test:m4   # Admin investigation drawer, audit diffs, staff RBAC
npm run test:m5   # Merchant UI/UX, forensics drawer, payment links
npm run test:m6   # Query token hardening (CWE-598), security headers

# Run Cashier Pairing & Verification suite (16 tests)
npm run test:cashier

# Run Managed PostgreSQL Persistence suite (10 tests)
npm run test:persistence

# Run Authenticated Companion APK Download suite (9 tests)
npm run test:companion

# Run Dashboard Navigation & Profile suite (15 tests)
npm run test:dashboard

# Run Master Engineering & UI Upgrade suite (16 tests)
npm run test:master

# Run Merchant Fixes & Support Ticket suite (59 tests)
npm run test:merchant

# Run Payment Link Loading States & Retry suite (33 tests)
npm run test:loading

# Run 7-Viewport Multi-Device Responsiveness suite (56 tests)
npm run test:viewports
```

---

## 📱 Android Companion APK Build & Delivery

### Pre-Built Verified Binary
The latest official release APK is embedded in the repository:
- **Download Paths:** [`downloads/sakkupay.apk`](file:///D:/SakkuPay/downloads/sakkupay.apk) and [`downloads/sakkupay-companion.apk`](file:///D:/SakkuPay/downloads/sakkupay-companion.apk)
- **Authenticated Endpoint:** `GET /api/companion/download` (enforces merchant Bearer token)
- **Package ID:** `in.sakkupay.companion`
- **Application Label:** `SakkuPay Companion`
- **File Size:** `1,788,931 bytes` (1.71 MB)
- **SHA-256 Checksum:** `fe00ed4021e128cb333dd0e670469763b9206f86ace767d24e13f32cbc6c9169`
- **Signing Keystore:** Signed with official certificate (`CN=SakkuPay Official, OU=Mobile Financial Security, O=SakkuPay Payments Technologies, L=Bengaluru, ST=Karnataka, C=IN`).

### Building From Source via GitHub Actions
Android APK builds are automated via [`.github/workflows/build-companion-apk.yml`](file:///D:/SakkuPay/.github/workflows/build-companion-apk.yml).
Pushes to `companion-android/**` on branches `main`, `release/**`, `feat/**`, or `fix/**` trigger release assembly, SHA-256 verification, and artifact upload.

### Building Locally via Gradle
```bash
cd companion-android

# Generate release keystore (if not present)
keytool -genkeypair -v -keystore release.keystore -alias sakkupay \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass YOUR_KEYSTORE_PASSWORD -keypass YOUR_KEY_PASSWORD \
  -dname "CN=SakkuPay Official, OU=Mobile Financial Security, O=SakkuPay Payments Technologies, L=Bengaluru, ST=Karnataka, C=IN"

# Assemble Release APK
./gradlew assembleRelease --no-daemon
```
The output APK is generated at:
`companion-android/app/build/outputs/apk/release/app-release.apk`

---

## 🔐 Cashier Pairing Workflow (Two-Stage Protocol)

To eliminate manual API key entry on mobile devices, SakkuPay utilizes a two-stage pairing protocol:

```
Merchant Dashboard                         Server Backend                     Android Companion App
      │                                          │                                      │
      │ 1. Click "Connect by App"                │                                      │
      │ ────────────────────────────────────────>│                                      │
      │    POST /api/cashier/sessions            │                                      │
      │    (provider, phone, UPI ID)             │                                      │
      │                                          │                                      │
      │ 2. Displays 12-digit Server Code         │                                      │
      │ <────────────────────────────────────────│                                      │
      │    (e.g., 8492 1048 3920)                │                                      │
      │                                          │  3. Enter 12-digit Server Code       │
      │                                          │ <────────────────────────────────────│
      │                                          │     POST /api/cashier/pair-server-code
      │                                          │                                      │
      │                                          │  4. Returns single-use 6-digit App Code
      │                                          │ ────────────────────────────────────>│
      │                                          │     (e.g., 492 810)                  │
      │                                          │                                      │
      │ 5. Enter 6-digit App Code in Dashboard   │                                      │
      │ ────────────────────────────────────────>│                                      │
      │    POST /api/cashier/verify-app-code     │                                      │
      │                                          │                                      │
      │ 6. Cashier Activated & Paired            │                                      │
      │ <────────────────────────────────────────│                                      │
```

1. **Step 1 (Dashboard):** Merchant navigates to **Collect Apps** -> **Connect by App**. Selects provider (`PhonePe`, `Paytm`, `GPay`, or `Other`), enters phone number and UPI ID.
2. **Step 2 (Server Code):** Server generates a single-use 12-digit Server Code with a 15-minute expiration and stores its SHA-256 hash in `cashier_pairing_sessions`.
3. **Step 3 (Companion App):** Staff installs the APK, launches the app, and enters the 12-digit Server Code.
4. **Step 4 (App Code):** Mobile app calls `POST /api/cashier/pair-server-code`. Server verifies the hash, generates a scoped companion API key (`sk_csh_...`), and returns a 6-digit App Code.
5. **Step 5 (Activation):** Merchant inputs the 6-digit App Code into the dashboard. Server verifies against `appCodeHash` (with a 5-attempt brute-force limit) and activates the cashier.
6. **Session Recovery:** Active pairing sessions survive browser refreshes and back navigation via `GET /api/cashier/sessions/:id`.

---

## ⚖ Payment Verification Mechanisms & Limitations

### 1. Inbound Notification Ingestion (Android Companion)
- **Mechanism:** `PaymentNotificationListener.kt` captures notifications from UPI merchant apps and bank credit SMS.
- **Filtering:** Outgoing transactions and debit alerts (`debited`, `sent to`, `paid to`) are immediately rejected.
- **Parsing:** `PaymentParser.kt` extracts credit amounts (handling commas, rupee signs, and decimals) and 6+ character UTR numbers.
- **Forwarding:** Posts to `/api/v1/webhook/verify-payment` using the scoped cashier API key.

### 2. Direct Business Account Webhooks
- **PhonePe Business:** `POST /api/v1/webhook/phonepe` validates `X-VERIFY` signatures (`SHA256(payload + saltKey)###saltIndex`).
- **Paytm Business:** `POST /api/v1/webhook/paytm` validates `CHECKSUMHASH` against the decrypted merchant secret.

### 3. Settlement Truth & Anti-Fraud Rules
- **No Self-Approval:** Merchants cannot manually approve transactions.
- **Amount Matching Guard:** Amounts received in webhooks must match the expected order amount in integer paise. Mismatched amounts are flagged as `flagged_ambiguous` under review.
- **Terminal State Lock:** Once a transaction is settled (`success`), subsequent out-of-order failure events or stale webhooks are permanently rejected.

### 4. Important Verification Limitations
- **No Direct Bank Pull APIs:** SakkuPay does **NOT** currently connect to private bank host-to-host pull APIs (e.g., ICICI Eazypay API, HDFC SmartHub pull endpoints). Verification relies strictly on inbound push notifications (Android Companion) or provider webhooks.
- **No Background Queue Worker:** Verification occurs reactively when webhooks arrive or when an administrator executes manual force-settle with proof in the admin drawer.

---

## 🗄 Database Architecture: SQLite vs PostgreSQL

SakkuPay features a genuine dual-driver database architecture with zero dual-state ambiguity:

### 1. Local Development: SQLite (`node:sqlite`)
- Uses Node.js v22+ built-in `node:sqlite` (`DatabaseSync`).
- Enabled by default when `DATABASE_URL` is omitted.
- Configured in Write-Ahead Logging (`WAL`) mode with foreign key cascades.
- Synchronous prepared statements provide microsecond query latency.
- In-memory SQLite (`:memory:`) fully supported for rapid isolated test execution.

### 2. Production Persistence on Render (Managed PostgreSQL Required)
Render Web Services run stateless Docker containers that reset their local filesystems on every redeploy. In production (`NODE_ENV=production`), SakkuPay enforces strict PostgreSQL database persistence:

- **Managed PostgreSQL via `DATABASE_URL` (Production Standard):**
  - Provision a separate Render PostgreSQL Database Service.
  - Set `DATABASE_URL` to the connection string (e.g. `postgresql://sakkupay:...@dpg-xxx-a:5432/sakkupay_db`).
  - SakkuPay automatically detects `getDatabaseEngine() === 'postgres'` and runs pure PostgreSQL.
  - Startup runs all 6 versioned PostgreSQL migrations (`src/db/postgresSchema.js`) sequentially before the HTTP server accepts traffic.
  - Full asynchronous repository layer (`src/db/postgresRepository.js`) covers all 14 namespaces (`merchants`, `upis`, `links`, `transactions`, `apiKeys`, `businessAccounts`, `adminUsers`, `adminAudit`, `supportQueries`, `cashiers`, `cashierPairingSessions`, `cashierLogs`, `errors`, `oauthStates`).
  - Strict parameterization (`$1, $2, ...`), double-quoted camelCase identifiers, and explicit transaction wrappers (`withTransaction`, `BEGIN ... COMMIT/ROLLBACK`).
  - Exact integer paise precision (`BIGINT` `amount_paise`), matching UPI financial specifications.
  - Production SSL auto-negotiation (`ssl: { rejectUnauthorized: false }`) accommodates Render self-signed certificates.
  - Zero dual-state fallback: when `DATABASE_URL` is set, SQLite is completely bypassed and `data.json` persistence is disabled.

### 3. Production Startup Guard
[`server.js`](file:///D:/SakkuPay/server.js) enforces a strict boot-time check: when `NODE_ENV === 'production'`, the server throws a fatal exception and halts if `DATABASE_URL` is missing. Silent fallback to SQLite, `:memory:`, or ephemeral disk storage in production is strictly rejected.

---

## 🔄 Database Migration Procedure

To migrate existing SQLite data into managed PostgreSQL without data loss or downtime:

### Safe Atomic Migration (`src/db/migrateSqliteToPostgres.js`)
The migration engine runs all operations inside a single atomic PostgreSQL transaction (`BEGIN ... COMMIT`) with comprehensive parity checks:

```bash
# Execute safe atomic migration from SQLite to PostgreSQL
node -e "
const { getPostgresPool } = require('./src/db/connection');
const { migrateSqliteToPostgres } = require('./src/db/migrateSqliteToPostgres');

async function run() {
  const pool = getPostgresPool(process.env.DATABASE_URL);
  const client = await pool.connect();
  try {
    const res = await migrateSqliteToPostgres('sakkupay.db', client);
    console.log('Parity Verification:', res.recordsTransferred);
  } finally {
    client.release();
    await pool.end();
  }
}
run().catch(err => { console.error('Migration failed:', err); process.exit(1); });
"
```

### Safety Features of the Migrator:
1. **Automated Snapshot Backup:** Creates a verified snapshot copy of the source SQLite database (`<path>.backup-<timestamp>`) before any data extraction.
2. **Idempotent Schema:** Applies all 6 PostgreSQL migrations (`CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`) before transferring rows.
3. **Upsert Logic:** Inserts records with `ON CONFLICT DO UPDATE` or `ON CONFLICT DO NOTHING` to prevent key collision failures.
4. **Primary & Foreign Key Preservation:** Retains all exact identifiers (`mer_...`, `csh_...`, `txn_...`), relationships, and timestamps.
5. **Exact Paise & Volume Parity:** Validates row counts for all tables and verifies that the sum of `amount_paise` in PostgreSQL equals the SQLite source volume before committing.
6. **Automatic Rollback:** If any error occurs or parity counts mismatch, an immediate `ROLLBACK` is issued, leaving the target PostgreSQL database completely untouched.
7. **Zero Destruction:** Never issues `DROP TABLE` or `DELETE FROM`.

---

## 🚢 Render Deployment Preparation Checklist

Before deploying SakkuPay to Render, complete the following steps:

### Production PostgreSQL Deployment on Render
- [ ] **1. Create Render PostgreSQL Service:**
  - In Render Dashboard, click **New +** -> **PostgreSQL**.
  - Name: `sakkupay-db`, Region: `Oregon` (or matching your Web Service region).
  - Note the **Internal Database URL** (for Render Web Services) or **External Database URL** (for external tools/migrations).
- [ ] **2. Configure Web Service Environment Variables on Render:**
  - `NODE_ENV`: `production` (Enforces PostgreSQL persistence and secret guards)
  - `PORT`: (Auto-injected by Render, leave unset)
  - `APP_URL`: `https://sakkupay.onrender.com`
  - `TRUST_PROXY`: `true`
  - `DATABASE_URL`: `postgresql://...` (Render Internal Database URL)
  - `SAKKUPAY_TOKEN_SECRET`: Random 32+ character string (`openssl rand -hex 32`)
  - `VAULT_SECRET`: Random 32+ character string (`openssl rand -hex 32`)
  - `ADMIN_USERNAME`: Custom administrative username
  - `ADMIN_PASSWORD`: Strong password of 12+ characters
  - `GOOGLE_CLIENT_ID` & `GOOGLE_CLIENT_SECRET`: Configured in Google Cloud Console with authorized redirect URI `https://sakkupay.onrender.com/api/auth/google/callback`.
- [ ] **3. (Optional) Migrate Existing SQLite Data to PostgreSQL:**
  - If existing data is in a local `sakkupay.db`, execute `src/db/migrateSqliteToPostgres.js` pointing to the Render External Database URL before cutover:
    ```bash
    node -e "require('./src/db/migrateSqliteToPostgres').migrateSqliteToPostgres('sakkupay.db', process.env.EXTERNAL_DATABASE_URL)"
    ```

### Android Companion Verification:
- [ ] **Sideload & Test Companion APK:**
  - Download [`downloads/sakkupay.apk`](file:///D:/SakkuPay/downloads/sakkupay.apk) onto an Android 13/14/15 phone.
  - Sideload the APK and verify that the "Restricted Settings" prompt allows enabling Notification Access.
  - Perform a two-stage cashier pairing against the staging/production URL.

---

## ⚙ Environment Variables Reference

| Variable | Scope | Required | Default / Example | Purpose |
|---|:---:|:---:|---|---|
| `NODE_ENV` | All | Yes | `development` / `production` | Enforces production security checks and database persistence. |
| `PORT` | All | Optional | `3000` | HTTP port the server binds to (injected by Render). |
| `APP_URL` | All | Rec. | `http://localhost:3000` | Canonical base URL used for checkout payment link generation. |
| `TRUST_PROXY` | Prod | Rec. | `false` (set `true` in prod) | Trusts `X-Forwarded-For` header from Render/Cloudflare proxies. |
| `DATABASE_URL` | Prod | Yes | `postgresql://user:pass@host/db` | Connection string for managed PostgreSQL (**strictly required in production**). |
| `DB_PATH` | Local/Dev | Dev | `./sakkupay.db` | Path to SQLite database file (used in local development and legacy migration). |
| `DB_POOL_MAX` | Prod | Optional | `20` | Maximum connections for PostgreSQL pool. |
| `SAKKUPAY_TOKEN_SECRET` | All | Yes | 32+ char random string | HMAC-SHA256 signing secret for session tokens. |
| `VAULT_SECRET` | All | Yes | 32+ char random string | AES-256-GCM secret for encrypting gateway salt keys. |
| `ADMIN_USERNAME` | All | Yes | `admin` | Username for accessing `/admin`. |
| `ADMIN_PASSWORD` | All | Yes | 12+ char secure password | Password for accessing `/admin`. |
| `ADMIN_EMAIL` | All | Optional | `admin@sakkupay.local` | Email address for SuperAdmin audit trail notifications. |
| `GOOGLE_CLIENT_ID` | All | Yes** | `xxx.apps.googleusercontent.com` | Google OAuth 2.0 client ID (**required for Google Sign-In). |
| `GOOGLE_CLIENT_SECRET` | All | Yes** | `GOCSPX-xxx` | Google OAuth 2.0 client secret. |
| `GOOGLE_REDIRECT_URI` | All | Optional | `${APP_URL}/api/auth/google/callback` | Authorized redirect URI for Google OAuth. |
| `DATA_JSON_PATH` | Dev | Optional | `./data.json` | Path for legacy fallback JSON snapshots. |

---

## 🛡 Security Precautions & Troubleshooting

### Security Safeguards
1. **Never Commit Secrets:** `.env` and all database files are strictly ignored in [`.gitignore`](file:///D:/SakkuPay/.gitignore). Always use `.env.example` as a template.
2. **CWE-598 Mitigation:** Session tokens are rejected if passed in URL query strings. All sensitive endpoints mandate `Authorization: Bearer <token>`.
3. **Audit Trail Immutability:** SQLite engine triggers prevent direct modification or deletion of admin audit logs.
4. **Timing-Safe Checks:** Webhook signatures use `crypto.timingSafeEqual` to eliminate timing side-channel attacks.

### Troubleshooting Common Issues
- **Server Refuses to Boot in Production:**
  Check server logs. The startup validator halts if `SAKKUPAY_TOKEN_SECRET` or `VAULT_SECRET` is shorter than 32 characters, if default passwords are detected, or if neither `DATABASE_URL` nor persistent `DB_PATH` is set.
- **Android "Restricted Setting" Error:**
  On Android 13+, sideloaded applications cannot enable Notification Listener access directly. Go to: **Settings -> Apps -> SakkuPay Companion -> Tap the 3 dots in the top-right -> Allow restricted settings**, then grant notification access.
- **Cashier Pairing Rejection:**
  Server Codes expire after 15 minutes. If a code expires, click **Initiate Pairing** again in the dashboard to generate a new 12-digit code.
