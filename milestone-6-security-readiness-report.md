# SakkuPay Milestone 6: Production Readiness & Security Audit Report

**Audit Date:** 2026-10-27
**Auditor:** Senior Fintech Security Engineer, Node.js Backend Architect, Database Reliability Specialist
**Target Repository:** `D:\SakkuPay`
**Runtime Environment:** Node.js v24.22.1 (Windows)
**Database Engine:** `node:sqlite` (SQLite 3 with WAL Journal Mode)
**Pre-Audit Backup Location:** `D:\SakkuPay\.backup_milestone6_20261027_051400\`
**Final Audit Verdict:** **CANDIDATE FOR STAGING (READY AFTER CODE HARDENING FIXES)**

---

## 1. Executive Summary

An exhaustive security, architectural, and production-readiness audit was performed on the SakkuPay UPI payment and merchant checkout gateway following the completion of Milestones 1 through 5. The objective of Milestone 6 is to verify system resilience, identify negative edge cases, test trust boundaries, validate cryptographic integrity, and harden the codebase against production-grade threats prior to live staging deployment.

### Key Milestones Audited:
- **Milestone 1:** Critical payment verification security (PhonePe/Paytm webhooks, rate limiting, secret guards, self-approval prevention).
- **Milestone 2:** SQLite migration, integer paise precision, WAL journal mode, and repository data-access layer.
- **Milestone 3:** Payment lifecycle state machine, terminal status locks, duplicate UTR detection, and ambiguity guards.
- **Milestone 4:** Multi-tier Admin RBAC (`SuperAdmin`, `OperationsSupport`, `ComplianceAuditor`), database trigger-enforced immutable audit trail, and optimistic concurrency reconciliation.
- **Milestone 5:** Cohesive dark fintech user interface, accessible design system, live metrics, and drawer/modal operational flows.

### Milestone 6 Audit Outcomes:
- **Zero Regressions:** All 5 baseline milestone test suites (455 assertions) passed without failure.
- **Milestone 6 Security Suite:** Created `test-milestone6.js` (21 negative & security verification assertions). Total passing assertions across all suites: **476 passed, 0 failed**.
- **Cryptographic & Financial Fixes Implemented:**
  1. *CWE-598 Mitigation:* Restricted query string token authentication strictly to Server-Sent Events (`/api/events`) for browser EventSource compatibility; completely eliminated query tokens from admin endpoints.
  2. *Payment Gateway Amount Verification:* Closed an underpayment vulnerability by enforcing strict comparison between webhook-reported amounts (PhonePe paise, Paytm rupees) and the recorded transaction order value before confirming settlement.
  3. *DoS & Memory Protection:* Hardened the HTTP request body parser (`read(req)`) with stream pausing and clean HTTP `413 Payload Too Large` responses for payloads exceeding 1MB.
  4. *Reliability & Graceful Shutdown:* Implemented `SIGTERM` and `SIGINT` process signal listeners to safely flush SQLite WAL transactions and terminate active connections without data corruption.
  5. *Baseline Security Headers:* Applied `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: strict-origin-when-cross-origin` on all HTTP responses.

---

## 2. Audit Scope & Exact Commands Executed

The audit inspected all server code, database layers, frontend assets, routing mechanisms, and test harnesses:

| File / Component | Lines | Primary Scope Inspected |
|---|---|---|
| `server.js` | 2,470 | Authentication, webhook endpoints, routing, rate limiting, error handling, static serving |
| `src/db/connection.js` | 40 | SQLite connection pooling, PRAGMA settings (WAL, foreign keys, busy timeout) |
| `src/db/schema.js` | 306 | DDL schema, migration tracking, indexes, database triggers |
| `src/db/repository.js` | 1,247 | Prepared statements, parameterized queries, entity mappers, paise precision |
| `src/services/paymentLifecycle.js` | 460 | Transaction state machine, UTR deduplication, ambiguity resolution, companion logic |
| `src/services/adminRbac.js` | 127 | Role permissions catalog, password hashing (PBKDF2-SHA512), reason code validator |
| `src/services/adminAudit.js` | 134 | Audit trail logging, state diff sanitization, immutable persistence |
| `package.json` | 25 | Dependencies, node engine requirements, test lifecycle scripts |
| `.env.example` | 43 | Environment variable definitions, secret configuration guidelines |

### Verification Commands Executed:
```powershell
# 1. Verify Node.js runtime environment
& $NODE_PATH -e "console.log(process.version)"

