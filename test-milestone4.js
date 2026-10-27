/* ==============================================================================
   SakkuPay Milestone 4 — Admin Control Center & Audit Trail Test Suite
   ============================================================================== */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const {
  server,
  repository: serverRepo,
  sqliteDb,
  adminToken,
  token,
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  REASON_CODES,
  hasPermission,
  isValidRole,
  isValidReasonCode,
  hashPassword,
  verifyPassword,
  logAdminAudit,
  sanitizeAuditState,
  RECON_STATUS
} = require('./server');

let passedTests = 0;
let failedTests = 0;
const results = [];

function assert(condition, message) {
  if (!condition) {
    failedTests++;
    results.push({ name: message, status: 'FAILED' });
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    passedTests++;
    results.push({ name: message, status: 'PASSED' });
    console.log(`  ✅ PASSED: ${message}`);
  }
}

async function request(baseUrl, path, options = {}) {
  const url = new URL(path, baseUrl);
  const headers = { ...(options.headers || {}) };
  let body = options.body;

  if (body && typeof body === 'object' && !(body instanceof Buffer)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  const res = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: body || undefined
  });

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text().catch(() => '');
  }

  return {
    status: res.status,
    headers: res.headers,
    data
  };
}

async function runMilestone4Tests() {
  console.log('==============================================================================');
  console.log('SakkuPay Milestone 4: Admin Control Center & Audit Trail Test Suite');
  console.log('==============================================================================');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 1: RBAC ENGINE, PASSWORD SECURITY & REASON CODES
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 1: RBAC Engine, Password Security & Reason Codes ---');

  // 1. Roles enumeration
  assert(ADMIN_ROLES.SUPER_ADMIN === 'SuperAdmin', 'SuperAdmin role is defined');
  assert(ADMIN_ROLES.OPERATIONS_SUPPORT === 'OperationsSupport', 'OperationsSupport role is defined');
  assert(ADMIN_ROLES.COMPLIANCE_AUDITOR === 'ComplianceAuditor', 'ComplianceAuditor role is defined');

  // 2. Role validation
  assert(isValidRole('SuperAdmin'), 'SuperAdmin is recognized as valid role');
  assert(isValidRole('OperationsSupport'), 'OperationsSupport is recognized as valid role');
  assert(isValidRole('ComplianceAuditor'), 'ComplianceAuditor is recognized as valid role');
  assert(!isValidRole('HackerRole'), 'Arbitrary role string is rejected');
  assert(!isValidRole(''), 'Empty role string is rejected');
  assert(!isValidRole(null), 'Null role is rejected');

  // 3. Permission checks
  assert(hasPermission(ADMIN_ROLES.SUPER_ADMIN, 'admin.users.write'), 'SuperAdmin has admin.users.write');
  assert(hasPermission(ADMIN_ROLES.SUPER_ADMIN, 'audit.read'), 'SuperAdmin has audit.read');
  assert(hasPermission(ADMIN_ROLES.SUPER_ADMIN, 'transactions.reconcile'), 'SuperAdmin has transactions.reconcile');
  assert(hasPermission(ADMIN_ROLES.SUPER_ADMIN, 'merchants.write'), 'SuperAdmin has merchants.write');
  assert(hasPermission(ADMIN_ROLES.SUPER_ADMIN, 'system.whatsapp.manage'), 'SuperAdmin has system.whatsapp.manage');

  assert(hasPermission(ADMIN_ROLES.OPERATIONS_SUPPORT, 'transactions.reconcile'), 'OperationsSupport has transactions.reconcile');
  assert(hasPermission(ADMIN_ROLES.OPERATIONS_SUPPORT, 'transactions.investigate'), 'OperationsSupport has transactions.investigate');
  assert(hasPermission(ADMIN_ROLES.OPERATIONS_SUPPORT, 'merchants.read'), 'OperationsSupport has merchants.read');
  assert(!hasPermission(ADMIN_ROLES.OPERATIONS_SUPPORT, 'admin.users.write'), 'OperationsSupport DENIED admin.users.write');
  assert(!hasPermission(ADMIN_ROLES.OPERATIONS_SUPPORT, 'audit.read'), 'OperationsSupport DENIED audit.read');
  assert(!hasPermission(ADMIN_ROLES.OPERATIONS_SUPPORT, 'merchants.write'), 'OperationsSupport DENIED merchants.write');
  assert(!hasPermission(ADMIN_ROLES.OPERATIONS_SUPPORT, 'system.whatsapp.manage'), 'OperationsSupport DENIED system.whatsapp.manage');

  assert(hasPermission(ADMIN_ROLES.COMPLIANCE_AUDITOR, 'audit.read'), 'ComplianceAuditor has audit.read');
  assert(hasPermission(ADMIN_ROLES.COMPLIANCE_AUDITOR, 'transactions.investigate'), 'ComplianceAuditor has transactions.investigate');
  assert(hasPermission(ADMIN_ROLES.COMPLIANCE_AUDITOR, 'merchants.read'), 'ComplianceAuditor has merchants.read');
  assert(!hasPermission(ADMIN_ROLES.COMPLIANCE_AUDITOR, 'transactions.reconcile'), 'ComplianceAuditor DENIED transactions.reconcile');
  assert(!hasPermission(ADMIN_ROLES.COMPLIANCE_AUDITOR, 'admin.users.write'), 'ComplianceAuditor DENIED admin.users.write');
  assert(!hasPermission(ADMIN_ROLES.COMPLIANCE_AUDITOR, 'merchants.write'), 'ComplianceAuditor DENIED merchants.write');

  // 4. Legacy 'admin' normalization
  assert(hasPermission('admin', 'admin.users.write'), "Legacy 'admin' string normalizes to SuperAdmin permissions");

  // 5. Reason code validator
  assert(isValidReasonCode('OFFICIAL_BANK_STATEMENT_PROOF'), 'Catalog reason code is valid');
  assert(isValidReasonCode('CUSTOM_MANUAL_REVIEW_2026'), 'Custom standard uppercase reason code is valid');
  assert(!isValidReasonCode('bad lowercase code'), 'Lowercase reason code with spaces is invalid');
  assert(!isValidReasonCode(''), 'Empty reason code is invalid');

  // 6. PBKDF2 SHA-512 password security
  const testPw = 'SecureAuditPass_2026!';
  const hashed = hashPassword(testPw);
  assert(typeof hashed === 'string' && hashed.includes(':'), 'Password hash produces salt:hash format');
  assert(verifyPassword(testPw, hashed), 'Valid password verifies successfully in constant time');
  assert(!verifyPassword('WrongAuditPass', hashed), 'Invalid password fails verification');
  assert(!verifyPassword('', hashed), 'Empty password fails verification');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 2: APPEND-ONLY ADMINISTRATIVE AUDIT TRAIL IMMUTABILITY & SANITIZATION
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 2: Append-Only Audit Trail Immutability & Sanitization ---');

  // 1. Secret Sanitization
  const sensitivePayload = {
    actor: 'adm_1',
    password: 'super_secret_plain_pw',
    passwordHash: '8b7f:c298',
    token: 'eyJhbGciOi...',
    saltKey: 'PHONEPE_SALT_ABC',
    nested: {
      key: 'AES_KEY_DATA',
      CHECKSUMHASH: 'HASH9988',
      safeField: 'audit_ok'
    }
  };
  const sanitized = sanitizeAuditState(sensitivePayload);
  assert(sanitized.password === '[REDACTED]', 'Password redacted in audit state');
  assert(sanitized.passwordHash === '[REDACTED]', 'PasswordHash redacted in audit state');
  assert(sanitized.token === '[REDACTED]', 'Token redacted in audit state');
  assert(sanitized.saltKey === '[REDACTED]', 'Salt key redacted in audit state');
  assert(sanitized.nested.key === '[REDACTED]', 'Nested key redacted in audit state');
  assert(sanitized.nested.CHECKSUMHASH === '[REDACTED]', 'Nested checksum redacted in audit state');
  assert(sanitized.nested.safeField === 'audit_ok', 'Safe fields preserved unredacted');

  // 2. Direct SQLite Trigger Immutability Verification
  const testAuditId = `aud_immutability_test_${Date.now()}`;
  sqliteDb.prepare(`
    INSERT INTO admin_audit_trail (
      id, actorId, actorEmail, actorRole, action, targetType, targetId,
      reasonCode, justification, outcome, createdAt
    ) VALUES (?, 'sec_test', 'sec@test.local', 'SuperAdmin', 'test.immutable', 'system', 'sys_1', 'SECURITY_TEST', 'Testing trigger immutability', 'success', ?)
  `).run(testAuditId, new Date().toISOString());

  // Verify prevent_admin_audit_update trigger
  let updateBlocked = false;
  try {
    sqliteDb.prepare('UPDATE admin_audit_trail SET justification = ? WHERE id = ?').run('tampered justification', testAuditId);
  } catch (err) {
    if (err.message.includes('admin_audit_trail is append-only: updates are forbidden')) {
      updateBlocked = true;
    }
  }
  assert(updateBlocked, 'TRIGGER ENFORCED: Direct SQL UPDATE on admin_audit_trail is strictly forbidden');

  // Verify prevent_admin_audit_delete trigger
  let deleteBlocked = false;
  try {
    sqliteDb.prepare('DELETE FROM admin_audit_trail WHERE id = ?').run(testAuditId);
  } catch (err) {
    if (err.message.includes('admin_audit_trail is append-only: deletes are forbidden')) {
      deleteBlocked = true;
    }
  }
  assert(deleteBlocked, 'TRIGGER ENFORCED: Direct SQL DELETE on admin_audit_trail is strictly forbidden');

  // Verify record remains untouched
  const persistedRecord = sqliteDb.prepare('SELECT * FROM admin_audit_trail WHERE id = ?').get(testAuditId);
  assert(persistedRecord !== undefined, 'Audit record remains intact in SQLite');
  assert(persistedRecord.justification === 'Testing trigger immutability', 'Audit record content unmodified');

  /* ────────────────────────────────────────────────────────────────────────────
     LIVE SERVER INTEGRATION SETUP
     ──────────────────────────────────────────────────────────────────────────── */
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`\nLive HTTP test server running at ${baseUrl}`);

  try {
    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 3: ADMIN AUTHENTICATION & LOGIN LIFECYCLE
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 3: Admin Authentication & Login Lifecycle ---');

    // 1. Seed dedicated test SuperAdmin
    const testAdminEmail = `superadmin_m4_${Date.now()}@sakkupay.local`;
    const testAdminPw = 'SuperSecretM4Pass!2026';
    const testSuperAdmin = serverRepo.adminUsers.create({
      email: testAdminEmail,
      name: 'M4 Super Administrator',
      passwordHash: hashPassword(testAdminPw),
      role: ADMIN_ROLES.SUPER_ADMIN,
      active: true
    });
    assert(Boolean(testSuperAdmin.id), 'Test SuperAdmin created in SQLite');

    // 2. Successful Login
    const loginRes = await request(baseUrl, '/api/admin/login', {
      method: 'POST',
      body: { email: testAdminEmail, password: testAdminPw }
    });
    assert(loginRes.status === 200, 'SuperAdmin login returns HTTP 200');
    assert(Boolean(loginRes.data.token), 'Login response contains JWT token');
    assert(loginRes.data.role === ADMIN_ROLES.SUPER_ADMIN, 'Login response confirms role SuperAdmin');
    const superAdminJwt = loginRes.data.token;

    // 3. Failed Login
    const badLoginRes = await request(baseUrl, '/api/admin/login', {
      method: 'POST',
      body: { email: testAdminEmail, password: 'WrongPassword123!' }
    });
    assert(badLoginRes.status === 401, 'Invalid password returns HTTP 401');

    // Verify audit log for failed login
    const recentFailedLoginAudit = sqliteDb.prepare(`
      SELECT * FROM admin_audit_trail WHERE actorEmail = ? AND action = 'admin.login' AND outcome = 'failed' ORDER BY createdAt DESC LIMIT 1
    `).get(testAdminEmail);
    assert(Boolean(recentFailedLoginAudit), 'Failed admin login is audited with outcome failed');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 4: ADMIN STAFF MANAGEMENT & PRIVILEGE ESCALATION PREVENTION
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 4: Admin Staff Management & Privilege Escalation Prevention ---');

    // 1. SuperAdmin creates OperationsSupport staff
    const opsEmail = `ops_${Date.now()}@sakkupay.local`;
    const opsPw = 'OpsStaffPass2026!';
    const createOpsRes = await request(baseUrl, '/api/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        email: opsEmail,
        name: 'Operations Officer',
        password: opsPw,
        role: ADMIN_ROLES.OPERATIONS_SUPPORT
      }
    });
    assert(createOpsRes.status === 201, 'SuperAdmin creates OperationsSupport user (HTTP 201)');
    assert(createOpsRes.data.role === ADMIN_ROLES.OPERATIONS_SUPPORT, 'Created staff has role OperationsSupport');
    assert(!createOpsRes.data.passwordHash, 'Password hash strictly excluded from staff response');
    const opsStaffId = createOpsRes.data.id;

    // Login as OperationsSupport
    const opsLoginRes = await request(baseUrl, '/api/admin/login', {
      method: 'POST',
      body: { email: opsEmail, password: opsPw }
    });
    assert(opsLoginRes.status === 200, 'OperationsSupport login succeeds (HTTP 200)');
    const opsJwt = opsLoginRes.data.token;

    // 2. SuperAdmin creates ComplianceAuditor staff
    const auditEmail = `auditor_${Date.now()}@sakkupay.local`;
    const auditPw = 'AuditorPass2026!';
    const createAuditRes = await request(baseUrl, '/api/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        email: auditEmail,
        name: 'Compliance Auditor',
        password: auditPw,
        role: ADMIN_ROLES.COMPLIANCE_AUDITOR
      }
    });
    assert(createAuditRes.status === 201, 'SuperAdmin creates ComplianceAuditor user (HTTP 201)');
    const auditStaffId = createAuditRes.data.id;

    // Login as ComplianceAuditor
    const auditLoginRes = await request(baseUrl, '/api/admin/login', {
      method: 'POST',
      body: { email: auditEmail, password: auditPw }
    });
    assert(auditLoginRes.status === 200, 'ComplianceAuditor login succeeds (HTTP 200)');
    const auditorJwt = auditLoginRes.data.token;

    // 3. Privilege Escalation Block: OperationsSupport cannot create staff
    const opsCreateStaffRes = await request(baseUrl, '/api/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opsJwt}` },
      body: {
        email: `hacker_${Date.now()}@sakkupay.local`,
        name: 'Escalated Admin',
        password: 'HackerPassword123!',
        role: ADMIN_ROLES.SUPER_ADMIN
      }
    });
    assert(opsCreateStaffRes.status === 403, 'PRIVILEGE ESCALATION BLOCKED: OperationsSupport cannot create staff (HTTP 403)');

    // 4. Privilege Escalation Block: ComplianceAuditor cannot create staff
    const auditorCreateStaffRes = await request(baseUrl, '/api/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auditorJwt}` },
      body: {
        email: `hacker2_${Date.now()}@sakkupay.local`,
        name: 'Escalated Admin 2',
        password: 'HackerPassword123!',
        role: ADMIN_ROLES.SUPER_ADMIN
      }
    });
    assert(auditorCreateStaffRes.status === 403, 'PRIVILEGE ESCALATION BLOCKED: ComplianceAuditor cannot create staff (HTTP 403)');

    // 5. Self-Role Modification Block: SuperAdmin cannot alter their own role
    const selfRoleRes = await request(baseUrl, `/api/admin/staff/${testSuperAdmin.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: { role: ADMIN_ROLES.OPERATIONS_SUPPORT }
    });
    assert(selfRoleRes.status === 400, 'Admins cannot alter their own role (HTTP 400)');

    // 6. Self-Deactivation Block: SuperAdmin cannot deactivate their own account
    const selfDeactivateRes = await request(baseUrl, `/api/admin/staff/${testSuperAdmin.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: { active: false }
    });
    assert(selfDeactivateRes.status === 400, 'Admins cannot deactivate their own account (HTTP 400)');

    // 7. Deactivated Account Access Block
    // SuperAdmin deactivates opsStaffId
    const deactivateOpsRes = await request(baseUrl, `/api/admin/staff/${opsStaffId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: { active: false }
    });
    assert(deactivateOpsRes.status === 200, 'SuperAdmin deactivates OperationsSupport user');
    assert(deactivateOpsRes.data.active === false, 'Staff user status updated to active: false');

    // Attempt request using deactivated user token
    const blockedOpsReq = await request(baseUrl, '/api/admin/merchants', {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(blockedOpsReq.status === 403, 'Deactivated admin account is strictly blocked from accessing APIs (HTTP 403)');
    assert(blockedOpsReq.data.error.includes('deactivated'), 'Error message clarifies account has been deactivated');

    // Reactivate opsStaffId for further tests
    await request(baseUrl, `/api/admin/staff/${opsStaffId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: { active: true }
    });

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 5: ROUTE AUTHORIZATION ENFORCEMENT & DENY-BY-DEFAULT
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 5: Route Authorization Enforcement & Deny-by-Default ---');

    // 1. Unauthenticated requests to protected admin routes
    const unauthStaffRes = await request(baseUrl, '/api/admin/staff');
    assert(unauthStaffRes.status === 401, 'Unauthenticated request to /api/admin/staff returns HTTP 401');

    const unauthAuditRes = await request(baseUrl, '/api/admin/audit-trail');
    assert(unauthAuditRes.status === 401, 'Unauthenticated request to /api/admin/audit-trail returns HTTP 401');

    const unauthSearchRes = await request(baseUrl, '/api/admin/investigation/search');
    assert(unauthSearchRes.status === 401, 'Unauthenticated request to /api/admin/investigation/search returns HTTP 401');

    // 2. Role-based permission enforcement on live endpoints
    // OperationsSupport lacks 'audit.read'
    const opsAuditRes = await request(baseUrl, '/api/admin/audit-trail', {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(opsAuditRes.status === 403, "OperationsSupport accessing /api/admin/audit-trail returns HTTP 403 (lacks 'audit.read')");

    // ComplianceAuditor lacks 'transactions.reconcile'
    const auditorReconcileRes = await request(baseUrl, '/api/admin/transactions/dummy_tx/reconcile', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auditorJwt}` },
      body: { action: 'flag_for_review', reasonCode: 'CUSTOMER_DISPUTE_SETTLED', justification: 'Test justification 12345' }
    });
    assert(auditorReconcileRes.status === 403, "ComplianceAuditor accessing reconcile returns HTTP 403 (lacks 'transactions.reconcile')");

    // ComplianceAuditor lacks 'merchants.write'
    const auditorSuspendRes = await request(baseUrl, '/api/admin/merchants/dummy_m/suspend', {
      method: 'POST',
      headers: { Authorization: `Bearer ${auditorJwt}` },
      body: { suspended: true }
    });
    assert(auditorSuspendRes.status === 403, "ComplianceAuditor accessing suspend returns HTTP 403 (lacks 'merchants.write')");

    // OperationsSupport lacks 'system.whatsapp.manage'
    const opsWaRes = await request(baseUrl, '/api/admin/whatsapp/status', {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(opsWaRes.status === 403, "OperationsSupport accessing WhatsApp management returns HTTP 403 (lacks 'system.whatsapp.manage')");

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 6: PAYMENT INVESTIGATION WORKSPACE APIS
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 6: Payment Investigation Workspace APIs ---');

    // 1. Seed merchant and transactions with diverse lifecycle states
    const testMerchantId = `mer_inv_${Date.now()}`;
    serverRepo.merchants.create({
      id: testMerchantId,
      email: `merchant_inv_${Date.now()}@example.com`,
      businessName: 'Investigation Merchant Pvt Ltd',
      supportEmail: 'support@invmerchant.com',
      description: 'Test business for investigation workspace',
      whatsappNumber: '9876543210'
    });

    const pendingTxRef = `REF_INV_PND_${Date.now()}`;
    const pendingTx = serverRepo.transactions.create({
      id: `tx_pnd_${Date.now()}`,
      merchantId: testMerchantId,
      reference: pendingTxRef,
      customerName: 'Aarav Patel',
      customerEmail: 'aarav@example.com',
      amount: 1500,
      amount_paise: 150000,
      status: 'pending',
      reconciliationStatus: RECON_STATUS.UNRECONCILED
    });

    const ambiguousTxRef = `REF_INV_AMB_${Date.now()}`;
    const ambiguousTx = serverRepo.transactions.create({
      id: `tx_amb_${Date.now()}`,
      merchantId: testMerchantId,
      reference: ambiguousTxRef,
      customerName: 'Priya Sharma',
      customerEmail: 'priya@example.com',
      amount: 750,
      amount_paise: 75000,
      status: 'pending',
      reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
      ambiguityReason: 'Multiple pending candidate transactions match amount ₹750'
    });

    const utrEvidenceTxRef = `REF_INV_UTR_${Date.now()}`;
    const utrEvidenceTx = serverRepo.transactions.create({
      id: `tx_utr_${Date.now()}`,
      merchantId: testMerchantId,
      reference: utrEvidenceTxRef,
      customerName: 'Vikram Singh',
      customerEmail: 'vikram@example.com',
      amount: 2500,
      amount_paise: 250000,
      status: 'pending',
      utr: 'UTRINV123456789',
      utrSubmittedAt: new Date().toISOString(),
      reconciliationStatus: RECON_STATUS.UNVERIFIED_EVIDENCE
    });

    // 2. Investigation Search API
    const searchRes = await request(baseUrl, `/api/admin/investigation/search?merchantId=${testMerchantId}`, {
      headers: { Authorization: `Bearer ${superAdminJwt}` }
    });
    assert(searchRes.status === 200, 'Investigation search API returns HTTP 200');
    assert(searchRes.data.total >= 3, `Investigation search returns total >= 3 (actual: ${searchRes.data.total})`);
    assert(Array.isArray(searchRes.data.items), 'Investigation search returns items array');

    // Search by UTR
    const utrSearchRes = await request(baseUrl, `/api/admin/investigation/search?utr=UTRINV123456789`, {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(utrSearchRes.status === 200, 'OperationsSupport can search investigation by UTR');
    assert(utrSearchRes.data.items.length >= 1, 'Search by UTR returned matching transaction');
    assert(utrSearchRes.data.items[0].id === utrEvidenceTx.id, 'Transaction ID matches seeded UTR transaction');

    // Search by reconciliationStatus
    const reconSearchRes = await request(baseUrl, `/api/admin/investigation/search?reconciliationStatus=${RECON_STATUS.FLAGGED_AMBIGUOUS}`, {
      headers: { Authorization: `Bearer ${auditorJwt}` }
    });
    assert(reconSearchRes.status === 200, 'ComplianceAuditor can search investigation by reconciliation status');
    assert(reconSearchRes.data.items.some(t => t.id === ambiguousTx.id), 'Ambiguous transaction found in reconciliation search');

    // 3. Chronological Investigation Timeline API
    const timelineRes = await request(baseUrl, `/api/admin/transactions/${utrEvidenceTx.id}/timeline`, {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(timelineRes.status === 200, 'Investigation timeline endpoint returns HTTP 200');
    assert(timelineRes.data.transaction.id === utrEvidenceTx.id, 'Timeline contains transaction details');
    assert(timelineRes.data.merchant.id === testMerchantId, 'Timeline contains merchant context');
    assert(timelineRes.data.diagnostics.reconciliationStatus === RECON_STATUS.UNVERIFIED_EVIDENCE, 'Timeline reflects unverified evidence diagnostic');
    assert(Array.isArray(timelineRes.data.timeline), 'Timeline events is an array');
    assert(timelineRes.data.timeline.length >= 2, 'Timeline records order created and customer UTR submission');
    assert(timelineRes.data.timeline[0].type === 'order_created', 'First timeline item is order_created');
    assert(timelineRes.data.timeline[1].type === 'customer_utr_submitted', 'Second timeline item is customer_utr_submitted');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 7: SAFE MANUAL RECONCILIATION ENGINE
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 7: Safe Manual Reconciliation Engine ---');

    // 1. Validation: Reject missing reasonCode
    const noReasonRes = await request(baseUrl, `/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'force_settle_with_proof',
        justification: 'Manual verification completed with bank'
      }
    });
    assert(noReasonRes.status === 400, 'Reconciliation without valid reasonCode returns HTTP 400');

    // 2. Validation: Reject short justification (< 10 chars)
    const shortJustRes = await request(baseUrl, `/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'force_settle_with_proof',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Done'
      }
    });
    assert(shortJustRes.status === 400, 'Reconciliation with short justification (< 10 chars) returns HTTP 400');

    // 3. Optimistic Concurrency Conflict Detection (409 Conflict)
    const conflictRes = await request(baseUrl, `/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'force_settle_with_proof',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Manual settlement based on statement',
        expectedCurrentStatus: 'failed', // actual status is 'pending'
        utr: 'BANKSTATEMENTUTR88'
      }
    });
    assert(conflictRes.status === 409, 'OPTIMISTIC CONCURRENCY: Status mismatch returns HTTP 409 Conflict');
    assert(conflictRes.data.error.includes('Concurrent modification detected'), 'Conflict message details mismatch');

    // Verify transaction remains untouched after 409 conflict
    const txAfterConflict = serverRepo.transactions.findById(pendingTx.id);
    assert(txAfterConflict.status === 'pending', 'Transaction status remains pending after concurrency conflict');

    // 4. Force Settle without Proof Rejected
    const noProofRes = await request(baseUrl, `/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'force_settle_with_proof',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Trying to settle without bank proof reference'
      }
    });
    assert(noProofRes.status === 400, 'force_settle_with_proof without UTR or providerReference returns HTTP 400');

    // 5. Successful Force Settle with Verified Bank Proof
    const validSettleRes = await request(baseUrl, `/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'force_settle_with_proof',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Bank manager provided signed statement confirming credit of ₹1500',
        utr: 'BANKPROOF998877',
        providerReference: 'HDFC_NEFT_20261027'
      }
    });
    assert(validSettleRes.status === 200, 'force_settle_with_proof with valid proof returns HTTP 200');
    assert(validSettleRes.data.transaction.status === 'success', 'Transaction transitioned to status success');
    assert(validSettleRes.data.transaction.reconciliationStatus === RECON_STATUS.SETTLED, 'Transaction reconciliationStatus set to settled');
    assert(validSettleRes.data.transaction.verifiedBy === 'admin-manual', 'Transaction verifiedBy set to admin-manual');
    assert(validSettleRes.data.transaction.utr === 'BANKPROOF998877', 'Transaction UTR saved from reconciliation proof');
    assert(Boolean(validSettleRes.data.auditId), 'Response returns auditId of immutable audit log');

    // 6. Idempotent Settle Replay
    const idempotentSettleRes = await request(baseUrl, `/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'force_settle_with_proof',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Re-running settlement action'
      }
    });
    assert(idempotentSettleRes.status === 200, 'Re-invoking force_settle on settled transaction returns HTTP 200');
    assert(idempotentSettleRes.data.duplicate === true, 'Response confirms transaction was already settled');

    // 7. TERMINAL STATE LOCK: Cannot reverse settled transaction to failed
    const reverseToFailedRes = await request(baseUrl, `/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'mark_failed_with_proof',
        reasonCode: 'SUSPECTED_FRAUD',
        justification: 'Attempting to reverse settled payment to failed'
      }
    });
    assert(reverseToFailedRes.status === 400, 'TERMINAL LOCK: Cannot reverse settled transaction to failed (HTTP 400)');
    assert(reverseToFailedRes.data.error.includes('Settlement is permanent'), 'Error message reinforces permanent settlement');

    // 8. Cannot flag settled transaction for review
    const flagSettledRes = await request(baseUrl, `/api/admin/transactions/${pendingTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        action: 'flag_for_review',
        reasonCode: 'CUSTOMER_DISPUTE_SETTLED',
        justification: 'Attempting to flag settled transaction'
      }
    });
    assert(flagSettledRes.status === 400, 'Cannot flag settled transaction for review (HTTP 400)');

    // 9. Mark unconfirmed transaction as failed with proof
    const markFailedRes = await request(baseUrl, `/api/admin/transactions/${utrEvidenceTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opsJwt}` },
      body: {
        action: 'mark_failed_with_proof',
        reasonCode: 'SUSPECTED_FRAUD',
        justification: 'Customer submitted fake forged screenshot. Bank confirmed no funds received.'
      }
    });
    assert(markFailedRes.status === 200, 'OperationsSupport can mark unconfirmed transaction as failed with proof');
    assert(markFailedRes.data.transaction.status === 'failed', 'Transaction status transitioned to failed');

    // 10. Flag transaction for review
    const freshReviewTx = serverRepo.transactions.create({
      id: `tx_rev_${Date.now()}`,
      merchantId: testMerchantId,
      reference: `REF_REV_${Date.now()}`,
      amount: 500,
      amount_paise: 50000,
      status: 'pending'
    });
    const flagReviewRes = await request(baseUrl, `/api/admin/transactions/${freshReviewTx.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opsJwt}` },
      body: {
        action: 'flag_for_review',
        reasonCode: 'COMPLIANCE_HOLD',
        justification: 'Discrepancy detected between payer name and account profile'
      }
    });
    assert(flagReviewRes.status === 200, 'flag_for_review returns HTTP 200');
    assert(flagReviewRes.data.transaction.status === 'pending', 'Transaction status remains pending while flagged for review');
    assert(flagReviewRes.data.transaction.reconciliationStatus === RECON_STATUS.FLAGGED_AMBIGUOUS, 'Reconciliation status marked flagged_ambiguous');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 8: MERCHANT OPERATIONS & ROUTINE DELETION PROTECTION
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 8: Merchant Operations & Routine Deletion Protection ---');

    // 1. Paginated merchants list
    const merchantsListRes = await request(baseUrl, '/api/admin/merchants', {
      headers: { Authorization: `Bearer ${superAdminJwt}` }
    });
    assert(merchantsListRes.status === 200, 'Admin merchants list returns HTTP 200');
    assert(Array.isArray(merchantsListRes.data.items), 'Merchants list returns items array');
    assert(Number.isFinite(merchantsListRes.data.total), 'Merchants list returns total count');

    // 2. Merchant detail view
    const merchantDetailRes = await request(baseUrl, `/api/admin/merchants/${testMerchantId}`, {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(merchantDetailRes.status === 200, 'Admin merchant detail returns HTTP 200');
    assert(merchantDetailRes.data.merchant.id === testMerchantId, 'Merchant ID matches');
    assert(Array.isArray(merchantDetailRes.data.recentTransactions), 'Merchant detail includes recentTransactions');

    // 3. Audited Merchant Suspension
    const suspendRes = await request(baseUrl, `/api/admin/merchants/${testMerchantId}/suspend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        suspended: true,
        reasonCode: 'COMPLIANCE_HOLD',
        justification: 'Temporary suspension pending additional merchant KYC documents'
      }
    });
    assert(suspendRes.status === 200, 'Audited merchant suspension returns HTTP 200');
    assert(suspendRes.data.suspended === true, 'Merchant suspension state confirmed as true');

    // Verify suspended merchant is blocked from protected merchant APIs
    const testMerchantObj = serverRepo.merchants.findById(testMerchantId);
    const merchantAuthToken = token(testMerchantObj);
    const merchantProfileRes = await request(baseUrl, '/api/profile', {
      headers: { Authorization: `Bearer ${merchantAuthToken}` }
    });
    assert(merchantProfileRes.status === 403, 'Suspended merchant is strictly blocked from /api/profile (HTTP 403)');

    // Reactivate merchant
    const unsuspendRes = await request(baseUrl, `/api/admin/merchants/${testMerchantId}/suspend`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminJwt}` },
      body: {
        suspended: false,
        reasonCode: 'MERCHANT_STATUS_UPDATE',
        justification: 'KYC verified successfully, unsuspending merchant'
      }
    });
    assert(unsuspendRes.status === 200, 'Reactivating merchant returns HTTP 200');
    assert(unsuspendRes.data.suspended === false, 'Merchant is no longer suspended');

    // 4. Financial Records Deletion Protection
    const deleteBlockedRes = await request(baseUrl, `/api/admin/users/${testMerchantId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${superAdminJwt}` }
    });
    assert(deleteBlockedRes.status === 400, 'ROUTINE DELETION BLOCKED: Cannot delete merchant with financial records (HTTP 400)');
    assert(deleteBlockedRes.data.error.includes('financial transaction records'), 'Error specifies financial records guard');

    // Verify merchant remains intact
    assert(serverRepo.merchants.findById(testMerchantId) !== null, 'Merchant preserved in database');

    // 5. Deleting an empty merchant without financial records succeeds
    const emptyMerchantId = `mer_empty_${Date.now()}`;
    serverRepo.merchants.create({
      id: emptyMerchantId,
      email: `empty_${Date.now()}@example.com`,
      businessName: 'Empty Test Merchant'
    });
    const deleteEmptyRes = await request(baseUrl, `/api/admin/users/${emptyMerchantId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${superAdminJwt}` }
    });
    assert(deleteEmptyRes.status === 204, 'Deleting merchant with zero financial records succeeds (HTTP 204)');
    assert(serverRepo.merchants.findById(emptyMerchantId) === null, 'Empty merchant was deleted');

    /* ────────────────────────────────────────────────────────────────────────────
       SECTION 9: PLATFORM HEALTH & SENSITIVE DATA EXPOSURE GUARD
       ──────────────────────────────────────────────────────────────────────────── */
    console.log('\n--- Section 9: Platform Health & Sensitive Data Exposure Guard ---');

    // 1. Platform Health Endpoint
    const healthRes = await request(baseUrl, '/api/admin/system/health', {
      headers: { Authorization: `Bearer ${opsJwt}` }
    });
    assert(healthRes.status === 200, 'Health endpoint returns HTTP 200');
    assert(healthRes.data.status === 'healthy', 'Health status is healthy');
    assert(healthRes.data.database.journalMode === 'wal', 'Health confirms WAL journal_mode');
    assert(healthRes.data.database.foreignKeys === true, 'Health confirms foreign_keys enabled');
    assert(healthRes.data.database.busyTimeoutMs >= 5000, 'Health confirms busyTimeout >= 5000ms');
    assert(Number.isFinite(healthRes.data.database.tableCounts.merchants), 'Health reports merchants table count');
    assert(Number.isFinite(healthRes.data.database.tableCounts.transactions), 'Health reports transactions table count');
    assert(Number.isFinite(healthRes.data.database.tableCounts.adminUsers), 'Health reports adminUsers table count');
    assert(Number.isFinite(healthRes.data.database.tableCounts.auditTrail), 'Health reports auditTrail table count');

    // Zero sensitive secrets leaked in health payload
    const rawHealthText = JSON.stringify(healthRes.data);
    assert(!rawHealthText.includes(testAdminPw), 'Health response does not leak admin passwords');
    assert(!rawHealthText.includes('sakkupay-vault-secret'), 'Health response does not leak vault secrets');
    assert(!rawHealthText.includes('PHONEPE_SALT'), 'Health response does not leak salt keys');

    // 2. Querying Audit Trail API (ComplianceAuditor & SuperAdmin)
    const auditTrailRes = await request(baseUrl, '/api/admin/audit-trail?limit=50', {
      headers: { Authorization: `Bearer ${auditorJwt}` }
    });
    assert(auditTrailRes.status === 200, 'ComplianceAuditor can query /api/admin/audit-trail');
    assert(Array.isArray(auditTrailRes.data.items), 'Audit trail returns items array');
    assert(auditTrailRes.data.total > 0, 'Audit trail contains recorded events');

    // Check that every audit event in the response is sanitized
    const rawAuditText = JSON.stringify(auditTrailRes.data);
    assert(!rawAuditText.includes(testAdminPw), 'Audit trail response does not contain cleartext passwords');
    assert(!rawAuditText.includes('super_secret_plain_pw'), 'Audit trail response redacted secret passwords');

    /* ────────────────────────────────────────────────────────────────────────────
       CLEANUP
       ──────────────────────────────────────────────────────────────────────────── */
    // Clean up test admin users
    try {
      serverRepo.adminUsers.delete(testSuperAdmin.id);
      serverRepo.adminUsers.delete(opsStaffId);
      serverRepo.adminUsers.delete(auditStaffId);
    } catch (_) {}

  } finally {
    await new Promise(resolve => server.close(resolve));
    console.log('\nLive HTTP test server closed cleanly.');
  }

  /* ────────────────────────────────────────────────────────────────────────────
     FINAL RESULTS REPORT
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n==============================================================================');
  console.log(`TEST SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('==============================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runMilestone4Tests().catch(err => {
  console.error('\n❌ Unhandled exception during Milestone 4 tests:', err);
  process.exit(1);
});
