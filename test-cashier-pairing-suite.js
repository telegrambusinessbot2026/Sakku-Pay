'use strict';

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SAKKUPAY_TOKEN_SECRET = 'test-token-secret-for-cashier-suite-minimum-32-chars';
process.env.DATA_FILE = 'temp_test_cashier_data.json';
process.env.DB_PATH = 'temp_test_cashier.db';

const { server, db, repository, token } = require('./server');

async function runTests() {
  console.log('==============================================================================');
  console.log('SakkuPay Cashier App, Two-Stage Pairing & UPI Verification Test Suite');
  console.log('==============================================================================');

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log('Live test server running on:', baseUrl);

  let passed = 0;
  let total = 0;

  function pass(msg) {
    passed++;
    total++;
    console.log(`  ✅ PASSED: ${msg}`);
  }

  function fail(msg, err) {
    total++;
    console.error(`  ❌ FAILED: ${msg}`);
    if (err) console.error(err);
    process.exitCode = 1;
  }

  try {
    // --------------------------------------------------------------------------
    // Test Setup: Seed two distinct merchants to verify isolation
    // --------------------------------------------------------------------------
    const merchantA = {
      id: 'mer_test_cashier_A',
      businessName: 'Sakku Retail Store',
      email: 'owner@sakkuretail.in',
      passwordHash: 'dummy_hash_a',
      createdAt: new Date().toISOString()
    };
    const merchantB = {
      id: 'mer_test_cashier_B',
      businessName: 'Other Merchant Store',
      email: 'owner@otherstore.in',
      passwordHash: 'dummy_hash_b',
      createdAt: new Date().toISOString()
    };

    try { repository.merchants.create(merchantA); } catch {}
    try { repository.merchants.create(merchantB); } catch {}

    const tokenA = token(merchantA);
    const tokenB = token(merchantB);

    // --------------------------------------------------------------------------
    // Section 1: Merchant Initiates Cashier Pairing Session (Stage 1)
    // --------------------------------------------------------------------------
    console.log('\n--- Section 1: Two-Stage Cashier Session Initiation ---');

    let sessionData = null;
    {
      const res = await fetch(`${baseUrl}/api/cashier/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenA}`
        },
        body: JSON.stringify({
          provider: 'phonepe',
          name: 'Counter 1 — POS Samsung',
          phoneNumber: '9876543210',
          upiId: 'sakkuretail@ybl'
        })
      });

      assert.strictEqual(res.status, 201, 'Initiating session returns HTTP 201 Created');
      sessionData = await res.json();
      assert.strictEqual(sessionData.ok, true);
      assert(sessionData.sessionId.startsWith('cps_'), 'Session ID starts with cps_');
      assert(sessionData.cashierId.startsWith('csh_'), 'Cashier ID starts with csh_');
      assert(sessionData.serverCode.length >= 12, 'Server code formatted properly');
      assert.strictEqual(sessionData.rawServerCode.length, 12, 'Raw server code is exactly 12 digits');
      assert(sessionData.expiresAt, 'ExpiresAt is set');

      // Verify in database that hash is stored, not plaintext
      const dbSession = repository.cashierPairingSessions.findById(sessionData.sessionId);
      assert.strictEqual(dbSession.status, 'pending_server_code');
      assert.notStrictEqual(dbSession.serverCodeHash, sessionData.rawServerCode);
      const computedHash = crypto.createHash('sha256').update(sessionData.rawServerCode).digest('hex');
      assert.strictEqual(dbSession.serverCodeHash, computedHash, 'Database stores SHA-256 hash of server code');

      pass('POST /api/cashier/sessions generates 12-digit Server Code, hashes it, and returns session');
    }

    // --------------------------------------------------------------------------
    // Section 2: Input Validation & Unauthenticated Access
    // --------------------------------------------------------------------------
    console.log('\n--- Section 2: Input Validation & Authentication ---');

    {
      const res = await fetch(`${baseUrl}/api/cashier/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'phonepe', phoneNumber: '9876543210', upiId: 'store@ybl' })
      });
      assert.strictEqual(res.status, 401, 'Unauthenticated request returns HTTP 401');
      pass('Unauthenticated POST /api/cashier/sessions is rejected with HTTP 401');
    }

    {
      const res = await fetch(`${baseUrl}/api/cashier/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
        body: JSON.stringify({ provider: 'invalid_provider', phoneNumber: '9876543210', upiId: 'store@ybl' })
      });
      assert.strictEqual(res.status, 400, 'Invalid provider returns HTTP 400');
      pass('Invalid payment provider is rejected with HTTP 400');
    }

    {
      const res = await fetch(`${baseUrl}/api/cashier/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
        body: JSON.stringify({ provider: 'phonepe', phoneNumber: '12345', upiId: 'store@ybl' })
      });
      assert.strictEqual(res.status, 400, 'Invalid phone number returns HTTP 400');
      pass('Invalid 10-digit mobile number is rejected with HTTP 400');
    }

    {
      const res = await fetch(`${baseUrl}/api/cashier/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
        body: JSON.stringify({ provider: 'phonepe', phoneNumber: '9876543210', upiId: 'invalid-upi-handle' })
      });
      assert.strictEqual(res.status, 400, 'Invalid UPI ID returns HTTP 400');
      pass('Invalid UPI ID without @ is rejected with HTTP 400');
    }

    // --------------------------------------------------------------------------
    // Section 3: Session Recovery & Merchant Isolation
    // --------------------------------------------------------------------------
    console.log('\n--- Section 3: Session Recovery & Merchant Isolation ---');

    {
      const res = await fetch(`${baseUrl}/api/cashier/sessions/${sessionData.sessionId}`, {
        headers: { 'Authorization': `Bearer ${tokenA}` }
      });
      assert.strictEqual(res.status, 200, 'Session recovery returns HTTP 200');
      const data = await res.json();
      assert.strictEqual(data.sessionId, sessionData.sessionId);
      assert.strictEqual(data.status, 'pending_server_code');
      assert.strictEqual(data.hasAppCode, false);
      pass('GET /api/cashier/sessions/:id recovers active session across page refreshes');
    }

    {
      // Merchant B attempts to access Merchant A's session
      const res = await fetch(`${baseUrl}/api/cashier/sessions/${sessionData.sessionId}`, {
        headers: { 'Authorization': `Bearer ${tokenB}` }
      });
      assert.strictEqual(res.status, 404, 'Cross-merchant session lookup returns HTTP 404');
      pass('Cross-merchant isolation: Merchant B cannot access Merchant A pairing session');
    }

    // --------------------------------------------------------------------------
    // Section 4: Companion App Verifies 12-Digit Server Code (Stage 2 Initiated)
    // --------------------------------------------------------------------------
    console.log('\n--- Section 4: Companion App Server Code Verification ---');

    let companionPairingResult = null;
    {
      // Companion app sends invalid code first
      const badRes = await fetch(`${baseUrl}/api/cashier/pair-server-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverCode: '000000000000', deviceModel: 'Samsung Galaxy A15' })
      });
      assert.strictEqual(badRes.status, 400, 'Invalid server code returns HTTP 400');
      pass('Companion App with incorrect Server Code is rejected');
    }

    {
      // Companion app sends valid 12-digit code
      const res = await fetch(`${baseUrl}/api/cashier/pair-server-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverCode: sessionData.rawServerCode,
          deviceModel: 'Samsung Galaxy A15 (Android 14)'
        })
      });
      assert.strictEqual(res.status, 200, 'Valid server code verification returns HTTP 200');
      companionPairingResult = await res.json();
      assert.strictEqual(companionPairingResult.ok, true);
      assert(companionPairingResult.appCode, 'App Code is generated');
      assert.strictEqual(companionPairingResult.appCode.length, 6, 'App Code is exactly 6 digits');
      assert(companionPairingResult.cashierApiKey.startsWith('sk_csh_'), 'Scoped cashier API key issued');
      assert.strictEqual(companionPairingResult.cashierId, sessionData.cashierId);
      assert.strictEqual(companionPairingResult.merchantId, merchantA.id);

      // Verify session updated to app_code_generated
      const dbSession = repository.cashierPairingSessions.findById(sessionData.sessionId);
      assert.strictEqual(dbSession.status, 'app_code_generated');
      pass('Companion App verifies 12-digit Server Code, receives 6-digit App Code & scoped API key');
    }

    // --------------------------------------------------------------------------
    // Section 5: Rate Limiting & Brute-Force Protection on App Code
    // --------------------------------------------------------------------------
    console.log('\n--- Section 5: App Code Verification & Brute-Force Defense ---');

    // Create a throwaway session to test rate limiting / lockouts
    {
      const initRes = await fetch(`${baseUrl}/api/cashier/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
        body: JSON.stringify({ provider: 'paytm', name: 'Lockout Test', phoneNumber: '9876543211', upiId: 'lockout@paytm' })
      });
      const throwawaySession = await initRes.json();

      await fetch(`${baseUrl}/api/cashier/pair-server-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverCode: throwawaySession.rawServerCode, deviceModel: 'Test Device' })
      });

      // Submit 4 incorrect app codes
      for (let attempt = 1; attempt <= 4; attempt++) {
        const attemptRes = await fetch(`${baseUrl}/api/cashier/verify-app-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
          body: JSON.stringify({ sessionId: throwawaySession.sessionId, appCode: '000000' })
        });
        assert.strictEqual(attemptRes.status, 400);
        const errData = await attemptRes.json();
        assert(errData.error.includes('attempts remaining'), 'Response indicates remaining attempts');
      }

      // 5th incorrect attempt must lock out and revoke session
      const lockRes = await fetch(`${baseUrl}/api/cashier/verify-app-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
        body: JSON.stringify({ sessionId: throwawaySession.sessionId, appCode: '000000' })
      });
      assert.strictEqual(lockRes.status, 400);
      const lockData = await lockRes.json();
      assert(lockData.error.includes('Session revoked for security'), '5th failed attempt locks out session');

      const lockedSession = repository.cashierPairingSessions.findById(throwawaySession.sessionId);
      assert.strictEqual(lockedSession.status, 'revoked', 'Session status set to revoked in DB');
      pass('Brute-force protection: 5 incorrect App Code attempts automatically revoke session');
    }

    // --------------------------------------------------------------------------
    // Section 6: Successful App Code Verification & Cashier Activation
    // --------------------------------------------------------------------------
    console.log('\n--- Section 6: Successful App Code Activation ---');

    {
      const res = await fetch(`${baseUrl}/api/cashier/verify-app-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenA}` },
        body: JSON.stringify({
          sessionId: sessionData.sessionId,
          appCode: companionPairingResult.appCode
        })
      });

      assert.strictEqual(res.status, 200, 'Valid App Code returns HTTP 200 OK');
      const data = await res.json();
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.cashier.status, 'active');
      assert(data.cashier.pairedAt, 'PairedAt timestamp recorded');

      const dbCashier = repository.cashiers.findById(sessionData.cashierId);
      assert.strictEqual(dbCashier.status, 'active');
      const dbSession = repository.cashierPairingSessions.findById(sessionData.sessionId);
      assert.strictEqual(dbSession.status, 'completed');

      pass('POST /api/cashier/verify-app-code successfully activates cashier and marks session completed');
    }

    // --------------------------------------------------------------------------
    // Section 7: Merchant Cashier Listing & Audit Trail
    // --------------------------------------------------------------------------
    console.log('\n--- Section 7: Cashier Listing & Audit Logs ---');

    {
      const res = await fetch(`${baseUrl}/api/cashier/list`, {
        headers: { 'Authorization': `Bearer ${tokenA}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert(Array.isArray(data.cashiers));
      const pairedCashier = data.cashiers.find(c => c.id === sessionData.cashierId);
      assert(pairedCashier, 'Paired cashier present in merchant list');
      assert.strictEqual(pairedCashier.status, 'active');
      pass('GET /api/cashier/list returns active cashiers');
    }

    {
      const res = await fetch(`${baseUrl}/api/cashier/logs`, {
        headers: { 'Authorization': `Bearer ${tokenA}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert(Array.isArray(data.logs));
      assert(data.logs.some(l => l.event === 'cashier_activated'), 'Activation event logged');
      pass('GET /api/cashier/logs returns audit trail of cashier pairing and activation');
    }

    // --------------------------------------------------------------------------
    // Section 8: End-to-End Payment Verification with Cashier Attribution
    // --------------------------------------------------------------------------
    console.log('\n--- Section 8: Payment Verification & Cashier Attribution ---');

    {
      // 1. Create a pending transaction for Merchant A
      const testTx = {
        id: 'txn_cashier_test_001',
        merchantId: merchantA.id,
        linkId: null,
        amount: 850,
        amountType: 'fixed',
        customerName: 'Rohit Sharma',
        customerPhone: '9123456789',
        reference: 'SP_CASHIER_850',
        status: 'pending',
        evidenceStatus: 'unverified_evidence',
        createdAt: new Date().toISOString()
      };
      repository.transactions.create(testTx);

      // 2. Companion App reports payment notification using the scoped cashierApiKey and cashierId
      const testUtr = '432198765432';
      const webhookRes = await fetch(`${baseUrl}/api/v1/webhook/verify-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': companionPairingResult.cashierApiKey
        },
        body: JSON.stringify({
          amount: 850,
          utr: testUtr,
          customerUpi: 'rohit@okaxis',
          cashierId: sessionData.cashierId,
          timestamp: new Date().toISOString()
        })
      });

      assert.strictEqual(webhookRes.status, 200, 'Webhook returns HTTP 200');
      const webhookData = await webhookRes.json();
      assert.strictEqual(webhookData.verified, true, 'Payment is verified');

      // Check updated transaction in DB
      const updatedTx = repository.transactions.findById(testTx.id);
      assert.strictEqual(updatedTx.status, 'success', 'Transaction status is updated to success');
      assert.strictEqual(updatedTx.utr, testUtr, 'UTR is attached');
      assert.strictEqual(updatedTx.verifiedBy, 'android-companion', 'Verified by android-companion');
      assert.strictEqual(updatedTx.cashierId, sessionData.cashierId, 'Transaction is attributed to cashier device');

      pass('Companion App with cashier credentials auto-verifies pending transaction with cashierId attribution');
    }

    // --------------------------------------------------------------------------
    // Section 9: Settlement Truth Principle (No False Success)
    // --------------------------------------------------------------------------
    console.log('\n--- Section 9: Strict Settlement Truth Enforcement ---');

    {
      // Create pending transaction for 1200 where customer claimed UTR 998877665544
      const testTx = {
        id: 'txn_truth_test_002',
        merchantId: merchantA.id,
        linkId: null,
        amount: 1200,
        amountType: 'fixed',
        reference: 'SP_TRUTH_1200',
        utr: '998877665544',
        status: 'pending',
        createdAt: new Date().toISOString()
      };
      repository.transactions.create(testTx);

      // Webhook notification arrives with MISMATCHED amount 1100
      const mismatchRes = await fetch(`${baseUrl}/api/v1/webhook/verify-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': companionPairingResult.cashierApiKey
        },
        body: JSON.stringify({
          amount: 1100,
          utr: '998877665544',
          cashierId: sessionData.cashierId
        })
      });

      assert.strictEqual(mismatchRes.status, 200);
      const mismatchData = await mismatchRes.json();
      assert.strictEqual(mismatchData.verified, false, 'Mismatched payment must NOT be marked verified');

      const txAfter = repository.transactions.findById(testTx.id);
      assert.strictEqual(txAfter.status, 'pending', 'Pending transaction strictly remains pending');

      pass('Settlement truth: Mismatched amounts never falsely mark transactions as success');
    }

    // --------------------------------------------------------------------------
    // Section 10: Cashier Revocation
    // --------------------------------------------------------------------------
    console.log('\n--- Section 10: Cashier Revocation ---');

    {
      const res = await fetch(`${baseUrl}/api/cashier/${sessionData.cashierId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${tokenA}` }
      });
      assert.strictEqual(res.status, 200, 'Revoke cashier returns HTTP 200');
      const data = await res.json();
      assert.strictEqual(data.ok, true);

      const dbCashier = repository.cashiers.findById(sessionData.cashierId);
      assert.strictEqual(dbCashier.status, 'revoked', 'Cashier status updated to revoked');

      pass('DELETE /api/cashier/:id securely revokes cashier and logs audit trail');
    }

    console.log('\n==============================================================================');
    console.log(`SUITE COMPLETE: ${passed} / ${total} TESTS PASSED`);
    console.log('==============================================================================');
  } catch (err) {
    fail('Unexpected exception during cashier suite run', err);
  } finally {
    server.close();
    try { if (fs.existsSync('temp_test_cashier.db')) fs.unlinkSync('temp_test_cashier.db'); } catch {}
    try { if (fs.existsSync('temp_test_cashier_data.json')) fs.unlinkSync('temp_test_cashier_data.json'); } catch {}
  }
}

server.listen(0, '127.0.0.1', () => {
  runTests();
});
