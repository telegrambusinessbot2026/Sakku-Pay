/* ==============================================================================
   SakkuPay — Authentic Merchant Dashboard & Checkout Visual QA Runner
   Controls headless Chrome via Chrome DevTools Protocol (CDP).
   Tests & captures:
   - Merchant Dashboard: Overview (#overview)
   - Merchant Dashboard: Links Studio (#links)
   - Create Link Modal: Template Gallery (#link-modal)
   - Checkout Templates 1-5 (Classic, Minimal, Premium Dark, Modern Gradient, Compact UPI)
   - Merchant Support Center (#support) with real inquiries
   - Merchant Settings (#settings) with profile fields
   - Companion App (#companion) with download card and Android/iOS explainer
   - Responsive Mobile Sidebar Drawer with Backdrop (390x844)
   ============================================================================== */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const PORT = 3366;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = 9226;

const SCREENSHOTS_DIR = path.join(__dirname, 'qa_screenshots');
const ARTIFACT_SCREENSHOTS_DIR = 'C:\\Users\\USER\\.gemini\\antigravity\\brain\\bd10c453-341b-4496-8b6d-b3c4a4fdce6d\\screenshots';

if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!fs.existsSync(ARTIFACT_SCREENSHOTS_DIR)) fs.mkdirSync(ARTIFACT_SCREENSHOTS_DIR, { recursive: true });

// Copy live database to dedicated QA database to guarantee 0 data pollution
const primaryDb = path.join(__dirname, 'sakkupay.db');
const qaDb = path.join(__dirname, 'sakkupay_visual_real_qa.db');
if (fs.existsSync(primaryDb)) {
  fs.copyFileSync(primaryDb, qaDb);
  if (fs.existsSync(primaryDb + '-wal')) fs.copyFileSync(primaryDb + '-wal', qaDb + '-wal');
}

process.env.DB_PATH = qaDb;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'development';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'AdminSecure2026!';
process.env.SAKKUPAY_TOKEN_SECRET = 'a'.repeat(32);
process.env.VAULT_SECRET = 'b'.repeat(32);

// Load server and SQLite repositories
const {
  server,
  repository,
  hashPassword,
  token
} = require('./server');

// ─── SEED SYNTHETIC QA DATA ──────────────────────────────────
console.log('Seeding rich test records into isolated QA database...');

const qaMerchantId = 'mer_vis_' + Date.now();
const qaMerchant = repository.merchants.create({
  id: qaMerchantId,
  email: 'merchant.demo@sakkupay.local',
  passwordHash: hashPassword('DemoPass123!'),
  businessName: 'Nexora Digital Technologies',
  phone: '9876543210'
});

const qaUpi = repository.upis.create({
  id: 'upi_vis_' + Date.now(),
  merchantId: qaMerchant.id,
  label: 'Nexora ICICI Current A/C',
  upiId: 'nexora@icici',
  phoneNumber: '9876543210',
  default: true
});

// Seed 5 links
const linkClassic = repository.links.create({
  id: 'lnk_vis_1',
  merchantId: qaMerchant.id,
  name: 'Standard Subscription (Classic)',
  slug: 'classic-demo',
  upiId: qaUpi.id,
  amount: 499.00,
  amount_paise: 49900,
  description: 'Clean default SakkuPay layout with QR code and UPI apps',
  template: 'classic',
  active: true
});

const linkMinimal = repository.links.create({
  id: 'lnk_vis_2',
  merchantId: qaMerchant.id,
  name: 'Minimal Clean Invoice',
  slug: 'minimal-demo',
  upiId: qaUpi.id,
  amount: 850.00,
  amount_paise: 85000,
  description: 'Ultra-clean high-contrast monochrome design for professional invoices',
  template: 'minimal',
  active: true
});

const linkPremium = repository.links.create({
  id: 'lnk_vis_3',
  merchantId: qaMerchant.id,
  name: 'Onyx Executive Membership',
  slug: 'premium-dark-demo',
  upiId: qaUpi.id,
  amount: 2499.00,
  amount_paise: 249900,
  description: 'High-ticket luxury dark theme with gold accents and metallic borders',
  template: 'premium-dark',
  active: true
});

