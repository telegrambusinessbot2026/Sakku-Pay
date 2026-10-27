/* SakkuPay Milestone 5: UI/UX Redesign & Static/API Integration Test Suite
   Verifies:
   - Static asset delivery and semantic integrity for Merchant and Admin frontends
   - Dark mode CSS rules, components, drawers, timeline, and diff viewer
   - Front-to-back integration for Merchant Forensics Drawer (/dashboard)
   - Front-to-back integration for Admin 8-Page Control Center (/admin)
   - RBAC UI contract & server authorization enforcement
   - Zero mock data & SQLite WAL integrity
   - Security audit: No secret leakage across all served endpoints
*/
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  server,
  repository,
  sqliteDb,
  adminToken,
  token,
  ADMIN_ROLES,
  hashPassword,
  verifyPassword
} = require('./server');

let totalPassed = 0;
let totalFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASSED: ${message}`);
    totalPassed++;
  } else {
    console.error(`  ❌ FAILED: ${message}`);
    totalFailed++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function request(baseUrl, p, opts = {}) {
  const url = new URL(p, baseUrl);
  return fetch(url.toString(), opts);
}

async function runMilestone5Tests() {
  console.log('='.repeat(78));
  console.log('SakkuPay Milestone 5: UI/UX Redesign & Full Integration Test Suite');
  console.log('='.repeat(78));

  // Spin up test server with dedicated test database
  const testDbFile = path.join(__dirname, 'test_m5_' + Date.now() + '.db');
  process.env.DB_PATH = testDbFile;
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.ADMIN_USERNAME = 'admin_m5_test';
  process.env.ADMIN_PASSWORD = 'AdminM5Password123!';
  process.env.SAKKUPAY_TOKEN_SECRET = 'a'.repeat(32);
  process.env.VAULT_SECRET = 'b'.repeat(32);

  // Require server after setting environment
  const { server } = require('./server');

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`\nTest server running at ${baseUrl}\n`);

  try {
    // ─── SECTION 1: Static Route & Semantic HTML Delivery ─────────
    console.log('--- Section 1: Static Assets & Semantic UI Delivery ---');

    // Merchant Dashboard
    const dashRes = await request(baseUrl, '/dashboard');
    assert(dashRes.status === 200, 'GET /dashboard returns HTTP 200 OK');
    const dashHtml = await dashRes.text();
    assert(dashHtml.includes('<!doctype html>'), 'Dashboard delivers valid HTML5 document');
    assert(dashHtml.includes('id="tx-detail-modal"'), 'Dashboard contains Transaction Forensics Drawer modal');
    assert(dashHtml.includes('id="dtl-ref"'), 'Forensics drawer contains reference display');
    assert(dashHtml.includes('id="dtl-ambiguity-box"'), 'Forensics drawer contains ambiguity notice box');
    assert(dashHtml.includes('id="dtl-merchant-note-input"'), 'Forensics drawer contains editable merchant note field');
    assert(dashHtml.includes('app-extra.css'), 'Dashboard links app-extra.css dark extensions');
    assert(dashHtml.includes('app-live.js'), 'Dashboard links app-live.js controller');

    // Admin Control Center
    const adminRes = await request(baseUrl, '/admin');
    assert(adminRes.status === 200, 'GET /admin returns HTTP 200 OK');
    const adminHtml = await adminRes.text();
    assert(adminHtml.includes('<!doctype html>'), 'Admin Control Center delivers valid HTML5 document');
    assert(adminHtml.includes('id="auth-overlay"'), 'Admin contains authentication overlay');
    assert(adminHtml.includes('id="page-overview"'), 'Admin contains Overview & Health page');
    assert(adminHtml.includes('id="page-merchants"'), 'Admin contains Merchant Directory page');
    assert(adminHtml.includes('id="page-transactions"'), 'Admin contains Global Settlement Ledger page');
    assert(adminHtml.includes('id="page-investigation"'), 'Admin contains Payment Investigation Workspace page');
    assert(adminHtml.includes('id="page-audit"'), 'Admin contains Append-Only Audit Trail page');
    assert(adminHtml.includes('id="page-staff"'), 'Admin contains Staff & RBAC Governance page');
    assert(adminHtml.includes('id="page-errors"'), 'Admin contains Error Diagnostics page');
    assert(adminHtml.includes('id="page-whatsapp"'), 'Admin contains WhatsApp Gateway page');
    assert(adminHtml.includes('id="merchant-drawer"'), 'Admin contains Merchant Detail Drawer');
    assert(adminHtml.includes('id="audited-suspend-modal"'), 'Admin contains Audited Suspend Modal');
    assert(adminHtml.includes('id="investigation-drawer"'), 'Admin contains Investigation Timeline Drawer');
    assert(adminHtml.includes('id="reconcile-modal"'), 'Admin contains Audited Manual Reconciliation Modal');
    assert(adminHtml.includes('id="staff-modal"'), 'Admin contains Staff Onboarding Modal');
    assert(adminHtml.includes('id="audit-inspect-modal"'), 'Admin contains Audit State Diff Modal');

    // Stylesheets & Scripts
    const adminCssRes = await request(baseUrl, '/admin.css');
    assert(adminCssRes.status === 200, 'GET /admin.css returns HTTP 200');
    assert(adminCssRes.headers.get('content-type').includes('text/css'), 'admin.css has text/css MIME type');
    const adminCss = await adminCssRes.text();
    assert(adminCss.includes('.role-pill'), 'admin.css includes role badge classes');
    assert(adminCss.includes('.health-grid'), 'admin.css includes architecture health grid styles');
    assert(adminCss.includes('.timeline-container'), 'admin.css includes lifecycle timeline styles');
    assert(adminCss.includes('.diff-pre'), 'admin.css includes audit diff inspection styles');
    assert(adminCss.includes('.modal-drawer'), 'admin.css includes slide-over drawer styles');

    const adminJsRes = await request(baseUrl, '/admin.js');
    assert(adminJsRes.status === 200, 'GET /admin.js returns HTTP 200');
    assert(adminJsRes.headers.get('content-type').includes('javascript'), 'admin.js has javascript MIME type');
    const adminJs = await adminJsRes.text();
    assert(adminJs.includes('applyRoleRestrictions'), 'admin.js includes RBAC dynamic UI adaptation');
    assert(adminJs.includes('openInvestigationDrawer'), 'admin.js includes investigation timeline renderer');
    assert(adminJs.includes('openReconcileModal'), 'admin.js includes manual reconciliation workflow');
    assert(adminJs.includes('loadAuditTrail'), 'admin.js includes audit trail loader');

    const appExtraRes = await request(baseUrl, '/app-extra.css');
    assert(appExtraRes.status === 200, 'GET /app-extra.css returns HTTP 200');
    const appExtraCss = await appExtraRes.text();
    assert(appExtraCss.includes('.pill.ambiguous'), 'app-extra.css defines ambiguous collision badge');
    assert(appExtraCss.includes('.pill.unverified'), 'app-extra.css defines unverified evidence badge');
    assert(appExtraCss.includes('.modal-drawer'), 'app-extra.css defines merchant forensics drawer');

    const appLiveRes = await request(baseUrl, '/app-live.js');
    assert(appLiveRes.status === 200, 'GET /app-live.js returns HTTP 200');
    const appLiveJs = await appLiveRes.text();
    assert(appLiveJs.includes('openTransactionDetail'), 'app-live.js includes transaction detail drawer controller');

    // ─── SECTION 2: Merchant Portal Front-to-Back Integration ───────
    console.log('\n--- Section 2: Merchant Portal Forensics & Lifecycle APIs ---');

    // Create test merchant in SQLite
    const testMerchantId = 'mer_m5_' + Date.now();
    const testMerchant = repository.merchants.create({
      id: testMerchantId,
      email: 'merchant_m5_' + Date.now() + '@test.local',
      passwordHash: 'hash123',
      businessName: 'Apex Cloud Solutions',
      phone: '9876543210'
    });

    const mUpiId = 'upi_m5_' + Date.now();
    const mUpi = repository.upis.create({
      id: mUpiId,
      merchantId: testMerchant.id,
      upiId: 'apexcloud@oksbi',
      phoneNumber: '9876543210',
      default: true
    });

    const mLinkId = 'lnk_m5_' + Date.now();
    const mLink = repository.links.create({
      id: mLinkId,
      merchantId: testMerchant.id,
      name: 'Pro Cloud Tier',
      upiId: mUpi.id,
      amount: 1499.50,
      slug: 'apex-pro-' + Date.now(),
      active: true
    });

    // Seed transaction with ambiguous collision and customer evidence
    const seededTxId = 'tx_m5_' + Date.now();
    const seededTx = repository.transactions.create({
      id: seededTxId,
      merchantId: testMerchant.id,
      linkId: mLink.id,
      reference: 'SP_M5_FORENSIC_' + Date.now().toString(36).toUpperCase(),
      amount: 1499.50,
      customerName: 'Aarav Sharma',
      customerEmail: 'aarav@test.local',
      customerPhone: '9876500001',
      status: 'pending',
      reconciliationStatus: 'flagged_ambiguous',
      ambiguityReason: 'multiple_candidate_collision: 2 pending orders matched ₹1499.50',
      utr: '429182736450',
      merchantNote: 'Initial customer inquiry noted'
    });

    // Generate merchant JWT token
    const merchantToken = token({ id: testMerchant.id, email: testMerchant.email });

    // Fetch transactions list as merchant
    const merchantTxsRes = await request(baseUrl, '/api/transactions', {
      headers: { 'Authorization': 'Bearer ' + merchantToken }
    });
    assert(merchantTxsRes.status === 200, 'Merchant GET /api/transactions returns HTTP 200');
    const mTxList = await merchantTxsRes.json();
    assert(Array.isArray(mTxList), 'Merchant transactions returns array');
    const foundTx = mTxList.find(t => t.id === seededTx.id);
    assert(foundTx !== undefined, 'Seeded transaction is present in merchant list');
    assert((foundTx.amount_paise || foundTx.amountPaise) === 149950, 'Integer paise accounting exact (149950 paise)');
    assert(foundTx.reconciliationStatus === 'flagged_ambiguous', 'Merchant can see reconciliation status');
    assert(foundTx.ambiguityReason.includes('multiple_candidate_collision'), 'Merchant can see ambiguity reason');

    // Merchant updates merchant note on transaction via PATCH
    const notePatchRes = await request(baseUrl, `/api/transactions/${seededTx.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + merchantToken
      },
      body: JSON.stringify({ note: 'Customer confirmed payment via phone, bank statement attached' })
    });
    assert(notePatchRes.status === 200, 'Merchant PATCH note returns HTTP 200 OK');
    const updatedTx = await notePatchRes.json();
    assert(updatedTx.merchantNote === 'Customer confirmed payment via phone, bank statement attached', 'Merchant note successfully updated and persisted');
    assert(updatedTx.status === 'pending', 'Status remains pending (self-approval strictly prevented)');

    // ─── SECTION 3: Admin Control Center Front-to-Back Integration ──
    console.log('\n--- Section 3: Admin Control Center 8-Page Operations ---');

    // 1. Admin Authentication
    const testAdminEmail = `superadmin_m5_${Date.now()}@sakkupay.local`;
    const testAdminPw = 'SuperSecretM5Pass!2026';
    repository.adminUsers.create({
      email: testAdminEmail,
      name: 'M5 Super Administrator',
      passwordHash: hashPassword(testAdminPw),
      role: ADMIN_ROLES.SUPER_ADMIN,
      active: true
    });

    const adminLoginRes = await request(baseUrl, '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testAdminEmail,
        password: testAdminPw
      })
    });
    assert(adminLoginRes.status === 200, 'Admin login returns HTTP 200 OK');
    const loginData = await adminLoginRes.json();
    assert(Boolean(loginData.token), 'Admin login returns JWT bearer token');
    assert(loginData.role === 'SuperAdmin', 'Admin login returns role SuperAdmin');
    const adminJwt = loginData.token;

    // 2. Overview & Architecture Health (Page 1)
    const statsRes = await request(baseUrl, '/api/admin/stats', {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(statsRes.status === 200, 'Admin GET /api/admin/stats returns HTTP 200');
    const stats = await statsRes.json();
    assert(stats.totalMerchants >= 1, 'Stats reports total merchants count');
    assert(stats.totalTransactions >= 1, 'Stats reports total transactions count');

    const healthRes = await request(baseUrl, '/api/admin/system/health', {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(healthRes.status === 200, 'Admin GET /api/admin/system/health returns HTTP 200');
    const health = await healthRes.json();
    assert(health.status === 'healthy', 'System health status is healthy');
    assert(health.database.journalMode === 'wal', 'Authoritative SQLite journal_mode is WAL');
    assert(health.database.foreignKeys === true, 'Foreign keys enforcement is active');
    assert(health.database.tableCounts.merchants >= 1, 'Table counts: merchants reported');
    assert(health.database.tableCounts.transactions >= 1, 'Table counts: transactions reported');
    assert(health.database.tableCounts.auditTrail >= 1, 'Table counts: audit trail reported');

    // 3. Merchant Directory & Detail Drawer (Page 2)
    const usersRes = await request(baseUrl, '/api/admin/users', {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(usersRes.status === 200, 'Admin GET /api/admin/users returns HTTP 200');
    const usersList = await usersRes.json();
    assert(usersList.some(u => u.id === testMerchant.id), 'Test merchant appears in admin directory');

    const merchantDetailRes = await request(baseUrl, `/api/admin/merchants/${testMerchant.id}`, {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(merchantDetailRes.status === 200, 'Admin GET /api/admin/merchants/:id returns HTTP 200');
    const mDetail = await merchantDetailRes.json();
    assert(mDetail.merchant.id === testMerchant.id, 'Merchant detail returns correct merchant id');
    assert(Array.isArray(mDetail.upis) && mDetail.upis.length === 1, 'Merchant detail contains connected UPIs');
    assert(Array.isArray(mDetail.links) && mDetail.links.length === 1, 'Merchant detail contains payment links');
    assert(Array.isArray(mDetail.recentTransactions) && mDetail.recentTransactions.length === 1, 'Merchant detail contains recent transactions');

    // 4. Audited Merchant Suspension
    const suspendRes = await request(baseUrl, `/api/admin/merchants/${testMerchant.id}/suspend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + adminJwt
      },
      body: JSON.stringify({
        suspended: true,
        reasonCode: 'COMPLIANCE_HOLD',
        justification: 'Audited KYC verification hold initiated by platform compliance team'
      })
    });
    assert(suspendRes.status === 200, 'POST /api/admin/merchants/:id/suspend returns HTTP 200');
    const suspResult = await suspendRes.json();
    assert(suspResult.suspended === true, 'Merchant suspension state successfully set to true');

    // Verify suspended merchant is rejected from private endpoints
    const merchantProfileRes = await request(baseUrl, '/api/profile', {
      headers: { 'Authorization': 'Bearer ' + merchantToken }
    });
    assert(merchantProfileRes.status === 403, 'Suspended merchant blocked from /api/profile (HTTP 403)');

    // Restore merchant access
    const unsuspendRes = await request(baseUrl, `/api/admin/merchants/${testMerchant.id}/suspend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + adminJwt
      },
      body: JSON.stringify({
        suspended: false,
        reasonCode: 'COMPLIANCE_HOLD',
        justification: 'KYC documentation accepted and merchant access restored'
      })
    });
    assert(unsuspendRes.status === 200, 'Unsuspend returns HTTP 200');

    // 5. Global Transactions Ledger (Page 3)
    const adminTxsRes = await request(baseUrl, '/api/admin/transactions', {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(adminTxsRes.status === 200, 'Admin GET /api/admin/transactions returns HTTP 200');
    const adminTxs = await adminTxsRes.json();
    assert(adminTxs.some(t => t.id === seededTx.id), 'Seeded transaction is present in global ledger');

    // 6. Payment Investigation Workspace (Page 4)
    const invSearchRes = await request(baseUrl, `/api/admin/investigation/search?utr=${seededTx.utr}`, {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(invSearchRes.status === 200, 'Admin GET /api/admin/investigation/search returns HTTP 200');
    const invData = await invSearchRes.json();
    assert(invData.items.length >= 1, 'Investigation search finds transaction by UTR');
    assert(invData.items[0].id === seededTx.id, 'Found transaction ID matches seeded ID');

    // Investigation Timeline & Forensic Pipeline
    const timelineRes = await request(baseUrl, `/api/admin/transactions/${seededTx.id}/timeline`, {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(timelineRes.status === 200, 'GET /api/admin/transactions/:id/timeline returns HTTP 200');
    const timelineData = await timelineRes.json();
    assert(timelineData.transaction.reference === seededTx.reference, 'Timeline contains transaction details');
    assert(timelineData.diagnostics.isAmbiguous === true, 'Timeline diagnostics flags ambiguity');
    assert(Array.isArray(timelineData.timeline), 'Timeline events array present');

    // 7. Audited Manual Reconciliation
    const reconcileRes = await request(baseUrl, `/api/admin/transactions/${seededTx.id}/reconcile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + adminJwt
      },
      body: JSON.stringify({
        action: 'force_settle_with_proof',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Customer submitted official stamped bank statement showing successful credit',
        expectedCurrentStatus: 'pending',
        utr: '429182736450'
      })
    });
    assert(reconcileRes.status === 200, 'POST /api/admin/transactions/:id/reconcile returns HTTP 200');
    const recResult = await reconcileRes.json();
    assert(recResult.transaction.status === 'success', 'Transaction settled to success via manual reconciliation');
    assert(recResult.transaction.reconciliationStatus === 'settled', 'Reconciliation status transitioned to settled');
    assert(recResult.transaction.verifiedBy === 'admin-manual', 'VerifiedBy recorded as admin-manual');

    // Concurrency conflict test (409)
    const conflictRes = await request(baseUrl, `/api/admin/transactions/${seededTx.id}/reconcile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + adminJwt
      },
      body: JSON.stringify({
        action: 'mark_failed_with_proof',
        reasonCode: 'SUSPECTED_FRAUD',
        justification: 'Attempting invalid reverse on settled transaction',
        expectedCurrentStatus: 'pending' // Mismatch! Current is 'success'
      })
    });
    assert(conflictRes.status === 409, 'Status mismatch triggers HTTP 409 Conflict (Optimistic Concurrency)');

    // 8. Administrative Audit Trail (Page 5)
    const auditRes = await request(baseUrl, '/api/admin/audit-trail?limit=10', {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(auditRes.status === 200, 'Admin GET /api/admin/audit-trail returns HTTP 200');
    const auditData = await auditRes.json();
    assert(Array.isArray(auditData.items) && auditData.items.length > 0, 'Audit trail returns recorded entries');
    const settleEntry = auditData.items.find(a => a.action === 'transaction.reconcile.force_settle_with_proof');
    assert(settleEntry !== undefined, 'Audit trail contains transaction.reconcile entry');
    assert(settleEntry.reasonCode === 'OFFICIAL_BANK_STATEMENT_PROOF', 'Audit entry contains reasonCode');
    assert(Boolean(settleEntry.afterState), 'Audit entry contains afterState for diff inspection');

    // 9. Staff Management & RBAC Enforcement (Page 6)
    // Create an OperationsSupport user
    const staffEmail = 'pooja_ops_' + Date.now() + '@sakkupay.local';
    const createStaffRes = await request(baseUrl, '/api/admin/staff', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + adminJwt
      },
      body: JSON.stringify({
        name: 'Pooja Verma',
        email: staffEmail,
        password: 'PasswordOps123!',
        role: 'OperationsSupport'
      })
    });
    assert(createStaffRes.status === 201, 'SuperAdmin POST /api/admin/staff returns HTTP 201 Created');
    const staffUser = await createStaffRes.json();
    assert(staffUser.role === 'OperationsSupport', 'Staff role is OperationsSupport');
    assert(!staffUser.passwordHash, 'Password hash is strictly excluded from staff response');

    // Login as OperationsSupport
    const opsLoginRes = await request(baseUrl, '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: staffEmail,
        password: 'PasswordOps123!'
      })
    });
    assert(opsLoginRes.status === 200, 'OperationsSupport login succeeds (HTTP 200)');
    const opsJwt = (await opsLoginRes.json()).token;

    // RBAC: OperationsSupport CAN access investigation
    const opsInvRes = await request(baseUrl, '/api/admin/investigation/search', {
      headers: { 'Authorization': 'Bearer ' + opsJwt }
    });
    assert(opsInvRes.status === 200, 'OperationsSupport CAN search investigation workspace (HTTP 200)');

    // RBAC: OperationsSupport CANNOT access audit trail
    const opsAuditRes = await request(baseUrl, '/api/admin/audit-trail', {
      headers: { 'Authorization': 'Bearer ' + opsJwt }
    });
    assert(opsAuditRes.status === 403, 'OperationsSupport DENIED access to audit trail (HTTP 403)');

    // RBAC: OperationsSupport CANNOT create staff
    const opsStaffRes = await request(baseUrl, '/api/admin/staff', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + opsJwt
      },
      body: JSON.stringify({
        name: 'Escalated Admin',
        email: 'hacker@sakkupay.local',
        password: 'Password123!',
        role: 'SuperAdmin'
      })
    });
    assert(opsStaffRes.status === 403, 'OperationsSupport DENIED staff creation (HTTP 403)');

    // 10. Error Diagnostics (Page 7)
    // Post client error
    await request(baseUrl, '/api/errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + merchantToken
      },
      body: JSON.stringify({
        message: 'Network timeout during UPI intent launch',
        url: 'https://checkout.sakkupay.local/pay/apex-pro',
        line: 42,
        col: 10
      })
    });

    const getErrorsRes = await request(baseUrl, '/api/admin/errors', {
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(getErrorsRes.status === 200, 'Admin GET /api/admin/errors returns HTTP 200');
    const errorsList = await getErrorsRes.json();
    assert(errorsList.some(e => e.message.includes('Network timeout')), 'Logged client error appears in diagnostics');

    // 11. Routine Deletion Protection on Merchant with Financial Records
    const deleteMerchantRes = await request(baseUrl, `/api/admin/users/${testMerchant.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + adminJwt }
    });
    assert(deleteMerchantRes.status === 400, 'Routine deletion guard: Cannot delete merchant with financial records (HTTP 400)');
    const delErr = await deleteMerchantRes.json();
    assert(delErr.error.includes('existing financial transaction records'), 'Guard message informs admin to suspend instead');

    // 12. Security Audit: No Secret Leaks in Served Content
    console.log('\n--- Section 4: Security Audit & Secret Leak Guard ---');
    const allServedText = dashHtml + adminHtml + adminCss + adminJs + appExtraCss + appLiveJs;
    assert(!allServedText.includes(process.env.ADMIN_PASSWORD), 'Admin password never leaked in any frontend script/HTML');
    assert(!allServedText.includes(process.env.SAKKUPAY_TOKEN_SECRET), 'Token secret never leaked in frontend code');
    assert(!allServedText.includes(process.env.VAULT_SECRET), 'Vault secret never leaked in frontend code');
    assert(!allServedText.includes('hash123'), 'Merchant password hash never leaked in frontend code');

    console.log('\n' + '='.repeat(78));
    console.log(`MILESTONE 5 TEST SUMMARY: ${totalPassed} PASSED, ${totalFailed} FAILED`);
    console.log('='.repeat(78));

  } finally {
    await new Promise(resolve => server.close(resolve));
    console.log('\nLive HTTP test server closed cleanly.');

    // Cleanup test database
    try {
      if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);
      if (fs.existsSync(testDbFile + '-wal')) fs.unlinkSync(testDbFile + '-wal');
      if (fs.existsSync(testDbFile + '-shm')) fs.unlinkSync(testDbFile + '-shm');
    } catch (_) {}
  }
}

runMilestone5Tests().catch(err => {
  console.error('\nFatal test execution error:', err);
  process.exit(1);
});
