# SakkuPay — Project Feature Audit & Engineering Status

**Local Project:** `D:\SakkuPay`  
**Active Feature Branch:** `feat/cashier-pairing-and-verification`  
**Latest Feature Commit:** `3a80231`  
**Target Production Deployment:** Render (`https://sakkupay.onrender.com`)  
**Audit Timestamp:** 2026-10-29  

---

## 1. Executive Summary

This document provides a factual, code-inspected audit of all features in SakkuPay, detailing completed systems, partial implementations, known architectural trade-offs, and pre-deployment prerequisites.

- **Automated Test Suites:** 14 distinct test suites (372 milestone regression tests + 214 feature integration tests = **586 tests total**) all execute with a **100% pass rate**.
- **Security & RBAC:** Session token authentication, AES-256-GCM vault encryption, rate limiting, and immutable audit logs are fully verified.
- **Android Companion:** Release-signed APK (`in.sakkupay.companion`) with two-stage cashier pairing is embedded and verified via checksum.
- **Production Status:** Deployment to Render and production database migration are **PENDING**. The service must not be promoted to production without provisioning persistent storage (PostgreSQL or Render Persistent Disk) and performing physical-device Android testing.

---

## 2. Detailed Feature Audit Matrix

### A. Android Companion App (`in.sakkupay.companion`)