const linkGradient = repository.links.create({
  id: 'lnk_vis_4',
  merchantId: qaMerchant.id,
  name: 'Modern Cloud SaaS Pass',
  slug: 'modern-gradient-demo',
  upiId: qaUpi.id,
  amount: 1299.00,
  amount_paise: 129900,
  description: 'Vibrant mesh gradient header for modern consumer and tech startups',
  template: 'modern-gradient',
  active: true
});

const linkCompact = repository.links.create({
  id: 'lnk_vis_5',
  merchantId: qaMerchant.id,
  name: 'Quick Flash Payment',
  slug: 'compact-upi-demo',
  upiId: qaUpi.id,
  amount: 199.00,
  amount_paise: 19900,
  description: 'Streamlined mobile-first checkout prioritizing direct 1-tap app launch',
  template: 'compact-upi',
  active: true
});

repository.supportQueries.create({
  id: 'sup_vis_101',
  merchantId: qaMerchant.id,
  subject: 'Integration with Shopify Storefront',
  category: 'api_integration',
  message: 'We are seeking guidance on webhook retry backoffs for our headless commerce store.',
  status: 'answered'
});
repository.supportQueries.create({
  id: 'sup_vis_102',
  merchantId: qaMerchant.id,
  subject: 'Companion App Background Notification Sync',
  category: 'companion_app',
  message: 'Confirmation that the Android NotificationListenerService is running smoothly on Samsung OneUI.',
  status: 'open'
});

const merchantAuthToken = token({ id: qaMerchant.id, email: qaMerchant.email });
console.log('Test data seeding complete.');

// ─── CDP CLIENT ──────────────────────────────────────────────
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
    await new Promise(r => setTimeout(r, 1200));
  }

  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const localPath = path.join(SCREENSHOTS_DIR, filename);
    const artifactPath = path.join(ARTIFACT_SCREENSHOTS_DIR, filename);

    fs.writeFileSync(localPath, buffer);
    fs.writeFileSync(artifactPath, buffer);
    console.log(`  📸 Captured: ${filename} (${Math.round(buffer.length / 1024)} KB)`);
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

