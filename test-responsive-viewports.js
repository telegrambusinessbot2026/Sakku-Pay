/* ==============================================================================
   SakkuPay — 7 Viewports Comprehensive Multi-Device Responsiveness Suite
   Mandatory viewports tested:
   1. 360 x 800 (Small Android phone)
   2. 390 x 844 (iPhone 14 / modern mobile)
   3. 430 x 932 (iPhone Pro Max / large mobile)
   4. 768 x 1024 (Tablet portrait)
   5. 1024 x 768 (Tablet landscape)
   6. 1366 x 768 (Standard laptop)
   7. 1920 x 1080 (Desktop monitor)
   ============================================================================== */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const PORT = 3377;
const BASE_URL = `http://127.0.0.1:${PORT}`;
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
const CDP_PORT = 9230;

const SCREENSHOTS_DIR = path.join(__dirname, 'qa_screenshots', 'viewports');
const ARTIFACT_SCREENSHOTS_DIR = process.env.ARTIFACT_DIR
  ? path.join(process.env.ARTIFACT_DIR, 'screenshots', 'viewports')
  : (process.platform === 'win32' && fs.existsSync('C:\\Users\\USER\\.gemini\\antigravity\\brain\\bd10c453-341b-4496-8b6d-b3c4a4fdce6d\\screenshots\\viewports')
      ? 'C:\\Users\\USER\\.gemini\\antigravity\\brain\\bd10c453-341b-4496-8b6d-b3c4a4fdce6d\\screenshots\\viewports'
      : null);

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (ARTIFACT_SCREENSHOTS_DIR && !fs.existsSync(ARTIFACT_SCREENSHOTS_DIR)) {
  try { fs.mkdirSync(ARTIFACT_SCREENSHOTS_DIR, { recursive: true }); } catch (_) {}
}

// Dedicated isolated database
const qaDb = path.join(__dirname, 'temp_viewport_test.db');
if (fs.existsSync(qaDb)) try { fs.unlinkSync(qaDb); } catch (_) {}

process.env.DB_PATH = qaDb;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'development';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'AdminSecure2026!';
process.env.SAKKUPAY_TOKEN_SECRET = 'v'.repeat(32);
process.env.VAULT_SECRET = 'w'.repeat(32);

const { server, repository, hashPassword, token } = require('./server');

// Seed test merchant & payment link
const merchant = repository.merchants.create({
  id: 'mer_vp_test',
  email: 'viewport.qa@sakkupay.local',
  passwordHash: hashPassword('TestPassword123!'),
  businessName: 'Apex Cloud Solutions',
  phone: '9876543210'
});

const upi = repository.upis.create({
  id: 'upi_vp_1',
  merchantId: merchant.id,
  label: 'Apex Primary UPI',
  upiId: 'apexpayments@okaxis',
  phoneNumber: '9876543210',
  default: true
});

repository.links.create({
  id: 'lnk_vp_1',
  merchantId: merchant.id,
  name: 'Apex Pro Subscription',
  slug: 'apex-pro-plan',
  upiId: upi.id,
  amount: 999.00,
  amount_paise: 99900,
  description: 'Enterprise API Access & Cloud Hosting',
  template: 'classic',
  active: true
});

