/* ==============================================================================
   SakkuPay Milestone 1 — Automated Security & Payment Verification Test Suite
   ============================================================================== */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const {
  server,
  db,
  persist,
  token,
  adminToken,
  encryptToken,
  decryptToken,
  validateProductionEnvironment,
  verifyPaytmChecksum
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

async function runTests() {
  console.log('==============================================================================');
  console.log('SakkuPay Milestone 1: Automated Security & Regression Suite');
  console.log('==============================================================================\n');

  // 1. Setup deterministic test fixture in database
  const testMerchantId = 'mer_sec_test';
  const testPhonePeMid = 'PHONEPE_TEST_MID';
  const testPhonePeSalt = 'test_salt_key_1234567890abcdef';
  const testPaytmMid = 'PAYTM_TEST_MID';
  const testPaytmKey = 'test_paytm_merchant_secret_key_123';

  // Ensure test merchant exists
  let m = db.merchants.find(x => x.id === testMerchantId);
  if (!m) {
    m = {
      id: testMerchantId,
      email: 'sec_test@sakkupay.in',
      businessName: 'Security Test Store',
      supportEmail: 'sec_test@sakkupay.in',
      description: 'Security Suite',
      whatsappNumber: '9876543210',
      createdAt: new Date().toISOString()
    };
    db.merchants.push(m);
  }

  // Ensure test business accounts exist
  let phonePeAcc = db.businessAccounts.find(x => x.merchantId === testMerchantId && x.provider === 'phonepe');
  if (!phonePeAcc) {
    phonePeAcc = {
      id: 'biz_phonepe_test',
      merchantId: testMerchantId,
      provider: 'phonepe',
      accountName: 'PhonePe Test Business',
      phoneNumber: '9876543210',
      merchantIdRef: testPhonePeMid,
      token: encryptToken(testPhonePeSalt),
      saltIndex: '1',
      status: 'connected',
      createdAt: new Date().toISOString()
    };
    db.businessAccounts.push(phonePeAcc);
  } else {
    phonePeAcc.merchantIdRef = testPhonePeMid;
    phonePeAcc.token = encryptToken(testPhonePeSalt);
    phonePeAcc.status = 'connected';
  }

  let paytmAcc = db.businessAccounts.find(x => x.merchantId === testMerchantId && x.provider === 'paytm');
  if (!paytmAcc) {
    paytmAcc = {
      id: 'biz_paytm_test',
      merchantId: testMerchantId,
      provider: 'paytm',
      accountName: 'Paytm Test Business',
      phoneNumber: '9876543210',
      merchantIdRef: testPaytmMid,
      token: encryptToken(testPaytmKey),
      status: 'connected',
      createdAt: new Date().toISOString()
    };
    db.businessAccounts.push(paytmAcc);
  } else {
    paytmAcc.merchantIdRef = testPaytmMid;
    paytmAcc.token = encryptToken(testPaytmKey);
    paytmAcc.status = 'connected';
  }

  // Create test transactions
  const txPhonePe = {
    id: 'txn_sec_phonepe',
    merchantId: testMerchantId,
    reference: 'SP_PHONEPE_TEST',
    customerName: 'Test Customer A',
    amount: 500,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  const txPaytm = {
    id: 'txn_sec_paytm',
    merchantId: testMerchantId,
    reference: 'SP_PAYTM_TEST',
    customerName: 'Test Customer B',
    amount: 750,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  const txMerchantPatch = {
    id: 'txn_sec_patch',
    merchantId: testMerchantId,
    reference: 'SP_PATCH_TEST',
    customerName: 'Test Customer C',
    amount: 1000,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  // Insert or reset test transactions in DB
  [txPhonePe, txPaytm, txMerchantPatch].forEach(t => {
    const idx = db.transactions.findIndex(x => x.id === t.id);
    if (idx >= 0) db.transactions[idx] = { ...t };
    else db.transactions.push({ ...t });
  });
  persist();

  // Start test server on ephemeral port (0)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server running at ${baseUrl}\n`);

  const merchantJwt = token(m);

  try {
    /* ─── Test 1: PhonePe Missing Signature Rejected ─── */
    console.log('--- Test 1: PhonePe Missing Signature Rejected ---');
    const t1Payload = {
      response: Buffer.from(JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: { merchantId: testPhonePeMid, merchantTransactionId: 'SP_PHONEPE_TEST', amount: 50000 }
      })).toString('base64')
    };
    const res1 = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      body: t1Payload
    });
    assert(res1.status === 401, 'Missing X-VERIFY header returns HTTP 401 Unauthorized');
    const tx1Check = db.transactions.find(x => x.id === 'txn_sec_phonepe');
    assert(tx1Check.status === 'pending', 'Transaction status remains pending when signature is missing');

    /* ─── Test 2: PhonePe Invalid Signature Rejected ─── */
    console.log('\n--- Test 2: PhonePe Invalid Signature Rejected ---');
    const res2 = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef###1' },
      body: t1Payload
    });
    assert(res2.status === 401, 'Forged X-VERIFY signature returns HTTP 401 Unauthorized');
    const tx2Check = db.transactions.find(x => x.id === 'txn_sec_phonepe');
    assert(tx2Check.status === 'pending', 'Transaction status remains pending when signature is invalid');

    /* ─── Test 3: Valid PhonePe Verification Succeeds ─── */
    console.log('\n--- Test 3: Valid PhonePe Verification Succeeds ---');
    const rawB64 = t1Payload.response;
    const computedHash = crypto.createHash('sha256').update(rawB64 + testPhonePeSalt).digest('hex');
    const validXVerify = `${computedHash}###1`;

    const res3 = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': validXVerify },
      body: t1Payload
    });
    assert(res3.status === 200, 'Cryptographically valid PhonePe signature returns HTTP 200 OK');
    assert(res3.data.verified === true, 'Response confirms verified: true');
    const tx3Check = db.transactions.find(x => x.id === 'txn_sec_phonepe');
    assert(tx3Check.status === 'success', 'Transaction status transitioned to success');
    assert(tx3Check.verifiedBy === 'phonepe-direct', 'Verification method recorded as phonepe-direct');

    /* ─── Test 4: Paytm Missing/Invalid Checksum Rejected ─── */
    console.log('\n--- Test 4: Paytm Missing/Invalid Checksum Rejected ---');
    const res4Missing = await request(baseUrl, '/api/v1/webhook/paytm', {
      method: 'POST',
      body: { MID: testPaytmMid, ORDERID: 'SP_PAYTM_TEST', STATUS: 'TXN_SUCCESS', TXNID: 'PT12345' }
    });
    assert(res4Missing.status === 401, 'Missing Paytm CHECKSUMHASH returns HTTP 401');

    const res4Invalid = await request(baseUrl, '/api/v1/webhook/paytm', {
      method: 'POST',
      body: {
        MID: testPaytmMid,
        ORDERID: 'SP_PAYTM_TEST',
        STATUS: 'TXN_SUCCESS',
        TXNID: 'PT12345',
        CHECKSUMHASH: 'invalid_forged_checksum_1234567890'
      }
    });
    assert(res4Invalid.status === 401, 'Forged Paytm CHECKSUMHASH returns HTTP 401');
    const tx4Check = db.transactions.find(x => x.id === 'txn_sec_paytm');
    assert(tx4Check.status === 'pending', 'Transaction status remains pending when checksum is invalid');

    /* ─── Test 5: Valid Paytm Verification Succeeds ─── */
    console.log('\n--- Test 5: Valid Paytm Verification Succeeds ---');
    const paytmParams = {
      MID: testPaytmMid,
      ORDERID: 'SP_PAYTM_TEST',
      STATUS: 'TXN_SUCCESS',
      TXNID: 'PT_REAL_987654',
      TXNAMOUNT: '750.00'
    };
    // Compute official HMAC-SHA256 checksum over sorted keys
    const sortedKeys = Object.keys(paytmParams).sort();
    const paramStr = sortedKeys.map(k => `${k}=${paytmParams[k]}`).join('|');
    const validChecksum = crypto.createHmac('sha256', testPaytmKey).update(paramStr).digest('hex');

    const res5 = await request(baseUrl, '/api/v1/webhook/paytm', {
      method: 'POST',
      body: { ...paytmParams, CHECKSUMHASH: validChecksum }
    });
    assert(res5.status === 200, 'Valid Paytm CHECKSUMHASH returns HTTP 200');
    assert(res5.data.verified === true, 'Response confirms verified: true');
    const tx5Check = db.transactions.find(x => x.id === 'txn_sec_paytm');
    assert(tx5Check.status === 'success', 'Transaction status transitioned to success');
    assert(tx5Check.verifiedBy === 'paytm-direct', 'Verification method recorded as paytm-direct');

    /* ─── Test 6: Block Merchant Self-Approval ─── */
    console.log('\n--- Test 6: Block Merchant Self-Approval ---');
    const res6 = await request(baseUrl, '/api/transactions/txn_sec_patch', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${merchantJwt}` },
      body: { status: 'success' }
    });
    assert(res6.status === 403, 'Merchant attempt to set status=success returns HTTP 403 Forbidden');
    const tx6Check = db.transactions.find(x => x.id === 'txn_sec_patch');
    assert(tx6Check.status === 'pending', 'Transaction status remains strictly pending');

    /* ─── Test 7: Legitimate Non-Financial Metadata Updates Allowed ─── */
    console.log('\n--- Test 7: Legitimate Non-Financial Metadata Updates Allowed ---');
    const res7 = await request(baseUrl, '/api/transactions/txn_sec_patch', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${merchantJwt}` },
      body: { note: 'Customer called confirming payment transfer', utr: '429381928371' }
    });
    assert(res7.status === 200, 'Legitimate metadata update returns HTTP 200 OK');
    const tx7Check = db.transactions.find(x => x.id === 'txn_sec_patch');
    assert(tx7Check.status === 'pending', 'Status remains pending (never self-approved)');
    assert(tx7Check.merchantNote === 'Customer called confirming payment transfer', 'Merchant note was saved');
    assert(tx7Check.utr === '429381928371', 'Customer UTR was attached as unverified evidence');

    /* ─── Test 8 & 9: Production Secret Guard vs Development Startup ─── */
    console.log('\n--- Test 8 & 9: Production Secret Guard vs Development ---');
    // Test 8: Production startup fails with default secrets
    const origNodeEnv = process.env.NODE_ENV;
    let prodCheckThrew = false;
    try {
      process.env.NODE_ENV = 'production';
      validateProductionEnvironment();
    } catch (err) {
      prodCheckThrew = true;
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
    assert(prodCheckThrew, 'Production boot throws error when default/weak secrets are detected');

    // Test 9: Development mode allows startup
    process.env.NODE_ENV = 'development';
    const devOk = validateProductionEnvironment();
    assert(devOk === true, 'Development mode allows boot with development secrets');

    /* ─── Test 10: Admin Login Rate Limiting (Brute-Force Guard) ─── */
    console.log('\n--- Test 10: Admin Login Rate Limiting ---');
    process.env.TRUST_PROXY = 'true';
    const fakeIp = '192.168.1.99';
    let hit429 = false;
    for (let i = 1; i <= 6; i++) {
      const loginRes = await request(baseUrl, '/api/admin/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': fakeIp },
        body: { username: 'admin', password: 'wrongpassword' }
      });
      if (i <= 5) {
        assert(loginRes.status === 401, `Attempt ${i}: Failed login returns 401`);
      } else {
        hit429 = loginRes.status === 429;
        assert(loginRes.status === 429, 'Attempt 6: Exceeding failed threshold returns HTTP 429 Too Many Requests');
        assert(loginRes.headers.get('retry-after') !== null, 'Retry-After header is returned');
      }
    }
    process.env.TRUST_PROXY = 'false';
    assert(hit429, 'Admin login brute-force rate limiter successfully locked out IP');

    /* ─── Test 11: Checkout Attempt Rate Limiting ─── */
    console.log('\n--- Test 11: Checkout Attempt Rate Limiting ---');
    // Ensure test link exists
    let testLink = db.links.find(x => x.slug === 'sec-test-slug');
    if (!testLink) {
      testLink = {
        id: 'lnk_sec_rate',
        merchantId: testMerchantId,
        upiId: 'sectest@upi',
        name: 'Rate Limit Test Product',
        slug: 'sec-test-slug',
        amount: 100,
        amountType: 'fixed',
        active: true,
        createdAt: new Date().toISOString()
      };
      db.links.push(testLink);
      persist();
    }

    let checkout429 = false;
    for (let i = 1; i <= 22; i++) {
      const attRes = await request(baseUrl, '/api/checkout/sec-test-slug/attempt', {
        method: 'POST',
        body: { amount: 100 }
      });
      if (attRes.status === 429) {
        checkout429 = true;
        break;
      }
    }
    assert(checkout429, 'Checkout attempt rate limiter returns HTTP 429 after 20 attempts/minute');

    /* ─── Test 12: Duplicate Webhook Delivery Idempotency ─── */
    console.log('\n--- Test 12: Duplicate Webhook Delivery Idempotency ---');
    const res12 = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': validXVerify },
      body: t1Payload
    });
    assert(res12.status === 200, 'Duplicate PhonePe delivery returns HTTP 200');
    assert(res12.data.duplicate === true, 'Duplicate notification returns duplicate: true without error');

    /* ─── Test 13: Regression Check (Existing Core APIs) ─── */
    console.log('\n--- Test 13: Regression Check (Existing Core APIs) ---');
    const dashRes = await request(baseUrl, '/api/dashboard', {
      headers: { Authorization: `Bearer ${merchantJwt}` }
    });
    assert(dashRes.status === 200 && dashRes.data.stats !== undefined, 'Merchant dashboard metrics API operational');

    const linksRes = await request(baseUrl, '/api/links', {
      headers: { Authorization: `Bearer ${merchantJwt}` }
    });
    assert(linksRes.status === 200 && Array.isArray(linksRes.data), 'Merchant links API operational');

    const upisRes = await request(baseUrl, '/api/upis', {
      headers: { Authorization: `Bearer ${merchantJwt}` }
    });
    assert(upisRes.status === 200 && Array.isArray(upisRes.data), 'Merchant UPI destinations API operational');

    const checkStatusRes = await request(baseUrl, '/api/checkout/sec-test-slug/status?ref=SP_PHONEPE_TEST');
    assert(checkStatusRes.status === 200 && checkStatusRes.data.status === 'success', 'Customer checkout status polling operational');

    console.log('\n==============================================================================');
    console.log(`TEST SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log('==============================================================================');

  } finally {
    // Cleanup test server
    await new Promise(resolve => server.close(resolve));
    console.log('Test server closed cleanly.');
  }
}

runTests().then(() => {
  if (failedTests > 0) process.exit(1);
  process.exit(0);
}).catch(err => {
  console.error('\nFatal test execution error:', err);
  process.exit(1);
});