| Component | Status | Source Verification | Notes / Limitations |
|---|:---:|---|---|
| **Package ID** | **Complete** | [`AndroidManifest.xml`](file:///D:/SakkuPay/companion-android/app/src/main/AndroidManifest.xml#L1) & [`build.gradle.kts`](file:///D:/SakkuPay/companion-android/app/build.gradle.kts#L11) | Set to `in.sakkupay.companion`. |
| **App Branding & Name** | **Complete** | [`strings.xml`](file:///D:/SakkuPay/companion-android/app/src/main/res/values/strings.xml#L3) | `app_name = "SakkuPay Companion"`. |
| **Launcher Icons** | **Complete** | `companion-android/app/src/main/res/mipmap-*` | Rasterized PNGs across all 5 densities (mdpi to xxxhdpi) + XML adaptive launcher. |
| **Release Signing** | **Complete** | CI Run `40732737653` | Signed with official release certificate (`CN=SakkuPay Official`, validity 2026–2054). |
| **Binary Output** | **Complete** | [`downloads/sakkupay.apk`](file:///D:/SakkuPay/downloads/sakkupay.apk) | SHA-256: `fe00ed4021e128cb333dd0e670469763b9206f86ace767d24e13f32cbc6c9169` (1,788,931 bytes). |
| **Two-Stage Pairing UI** | **Complete** | [`MainActivity.kt`](file:///D:/SakkuPay/companion-android/app/src/main/java/in/sakkupay/companion/MainActivity.kt#L56-L153) | Server Code input (auto 4-digit spacing) -> Check & Pair -> Displays 6-digit App Code. |
| **Notification Listener** | **Complete** | [`PaymentNotificationListener.kt`](file:///D:/SakkuPay/companion-android/app/src/main/java/in/sakkupay/companion/PaymentNotificationListener.kt) | Listens to GPay, PhonePe, Paytm, BHIM, and bank SMS packages. |
| **Regex Parser** | **Complete** | [`PaymentParser.kt`](file:///D:/SakkuPay/companion-android/app/src/main/java/in/sakkupay/companion/PaymentParser.kt) | Rejects debits/transfers sent; parses credit amounts (₹/Rs/INR) and UTR references. |
| **Physical Device Verification** | **Pending** | Hardware Requirement | Physical sideloading on Android 13/14/15 required to verify OS Restricted Settings. |
| **Play Protect Reputation** | **Pending** | External Google Service | Keystore warning heuristic is resolved; full sideloading reputation accumulates over time. |

---

### B. Merchant Cashier Connection & Pairing Protocol

| Step / Feature | Status | Implementation Details |
|---|:---:|---|
| **Collect Apps Navigation** | **Complete** | Dedicated "Collect Apps" tab in merchant dashboard with "Connect by App" modal. |
| **Download & Tutorial Page** | **Complete** | 3-step illustrated guide with explicit warning on Android 13+ Restricted Settings. |
| **Session Persistence & Recovery** | **Complete** | `cashier_pairing_sessions` table in SQLite/PostgreSQL. Endpoint `GET /api/cashier/sessions/:id` recovers state across refreshes and back navigation. |
| **12-Digit Server Code** | **Complete** | Generated cryptographically via `crypto.randomBytes(12)`, formatted as `XXXX XXXX XXXX`, stored as SHA-256 hash with 15-minute expiration (`/api/cashier/sessions`). |
| **Companion App Code Check** | **Complete** | Mobile app calls `POST /api/cashier/pair-server-code`. Validates hash, issues scoped API key (`sk_csh_...`), and generates single-use 6-digit App Code. |
| **Dashboard Verify Cashier** | **Complete** | Merchant inputs 6-digit App Code (`POST /api/cashier/verify-app-code`). Validates against `appCodeHash` with 5-attempt brute-force lockout. |
| **Attached Cashiers List** | **Complete** | `GET /api/cashier/list` renders active paired cashiers with provider badges, phone numbers, and last active timestamps. |
| **Cashier Audit Logs** | **Complete** | `GET /api/cashier/logs` displays pairing lifecycle events (`pairing_session_created`, `server_code_verified`, `cashier_activated`, `cashier_revoked`). |
| **Provider & UPI Validation** | **Complete** | Validates provider in `['phonepe', 'paytm', 'gpay', 'other']`, 10-digit mobile number, and valid UPI handle format (`@` check). |

---

### C. Backend, Security & Infrastructure

| Security Dimension | Status | Verification & Code Evidence |
|---|:---:|---|
| **Merchant Authentication** | **Complete** | HMAC-SHA256 Bearer tokens signed with `SAKKUPAY_TOKEN_SECRET`. Strict `auth(req)` middleware on all private routes. |
| **Admin RBAC** | **Complete** | Multi-role administrative structure (`SuperAdmin`, `OperationsSupport`, `ComplianceAuditor`) with privilege escalation prevention. |
| **Single-Use Pairing Codes** | **Complete** | Sessions transition from `pending_server_code` -> `app_code_generated` -> `completed`. Expired or used codes are immediately rejected. |
| **Brute-Force & Rate Limiting** | **Complete** | In-memory sliding-window rate limiters on checkout (20/min), admin login (5 failures/15min lockout), companion webhook (60/min), and cashier pairing (15/10min). |
| **Merchant Data Isolation** | **Complete** | All queries enforce `WHERE merchantId = ?`. Cross-tenant mutations return HTTP 404 (preventing ID enumeration). |
| **Immutable Audit Logs** | **Complete** | SQLite triggers `trg_prevent_audit_update` and `trg_prevent_audit_delete` strictly block raw mutations. Admin actions create structured change logs. |
| **Production Secret Guards** | **Complete** | Server refuses to boot in `NODE_ENV === 'production'` if default/weak secrets or ephemeral SQLite are detected. |

---

### D. Database Architecture & Persistence Status

| Capability | Status | Implementation Details |
|---|:---:|---|
| **Local SQLite Driver** | **Complete** | Node.js v22+ built-in `node:sqlite` in WAL mode with foreign keys. High-performance prepared statements. |
| **PostgreSQL Schema Migrations** | **Complete** | [`src/db/postgresSchema.js`](file:///D:/SakkuPay/src/db/postgresSchema.js) provides 5 sequential, atomic DDL migrations with integer paise precision (`BIGINT`). |
| **Atomic Data Migration Engine** | **Complete** | [`src/db/migrateSqliteToPostgres.js`](file:///D:/SakkuPay/src/db/migrateSqliteToPostgres.js) transfers all SQLite records into PostgreSQL in a single atomic transaction with count parity checks. |
| **Runtime Persistence on Render** | **Partially Complete** | **Option A (Ready):** Mounting a Render Persistent Disk at `DB_PATH=/var/data/sakkupay.db` works 100% out-of-the-box with current synchronous repository code.<br>**Option B (Pending):** Full runtime querying against managed PostgreSQL requires adapting the synchronous repository layer ([`src/db/repository.js`](file:///D:/SakkuPay/src/db/repository.js)) from `DatabaseSync` to async queries. |
| **Startup Persistence Guard** | **Complete** | [`server.js`](file:///D:/SakkuPay/server.js#L91-L95) explicitly throws and halts boot in production if neither `DATABASE_URL` nor persistent `DB_PATH` is configured. |

---

### E. Payment Verification Engine & Provider Integration Limits

| Payment Route | Status | Mechanism & Limitations |
|---|:---:|---|
| **Payment Link Creation** | **Complete** | Dynamic slug generation, fixed or open amounts, template selection (`classic`, `minimal`, `premium-dark`, `modern-gradient`, `compact-upi`). |
| **Checkout UI & QR Code** | **Complete** | Real vector QR code rendered via `qrcode.min.js`, deep-link UPI intents for GPay, PhonePe, Paytm, BHIM. |
| **Android Companion Webhook** | **Complete** | `POST /api/v1/webhook/verify-payment` receives parsed notification data, verifies scoped API key, matches UTR and amount against pending orders. |
| **Direct PhonePe Webhook** | **Complete** | `POST /api/v1/webhook/phonepe` validates `X-VERIFY` cryptographic signature using AES-256 decrypted salt key, verifies amount in paise. |
| **Direct Paytm Webhook** | **Complete** | `POST /api/v1/webhook/paytm` validates `CHECKSUMHASH` against AES-256 decrypted merchant key. |
| **Duplicate Prevention** | **Complete** | Reconciler flags repeated webhook events as duplicates (`duplicate: true`) without credit duplication. |
| **Settlement Truth Guard** | **Complete** | Mismatched amounts or ambiguous UTR submissions are placed in `reconciliationStatus: flagged_ambiguous` / `under_review`. Payments are never self-approved by merchants. |
| **Bank Direct Pull APIs** | **Not Implemented** | There is **NO** direct corporate banking server-to-server pull integration (e.g. ICICI Corporate API, HDFC SmartHub). Reconciliation relies strictly on inbound push notifications (Android Companion) or provider webhooks (PhonePe/Paytm). |
| **Background Cron/Queue Worker** | **Not Implemented** | No background queue worker (Redis/BullMQ) is running. Re-verification occurs when webhooks arrive or when an administrator executes manual force-settle with proof. |

---

## 3. Automated Test Suite Execution Summary

All 14 test suites in the repository were executed and verified:

| Test Suite | Tests | Result | Focus Area |
|---|:---:|:---:|---|
| `test-milestone1.js` | 38 | **PASSED** | PhonePe/Paytm signatures, rate limits, merchant self-approval blocks |
| `test-milestone2.js` | 35 | **PASSED** | SQLite migration, foreign keys, prepared statements, paise math |
| `test-milestone3.js` | 27 | **PASSED** | Terminal state lock, out-of-order webhooks, companion ambiguity |
| `test-milestone4.js` | 140 | **PASSED** | Admin investigation drawer, audit diffs, staff RBAC, diagnostics |
| `test-milestone5.js` | 111 | **PASSED** | Merchant UI/UX, forensics drawer, public payment link studio |
| `test-milestone6.js` | 21 | **PASSED** | Query token hardening (CWE-598), security headers, DoS limits |
| `test-postgres-database-persistence.js` | 10 | **PASSED** | PostgreSQL migrations 1–5, engine selection, atomic rollback |
| `test-cashier-pairing-suite.js` | 16 | **PASSED** | Two-stage pairing, 12-digit Server Code, 6-digit App Code, logs |
| `test-companion-download-auth.js` | 9 | **PASSED** | Authenticated APK download, HEAD requests, token verification |
| `test-dashboard-navigation-and-profile.js` | 15 | **PASSED** | 8 dashboard pages, workspace footer, profile API, security tabs |
| `test-master-upgrade-suite.js` | 16 | **PASSED** | Payment link modal, real QR generation, admin RBAC |
| `test-merchant-fixes.js` | 59 | **PASSED** | Public checkout routing, templates, support ticket tracking |
| `test-payment-link-loading-states.js` | 33 | **PASSED** | Visual checkout states, error recovery, inactive link badges |
| `test-responsive-viewports.js` | 56 | **PASSED** | 7 viewports (360px to 1920px) across Home, Login, Checkout, Admin |
| **Cumulative Total** | **586** | **100% PASSED** | **Zero Failures Across Entire Codebase** |

---

## 4. Known Limitations & Blockers Before Production Deployment

1. **Production Infrastructure Not Provisioned**:
   - The production Render service is currently running an earlier build.
   - A managed PostgreSQL instance or Render Persistent Disk has **not** been attached to the production service yet.
2. **Repository Layer Driver Scope**:
   - `src/db/repository.js` operates synchronously via `node:sqlite`.
   - For immediate production persistence on Render without modifying the data access layer, a **Render Persistent Disk** mounted at `DB_PATH=/var/data/sakkupay.db` is the recommended path.
   - For managed PostgreSQL, the schema and atomic data migrator are fully tested, but an async repository adapter must be completed before pointing live web requests directly to PostgreSQL.
3. **Physical Android Device Testing Required**:
   - The Companion APK binary is release-signed, but physical testing on Android 13/14/15 is necessary to guide users through the "Restricted Settings" dialog (which Android applies to sideloaded notification listeners).
4. **Google OAuth Production Redirect URI**:
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must be created in Google Cloud Console with authorized redirect URI `https://sakkupay.onrender.com/api/auth/google/callback`.
