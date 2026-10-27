/* ==============================================================================
   SakkuPay Staging Instance Live Operational Verification
   Starts an isolated staging server instance on port 3001 with staging DB,
   tests page serving, authentication, admin health, and clean shutdown.
   ============================================================================== */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

const STAGING_PORT = 3001;
const BASE_URL = `http://127.0.0.1:${STAGING_PORT}`;

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

    const req = http.request(url, reqOptions, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
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

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function runStagingVerification() {
  console.log('========================================================================');
  console.log('STAGING INSTANCE OPERATIONAL VERIFICATION');
  console.log('========================================================================\n');

  // Launch staging instance with staging environment variables
  const stagingEnv = {
    ...process.env,
    NODE_ENV: 'staging',
    PORT: String(STAGING_PORT),
    DB_PATH: path.join(__dirname, 'sakkupay_staging.db'),
    DATA_JSON_PATH: path.join(__dirname, 'data.json'),
    SAKKUPAY_TOKEN_SECRET: 'staging-token-secret-f9b8c2d4e6a01735bc8f2a4e6c8b0d2e4f6a8c0e2d4b6a8c',
    VAULT_SECRET: 'staging-vault-secret-7a1b3c5e9d2f4a6b8c0e2d4f6a8b0c2e4f6a8b0c2d4e6f8a',
    ADMIN_USERNAME: 'staging_admin',
    ADMIN_PASSWORD: (fs.readFileSync(path.join(__dirname, '.env.staging'), 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)?.[1] || process.env.ADMIN_PASSWORD),
    TRUST_PROXY: 'true'
  };

  console.log(`Starting staging instance on ${BASE_URL}...`);
  const child = cp.spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: stagingEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', d => console.log(`[Staging Server STDOUT] ${d.toString().trim()}`));
  child.stderr.on('data', d => console.error(`[Staging Server STDERR] ${d.toString().trim()}`));

  // Wait for server to be ready
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    try {
      const res = await request('/home.html');
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch (_) {}
  }

  if (!ready) {
    child.kill('SIGKILL');
    throw new Error('Staging instance failed to start within timeout window');
  }

  console.log('  ✅ Staging server ready and responding.');

  let passed = 0;
  function assert(cond, msg) {
    if (cond) {
      passed++;
      console.log(`  ✅ PASSED: ${msg}`);
    } else {
      console.error(`  ❌ FAILED: ${msg}`);
      throw new Error(`Assertion failed: ${msg}`);
    }
  }

  try {
    // 1. Verify Public HTML Pages
    console.log('\n--- 1. Public & Customer Checkout Pages ---');
    const resHome = await request('/');
    assert(resHome.status === 200, 'Landing page (GET /) serves HTTP 200');

    const resLogin = await request('/login');
    assert(resLogin.status === 200, 'Login page (GET /login) serves HTTP 200');

    const resPay = await request('/pay/beta-test-order');
    assert(resPay.status === 200, 'Checkout page (GET /pay/beta-test-order) serves HTTP 200');

    const resAdmin = await request('/admin');
    assert(resAdmin.status === 200, 'Admin portal (GET /admin) serves HTTP 200');

    // 2. Verify Staging Admin Authentication
    console.log('\n--- 2. Staging Admin Authentication ---');
    const resLoginFail = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'staging_admin', password: 'intentionally-incorrect-password' }
    });
    assert(resLoginFail.status === 401, 'Invalid admin password rejected (HTTP 401)');

    const resLoginSuccess = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'staging_admin', password: stagingEnv.ADMIN_PASSWORD }
    });
    assert(resLoginSuccess.status === 200, 'Valid staging admin login returns HTTP 200');
    assert(typeof resLoginSuccess.data.token === 'string', 'Admin login returns valid JWT token');
    const adminToken = resLoginSuccess.data.token;

    // 3. Verify Admin System Health & Database Isolation
    console.log('\n--- 3. Admin Health & Isolation Verification ---');
    const resHealth = await request('/api/admin/system/health', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(resHealth.status === 200, 'Admin system health (GET /api/admin/system/health) returns HTTP 200');
    assert(resHealth.data.database.journalMode === 'wal', 'Staging database journal mode is WAL');
    assert(resHealth.data.database.foreignKeys === true, 'Staging foreign key enforcement is active');
    console.log('  Staging Health Table Counts:', resHealth.data.database.tableCounts);
    assert(resHealth.data.database.tableCounts.merchants >= 1, 'Staging isolated database reports synthetic merchants present');
    assert(resHealth.data.database.tableCounts.transactions >= 2, 'Staging isolated database reports synthetic transactions present');

    // 4. Verify Merchant Directory API
    console.log('\n--- 4. Merchant Management API ---');
    const resMerchants = await request('/api/admin/users', {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert(resMerchants.status === 200, 'Admin merchants directory (GET /api/admin/users) returns HTTP 200');
    assert(Array.isArray(resMerchants.data) && resMerchants.data.length >= 1, 'Synthetic merchants present in staging directory');
    assert(resMerchants.data.some(m => m.businessName === 'Staging Beta Retailer'), 'Merchant name matches synthetic beta retailer');

    // 5. Verify Clean Graceful Shutdown
    console.log('\n--- 5. Graceful Process Shutdown ---');
    const exitPromise = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const exitResult = await exitPromise;
    console.log(`  Staging server exited with code: ${exitResult.code}, signal: ${exitResult.signal}`);
    assert(exitResult.code === 0 || exitResult.signal === 'SIGTERM', 'Staging instance shut down cleanly via SIGTERM');

    console.log('\n' + '='.repeat(78));
    console.log(`STAGING OPERATIONAL VERIFICATION COMPLETE: ALL ${passed} ASSERTIONS PASSED`);
    console.log('='.repeat(78));

  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
}

runStagingVerification().catch(err => {
  console.error('Staging verification error:', err);
  process.exit(1);
});