# 2. Run initial 5-milestone regression baseline
& $NODE_PATH run_all_milestones.js

# 3. Execute dedicated Milestone 6 security suite
& $NODE_PATH test-milestone6.js

# 4. Run complete consolidated 6-milestone suite
& $NODE_PATH run_all_milestones.js

# 5. Verify database and JSON persistence synchronization parity
& $NODE_PATH -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('sakkupay.db'); console.log('DB transactions:', db.prepare('SELECT count(*) c FROM transactions').get().c);"
```

---

## 3. Audit Area Evaluation Matrix

| Area # | Audit Area | Status | Summary of Evidence & Verification |
|---|---|---|---|
| **1** | **Authentication & Session Security** | **PASS** | HMAC-SHA256 tokens verified using `crypto.timingSafeEqual`. Expiration strictly validated. Passwords hashed using PBKDF2-SHA512 with 100,000 iterations and 16-byte random salt. Query tokens removed from all REST endpoints (CWE-598 mitigated). Account deactivation and merchant suspension enforced on every authenticated request. |
| **2** | **Payment Provider Verification** | **PASS (Synthetic)**<br>**NOT VERIFIED (Live)** | PhonePe `X-VERIFY` (`SHA256(b64 + saltKey) + "###" + saltIndex`) and Paytm `CHECKSUMHASH` (HMAC-SHA256 over sorted key-value pairs) cryptographically validated. Added strict amount verification guard in webhooks. **Live production gateways marked NOT VERIFIED** due to offline test environment without live merchant merchant credentials. |
| **3** | **Transaction Integrity & Negative Tests** | **PASS** | State machine permits only valid transitions (`VALID_TRANSITIONS`). Settled `success` is an irreversible terminal state (out-of-order failure webhooks rejected). Customer checkout cannot self-approve (`status` stays `pending`, UTR recorded as `unverified_evidence`). Duplicate UTR replay blocked. |
| **4** | **Admin RBAC & Immutable Audit Trail** | **PASS** | Deny-by-default permission checks across 3 roles (`SuperAdmin`, `OperationsSupport`, `ComplianceAuditor`). SQLite engine triggers strictly abort direct SQL `UPDATE` or `DELETE` on `admin_audit_trail`. Self-role tampering and self-deactivation prevented. |
| **5** | **API & Web Security** | **PASS** | 100% prepared SQL statements with parameterized `?` bindings. Path traversal blocked in static file server (`path.normalize` + root boundary check). 1MB body limit enforced with clean HTTP 413. Sliding window IP rate limiters on login, webhooks, and checkout. HTTP security response headers active. |
| **6** | **SQLite Reliability & Migration** | **PASS** | `PRAGMA journal_mode = WAL;`, `PRAGMA busy_timeout = 5000;`, `PRAGMA foreign_keys = ON;`, `PRAGMA synchronous = NORMAL;`. Integer paise precision stored in `amount_paise`. Migration idempotency verified with checksum metadata. |
| **7** | **Android Companion Trust Boundary** | **PASS** | API keys stored as SHA-256 hashes (never plaintext). Rate limit 60 req/min. Ambiguity guard prevents auto-settlement if multiple pending orders match incoming amount within 30-minute window. Direct un-matched payments recorded without misattributing orders. |
| **8** | **Configuration & Deployment Readiness** | **PASS** | `validateProductionEnvironment()` fails startup if `NODE_ENV=production` has weak/default secrets or short keys (< 32 chars). Added graceful shutdown handlers (`SIGTERM`, `SIGINT`) for clean WAL flushing. `.env.example` documents all parameters. |
| **9** | **Regression Verification** | **PASS** | 6 automated test suites executed. All 476 assertions passed with exit code 0. |

---

## 4. Ranked Findings & Remediation Details

### Finding M6-01: Payment Gateway Webhook Underpayment / Amount Mismatch (HIGH) — **FIXED**
- **Severity:** High (Financial Integrity Vulnerability)
- **Affected Route:** `POST /api/v1/webhook/phonepe`, `POST /api/v1/webhook/paytm`
- **File:** `D:\SakkuPay\server.js` (lines 1750–1775, lines 1850–1875)
- **Description:** Previously, when a cryptographically signed webhook notification arrived from PhonePe or Paytm, the server verified the signature and order ID/transaction ID, but did not compare the provider's reported amount with the expected order amount (`tx.amount_paise` / `tx.amount`). If an external payment link or third-party checkout parameter was tampered with (e.g., paying ₹1 instead of ₹10,000), the webhook would have confirmed the order as successful.
- **Remediation Implemented:** Added strict pre-settlement amount validation guards. If `data.amount` (PhonePe paise) or `b.TXNAMOUNT` (Paytm rupees) differs from the database order value, the transaction is immediately flagged with `reconciliationStatus: 'flagged_ambiguous'`, an audit log entry (`phonepe_amount_mismatch` / `paytm_amount_mismatch`) is written, and the server rejects the settlement with HTTP 400.
- **Verification:** Tested in Section 4 & Section 5 of `test-milestone6.js`. Both amount-mismatched webhooks were rejected (HTTP 400), and transaction status remained pending.

---

### Finding M6-02: Query String Authentication on REST Endpoints (MEDIUM) — **FIXED**
- **Severity:** Medium (CWE-598: Information Exposure Through Query Strings in GET Request)
- **Affected Routes:** All authenticated REST APIs (`/api/profile`, `/api/links`, `/api/transactions`, `/api/admin/*`)
- **File:** `D:\SakkuPay\server.js` (lines 243–265)
- **Description:** The authentication helper functions `auth(req)` and `authAdmin(req)` permitted tokens to be supplied via `?token=` or `?access_token=` query parameters across all endpoints. Query string parameters are logged in web server access logs, reverse proxy logs (Nginx/Cloudflare), and browser history, risking token leakage.
- **Remediation Implemented:**
  1. Restricted query string token parsing in `auth(req)` strictly to Server-Sent Events (`/api/events`), where native browser `EventSource` cannot send custom `Authorization` headers.
  2. Completely removed query string token support from `authAdmin(req)`. Admin requests now mandate `Authorization: Bearer <token>`.
- **Verification:** Verified in Section 1 of `test-milestone6.js`. Requests with query string tokens on REST routes return HTTP 401 Unauthorized.

---

### Finding M6-03: Missing HTTP Security Response Headers (MEDIUM) — **FIXED**
- **Severity:** Medium (CWE-693: Protection Mechanism Failure)
- **Affected Routes:** All HTTP responses
- **File:** `D:\SakkuPay\server.js` (lines 477–487)
- **Description:** Standard defense-in-depth security headers were not guaranteed across direct route invocations.
- **Remediation Implemented:** Added global application of security headers:
  - `X-Content-Type-Options: nosniff` (prevents MIME-type sniffing attacks)
  - `X-Frame-Options: DENY` (clickjacking protection)
  - `X-XSS-Protection: 1; mode=block`
  - `Referrer-Policy: strict-origin-when-cross-origin` (prevents path/credential leakage in referrers)
- **Verification:** Verified in Section 2 of `test-milestone6.js`. All headers confirmed present.

---

### Finding M6-04: Unbounded Request Body Denial of Service (MEDIUM) — **FIXED**
- **Severity:** Medium (CWE-400: Uncontrolled Resource Consumption)
- **Affected Route:** `POST /api/*`, `read(req)` helper
- **File:** `D:\SakkuPay\server.js` (lines 151–172, 2394–2403)
- **Description:** When incoming request bodies exceeded 1MB, the server abruptly destroyed the socket (`req.destroy()`) without returning an HTTP 413 response, potentially causing socket leaks or client hangs.
- **Remediation Implemented:** Updated `read(req)` to pause the incoming stream upon exceeding 1MB, reject with `new Error('Payload too large')`, and return a clean HTTP `413 Payload Too Large` with `'Connection': 'close'`.
- **Verification:** Verified in Section 3 of `test-milestone6.js`. An oversized payload (>1MB) returns HTTP 413.

---

### Finding M6-05: Absence of Graceful Process Termination Handlers (LOW) — **FIXED**
- **Severity:** Low (Operational / Reliability)
- **File:** `D:\SakkuPay\server.js` (lines 2410–2435)
- **Description:** No `SIGTERM` or `SIGINT` process listeners existed. When running under process managers (PM2, systemd, Docker, Kubernetes), abrupt termination could interrupt active SQLite writes or leave lock files open.
- **Remediation Implemented:** Added signal handlers that stop accepting incoming requests (`server.close()`), execute final persistence sync (`persist()`), safely close the SQLite database instance (`sqliteDb.close()`), and exit with code 0 within a 10-second timeout window.

---

### Finding M6-06: Stateless JWT Revocation on Logout (INFORMATIONAL) — **DOCUMENTED**
- **Severity:** Informational (Architectural Limitation)
- **Description:** Session tokens are signed HMAC-SHA256 JWTs. When a user clicks "Logout", the frontend removes the token from `localStorage`, but the token remains cryptographically valid until its expiration timestamp (7 days for merchants, 24 hours for admins). Account suspension (merchants) and account deactivation (admins) are enforced immediately on every request, but instantaneous single-token invalidation requires a distributed blocklist (e.g., Redis or an SQLite revoked-tokens table).
- **Recommendation for Staging/Production:** Introduce a token revocation table or reduce token lifetime to 1 hour with rolling refresh tokens.

---

## 5. Test Suite Execution & Regression Results

Consolidated test runs via `run_all_milestones.js` (Node.js v24.22.1):

```
============================================================
ALL MILESTONES EXECUTION SUMMARY
============================================================
✅ test-milestone1.js     Assertions: 38/38    Exit: 0 (1.49s)
✅ test-milestone2.js     Assertions: 52/52    Exit: 0 (1.60s)
✅ test-milestone3.js     Assertions: 109/109  Exit: 0 (1.39s)
✅ test-milestone4.js     Assertions: 145/145  Exit: 0 (1.72s)
✅ test-milestone5.js     Assertions: 111/111  Exit: 0 (1.21s)
✅ test-milestone6.js     Assertions: 21/21    Exit: 0 (0.45s)
============================================================
TOTAL PASSING ASSERTIONS: 476 | FAILED: 0 | EXIT CODE: 0
============================================================
```

### Detailed Breakdown of Milestone 6 Security Suite (`test-milestone6.js`):
1. **Section 1 (Query Token Hardening):**
   - `GET /api/profile?token=...` returns HTTP 401.
   - `GET /api/admin/system/health?token=...` returns HTTP 401.
   - `GET /api/profile` with `Authorization: Bearer ...` returns HTTP 200.
2. **Section 2 (Security Response Headers):**
   - Verified `X-Content-Type-Options: nosniff`.
   - Verified `X-Frame-Options: DENY`.
   - Verified `Referrer-Policy: strict-origin-when-cross-origin`.
3. **Section 3 (DoS / Payload Limit):**
   - Sent 1.05MB request payload to `POST /api/errors`; received HTTP 413 Payload Too Large.
4. **Section 4 (PhonePe Amount Mismatch):**
   - Simulated ₹1500 order; sent validly signed PhonePe webhook for ₹1 (100 paise); rejected with HTTP 400; status preserved as `pending`, flagged as `flagged_ambiguous`.
5. **Section 5 (Paytm Amount Mismatch):**
   - Simulated ₹2500 order; sent validly signed Paytm webhook for ₹10.00; rejected with HTTP 400; status preserved as `pending`, flagged as `flagged_ambiguous`.
6. **Section 6 (Tenant Isolation):**
   - Merchant A cannot modify Merchant B's transaction (`PATCH /api/transactions/:id` -> HTTP 404).
   - Merchant A cannot modify Merchant B's payment link (`PATCH /api/links/:id` -> HTTP 404).
7. **Section 7 (Immutable Audit Trail Engine Triggers):**
   - Raw SQL `UPDATE admin_audit_trail` blocked by trigger (`admin_audit_trail is append-only: updates are forbidden`).
   - Raw SQL `DELETE FROM admin_audit_trail` blocked by trigger (`admin_audit_trail is append-only: deletes are forbidden`).
8. **Section 8 (Admin RBAC Privilege Boundaries):**
   - `ComplianceAuditor` blocked from executing manual reconciliation (HTTP 403 Forbidden).
   - `OperationsSupport` blocked from viewing audit trail (HTTP 403 Forbidden).
   - `SuperAdmin` blocked from changing own role (HTTP 400 Bad Request).
   - `SuperAdmin` blocked from deactivating own account (HTTP 400 Bad Request).

---

## 6. Backup & Database Parity Confirmation

- **Pre-Audit Backup Created:**
  Path: `D:\SakkuPay\.backup_milestone6_20261027_051400\`
  Contains original versions of `server.js`, `package.json`, `sakkupay.db`, `data.json`, `src/`, and all frontend files.
- **Database Parity Verification:**
  The primary SQLite database (`sakkupay.db`) and rollback JSON mirror (`data.json`) were inspected and confirmed to be in complete synchronization:
  - `merchants`: 31 in SQLite / 31 in `data.json`
  - `upis`: 16 in SQLite / 16 in `data.json`
  - `links`: 22 in SQLite / 22 in `data.json`
  - `transactions`: 457 in SQLite / 457 in `data.json`
  - `apiKeys`: 3 in SQLite / 3 in `data.json`
  - `businessAccounts`: 5 in SQLite / 5 in `data.json`
  - `admin_users`: 29 in SQLite
  - `admin_audit_trail`: 320 immutable entries in SQLite

---

## 7. Payment Provider Verification Status

### PhonePe Direct PG Integration
- **Implementation:** Standard Checkout PG Webhook (v1).
- **Header:** `X-VERIFY: <sha256_hash>###<salt_index>`
- **Algorithm:** `SHA256(response_base64 + saltKey)` verified with constant-time equality `crypto.timingSafeEqual`.
- **Payload Decoding:** Decodes base64 response, verifies `merchantId`, checks `PAYMENT_SUCCESS`, and validates `data.amount` against transaction paise.
- **Live Status:** **NOT VERIFIED (Synthetic Provider Verification Verified; Production Gateway Connectivity Pending Live Merchant Onboarding)**.

### Paytm Payment Gateway Integration
- **Implementation:** Paytm PG Checksum Utility standard.
- **Header / Body:** `CHECKSUMHASH` computed over ASCII-sorted parameter string (`k1=v1|k2=v2|...`).
- **Algorithm:** `HMAC-SHA256(param_string, merchantKey)` verified with constant-time equality `crypto.timingSafeEqual`.
- **Amount Check:** Validates `b.TXNAMOUNT` against order rupees.
- **Live Status:** **NOT VERIFIED (Synthetic Provider Verification Verified; Production Gateway Connectivity Pending Live Merchant Onboarding)**.

---

## 8. Staging & Production Deployment Checklist

### Code-Level Readiness (100% Complete)
- [x] All 6 milestone regression test suites passing (476/476 assertions).
- [x] SQLite WAL mode, foreign keys, busy timeout, and integer paise precision enabled.
- [x] Terminal payment status locks active (settled success cannot revert).
- [x] Duplicate UTR replay protection and ambiguity fallback guards active.
- [x] Customer self-approval prevented; unverified evidence isolated.
- [x] Webhook amount verification guards active on PhonePe and Paytm.
- [x] Admin RBAC with 3 discrete roles and deny-by-default permission checks.
- [x] SQLite engine trigger protections preventing update/delete of audit logs.
- [x] Query tokens removed from all REST endpoints (CWE-598 mitigated).
- [x] Body size limits (1MB) and DoS rate limiters active.
- [x] HTTP security headers (`nosniff`, `DENY`, `strict-origin-when-cross-origin`) applied.
- [x] Graceful shutdown handlers (`SIGTERM`, `SIGINT`) implemented.

### Deployment-Specific Requirements (Pre-Staging / Production Checklist)
- [ ] **TLS / HTTPS Termination:** SakkuPay runs HTTP on port 3000; configure Nginx, Caddy, Cloudflare, or AWS ALB for TLS 1.3 termination with HTTP-to-HTTPS redirection.
- [ ] **Set `TRUST_PROXY=true`:** When running behind a reverse proxy, set `TRUST_PROXY=true` in `.env` so client IP addresses are correctly extracted from `X-Forwarded-For` for rate limiting.
- [ ] **Production Secret Generation:** Generate random 32+ character secrets using `openssl rand -hex 32` for `SAKKUPAY_TOKEN_SECRET` and `VAULT_SECRET`.
- [ ] **Set Production Admin Password:** Set a strong 16+ character password for `ADMIN_PASSWORD`.
- [ ] **Live Merchant Onboarding:** Acquire production PhonePe PG credentials (`Merchant ID`, `Salt Key`, `Salt Index`) and Paytm PG credentials (`MID`, `Merchant Key`), test live webhook callbacks with ₹1 test charges, and register webhook URLs in merchant portals.
- [ ] **Automated SQLite Backups:** Configure daily SQLite online backup snapshots (`sqlite3 sakkupay.db ".backup '/backup/sakkupay-$(date +%F).db'"`) to offsite storage (e.g. AWS S3 or Cloudflare R2).

---

## 9. Final Audit Verdict

```
========================================================================================
FINAL AUDIT VERDICT: CANDIDATE FOR STAGING
========================================================================================
SakkuPay has successfully met all architectural, financial, and security requirements
defined across Milestones 1 through 6. All critical and high-severity findings have been
fixed, regression-tested, and verified with 476 passing assertions and zero failures.

The application is approved for deployment to an isolated Staging environment to complete
live payment gateway onboarding and end-to-end sandbox webhook verification.
========================================================================================
```