async function main() {
  console.log('='.repeat(78));
  console.log('SakkuPay: Authentic Merchant Dashboard & Checkout Visual QA Runner');
  console.log('='.repeat(78));

  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`Test server running at ${BASE_URL}`);

  console.log('Spawning Headless Chrome on port ' + CDP_PORT + '...');
  const chromeProc = cp.spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disable-gpu',
    'about:blank'
  ]);

  await new Promise(r => setTimeout(r, 2000));

  try {
    const { session, targetId } = await createCdpSession();

    // Helper to login merchant with verified storage key
    async function loginMerchant() {
      await session.navigate(`${BASE_URL}/login.html`);
      await session.evaluate(`
        localStorage.setItem('sakku-token', '${merchantAuthToken}');
        localStorage.setItem('sakku_token', '${merchantAuthToken}');
      `);
      await session.navigate(`${BASE_URL}/dashboard.html#access_token=${merchantAuthToken}`);
      await new Promise(r => setTimeout(r, 1500));
      const pageLoc = await session.evaluate(`window.location.pathname`);
      const bizName = await session.evaluate(`document.getElementById('profile-biz')?.textContent || ''`);
      console.log(`    Authenticated as merchant on ${pageLoc} (Biz: ${bizName})`);
    }

    // ─────────────────────────────────────────────────────────────
    // 1. Dashboard Overview (Desktop 1440x900)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 1. Merchant Dashboard: Overview (Desktop) ---');
    await session.setViewport(1440, 900, false);
    await loginMerchant();
    await session.screenshot('21_merchant_dashboard_overview_desktop.png');

    // ─────────────────────────────────────────────────────────────
    // 2. Links Studio (Desktop 1440x900)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 2. Merchant Dashboard: Payment Links Studio ---');
    await session.evaluate(`go('links');`);
    await new Promise(r => setTimeout(r, 800));
    await session.screenshot('22_merchant_links_studio_desktop.png');

    // Open Link Creation Modal with Template Gallery
    console.log('\n--- 3. Create Link Modal: Template Gallery ---');
    await session.evaluate(`modal('link-modal', true);`);
    await new Promise(r => setTimeout(r, 600));
    await session.screenshot('23_merchant_links_modal_template_gallery_desktop.png');
    await session.evaluate(`modal('link-modal', false);`);

    // ─────────────────────────────────────────────────────────────
    // 4. All 5 Checkout Page Templates (Desktop & Mobile)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 4. Checkout Template 1: Classic ---');
    await session.setViewport(1440, 900, false);
    await session.navigate(`${BASE_URL}/pay/classic-demo`);
    await session.screenshot('24_checkout_template_classic_desktop.png');
    await session.setViewport(390, 844, true);
    await new Promise(r => setTimeout(r, 500));
    await session.screenshot('24_checkout_template_classic_mobile.png');

    console.log('\n--- 5. Checkout Template 2: Minimal ---');
    await session.setViewport(1440, 900, false);
    await session.navigate(`${BASE_URL}/pay/minimal-demo`);
    await session.screenshot('25_checkout_template_minimal_desktop.png');
    await session.setViewport(390, 844, true);
    await new Promise(r => setTimeout(r, 500));
    await session.screenshot('25_checkout_template_minimal_mobile.png');

    console.log('\n--- 6. Checkout Template 3: Premium Dark ---');
    await session.setViewport(1440, 900, false);
    await session.navigate(`${BASE_URL}/pay/premium-dark-demo`);
    await session.screenshot('26_checkout_template_premium_dark_desktop.png');
    await session.setViewport(390, 844, true);
    await new Promise(r => setTimeout(r, 500));
    await session.screenshot('26_checkout_template_premium_dark_mobile.png');

    console.log('\n--- 7. Checkout Template 4: Modern Gradient ---');
    await session.setViewport(1440, 900, false);
    await session.navigate(`${BASE_URL}/pay/modern-gradient-demo`);
    await session.screenshot('27_checkout_template_modern_gradient_desktop.png');
    await session.setViewport(390, 844, true);
    await new Promise(r => setTimeout(r, 500));
    await session.screenshot('27_checkout_template_modern_gradient_mobile.png');

    console.log('\n--- 8. Checkout Template 5: Compact Mobile UPI ---');
    await session.setViewport(390, 844, true);
    await session.navigate(`${BASE_URL}/pay/compact-upi-demo`);
    await session.screenshot('28_checkout_template_compact_upi_mobile.png');

    // ─────────────────────────────────────────────────────────────
    // 9. Merchant Support Center (#support)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 9. Merchant Support Center ---');
    await session.setViewport(1440, 900, false);
    await loginMerchant();
    await session.evaluate(`go('support');`);
    await new Promise(r => setTimeout(r, 800));
    await session.screenshot('29_merchant_support_center_desktop.png');

    // ─────────────────────────────────────────────────────────────
    // 10. Merchant Settings Page (#settings)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 10. Merchant Settings ---');
    await session.evaluate(`go('settings');`);
    await new Promise(r => setTimeout(r, 800));
    await session.screenshot('30_merchant_settings_desktop.png');

    // ─────────────────────────────────────────────────────────────
    // 11. Companion App View (#companion)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 11. Companion App Page ---');
    await session.evaluate(`go('companion');`);
    await new Promise(r => setTimeout(r, 800));
    await session.screenshot('31_merchant_companion_page_desktop.png');

    // ─────────────────────────────────────────────────────────────
    // 12. Mobile Sidebar Slideout Drawer (390x844)
    // ─────────────────────────────────────────────────────────────
    console.log('\n--- 12. Mobile Sidebar Slideout Drawer ---');
    await session.setViewport(390, 844, true);
    await session.evaluate(`
      document.querySelector('.sidebar')?.classList.add('open');
      document.getElementById('sidebar-backdrop')?.classList.add('active');
    `);
    await new Promise(r => setTimeout(r, 600));
    await session.screenshot('32_merchant_mobile_sidebar_drawer.png');

    console.log('\nSession errors count:', session.pageErrors.length);
    await closeTarget(targetId);
  } finally {
    try { chromeProc.kill(); } catch (_) {}
    server.close();
    try {
      if (fs.existsSync(qaDb)) fs.unlinkSync(qaDb);
      if (fs.existsSync(qaDb + '-wal')) fs.unlinkSync(qaDb + '-wal');
      if (fs.existsSync(qaDb + '-shm')) fs.unlinkSync(qaDb + '-shm');
    } catch (_) {}
  }

  console.log('\n============================================================');
  console.log('AUTHENTIC VISUAL QA COMPLETE: ALL SCREENSHOTS CAPTURED');
  console.log('============================================================');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error in visual QA runner:', err);
  process.exit(1);
});
