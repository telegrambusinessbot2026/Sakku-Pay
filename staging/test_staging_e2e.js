/* ==============================================================================
   SakkuPay Milestone 6.2: Staging End-to-End Acceptance Test Suite
   Runs comprehensive verification against isolated staging server on port 3001.
   Covers:
   - Merchant Workflows & Multi-Tenant Isolation
   - Multi-Tier Admin RBAC (SuperAdmin, OperationsSupport, ComplianceAuditor)
   - Payment Lifecycle Negative & Tamper Protection
   - Operational Integrity & Zero-Production Leaks
   ============================================================================== */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const STAGING_PORT = 3001;
const BASE_URL = `http://127.0.0.1:${STAGING_PORT}`;
const STAGING_DIR = __dirname;
const STAGING_DB_PATH = path.join(STAGING_DIR, 'sakkupay_staging.db');
const STAGING_JSON_PATH = path.join(STAGING_DIR, 'data.json');
const ENV_STAGING_PATH = path.join(STAGING_DIR, '.env.staging');

// Helper to make HTTP requests
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    let bodyStr = null;
    if (options.body) {
      bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (!reqOptions.headers['Content-Type']) {
        reqOptions.headers['Content-Type'] = 'application/json';
      }
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    let settled = false;
    let resReceived = false;

    const req = http.request(url, reqOptions, res => {
      resReceived = true;
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json !== null ? json : data,
          raw: data
        });
      });
    });

    req.on('error', err => {
      if (settled) return;
      if (resReceived) {
        setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }, 50);
        return;
      }
      settled = true;
      reject(err);
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let passedAssertions = 0;
let failedAssertions = 0;

function assert(condition, message) {
  if (condition) {
    passedAssertions++;
    console.log(`  ✅ PASSED: ${message}`);
  } else {
    failedAssertions++;
    console.error(`  ❌ FAILED: ${message}`);
  }
}

