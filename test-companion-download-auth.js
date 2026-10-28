'use strict';

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SAKKUPAY_TOKEN_SECRET = 'test-token-secret-for-auth-verification-minimum-32-chars';
process.env.DATA_FILE = 'temp_test_companion_data.json';
process.env.DB_PATH = 'temp_test_companion.db';

const { server, db, repository, token } = require('./server');

async function runTests() {
  console.log('==============================================================================');
  console.log('SakkuPay Companion APK Download & Authorization Test Suite');
  console.log('==============================================================================');

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log('Live test server running on:', baseUrl);

  // Setup test merchant in disposable repository
  const testMerchant = {
    id: 'mer_test_companion_99',
    businessName: 'Apex Mobile Tech',
    email: 'merchant@apexmobile.in',
    passwordHash: 'dummy_hash',
    createdAt: new Date().toISOString()
  };
  try {
    repository.merchants.create(testMerchant);
  } catch {
    // If table already has it
  }
  const validMerchantToken = token(testMerchant);

  let passed = 0;
  let total = 0;

  function pass(msg) {
    passed++;
    total++;
    console.log(`  ✅ PASSED: ${msg}`);
  }

  function fail(msg, err) {
    total++;
    console.error(`  ❌ FAILED: ${msg}`, err);
    process.exitCode = 1;
  }

  try {
    // Test 1: Status endpoint
    {
      const res = await fetch(`${baseUrl}/api/companion/status`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.available, true);
      assert.strictEqual(data.packageName, 'in.sakkupay.companion');
      assert.strictEqual(data.version, '1.0');
      assert.strictEqual(data.filename, 'sakkupay.apk');
      assert(data.sizeBytes > 1000000, 'Size should be > 1MB');
      pass('GET /api/companion/status reports available: true, package in.sakkupay.companion, filename sakkupay.apk, and valid size');
    }

    // Test 2: Unauthenticated download is strictly blocked
    {
      const res = await fetch(`${baseUrl}/api/companion/download`);
      assert.strictEqual(res.status, 401, 'Unauthenticated download must return HTTP 401');
      const data = await res.json();
      assert.strictEqual(data.error, 'Unauthorized');
      pass('GET /api/companion/download without token returns HTTP 401 Unauthorized');
    }

    // Test 3: Download with invalid token is strictly blocked
    {
      const res = await fetch(`${baseUrl}/api/companion/download`, {
        headers: { 'Authorization': 'Bearer fake_invalid_token_12345' }
      });
      assert.strictEqual(res.status, 401, 'Invalid token must return HTTP 401');
      pass('GET /api/companion/download with invalid token returns HTTP 401 Unauthorized');
    }

    // Test 4: Download with valid merchant token succeeds
    {
      const res = await fetch(`${baseUrl}/api/companion/download`, {
        headers: { 'Authorization': `Bearer ${validMerchantToken}` }
      });
      assert.strictEqual(res.status, 200, 'Authenticated download must return HTTP 200');
      assert.strictEqual(res.headers.get('content-type'), 'application/vnd.android.package-archive');
      assert(res.headers.get('content-disposition').includes('sakkupay.apk'));
      assert.strictEqual(res.headers.get('cache-control'), 'private, no-cache, no-store, must-revalidate');

      const arrayBuf = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      assert.strictEqual(buf.length, 1734515, 'Buffer size must match exact APK size');
      assert.strictEqual(buf.slice(0, 4).toString('utf8'), 'PK\x03\x04', 'Buffer starts with APK/Zip header PK\\x03\\x04');
      pass('GET /api/companion/download with valid merchant token serves binary APK with attachment filename sakkupay.apk');
    }

    // Test 5: Direct routes /downloads/sakkupay.apk and /downloads/sakkupay-companion.apk enforce merchant auth
    {
      const resUnauth = await fetch(`${baseUrl}/downloads/sakkupay.apk`);
      assert.strictEqual(resUnauth.status, 401);
      pass('/downloads/sakkupay.apk enforces merchant authentication (HTTP 401 without token)');

      const resAuth = await fetch(`${baseUrl}/downloads/sakkupay.apk`, {
        headers: { 'Authorization': `Bearer ${validMerchantToken}` }
      });
      assert.strictEqual(resAuth.status, 200);
      assert.strictEqual(resAuth.headers.get('content-type'), 'application/vnd.android.package-archive');
      pass('/downloads/sakkupay.apk serves APK when authenticated with valid token');
    }

    // Test 6: HTTP HEAD request delivers valid metadata headers without a body stream
    {
      const res = await fetch(`${baseUrl}/api/companion/download`, {
        method: 'HEAD',
        headers: { 'Authorization': `Bearer ${validMerchantToken}` }
      });
      assert.strictEqual(res.status, 200, 'Authenticated HEAD request must return HTTP 200');
      assert.strictEqual(res.headers.get('content-type'), 'application/vnd.android.package-archive');
      assert.strictEqual(res.headers.get('content-length'), '1734515');
      assert(res.headers.get('content-disposition').includes('sakkupay.apk'));
      const text = await res.text();
      assert.strictEqual(text, '', 'HEAD response body must be empty');
      pass('HEAD /api/companion/download delivers accurate headers with empty body');
    }

    // Test 7: Method Not Allowed for unsupported methods (POST, DELETE)
    {
      const res = await fetch(`${baseUrl}/api/companion/download`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${validMerchantToken}` }
      });
      assert.strictEqual(res.status, 405, 'POST method should return HTTP 405');
      assert.strictEqual(res.headers.get('allow'), 'GET, HEAD');
      pass('POST /api/companion/download returns HTTP 405 Method Not Allowed');
    }

    // Test 8: Missing file returns HTTP 404 when candidate files are absent
    {
      // Temporarily rename both downloads files
      const p1 = path.join(__dirname, 'downloads/sakkupay.apk');
      const p1bak = path.join(__dirname, 'downloads/sakkupay.apk.bak');
      const p2 = path.join(__dirname, 'downloads/sakkupay-companion.apk');
      const p2bak = path.join(__dirname, 'downloads/sakkupay-companion.apk.bak');
      if (fs.existsSync(p1)) fs.renameSync(p1, p1bak);
      if (fs.existsSync(p2)) fs.renameSync(p2, p2bak);

      try {
        const res = await fetch(`${baseUrl}/api/companion/download`, {
          headers: { 'Authorization': `Bearer ${validMerchantToken}` }
        });
        assert.strictEqual(res.status, 404, 'Missing APK must return HTTP 404');
        const data = await res.json();
        assert.strictEqual(data.available, false);
        pass('GET /api/companion/download returns HTTP 404 with available: false when APK missing');
      } finally {
        if (fs.existsSync(p1bak)) fs.renameSync(p1bak, p1);
        if (fs.existsSync(p2bak)) fs.renameSync(p2bak, p2);
      }
    }

    console.log('==============================================================================');
    console.log(`SUITE COMPLETE: ${passed} / ${total} PASSED`);
    console.log('==============================================================================');
  } catch (err) {
    fail('Unexpected exception during test run', err);
  } finally {
    server.close();
    // Clean up temp test database and json
    try { if (fs.existsSync('temp_test_companion.db')) fs.unlinkSync('temp_test_companion.db'); } catch {}
    try { if (fs.existsSync('temp_test_companion_data.json')) fs.unlinkSync('temp_test_companion_data.json'); } catch {}
  }
}

server.listen(0, '127.0.0.1', () => {
  runTests();
});
