/* ==============================================================================
   SakkuPay Milestone 6: Production Readiness & Negative Security Test Suite
   ============================================================================== */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const {
  server,
  db,
  repository,
  sqliteDb,
  persist,
  encryptToken,
  token,
  adminToken,
  verifyPaytmChecksum,
  ADMIN_ROLES,
  REASON_CODES
} = require('./server');

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

function request(baseUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    let bodyStr = null;
    if (options.body) {
      if (typeof options.body === 'string') {
        bodyStr = options.body;
      } else {
        bodyStr = JSON.stringify(options.body);
        if (!reqOptions.headers['Content-Type']) {
          reqOptions.headers['Content-Type'] = 'application/json';
        }
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
      // If server responded with status (e.g. 413) before closing TCP socket, allow response to settle
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

async function runMilestone6Suite() {
  console.log('==============================================================================');
  console.log('SakkuPay Milestone 6: Production Readiness & Security Test Suite');
  console.log('==============================================================================\n');

  // Start ephemeral server
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server active on ${baseUrl}\n`);

  // Setup test fixtures
  const merchantA = {
    id: 'mer_m6_test_a',
    email: 'm6_a@sakkupay.in',
    businessName: 'Merchant A Org',
    whatsappNumber: '9988776655',
    createdAt: new Date().toISOString()
  };
  const merchantB = {
    id: 'mer_m6_test_b',
    email: 'm6_b@sakkupay.in',
    businessName: 'Merchant B Org',
    whatsappNumber: '9988776644',
    createdAt: new Date().toISOString()
  };

  [merchantA, merchantB].forEach(m => {
    const existing = repository.merchants.findById(m.id);
    if (!existing) repository.merchants.create(m);
    if (!db.merchants.some(x => x.id === m.id)) db.merchants.push(m);
  });

  const tokenA = token(merchantA);
  const tokenB = token(merchantB);
  const superAdminToken = adminToken(ADMIN_ROLES.SUPER_ADMIN);
  const opsToken = adminToken(ADMIN_ROLES.OPERATIONS_SUPPORT);
  const auditToken = adminToken(ADMIN_ROLES.COMPLIANCE_AUDITOR);

  try {
    /* ─── Section 1: Query String Token Rejection on REST Routes ─── */
    console.log('--- Section 1: Query String Token Hardening (CWE-598) ---');

    // 1. Merchant REST endpoint must reject ?token=... without Authorization header
    const resM1 = await request(baseUrl, `/api/profile?token=${tokenA}`);
    assert(resM1.status === 401, 'Merchant GET /api/profile with query token returns HTTP 401 Unauthorized');

    // 2. Admin REST endpoint must reject ?token=... without Authorization header
    const resM2 = await request(baseUrl, `/api/admin/system/health?token=${superAdminToken}`);
    assert(resM2.status === 401, 'Admin GET /api/admin/system/health with query token returns HTTP 401 Unauthorized');

    // 3. Proper Authorization header succeeds
    const resM3 = await request(baseUrl, '/api/profile', {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert(resM3.status === 200, 'Merchant GET /api/profile with Authorization header succeeds (HTTP 200)');

    /* ─── Section 2: Security Response Headers ─── */
    console.log('\n--- Section 2: Security Response Headers ---');
    const resH = await request(baseUrl, '/api/profile', {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert(resH.headers['x-content-type-options'] === 'nosniff', 'Header X-Content-Type-Options: nosniff present');
    assert(resH.headers['x-frame-options'] === 'DENY', 'Header X-Frame-Options: DENY present');
    assert(resH.headers['referrer-policy'] === 'strict-origin-when-cross-origin', 'Header Referrer-Policy present');

    /* ─── Section 3: Oversized Body Parser Guard (DoS Prevention) ─── */
    console.log('\n--- Section 3: Request Body Parser Limit (DoS Guard) ---');
    const largePayload = {
      message: 'A'.repeat(1024 * 1024 + 100) // > 1MB
    };
    const resLarge = await request(baseUrl, '/api/errors', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: largePayload
    });
    assert(resLarge.status === 413, 'Oversized payload (>1MB) returns HTTP 413 Payload Too Large');

    /* ─── Section 4: PhonePe Webhook Amount Mismatch Protection ─── */
    console.log('\n--- Section 4: PhonePe Webhook Amount Mismatch Protection ---');
    const phonePeSalt = 'test_salt_m6_phonepe_1234567890';
    const phonePeMid = 'PHONEPE_M6_MID';
    let phonePeAcc = repository.businessAccounts.findByProviderAndMid('phonepe', phonePeMid);
    if (!phonePeAcc) {
      phonePeAcc = repository.businessAccounts.create({
        id: 'biz_phonepe_m6',
        merchantId: merchantA.id,
        provider: 'phonepe',
        accountName: 'PhonePe M6 Account',
        phoneNumber: '9988776655',
        merchantIdRef: phonePeMid,
        token: encryptToken(phonePeSalt),
        saltIndex: '1',
        status: 'connected'
      });
      db.businessAccounts.push(phonePeAcc);
    }

    const existingTxPP = repository.transactions.findById('txn_m6_phonepe_tamper');
    let txPhonePeOrder;
    if (!existingTxPP) {
      txPhonePeOrder = repository.transactions.create({
        id: 'txn_m6_phonepe_tamper',
        merchantId: merchantA.id,
        reference: 'SP_M6_PHONEPE',
        customerName: 'PhonePe Underpay Attacker',
        amount: 1500, // ₹1,500 = 150000 paise
        status: 'pending'
      });
      if (!db.transactions.some(x => x.id === 'txn_m6_phonepe_tamper')) {
        db.transactions.unshift(txPhonePeOrder);
      }
    } else {
      txPhonePeOrder = repository.transactions.update('txn_m6_phonepe_tamper', {
        status: 'pending',
        reconciliationStatus: 'unreconciled'
      });
      const inMem = db.transactions.find(x => x.id === 'txn_m6_phonepe_tamper');
      if (inMem) Object.assign(inMem, txPhonePeOrder);
    }
    persist();

    // Attacker crafts payload claiming success, but paid only 100 paise (₹1)
    const phonePeTamperedPayload = {
      response: Buffer.from(JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: {
          merchantId: phonePeMid,
          merchantTransactionId: 'SP_M6_PHONEPE',
          amount: 100, // Underpayment: 100 paise vs 150000 expected!
          providerReferenceId: 'PP_UNDERPAY_001'
        }
      })).toString('base64')
    };
    const phonePeHash = crypto.createHash('sha256').update(phonePeTamperedPayload.response + phonePeSalt).digest('hex');
    const phonePeXVerify = `${phonePeHash}###1`;

    const resPhonePeMismatch = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': phonePeXVerify },
      body: phonePeTamperedPayload
    });
    assert(resPhonePeMismatch.status === 400, 'PhonePe amount mismatch returns HTTP 400 Bad Request');
    const freshTxPP = repository.transactions.findById('txn_m6_phonepe_tamper');
    assert(freshTxPP.status === 'pending', 'Transaction status remains strictly pending (not settled)');
    assert(freshTxPP.reconciliationStatus === 'flagged_ambiguous', 'Transaction reconciliationStatus flagged as flagged_ambiguous');

    /* ─── Section 5: Paytm Webhook Amount Mismatch Protection ─── */
    console.log('\n--- Section 5: Paytm Webhook Amount Mismatch Protection ---');
    const paytmKey = 'test_paytm_key_m6_1234567890';
    const paytmMid = 'PAYTM_M6_MID';
    let paytmAcc = repository.businessAccounts.findByProviderAndMid('paytm', paytmMid);
    if (!paytmAcc) {
      paytmAcc = repository.businessAccounts.create({
        id: 'biz_paytm_m6',
        merchantId: merchantA.id,
        provider: 'paytm',
        accountName: 'Paytm M6 Account',
        phoneNumber: '9988776655',
        merchantIdRef: paytmMid,
        token: encryptToken(paytmKey),
        status: 'connected'
      });
      db.businessAccounts.push(paytmAcc);
    }

    const existingTxPaytm = repository.transactions.findById('txn_m6_paytm_tamper');
    let txPaytmOrder;
    if (!existingTxPaytm) {
      txPaytmOrder = repository.transactions.create({
        id: 'txn_m6_paytm_tamper',
        merchantId: merchantA.id,
        reference: 'SP_M6_PAYTM',
        customerName: 'Paytm Underpay Attacker',
        amount: 2500, // ₹2,500
        status: 'pending'
      });
      if (!db.transactions.some(x => x.id === 'txn_m6_paytm_tamper')) {
        db.transactions.unshift(txPaytmOrder);
      }
    } else {
      txPaytmOrder = repository.transactions.update('txn_m6_paytm_tamper', {
        status: 'pending',
        reconciliationStatus: 'unreconciled'
      });
      const inMem = db.transactions.find(x => x.id === 'txn_m6_paytm_tamper');
      if (inMem) Object.assign(inMem, txPaytmOrder);
    }
    persist();

    // Attacker crafts payload claiming success, but paid only ₹10.00
    const paytmParams = {
      MID: paytmMid,
      ORDERID: 'SP_M6_PAYTM',
      STATUS: 'TXN_SUCCESS',
      TXNID: 'PTM_TAMPER_001',
      TXNAMOUNT: '10.00' // Underpayment: ₹10 vs ₹2500 expected!
    };
    const sortedKeys = Object.keys(paytmParams).sort();
    const paramStr = sortedKeys.map(k => `${k}=${paytmParams[k]}`).join('|');
    const validPaytmChecksum = crypto.createHmac('sha256', paytmKey).update(paramStr).digest('hex');

    const resPaytmMismatch = await request(baseUrl, '/api/v1/webhook/paytm', {
      method: 'POST',
      body: { ...paytmParams, CHECKSUMHASH: validPaytmChecksum }
    });
    assert(resPaytmMismatch.status === 400, 'Paytm amount mismatch returns HTTP 400 Bad Request');
    const freshTxPaytm = repository.transactions.findById('txn_m6_paytm_tamper');
    assert(freshTxPaytm.status === 'pending', 'Transaction status remains strictly pending (not settled)');
    assert(freshTxPaytm.reconciliationStatus === 'flagged_ambiguous', 'Transaction reconciliationStatus flagged as flagged_ambiguous');

    /* ─── Section 6: Cross-Tenant Isolation Enforcement ─── */
    console.log('\n--- Section 6: Cross-Tenant Isolation Enforcement ---');
    // Merchant B creates a link and a transaction
    let linkB = repository.links.findById('lnk_m6_tenant_b');
    if (!linkB) {
      linkB = repository.links.create({
        id: 'lnk_m6_tenant_b',
        merchantId: merchantB.id,
        upiId: 'merchantb@upi',
        name: 'Private Link B',
        slug: 'private-link-b',
        amount: 999,
        amountType: 'fixed',
        active: true
      });
      db.links.unshift(linkB);
    }
    let txB = repository.transactions.findById('txn_m6_tenant_b');
    if (!txB) {
      txB = repository.transactions.create({
        id: 'txn_m6_tenant_b',
        merchantId: merchantB.id,
        reference: 'SP_TENANT_B',
        customerName: 'Customer B',
        amount: 999,
        status: 'pending'
      });
      db.transactions.unshift(txB);
    }
    persist();

    // Merchant A attempts to access/mutate Merchant B's transaction
    const resCrossTx = await request(baseUrl, `/api/transactions/${txB.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { note: 'Illegitimate cross-merchant update' }
    });
    assert(resCrossTx.status === 404, 'Merchant A attempt to mutate Merchant B transaction returns HTTP 404 Not Found');

    // Merchant A attempts to mutate Merchant B's link
    const resCrossLink = await request(baseUrl, `/api/links/${linkB.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { active: false }
    });
    assert(resCrossLink.status === 404, 'Merchant A attempt to mutate Merchant B link returns HTTP 404 Not Found');

    /* ─── Section 7: SQLite Database Engine Trigger Immutability ─── */
    console.log('\n--- Section 7: SQLite Immutable Audit Trail Triggers ---');
    const auditId = 'adt_test_immutable_' + Date.now();
    sqliteDb.prepare(`
      INSERT INTO admin_audit_trail (id, actorId, actorEmail, actorRole, action, targetType, reasonCode, justification, outcome, createdAt)
      VALUES (?, 'adm_test', 'test@sakkupay.local', 'SuperAdmin', 'test.immutable', 'system', 'OFFICIAL_BANK_STATEMENT_PROOF', 'Audit trigger immutability verification', 'success', ?)
    `).run(auditId, new Date().toISOString());

    let updateBlocked = false;
    try {
      sqliteDb.prepare('UPDATE admin_audit_trail SET justification = ? WHERE id = ?').run('tampered justification', auditId);
    } catch (e) {
      if (e.message.includes('append-only') || e.message.includes('forbidden')) {
        updateBlocked = true;
      }
    }
    assert(updateBlocked, 'Direct raw SQL UPDATE on admin_audit_trail strictly blocked by SQLite engine trigger');

    let deleteBlocked = false;
    try {
      sqliteDb.prepare('DELETE FROM admin_audit_trail WHERE id = ?').run(auditId);
    } catch (e) {
      if (e.message.includes('append-only') || e.message.includes('forbidden')) {
        deleteBlocked = true;
      }
    }
    assert(deleteBlocked, 'Direct raw SQL DELETE on admin_audit_trail strictly blocked by SQLite engine trigger');

    /* ─── Section 8: Admin RBAC Self-Protection & Least Privilege ─── */
    console.log('\n--- Section 8: Admin RBAC Privilege & Self-Protection Enforcement ---');
    // 1. ComplianceAuditor cannot execute reconciliation mutations
    const resAuditorRecon = await request(baseUrl, `/api/admin/transactions/${freshTxPP.id}/reconcile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auditToken}` },
      body: {
        action: 'force_settle_with_proof',
        reasonCode: 'OFFICIAL_BANK_STATEMENT_PROOF',
        justification: 'Auditor attempt to force settle',
        utr: 'UTR99887766'
      }
    });
    assert(resAuditorRecon.status === 403, 'ComplianceAuditor blocked from executing reconciliation (HTTP 403 Forbidden)');

    // 2. OperationsSupport cannot read audit trail
    const resOpsAudit = await request(baseUrl, '/api/admin/audit-trail', {
      headers: { Authorization: `Bearer ${opsToken}` }
    });
    assert(resOpsAudit.status === 403, 'OperationsSupport blocked from viewing audit trail (HTTP 403 Forbidden)');

    // 3. SuperAdmin cannot alter their own role (self-escalation / demotion prevention)
    const resSelfRole = await request(baseUrl, '/api/admin/staff/adm_default_superadmin', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { role: ADMIN_ROLES.OPERATIONS_SUPPORT }
    });
    assert(resSelfRole.status === 400, 'SuperAdmin attempt to mutate own role returns HTTP 400 Bad Request');

    // 4. SuperAdmin cannot deactivate own account
    const resSelfDeact = await request(baseUrl, '/api/admin/staff/adm_default_superadmin', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: { active: false }
    });
    assert(resSelfDeact.status === 400, 'SuperAdmin attempt to deactivate own account returns HTTP 400 Bad Request');

  } finally {
    await new Promise(resolve => server.close(resolve));
    console.log('\nTest server closed cleanly.');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`MILESTONE 6 TEST SUMMARY: ${passedAssertions} PASSED, ${failedAssertions} FAILED`);
  console.log('='.repeat(78));

  process.exit(failedAssertions === 0 ? 0 : 1);
}

runMilestone6Suite().catch(err => {
  console.error('Test runner encountered an error:', err);
  process.exit(1);
});
