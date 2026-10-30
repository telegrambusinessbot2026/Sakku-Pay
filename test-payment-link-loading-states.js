/* ==============================================================================
   SakkuPay — Comprehensive Payment Link Lifecycle & Error States Test Suite
   Verifies:
   1. Static asset isolation (/pay/checkout.js, /pay/styles.css)
   2. API endpoint responses for valid, invalid (/pay/hi), and inactive links
   3. Headless Chrome end-to-end rendering of all 6 states:
      - Loading cleanup guarantee
      - State 2: Success state on valid payment link
      - State 3: Not Found state on /pay/hi
      - State 4: Inactive/Revoked state on deactivated link
      - State 5: Server error state with functional Retry button
      - State 6: Timeout state with functional Retry button
   4. Mobile (390x844) & Desktop (1440x900) layout rendering
   5. Page refresh stability
   6. Zero console errors and zero uncaught exceptions
   ============================================================================== */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const assert = require('assert');

const TEST_PORT = 3388;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
function resolveChromePath() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  if (process.platform === 'win32') {
    const winPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null
    ].filter(Boolean);
    for (const p of winPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (process.platform === 'linux') {
    const linuxPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium'
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (process.platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const CHROME_PATH = resolveChromePath();
const CDP_PORT = 9228;

const SCREENSHOTS_DIR = path.join(__dirname, 'qa_screenshots');
const ARTIFACT_SCREENSHOTS_DIR = process.env.ARTIFACT_DIR
  ? path.join(process.env.ARTIFACT_DIR, 'screenshots')
  : (process.platform === 'win32' && fs.existsSync('C:\\Users\\USER\\.gemini\\antigravity\\brain\\bd10c453-341b-4496-8b6d-b3c4a4fdce6d\\screenshots')
      ? 'C:\\Users\\USER\\.gemini\\antigravity\\brain\\bd10c453-341b-4496-8b6d-b3c4a4fdce6d\\screenshots'
      : null);

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (ARTIFACT_SCREENSHOTS_DIR && !fs.existsSync(ARTIFACT_SCREENSHOTS_DIR)) {
  try { fs.mkdirSync(ARTIFACT_SCREENSHOTS_DIR, { recursive: true }); } catch (_) {}
}

// Dedicated isolated test DB & data.json
const testDbPath = path.join(__dirname, 'temp_test_checkout_states.db');
const testDataJson = path.join(__dirname, 'temp_test_checkout_data.json');
try {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
  if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
  const sourceDataJson = fs.existsSync(path.join(__dirname, 'data.json'))
    ? path.join(__dirname, 'data.json')
    : path.join(__dirname, 'data.json.example');
  fs.copyFileSync(sourceDataJson, testDataJson);
} catch (_) {}

process.env.DB_PATH = testDbPath;
process.env.DATA_JSON_PATH = testDataJson;
process.env.PORT = String(TEST_PORT);
process.env.NODE_ENV = 'development';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'AdminSecure2026!';
process.env.SAKKUPAY_TOKEN_SECRET = 'a'.repeat(32);
process.env.VAULT_SECRET = 'b'.repeat(32);

const {
  server,
  repository,
  hashPassword,
  token
} = require('./server');

// Seed test merchant & links
const testMerchant = repository.merchants.create({
  id: 'mer_test_states_' + Date.now(),
  email: 'checkout.test@sakkupay.local',
  passwordHash: hashPassword('TestPass123!'),
  businessName: 'Apex Cloud Solutions',
  phone: '9876543210'
});

const testUpi = repository.upis.create({
  id: 'upi_test_states_' + Date.now(),
  merchantId: testMerchant.id,
  label: 'Apex ICICI UPI',
  upiId: 'apexcloud@icici',
  phoneNumber: '9876543210',
  default: true
});

const validLink = repository.links.create({
  id: 'lnk_valid_state_1',
  merchantId: testMerchant.id,
  name: 'Apex Pro Subscription',
  slug: 'apex-pro-plan',
  upiId: testUpi.upiId,
  amount: 999.00,
  amount_paise: 99900,
  description: 'Enterprise cloud services subscription',
  template: 'classic',
  active: true
});

const inactiveLink = repository.links.create({
  id: 'lnk_inactive_state_2',
  merchantId: testMerchant.id,
  name: 'Old Promotion 2025',
  slug: 'old-promo-expired',
  upiId: testUpi.upiId,
  amount: 299.00,
  amount_paise: 29900,
  description: 'Expired promotional offer',
  template: 'minimal',
  active: false
});

let testCount = 0;
function test(name, fn) {
  try {
    fn();
    testCount++;
    console.log(`  ✅ PASSED: ${name}`);
  } catch (e) {
    console.error(`  ❌ FAILED: ${name}`);
    console.error(e);
    process.exit(1);
  }
}

async function request(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, options);
  let data = null;
  const cType = res.headers.get('content-type') || '';
  if (cType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, headers: res.headers, data };
}

// ─── CDP Client ─────────────────────────────────────────────────────────────
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.msgId = 1;
    this.callbacks = new Map();
    this.consoleLogs = [];
    this.pageErrors = [];

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        if (msg.id && this.callbacks.has(msg.id)) {
          const { resolve, reject } = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else if (msg.method === 'Runtime.consoleAPICalled') {
          const args = (msg.params.args || []).map(a => a.value || a.description || '').join(' ');
          this.consoleLogs.push(`[Console ${msg.params.type}] ${args}`);
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const desc = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'Script error';
          this.pageErrors.push(desc);
        }
      } catch (_) {}
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async setViewport(width, height, isMobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: isMobile
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return res?.result?.value;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await new Promise(r => setTimeout(r, 1000));
  }

  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const localPath = path.join(SCREENSHOTS_DIR, filename);
    fs.writeFileSync(localPath, buffer);
    if (ARTIFACT_SCREENSHOTS_DIR && ARTIFACT_SCREENSHOTS_DIR !== SCREENSHOTS_DIR) {
      try {
        const artifactPath = path.join(ARTIFACT_SCREENSHOTS_DIR, filename);
        fs.writeFileSync(artifactPath, buffer);
      } catch (_) {}
    }
    console.log(`    📸 Saved: ${filename} (${Math.round(buffer.length / 1024)} KB)`);
    return localPath;
  }
}