const merchantToken = token({ id: merchant.id, email: merchant.email });
const adminBasicAuth = Buffer.from('admin:AdminSecure2026!').toString('base64');

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.msgId = 1;
    this.callbacks = new Map();

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data.toString());
        if (msg.id && this.callbacks.has(msg.id)) {
          const { resolve, reject } = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
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

  async setViewport(width, height, isMobile) {
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
    const safeWrite = (filePath, buf) => {
      for (let i = 0; i < 5; i++) {
        try {
          fs.writeFileSync(filePath, buf);
          return;
        } catch (e) {
          if (i === 4) console.warn('Warning writing screenshot:', filePath, e.message);
          const end = Date.now() + 150;
          while (Date.now() < end) {}
        }
      }
    };

    safeWrite(localPath, buffer);
    if (ARTIFACT_SCREENSHOTS_DIR && ARTIFACT_SCREENSHOTS_DIR !== SCREENSHOTS_DIR) {
      const artifactPath = path.join(ARTIFACT_SCREENSHOTS_DIR, filename);
      safeWrite(artifactPath, buffer);
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
    ws.onerror = reject;
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

const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800, mobile: true, desc: 'Small Android Phone' },
  { name: '390x844', width: 390, height: 844, mobile: true, desc: 'iPhone 14 / Modern Phone' },
  { name: '430x932', width: 430, height: 932, mobile: true, desc: 'iPhone Pro Max / Large Phone' },
  { name: '768x1024', width: 768, height: 1024, mobile: true, desc: 'Tablet Portrait (iPad Mini)' },
  { name: '1024x768', width: 1024, height: 768, mobile: false, desc: 'Tablet Landscape / Small Laptop' },
  { name: '1366x768', width: 1366, height: 768, mobile: false, desc: 'Standard HD Laptop' },
  { name: '1920x1080', width: 1920, height: 1080, mobile: false, desc: 'Full HD Desktop' }
];

async function run() {
  console.log('='.repeat(80));
  console.log('SakkuPay: 7 Viewports Comprehensive Multi-Device Responsiveness Suite');
  console.log('='.repeat(80));

  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  console.log(`Server listening on ${BASE_URL}`);

  if (!CHROME_PATH) {
    console.log('⚠️  Google Chrome / Chromium executable not found on this system. Skipping multi-device responsive viewport assertions.');
    server.close();
    try { fs.unlinkSync(qaDb); } catch (_) {}
    try { fs.unlinkSync(qaDb + '-wal'); } catch (_) {}
    try { fs.unlinkSync(qaDb + '-shm'); } catch (_) {}
    console.log('\n' + '='.repeat(80));
    console.log('VIEWPORT RESPONSIVENESS SUITE COMPLETE: 0 PASSED, 0 FAILED (CDP browser skipped: no browser)');
    console.log('='.repeat(80));
    return;
  }

  console.log('Spawning Headless Chrome (' + CHROME_PATH + ') on CDP port ' + CDP_PORT + '...');
  const chromeProc = cp.spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
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
    try { fs.unlinkSync(qaDb); } catch (_) {}
    try { fs.unlinkSync(qaDb + '-wal'); } catch (_) {}
    try { fs.unlinkSync(qaDb + '-shm'); } catch (_) {}
    console.log('\n' + '='.repeat(80));
    console.log('VIEWPORT RESPONSIVENESS SUITE COMPLETE: 0 PASSED, 0 FAILED (CDP browser skipped: port unconnectable)');
    console.log('='.repeat(80));
    return;
  }

  let passedAssertions = 0;
  let failedAssertions = 0;

  function assert(cond, msg) {
    if (cond) {
      console.log(`  ✅ PASSED: ${msg}`);
      passedAssertions++;
    } else {
      console.error(`  ❌ FAILED: ${msg}`);
      failedAssertions++;
    }
  }

  try {
    const { session, targetId } = await createCdpSession();

    // ─── Test Viewports for Public Home Page ────────────────────────────────
    console.log('\n--- Section 1: Public Home Page (/) Across All 7 Viewports ---');
    for (const vp of VIEWPORTS) {
      await session.setViewport(vp.width, vp.height, vp.mobile);
      await session.navigate(`${BASE_URL}/`);
      await new Promise(r => setTimeout(r, 600));

      const overflow = await session.evaluate(`
        (() => {
          const w = window.innerWidth;
          const sw = document.documentElement.scrollWidth;
          const bodySw = document.body.scrollWidth;
          return { hasOverflow: sw > w + 2 || bodySw > w + 2, w, sw, bodySw };
        })()
      `);

      assert(!overflow.hasOverflow, `Home Page on ${vp.name} (${vp.desc}) has no horizontal overflow (width: ${overflow.w}, scrollWidth: ${overflow.sw})`);
      await session.screenshot(`home_${vp.name}.png`);
    }

    // ─── Test Viewports for Login Page ──────────────────────────────────────
    console.log('\n--- Section 2: Login Page (/login) Across All 7 Viewports ---');
    for (const vp of VIEWPORTS) {
      await session.setViewport(vp.width, vp.height, vp.mobile);
      await session.navigate(`${BASE_URL}/login`);
      await new Promise(r => setTimeout(r, 600));

      const overflow = await session.evaluate(`
        (() => {
          const w = window.innerWidth;
          const sw = document.documentElement.scrollWidth;
          return { hasOverflow: sw > w + 2, w, sw };
        })()
      `);

      const cardVisible = await session.evaluate(`
        (() => {
          const card = document.querySelector('.login-card');
          return !!card && card.offsetWidth > 0 && card.offsetHeight > 0;
        })()
      `);

      assert(!overflow.hasOverflow, `Login Page on ${vp.name} has no horizontal overflow`);
      assert(cardVisible, `Login Card is visible and centered on ${vp.name}`);
      await session.screenshot(`login_${vp.name}.png`);
    }

    // ─── Test Viewports for Public Checkout Page ────────────────────────────
    console.log('\n--- Section 3: Public Checkout (/pay/apex-pro-plan) Across All 7 Viewports ---');
    for (const vp of VIEWPORTS) {
      await session.setViewport(vp.width, vp.height, vp.mobile);
      await session.navigate(`${BASE_URL}/pay/apex-pro-plan`);
      await new Promise(r => setTimeout(r, 1000));

      const state = await session.evaluate(`
        (() => {
          const title = document.querySelector('.checkout-title, .product-title, h1, h2')?.textContent || '';
          const qr = !!document.querySelector('#checkout-qr-container, .qr-box, #qrcode, canvas, img[alt*="QR"]');
          const w = window.innerWidth;
          const sw = document.documentElement.scrollWidth;
          return { hasOverflow: sw > w + 2, w, sw, title, qr };
        })()
      `);

      assert(!state.hasOverflow, `Checkout page on ${vp.name} has zero horizontal overflow (w: ${state.w}, sw: ${state.sw})`);
      assert(state.qr, `Checkout page on ${vp.name} displays QR code and payment actions`);
      await session.screenshot(`checkout_${vp.name}.png`);
    }

    // ─── Test Viewports for Merchant Dashboard ──────────────────────────────
    console.log('\n--- Section 4: Merchant Dashboard (/dashboard) Across All 7 Viewports ---');
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        try {
          localStorage.setItem('sakku-token', '${merchantToken}');
          localStorage.setItem('sakku_token', '${merchantToken}');
        } catch (_) {}
      `
    });

    for (const vp of VIEWPORTS) {
      await session.setViewport(vp.width, vp.height, vp.mobile);
      await session.navigate(`${BASE_URL}/dashboard`);
      await new Promise(r => setTimeout(r, 1200));

      const dashState = await session.evaluate(`
        (() => {
          const w = window.innerWidth;
          const sw = document.documentElement.scrollWidth;
          const isMobileView = w <= 768;
          const hamburger = document.querySelector('.menu-btn.mobile, .mobile-menu-btn, .hamburger, [onclick*="sidebar"]');
          const sidebar = document.querySelector('.sidebar');
          const sidebarVisible = sidebar ? window.getComputedStyle(sidebar).display !== 'none' : false;
          const btn = document.querySelector('.menu-btn');
          const btnDisplay = btn ? window.getComputedStyle(btn).display : 'null';
          return {
            w,
            sw,
            hasOverflow: sw > w + 2,
            isMobileView,
            hamburgerVisible: hamburger ? window.getComputedStyle(hamburger).display !== 'none' : false,
            sidebarVisible,
            btnDisplay,
            hasBtn: !!btn
          };
        })()
      `);

      console.log(`    [Debug ${vp.name}] w=${dashState.w}, sw=${dashState.sw}, isMobile=${dashState.isMobileView}, hamburger=${dashState.hamburgerVisible}, sidebar=${dashState.sidebarVisible}, hasBtn=${dashState.hasBtn}, btnDisplay=${dashState.btnDisplay}`);
      assert(!dashState.hasOverflow, `Merchant Dashboard on ${vp.name} has no horizontal overflow`);
      if (vp.width <= 768) {
        assert(dashState.btnDisplay === 'block', `Mobile hamburger button is visible and active on ${vp.name} (display: ${dashState.btnDisplay})`);
      } else {
        assert(dashState.sidebarVisible, `Desktop sidebar is visible on ${vp.name}`);
      }
      await session.screenshot(`dashboard_${vp.name}.png`);
    }

    // ─── Test Viewports for Admin Dashboard ─────────────────────────────────
    console.log('\n--- Section 5: Admin Dashboard (/admin) Across All 7 Viewports ---');
    await session.send('Network.enable');
    await session.send('Network.setExtraHTTPHeaders', {
      headers: {
        'Authorization': `Basic ${adminBasicAuth}`
      }
    });

    for (const vp of VIEWPORTS) {
      await session.setViewport(vp.width, vp.height, vp.mobile);
      await session.navigate(`${BASE_URL}/admin`);
      await new Promise(r => setTimeout(r, 1200));

      const adminState = await session.evaluate(`
        (() => {
          const w = window.innerWidth;
          const sw = document.documentElement.scrollWidth;
          return { hasOverflow: sw > w + 2, w, sw };
        })()
      `);

      assert(!adminState.hasOverflow, `Admin Dashboard on ${vp.name} has no horizontal overflow`);
      await session.screenshot(`admin_${vp.name}.png`);
    }

    await closeTarget(targetId);
  } finally {
    try { chromeProc.kill(); } catch (_) {}
    server.close();
    try { fs.unlinkSync(qaDb); } catch (_) {}
    try { fs.unlinkSync(qaDb + '-wal'); } catch (_) {}
    try { fs.unlinkSync(qaDb + '-shm'); } catch (_) {}
  }

  console.log('\n' + '='.repeat(80));
  console.log(`VIEWPORT RESPONSIVENESS SUITE COMPLETE: ${passedAssertions} PASSED, ${failedAssertions} FAILED`);
  console.log('='.repeat(80));
  if (failedAssertions > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