async function runMilestone62StagingSuite() {
  console.log('==============================================================================');
  console.log('SakkuPay Milestone 6.2: Staging End-to-End Acceptance Test Suite');
  console.log('==============================================================================\n');

  // 1. Verify Staging Password from .env.staging
  const envContent = fs.readFileSync(ENV_STAGING_PATH, 'utf8');
  const envPasswordMatch = envContent.match(/^ADMIN_PASSWORD=(.*)$/m);
  if (!envPasswordMatch || !envPasswordMatch[1]) {
    throw new Error('ADMIN_PASSWORD not configured in .env.staging');
  }
  const stagingAdminPassword = envPasswordMatch[1].trim();

  // 2. Prepare staging environment variables
  const stagingEnv = {
    ...process.env,
    NODE_ENV: 'staging',
    PORT: String(STAGING_PORT),
    DB_PATH: STAGING_DB_PATH,
    DATA_JSON_PATH: STAGING_JSON_PATH,
    SAKKUPAY_TOKEN_SECRET: 'staging-token-secret-f9b8c2d4e6a01735bc8f2a4e6c8b0d2e4f6a8c0e2d4b6a8c',
    VAULT_SECRET: 'staging-vault-secret-7a1b3c5e9d2f4a6b8c0e2d4f6a8b0c2e4f6a8b0c2d4e6f8a',
    ADMIN_USERNAME: 'staging_admin',
    ADMIN_PASSWORD: stagingAdminPassword,
    TRUST_PROXY: 'true'
  };

  // Configure test runner environment to match staging secrets
  process.env.SAKKUPAY_TOKEN_SECRET = stagingEnv.SAKKUPAY_TOKEN_SECRET;
  process.env.VAULT_SECRET = stagingEnv.VAULT_SECRET;
  process.env.DB_PATH = stagingEnv.DB_PATH;
  process.env.DATA_JSON_PATH = stagingEnv.DATA_JSON_PATH;
  process.env.ADMIN_USERNAME = stagingEnv.ADMIN_USERNAME;
  process.env.ADMIN_PASSWORD = stagingAdminPassword;

  // 3. Launch isolated staging server instance
  console.log(`Launching isolated staging server at ${BASE_URL}...`);
  const serverProcess = cp.spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: stagingEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', d => {
    const s = d.toString().trim();
    if (s.includes('running at')) console.log(`  [Server Info] ${s}`);
  });
  serverProcess.stderr.on('data', d => {
    const s = d.toString().trim();
    if (!s.includes('Payload too large')) console.error(`  [Server Stderr] ${s}`);
  });

  // Wait for server to bind
  let serverOnline = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await request('/home.html');
      if (res.status === 200) {
        serverOnline = true;
        break;
      }
    } catch (_) {}
  }

  if (!serverOnline) {
    serverProcess.kill('SIGKILL');
    throw new Error('Staging server failed to bind port 3001 within timeout');
  }
  console.log('  ✅ Staging server online and isolated.\n');

  try {
    /* ==========================================================================
       SECTION 1: STAGING ISOLATION & GIT HYGIENE
       ========================================================================== */
    console.log('--- Section 1: Staging Isolation & Secret Hygiene ---');
    // Confirm .gitignore excludes secrets, db files, and backups
    const gitignoreContent = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    assert(gitignoreContent.includes('.env*') || gitignoreContent.includes('.env'), '.gitignore properly excludes .env files');
    assert(gitignoreContent.includes('*.db'), '.gitignore properly excludes SQLite database files');
    assert(gitignoreContent.includes('.backup*'), '.gitignore properly excludes backup directories');
    assert(gitignoreContent.includes('staging/*.db'), '.gitignore excludes staging database files');

    // Confirm that the staging server uses sakkupay_staging.db and NOT sakkupay.db
    assert(stagingEnv.DB_PATH.includes('sakkupay_staging.db'), 'Staging environment explicitly targets sakkupay_staging.db');
    assert(stagingEnv.DATA_JSON_PATH.includes('staging'), 'Staging environment explicitly targets staging/data.json');

    /* ==========================================================================
       SECTION 2: END-TO-END MERCHANT WORKFLOWS
       ========================================================================== */
    console.log('\n--- Section 2: End-to-End Merchant Workflows ---');
    const { token, adminToken } = require('../server');

    // Load merchant 1 from staging database
    const db = new DatabaseSync(STAGING_DB_PATH, { readOnly: true });
    const merchant1 = db.prepare("SELECT * FROM merchants WHERE id = 'mer_staging_retailer_01'").get();
    const tokenM1 = token(merchant1);

    // 1. Merchant Authentication & Profile
    const resProf = await request('/api/profile', {
      headers: { Authorization: `Bearer ${tokenM1}` }
    });
    assert(resProf.status === 200, 'Merchant profile retrieval returns HTTP 200');
    assert(resProf.data.businessName === 'Staging Beta Retailer', 'Merchant profile returns correct business name');
    assert(resProf.data.passwordHash === undefined, 'Merchant profile strictly omits passwordHash');

    // 2. Dashboard Metrics & Ledger Loading
    const resDash = await request('/api/dashboard', {
      headers: { Authorization: `Bearer ${tokenM1}` }
    });
    assert(resDash.status === 200, 'Merchant dashboard metrics returns HTTP 200');
    assert(typeof resDash.data.stats.volume === 'number', 'Dashboard returns financial volume');
    assert(typeof resDash.data.stats.volumePaise === 'number', 'Dashboard returns volumePaise integer precision');

    const resTxList = await request('/api/transactions', {
      headers: { Authorization: `Bearer ${tokenM1}` }
    });
    assert(resTxList.status === 200, 'Merchant transaction ledger returns HTTP 200');
    assert(Array.isArray(resTxList.data), 'Transactions returned as array');

    // 3. Payment Link Creation: Fixed-Amount & Open-Amount
    const resCreateFixedLink = await request('/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        name: 'Annual Subscription Plan',
        amount: 999,
        amountType: 'fixed',
        description: 'Fixed amount test link'
      }
    });
    assert(resCreateFixedLink.status === 201, 'Create fixed-amount payment link returns HTTP 201 Created');
    assert(resCreateFixedLink.data.amount === 999, 'Fixed link amount stored correctly');
    const fixedLink = resCreateFixedLink.data;

    const resCreateOpenLink = await request('/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        name: 'Custom Contribution Fund',
        amountType: 'open',
        description: 'Open amount customer contribution'
      }
    });
    assert(resCreateOpenLink.status === 201, 'Create open-amount payment link returns HTTP 201 Created');
    assert(resCreateOpenLink.data.amountType === 'open', 'Open link amountType stored correctly');
    const openLink = resCreateOpenLink.data;

    // 4. Customer Checkout Page & Intent QR Inspection
    const resCheckoutFixed = await request(`/pay/${fixedLink.slug}`);
    assert(resCheckoutFixed.status === 200, 'Customer checkout page for fixed link serves HTTP 200');

    // 5. Customer UTR Submission (Unverified Evidence Only)
    // Customer submits UTR via confirmation endpoint
    const resSubmitUtr = await request(`/api/checkout/${fixedLink.slug}/confirm`, {
      method: 'POST',
      body: {
        customerName: 'Aaditya Sharma',
        customerEmail: 'aaditya@example.com',
        amount: 999,
        utr: 'UTR998877665544'
      }
    });
    assert(resSubmitUtr.status === 200, 'Customer checkout confirm returns HTTP 200');
    assert(resSubmitUtr.data.transaction && resSubmitUtr.data.transaction.status === 'pending', 'Customer UTR submission keeps transaction status STRICTLY pending');
    assert(resSubmitUtr.data.transaction.reconciliationStatus === 'unverified_evidence', 'Customer UTR submission flagged as unverified_evidence');
    const pendingTx = resSubmitUtr.data.transaction;

    // 6. Polling Checkout Status
    const resPoll = await request(`/pay/${fixedLink.slug}`);
    assert(resPoll.status === 200, 'Customer polling endpoint operational');

    // 7. Multi-Tenant Merchant Isolation
    // Create a second synthetic merchant
    const dbWrite = new DatabaseSync(STAGING_DB_PATH);
    const merchant2 = {
      id: 'mer_staging_retailer_02',
      email: 'merchant2@staging.sakkupay.local',
      businessName: 'Rival Store Ltd',
      whatsappNumber: '9998887766',
      createdAt: new Date().toISOString()
    };
    dbWrite.prepare(`
      INSERT OR IGNORE INTO merchants (id, email, businessName, whatsappNumber, createdAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(merchant2.id, merchant2.email, merchant2.businessName, merchant2.whatsappNumber, merchant2.createdAt);
    dbWrite.close();

    const tokenM2 = token(merchant2);

    // Merchant 2 attempts to mutate Merchant 1's transaction
    const resTenantTxViolation = await request(`/api/transactions/${pendingTx.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenM2}` },
      body: { note: 'Illegitimate cross-merchant update attempt' }
    });
    assert(resTenantTxViolation.status === 404, 'Cross-tenant transaction modification blocked (HTTP 404 Not Found)');

    // Merchant 2 attempts to mutate Merchant 1's link
    const resTenantLinkViolation = await request(`/api/links/${fixedLink.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenM2}` },
      body: { active: false }
    });
    assert(resTenantLinkViolation.status === 404, 'Cross-tenant link modification blocked (HTTP 404 Not Found)');

    // 8. Invalid Input Handling
    const resInvalidLink = await request('/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { name: '', amount: -50 } // Invalid
    });
    assert(resInvalidLink.status === 400, 'Invalid link input rejected with HTTP 400 Bad Request');

    /* ==========================================================================
       SECTION 3: ADMIN WORKFLOWS & MULTI-TIER RBAC
       ========================================================================== */
    console.log('\n--- Section 3: Admin Workflows & Multi-Tier RBAC ---');
    const { ADMIN_ROLES, REASON_CODES } = require('../src/services/adminRbac');

    // Authenticate SuperAdmin via direct login
    const resAdminLogin = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'superadmin@staging.sakkupay.local', password: stagingAdminPassword }
    });
    assert(resAdminLogin.status === 200, 'SuperAdmin login returns HTTP 200');
    const superAdminJwt = resAdminLogin.data.token;

    // Create tokens for OperationsSupport and ComplianceAuditor
    const opsUser = db.prepare("SELECT * FROM admin_users WHERE role = 'OperationsSupport'").get();
    const auditorUser = db.prepare("SELECT * FROM admin_users WHERE role = 'ComplianceAuditor'").get();
    const opsJwt = adminToken(opsUser);
    const auditorJwt = adminToken(auditorUser);

    // 1. Merchant Directory & Suspension
    // SuperAdmin can suspend
    const resSuspend = await request(`/api/admin/merchants/${merchant1.id}/suspend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: { suspended: true, reasonCode: 'COMPLIANCE_HOLD', justification: 'Temporary compliance review' }
    });
    assert(resSuspend.status === 200, 'SuperAdmin can suspend merchant (HTTP 200)');
    assert(resSuspend.data.suspended === true, 'Merchant suspension state recorded as true');

    // Suspended merchant blocked from profile
    const resSuspendedAccess = await request('/api/profile', {
      headers: { Authorization: `Bearer ${tokenM1}` }
    });
    assert(resSuspendedAccess.status === 403, 'Suspended merchant blocked from API (HTTP 403 Forbidden)');

    // SuperAdmin unsuspends merchant
    const resUnsuspend = await request(`/api/admin/merchants/${merchant1.id}/suspend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: { suspended: false, reasonCode: 'COMPLIANCE_HOLD', justification: 'Review passed' }
    });
    assert(resUnsuspend.status === 200, 'SuperAdmin can unsuspend merchant (HTTP 200)');

    // OperationsSupport and ComplianceAuditor CANNOT suspend merchants
    const resOpsSuspend = await request(`/api/admin/merchants/${merchant1.id}/suspend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opsJwt}` },
      body: { suspended: true }
    });
    assert(resOpsSuspend.status === 403, 'OperationsSupport DENIED permission to suspend merchant (HTTP 403)');

    const resAuditorSuspend = await request(`/api/admin/merchants/${merchant1.id}/suspend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auditorJwt}` },
      body: { suspended: true }
    });
    assert(resAuditorSuspend.status === 403, 'ComplianceAuditor DENIED permission to suspend merchant (HTTP 403)');

    // 2. Transaction Investigation & Diagnostics Timeline
    const resTimeline = await request(`/api/admin/transactions/${pendingTx.id}/timeline`, {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(resTimeline.status === 200, 'OperationsSupport can access investigation timeline (HTTP 200)');
    assert(resTimeline.data.diagnostics.reconciliationStatus === 'unverified_evidence', 'Investigation timeline highlights unverified customer evidence');
    assert(resTimeline.data.timeline.some(e => e.type === 'customer_utr_submitted'), 'Customer UTR submission event recorded in timeline');

    // 3. Audited Reconciliation & Concurrency Conflict
    // ComplianceAuditor CANNOT reconcile
    const resAuditorRecon = await request(`/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auditorJwt}` },
      body: {
        action: 'force_settle_with_proof',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Auditor attempt',
        utr: 'UTR998877665544'
      }
    });
    assert(resAuditorRecon.status === 403, 'ComplianceAuditor DENIED reconciliation access (HTTP 403 Forbidden)');

    // SuperAdmin reconciles with concurrency conflict check
    const resConflict = await request(`/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'force_settle_with_proof',
        expectedCurrentStatus: 'success', // Stale expected status! It is pending!
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Confirmed via official bank statement verification',
        utr: 'UTR998877665544'
      }
    });
    assert(resConflict.status === 409, 'Status mismatch triggers HTTP 409 Conflict (Optimistic Concurrency Lock)');

    // Successful reconciliation with matching expectedCurrentStatus
    const resReconSuccess = await request(`/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'force_settle_with_proof',
        expectedCurrentStatus: 'pending',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Confirmed settlement against HDFC bank portal statement',
        utr: 'UTR998877665544'
      }
    });
    assert(resReconSuccess.status === 200, 'SuperAdmin can reconcile transaction with proof (HTTP 200)');
    assert(resReconSuccess.data.transaction.status === 'success', 'Transaction settled to success');
    assert(resReconSuccess.data.transaction.verifiedBy === 'admin-manual', 'VerifiedBy recorded as admin-manual');

    // 4. Audit Trail Read Access & Engine Immutability
    // ComplianceAuditor CAN read audit trail
    const resAuditorAudit = await request('/api/admin/audit-trail', {
      headers: { Authorization: `Bearer ${auditorJwt}` }
    });
    assert(resAuditorAudit.status === 200, 'ComplianceAuditor can view audit trail (HTTP 200)');
    assert(Array.isArray(resAuditorAudit.data.items), 'Audit trail returned with items array');
    assert(typeof resAuditorAudit.data.total === 'number', 'Audit trail total count returned');

    // OperationsSupport CANNOT read audit trail
    const resOpsAudit = await request('/api/admin/audit-trail', {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(resOpsAudit.status === 403, 'OperationsSupport DENIED audit trail access (HTTP 403 Forbidden)');

    // 5. Staff Administration Self-Protection
    // SuperAdmin cannot change own role
    const resSelfRole = await request('/api/admin/staff/adm_staging_superadmin', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: { role: 'OperationsSupport' }
    });
    assert(resSelfRole.status === 400, 'Self-role alteration blocked (HTTP 400 Bad Request)');

    // SuperAdmin cannot deactivate own account
    const resSelfDeact = await request('/api/admin/staff/adm_staging_superadmin', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: { active: false }
    });
    assert(resSelfDeact.status === 400, 'Self-deactivation blocked (HTTP 400 Bad Request)');

    // OperationsSupport cannot manage staff
    const resOpsCreateStaff = await request('/api/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opsJwt}` },
      body: { email: 'hacker@test.com', name: 'Fake Staff', role: 'SuperAdmin', password: 'password123' }
    });
    assert(resOpsCreateStaff.status === 403, 'OperationsSupport blocked from creating staff (HTTP 403 Forbidden)');

    /* ==========================================================================
       SECTION 4: PAYMENT LIFECYCLE NEGATIVE & TAMPER PROTECTION
       ========================================================================== */
    console.log('\n--- Section 4: Payment Lifecycle Negative Cases & Tamper Tests ---');

    // 1. Setup business gateway in staging DB
    const phonePeSalt = 'staging_phonepe_salt_secret_12345';
    const phonePeMid = 'PHONEPE_STAGING_MID';
    const { encryptToken } = require('../server');
    const dbGate = new DatabaseSync(STAGING_DB_PATH);
    dbGate.prepare(`
      INSERT OR REPLACE INTO businessAccounts (id, merchantId, provider, accountName, phoneNumber, merchantIdRef, token, saltIndex, status, autoVerify, createdAt)
      VALUES (?, ?, 'phonepe', 'PhonePe Staging Gateway', '9990001122', ?, ?, '1', 'connected', 1, ?)
    `).run('biz_stg_pp_01', merchant1.id, phonePeMid, encryptToken(phonePeSalt), new Date().toISOString());

    // Create a new pending order
    const orderRef = 'SP_STG_NEG_001';
    dbGate.prepare(`
      INSERT OR REPLACE INTO transactions (id, merchantId, reference, customerName, amount, amount_paise, status, createdAt)
      VALUES (?, ?, ?, 'Negative Tester', 1000, 100000, 'pending', ?)
    `).run('txn_stg_neg_001', merchant1.id, orderRef, new Date().toISOString());
    dbGate.close();

    // A. Forged Signature Webhook
    const forgedPayload = {
      response: Buffer.from(JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: { merchantId: phonePeMid, merchantTransactionId: orderRef, amount: 100000 }
      })).toString('base64')
    };
    const resForged = await request('/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': 'badhash00112233445566778899aabbccddeeff00112233445566778899aabb###1' },
      body: forgedPayload
    });
    assert(resForged.status === 401, 'Forged PhonePe webhook signature rejected with HTTP 401 Unauthorized');

    // B. Amount Mismatch Webhook (Underpayment Attack)
    const underpayPayload = {
      response: Buffer.from(JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: { merchantId: phonePeMid, merchantTransactionId: orderRef, amount: 100 } // Paid ₹1 instead of ₹1000!
      })).toString('base64')
    };
    const underpayHash = crypto.createHash('sha256').update(underpayPayload.response + phonePeSalt).digest('hex') + '###1';
    const resUnderpay = await request('/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': underpayHash },
      body: underpayPayload
    });
    assert(resUnderpay.status === 400, 'PhonePe amount mismatch rejected with HTTP 400 Bad Request');

    // C. Non-Existent Transaction Webhook
    const nonExistentPayload = {
      response: Buffer.from(JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: { merchantId: phonePeMid, merchantTransactionId: 'NON_EXISTENT_ORDER_999', amount: 100000 }
      })).toString('base64')
    };
    const nonExistentHash = crypto.createHash('sha256').update(nonExistentPayload.response + phonePeSalt).digest('hex') + '###1';
    const resNonExistent = await request('/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': nonExistentHash },
      body: nonExistentPayload
    });
    assert(resNonExistent.status === 404, 'Webhook for non-existent order returns HTTP 404 Not Found');

    // D. Valid Settlement
    const validPayload = {
      response: Buffer.from(JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: { merchantId: phonePeMid, merchantTransactionId: orderRef, amount: 100000, providerReferenceId: 'PP_SETTLE_123' }
      })).toString('base64')
    };
    const validHash = crypto.createHash('sha256').update(validPayload.response + phonePeSalt).digest('hex') + '###1';
    const resValid = await request('/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': validHash },
      body: validPayload
    });
    assert(resValid.status === 200, 'Valid PhonePe webhook settles transaction (HTTP 200)');

    // E. Duplicate Webhook Idempotency
    const resDup = await request('/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': validHash },
      body: validPayload
    });
    assert(resDup.status === 200, 'Duplicate webhook returns HTTP 200 OK');
    assert(resDup.data.duplicate === true, 'Duplicate delivery acknowledged without error');

    // F. Stale Failure Rejected After Verified Settlement
    const staleFailurePayload = {
      response: Buffer.from(JSON.stringify({
        success: false,
        code: 'PAYMENT_ERROR',
        data: { merchantId: phonePeMid, merchantTransactionId: orderRef, amount: 100000 }
      })).toString('base64')
    };
    const staleHash = crypto.createHash('sha256').update(staleFailurePayload.response + phonePeSalt).digest('hex') + '###1';
    const resStale = await request('/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': staleHash },
      body: staleFailurePayload
    });
    assert(resStale.status === 200, 'Out-of-order failure handled safely');
    assert(resStale.data.staleEventRejected === true, 'Stale failure event rejected; settlement preserved');

    // G. Merchant Self-Approval Blocked
    const resSelfApprove = await request('/api/transactions/txn_stg_neg_001', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { status: 'success' }
    });
    assert(resSelfApprove.status === 403, 'Merchant attempt to self-approve transaction blocked with HTTP 403');

    /* ==========================================================================
       SECTION 5: OPERATIONAL INTEGRITY & RESPONSE SECURITY
       ========================================================================== */
    console.log('\n--- Section 5: Operational Integrity & Response Security ---');

    // 1. HTTP Security Headers
    assert(resProf.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff header present');
    assert(resProf.headers['x-frame-options'] === 'DENY', 'X-Frame-Options: DENY header present');
    assert(resProf.headers['referrer-policy'] === 'strict-origin-when-cross-origin', 'Referrer-Policy header present');

    // 2. Request Body Limit (DoS Protection)
    const largeBody = { data: 'X'.repeat(1024 * 1024 + 50) }; // > 1MB
    const resOversize = await request('/api/errors', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: largeBody
    });
    assert(resOversize.status === 413, 'Oversized request body returns HTTP 413 Payload Too Large');

    // 3. System Diagnostics Health & Clean Journal
    const resHealth = await request('/api/admin/system/health', {
      headers: { Authorization: `Bearer ${superAdminJwt}` }
    });
    assert(resHealth.status === 200, 'System health endpoint operational (HTTP 200)');
    assert(resHealth.data.database.journalMode === 'wal', 'Staging database journal mode is WAL');
    assert(resHealth.data.database.foreignKeys === true, 'Foreign keys active');

    db.close();

  } finally {
    // Graceful shutdown
    console.log('\nInitiating clean SIGTERM graceful shutdown...');
    const exitPromise = new Promise(resolve => serverProcess.on('exit', (code, signal) => resolve({ code, signal })));
    serverProcess.kill('SIGTERM');
    const exitRes = await exitPromise;
    console.log(`Staging server closed with code: ${exitRes.code}, signal: ${exitRes.signal}`);
    assert(exitRes.code === 0 || exitRes.signal === 'SIGTERM', 'Server process shut down cleanly via SIGTERM');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`STAGING E2E ACCEPTANCE SUMMARY: ${passedAssertions} PASSED, ${failedAssertions} FAILED`);
  console.log('='.repeat(78));

  process.exit(failedAssertions === 0 ? 0 : 1);
}

runMilestone62StagingSuite().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