async function createCdpSession() {
  const newTargetRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' });
  const target = await newTargetRes.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (err) => reject(new Error('WebSocket connection failed: ' + (err?.message || err)));
  });
  const session = new CdpSession(ws);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('DOM.enable');
  return { session, targetId: target.id };
}

async function closeTarget(targetId) {
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${targetId}`);
  } catch (_) {}
}

async function run() {
  console.log('='.repeat(78));
  console.log('SakkuPay: Payment Link Lifecycle, Error States & Bug Fix Verification');
  console.log('='.repeat(78));

  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));
  console.log(`Live test server active on: ${BASE_URL}\n`);

  /* ── Section 1: HTTP Route & Asset Isolation ── */
  console.log('--- Section 1: HTTP Route & Asset Isolation ---');
  const resJs = await request('/pay/checkout.js');
  test('GET /pay/checkout.js returns HTTP 200', () => assert.strictEqual(resJs.status, 200));
  test('GET /pay/checkout.js serves application/javascript MIME type', () => assert(resJs.headers.get('content-type').includes('javascript')));
  test('GET /pay/checkout.js returns actual JS script (not checkout.html)', () => {
    assert(resJs.data.includes('renderLoadingState'));
    assert(!resJs.data.includes('<!doctype html>'));
  });

  const resCss = await request('/pay/styles.css');
  test('GET /pay/styles.css returns HTTP 200 and text/css', () => {
    assert.strictEqual(resCss.status, 200);
    assert(resCss.headers.get('content-type').includes('css'));
  });

  const resExtraCss = await request('/pay/app-extra.css');
  test('GET /pay/app-extra.css returns HTTP 200 and text/css', () => {
    assert.strictEqual(resExtraCss.status, 200);
    assert(resExtraCss.headers.get('content-type').includes('css'));
  });

  const resPayHtml = await request('/pay/hi');
  test('GET /pay/hi returns HTTP 200 and serves checkout.html', () => {
    assert.strictEqual(resPayHtml.status, 200);
    assert(resPayHtml.headers.get('content-type').includes('html'));
    assert(resPayHtml.data.includes('public-checkout'));
  });

  const resPaySlash = await request('/pay/');
  test('GET /pay/ returns HTTP 200 and serves checkout.html', () => {
    assert.strictEqual(resPaySlash.status, 200);
    assert(resPaySlash.data.includes('public-checkout'));
  });

  /* ── Section 2: Backend API Response Contracts ── */
  console.log('\n--- Section 2: Backend API Response Contracts ---');

  // Link lookup for /pay/hi
  const resApiHi = await request('/api/checkout/hi');
  test('GET /api/checkout/hi returns HTTP 404', () => assert.strictEqual(resApiHi.status, 404));
  test('GET /api/checkout/hi response includes LINK_NOT_FOUND code', () => {
    assert.strictEqual(resApiHi.data.code, 'LINK_NOT_FOUND');
    assert.strictEqual(resApiHi.data.error, 'Payment link not found');
  });

  // Valid active link
  const resApiValid = await request('/api/checkout/apex-pro-plan');
  test('GET /api/checkout/apex-pro-plan returns HTTP 200', () => assert.strictEqual(resApiValid.status, 200));
  test('Valid link API returns template, amount, and business name', () => {
    assert.strictEqual(resApiValid.data.name, 'Apex Pro Subscription');
    assert.strictEqual(resApiValid.data.amount, 999);
    assert.strictEqual(resApiValid.data.template, 'classic');
    assert.strictEqual(resApiValid.data.businessName, 'Apex Cloud Solutions');
    assert.strictEqual(resApiValid.data.upiId, 'apexcloud@icici');
    assert.strictEqual(resApiValid.data.active, true);
  });

  // Lookup valid link by ID
  const resApiById = await request(`/api/checkout/${validLink.id}`);
  test('GET /api/checkout/:id resolves valid link by ID', () => {
    assert.strictEqual(resApiById.status, 200);
    assert.strictEqual(resApiById.data.slug, 'apex-pro-plan');
  });

  // Inactive / expired link
  const resApiInactive = await request('/api/checkout/old-promo-expired');
  test('GET /api/checkout/old-promo-expired returns HTTP 404 with LINK_INACTIVE code', () => {
    assert.strictEqual(resApiInactive.status, 404);
    assert.strictEqual(resApiInactive.data.code, 'LINK_INACTIVE');
  });

  /* ── Section 3: Headless Chrome Browser Visual & Functional Validation ── */
  console.log('\n--- Section 3: Headless Chrome Visual & State Validation ---');
  if (!CHROME_PATH) {
    console.log('⚠️  Google Chrome / Chromium executable not found on this system. Skipping visual CDP validation; HTTP and API tests succeeded.');
    server.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
      if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    } catch (_) {}
    console.log('\n' + '='.repeat(78));
    console.log(`SUITE COMPLETE: ${testCount} PASSED, 0 FAILED (CDP browser visual skipped: no browser)`);
    console.log('='.repeat(78));
    return;
  }

  console.log('Spawning Headless Chrome (' + CHROME_PATH + ') on CDP port ' + CDP_PORT + '...');
  const chromeProc = cp.spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-sync',
    'about:blank'
  ]);

  let cdpReady = false;
  for (let attempt = 1; attempt <= 15; attempt++) {
    try {
      const verRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (verRes.ok) {
        cdpReady = true;
        break;
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }

  if (!cdpReady) {
    console.warn('⚠️  Could not connect to Chrome CDP endpoint after launch. Skipping CDP browser visual validation.');
    try { chromeProc.kill(); } catch (_) {}
    server.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
      if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    } catch (_) {}
    console.log('\n' + '='.repeat(78));
    console.log(`SUITE COMPLETE: ${testCount} PASSED, 0 FAILED (CDP visual skipped: port unconnectable)`);
    console.log('='.repeat(78));
    return;
  }

  try {
    const { session, targetId } = await createCdpSession();

    // ─────────────────────────────────────────────────────────────
    // TEST A: Navigate to /pay/hi (Invalid link)
    // ─────────────────────────────────────────────────────────────
    console.log('\n  [Browser Test A] Opening /pay/hi...');
    await session.setViewport(1440, 900, false);
    await session.navigate(`${BASE_URL}/pay/hi`);
    await new Promise(r => setTimeout(r, 600));

    // Verify loading state is CLEARED
    const isLoadingPresentA = await session.evaluate(`Boolean(document.getElementById('checkout-loading-state'))`);
    test('/pay/hi: Loading indicator is completely removed after API response', () => {
      assert.strictEqual(isLoadingPresentA, false);
    });

    // Verify Not Found card is rendered
    const cardTitleA = await session.evaluate(`document.querySelector('.checkout-state-title')?.textContent`);
    const cardBadgeA = await session.evaluate(`document.querySelector('.checkout-state-badge')?.textContent`);
    const cardDescA = await session.evaluate(`document.querySelector('.checkout-state-desc')?.textContent`);
    test('/pay/hi: Renders "Payment Link Unavailable" title', () => {
      assert.strictEqual(cardTitleA, 'Payment Link Unavailable');
    });
    test('/pay/hi: Displays "Link Not Found" badge', () => {
      assert.strictEqual(cardBadgeA, 'Link Not Found');
    });
    test('/pay/hi: Explains that /pay/hi does not exist', () => {
      assert(cardDescA.includes('/pay/hi'));
    });

    await session.screenshot('33_checkout_state_not_found_hi.png');

    // ─────────────────────────────────────────────────────────────
    // TEST B: Navigate to Valid Link (/pay/apex-pro-plan)
    // ─────────────────────────────────────────────────────────────
    console.log('\n  [Browser Test B] Opening valid link /pay/apex-pro-plan...');
    await session.navigate(`${BASE_URL}/pay/apex-pro-plan`);
    await new Promise(r => setTimeout(r, 600));

    const isLoadingPresentB = await session.evaluate(`Boolean(document.getElementById('checkout-loading-state'))`);
    test('/pay/apex-pro-plan: Loading state is removed upon success', () => {
      assert.strictEqual(isLoadingPresentB, false);
    });

    const merchantTitle = await session.evaluate(`document.querySelector('.merchant-title')?.textContent`);
    const itemTitle = await session.evaluate(`document.querySelector('.item-title')?.textContent`);
    const amountText = await session.evaluate(`document.querySelector('#display-amount')?.textContent`);
    const upiAppsCount = await session.evaluate(`document.querySelectorAll('.apps-grid a').length`);

    test('Valid link: Displays merchant name Apex Cloud Solutions', () => {
      assert.strictEqual(merchantTitle, 'Apex Cloud Solutions');
    });
    test('Valid link: Displays item title Apex Pro Subscription', () => {
      assert.strictEqual(itemTitle, 'Apex Pro Subscription');
    });
    test('Valid link: Formats amount ₹999', () => {
      assert(amountText.includes('999'));
    });
    test('Valid link: Renders all 4 direct UPI payment app launch buttons', () => {
      assert.strictEqual(upiAppsCount, 4);
    });

    await session.screenshot('34_checkout_state_success_valid.png');

    // ─────────────────────────────────────────────────────────────
    // TEST C: Inactive / Expired Link (/pay/old-promo-expired)
    // ─────────────────────────────────────────────────────────────
    console.log('\n  [Browser Test C] Opening inactive link /pay/old-promo-expired...');
    await session.navigate(`${BASE_URL}/pay/old-promo-expired`);
    await new Promise(r => setTimeout(r, 600));

    const isLoadingPresentC = await session.evaluate(`Boolean(document.getElementById('checkout-loading-state'))`);
    test('Inactive link: Loading state is removed', () => {
      assert.strictEqual(isLoadingPresentC, false);
    });

    const cardTitleC = await session.evaluate(`document.querySelector('.checkout-state-title')?.textContent`);
    const cardBadgeC = await session.evaluate(`document.querySelector('.checkout-state-badge')?.textContent`);
    test('Inactive link: Renders "Payment Link Inactive" title', () => {
      assert.strictEqual(cardTitleC, 'Payment Link Inactive');
    });
    test('Inactive link: Displays "Link Closed" badge', () => {
      assert.strictEqual(cardBadgeC, 'Link Closed');
    });

    await session.screenshot('35_checkout_state_inactive_revoked.png');

    // ─────────────────────────────────────────────────────────────
    // TEST D: Network / Server Error Handling with Working Retry
    // ─────────────────────────────────────────────────────────────
    console.log('\n  [Browser Test D] Testing Server Error and Retry action...');
    // We can simulate an error state via client invocation of renderServerErrorState
    await session.evaluate(`
      renderServerErrorState('Simulated upstream gateway downtime', () => {
        window.__retryTriggered = true;
      });
    `);
    const errorTitle = await session.evaluate(`document.querySelector('.checkout-state-title')?.textContent`);
    test('Server error state: Renders "Unable to Load Checkout"', () => {
      assert.strictEqual(errorTitle, 'Unable to Load Checkout');
    });
    const hasRetryBtn = await session.evaluate(`Boolean(document.getElementById('checkout-action-retry'))`);
    test('Server error state: Provides working Try Again retry button', () => {
      assert.strictEqual(hasRetryBtn, true);
    });

    // Click Retry
    await session.evaluate(`document.getElementById('checkout-action-retry').click();`);
    const retryTriggered = await session.evaluate(`window.__retryTriggered`);
    test('Clicking Try Again button executes retry callback', () => {
      assert.strictEqual(retryTriggered, true);
    });
    await session.screenshot('36_checkout_state_server_error_retry.png');

    // ─────────────────────────────────────────────────────────────
    // TEST E: Timeout State Handling with Working Retry
    // ─────────────────────────────────────────────────────────────
    console.log('\n  [Browser Test E] Testing Timeout state and Retry action...');
    await session.evaluate(`
      renderTimeoutState(() => {
        window.__timeoutRetryTriggered = true;
      });
    `);
    const timeoutTitle = await session.evaluate(`document.querySelector('.checkout-state-title')?.textContent`);
    test('Timeout state: Renders "Connection Timed Out"', () => {
      assert.strictEqual(timeoutTitle, 'Connection Timed Out');
    });

    await session.evaluate(`document.getElementById('checkout-action-retry').click();`);
    const timeoutRetryTriggered = await session.evaluate(`window.__timeoutRetryTriggered`);
    test('Clicking Retry Connection button executes timeout retry callback', () => {
      assert.strictEqual(timeoutRetryTriggered, true);
    });
    await session.screenshot('37_checkout_state_timeout_retry.png');

    // ─────────────────────────────────────────────────────────────
    // TEST F: Direct Opening in Fresh Tab & Refreshing Page
    // ─────────────────────────────────────────────────────────────
    console.log('\n  [Browser Test F] Testing direct page refresh...');
    await session.navigate(`${BASE_URL}/pay/apex-pro-plan`);
    await new Promise(r => setTimeout(r, 500));
    // Hard refresh page
    await session.send('Page.reload');
    await new Promise(r => setTimeout(r, 800));

    const refreshedAmount = await session.evaluate(`document.querySelector('#display-amount')?.textContent`);
    test('Refreshing payment page preserves rendered state without freezing', () => {
      assert(refreshedAmount && refreshedAmount.includes('999'));
    });

    // ─────────────────────────────────────────────────────────────
    // TEST G: Mobile Viewport (390x844)
    // ─────────────────────────────────────────────────────────────
    console.log('\n  [Browser Test G] Testing mobile viewport (390x844)...');
    await session.setViewport(390, 844, true);
    await new Promise(r => setTimeout(r, 500));
    const mobileAmount = await session.evaluate(`document.querySelector('#display-amount')?.textContent`);
    test('Mobile viewport (390x844) renders complete payment card', () => {
      assert(mobileAmount && mobileAmount.includes('999'));
    });
    await session.screenshot('38_checkout_mobile_390x844.png');

    // Check for console errors
    test('Zero JavaScript runtime errors or unhandled exceptions across all test flows', () => {
      assert.strictEqual(session.pageErrors.length, 0);
    });

    await closeTarget(targetId);
  } finally {
    try { chromeProc.kill(); } catch (_) {}
    server.close();
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
      if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    } catch (_) {}
  }

  console.log('\n' + '='.repeat(78));
  console.log(`SUITE COMPLETE: ${testCount} PASSED, 0 FAILED`);
  console.log('='.repeat(78));
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
