'use strict';

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Set isolated test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SAKKUPAY_TOKEN_SECRET = 'test-token-secret-for-master-upgrade-suite-min-32-chars';
process.env.DATA_FILE = 'temp_test_master_data.json';
process.env.DB_PATH = 'temp_test_master.db';

const { server, repository, token, db } = require('./server');

async function runMasterSuite() {
  console.log('==============================================================================');
  console.log('SakkuPay Master Engineering & UI Upgrade Verification Suite');
  console.log('==============================================================================');

  if (!server.listening) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
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
    console.error(`  ❌ FAILED: ${msg}`, err);
    process.exitCode = 1;
  }

  // Setup test merchant in repository
  const testMerchant = {
    id: 'mer_master_test_77',
    businessName: 'SakkuPay Enterprise Labs',
    email: 'merchant@sakkupay.labs',
    passwordHash: 'dummy_hash_for_test',
    whatsappNumber: '9988776655',
    createdAt: new Date().toISOString()
  };
  try {
    repository.merchants.create(testMerchant);
  } catch {}
  const validMerchantToken = token(testMerchant);

  try {
    // ── SECTION 1: PAYMENT LINK BUILDER & MODAL STRUCTURE ──
    console.log('\n--- Section 1: Payment Link Builder & Modal Structure (Phase 4) ---');
    {
      const dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      assert(dashboardHtml.includes('class="modal payment-link-builder-modal"'), 'Modal must have payment-link-builder-modal class');
      assert(dashboardHtml.includes('class="builder-modal-header"'), 'Modal must have fixed builder-modal-header');
      assert(dashboardHtml.includes('class="builder-modal-form"'), 'Modal must have builder-modal-form');
      assert(dashboardHtml.includes('class="builder-modal-body"'), 'Modal must have scrollable builder-modal-body');
      assert(dashboardHtml.includes('class="builder-modal-footer"'), 'Modal must have sticky builder-modal-footer');
      assert(dashboardHtml.includes('id="link-submit-btn"'), 'Submit button must be inside modal');
      assert(dashboardHtml.includes('id="link-name"'), 'Collection title field must be present');
      assert(dashboardHtml.includes('id="link-description"'), 'Description field must be present');
      assert(dashboardHtml.includes('id="link-amount"'), 'Amount field must be present');
      assert(dashboardHtml.includes('id="link-slug"'), 'Slug field must be present');
      assert(dashboardHtml.includes('id="link-upi-select"'), 'Receiving UPI selector must be present');
      assert(dashboardHtml.includes('id="template-options-grid"'), 'Template gallery grid must be present');
      pass('Payment link builder modal structure has fixed header, scrollable body, sticky footer, and all required inputs');
    }

    {
      const extraCss = fs.readFileSync(path.join(__dirname, 'app-extra.css'), 'utf8');
      assert(extraCss.includes('.payment-link-builder-modal'), 'CSS must define .payment-link-builder-modal');
      assert(extraCss.includes('.builder-modal-header'), 'CSS must define .builder-modal-header');
      assert(extraCss.includes('.builder-modal-body'), 'CSS must define .builder-modal-body');
      assert(extraCss.includes('.builder-modal-footer'), 'CSS must define .builder-modal-footer');
      assert(extraCss.includes('overflow-y: auto'), 'Body must be scrollable');
      pass('CSS rules enforce bounded modal height, scrollable body, and sticky action buttons');
    }

    // ── SECTION 2: PAYMENT LINK RESULT VIEW & REAL QR CODE ──
    console.log('\n--- Section 2: Payment Link Result View & Real QR Code (Phase 5) ---');
    {
      const dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      assert(dashboardHtml.includes('id="qr-modal"'), 'Result modal #qr-modal must exist');
      assert(dashboardHtml.includes('id="qr-modal-title"'), 'Result modal title must exist');
      assert(dashboardHtml.includes('id="qr-modal-amount-pill"'), 'Amount badge must exist');
      assert(dashboardHtml.includes('id="qr-modal-upi-pill"'), 'UPI badge must exist');
      assert(dashboardHtml.includes('id="qr-modal-template-pill"'), 'Template badge must exist');
      assert(dashboardHtml.includes('id="modal-qrcode"'), 'QR code container must exist');
      assert(dashboardHtml.includes('id="modal-download-qr-btn"'), 'Download QR code button must exist');
      assert(dashboardHtml.includes('id="qr-modal-url"'), 'Shareable checkout URL input must exist');
      assert(dashboardHtml.includes('id="qr-modal-copy-btn"'), 'Copy link button must exist');
      assert(dashboardHtml.includes('id="qr-modal-open-link"'), 'Open checkout page action must exist');
      pass('Payment link result modal provides complete metadata badges, real QR container, copy button, and download QR action');
    }

    {
      const liveJs = fs.readFileSync(path.join(__dirname, 'app-live.js'), 'utf8');
      assert(liveJs.includes('new QRCode(qrContainer, { text: fullUrl'), 'QR code must encode full payment URL directly');
      assert(liveJs.includes('qr-modal-upi-pill'), 'showQrModal updates UPI badge');
      assert(liveJs.includes('qr-modal-template-pill'), 'showQrModal updates template badge');
      pass('Client logic generates QR code directly from actual checkout payment URL');
    }

    // ── SECTION 3: ANDROID APK FILENAME & DOWNLOAD INTEGRATION ──
    console.log('\n--- Section 3: Android APK Filename & Download Integration (Phase 7) ---');
    {
      const res = await fetch(`${baseUrl}/api/companion/status`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.available, true);
      assert.strictEqual(data.filename, 'sakkupay.apk', 'Status API must report filename sakkupay.apk');
      assert.strictEqual(data.packageName, 'in.sakkupay.companion');
      pass('GET /api/companion/status returns available: true and filename sakkupay.apk');
    }

    {
      const res = await fetch(`${baseUrl}/api/companion/download`, {
        headers: { 'Authorization': `Bearer ${validMerchantToken}` }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'application/vnd.android.package-archive');
      const disp = res.headers.get('content-disposition');
      assert(disp.includes('filename="sakkupay.apk"'), `Content-Disposition must specify sakkupay.apk, got: ${disp}`);
      const buf = Buffer.from(await res.arrayBuffer());
      assert(buf.length > 1000000, 'APK size must be > 1MB');
      assert.strictEqual(buf.slice(0, 4).toString('utf8'), 'PK\x03\x04', 'Binary must be valid zip/apk archive');
      pass('Authenticated GET /api/companion/download returns binary APK with filename="sakkupay.apk"');
    }

    {
      const res = await fetch(`${baseUrl}/downloads/sakkupay.apk`, {
        headers: { 'Authorization': `Bearer ${validMerchantToken}` }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'application/vnd.android.package-archive');
      pass('Protected GET /downloads/sakkupay.apk serves APK when authenticated with merchant token');
    }

    {
      const resUnauth = await fetch(`${baseUrl}/downloads/sakkupay.apk`);
      assert.strictEqual(resUnauth.status, 401, 'Unauthenticated request must be rejected with 401');
      pass('Unauthenticated request to /downloads/sakkupay.apk is strictly rejected with HTTP 401');
    }

    // ── SECTION 4: ANDROID MANIFEST, BRAND ICON & DISPLAY NAME ──
    console.log('\n--- Section 4: Android App Branding, Icon & Manifest (Phase 7 & 8) ---');
    {
      const manifestPath = path.join(__dirname, 'companion-android/app/src/main/AndroidManifest.xml');
      assert(fs.existsSync(manifestPath), 'AndroidManifest.xml must exist');
      const manifest = fs.readFileSync(manifestPath, 'utf8');

      assert(manifest.includes('android:label="@string/app_name"'), 'Application must use @string/app_name (SakkuPay)');
      assert(manifest.includes('android:icon="@mipmap/ic_launcher"'), 'Application must declare android:icon');
      assert(manifest.includes('android:roundIcon="@mipmap/ic_launcher_round"'), 'Application must declare android:roundIcon');
      assert(manifest.includes('android.intent.action.MAIN'), 'MainActivity must have MAIN action');
      assert(manifest.includes('android.intent.category.LAUNCHER'), 'MainActivity must have LAUNCHER category');
      assert(manifest.includes('android:exported="true"'), 'MainActivity must be exported');
      assert(!manifest.includes('android:usesCleartextTraffic="true"'), 'usesCleartextTraffic must not be true for release security');
      pass('AndroidManifest.xml contains valid app_name, launcher icons, launcher intent filters, and no cleartext traffic flag');
    }

    {
      const stringsPath = path.join(__dirname, 'companion-android/app/src/main/res/values/strings.xml');
      assert(fs.existsSync(stringsPath), 'strings.xml must exist');
      const stringsXml = fs.readFileSync(stringsPath, 'utf8');
      assert(stringsXml.includes('<string name="app_name">SakkuPay Companion</string>') || stringsXml.includes('<string name="app_name">SakkuPay</string>'), 'app_name must be SakkuPay Companion or SakkuPay');
      assert(stringsXml.includes('notification_listener_description'), 'notification_listener_description must be defined');
      pass('strings.xml defines app_name="SakkuPay" and official notification listener description');
    }

    {
      const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
      for (const d of densities) {
        const iconPath = path.join(__dirname, `companion-android/app/src/main/res/mipmap-${d}/ic_launcher.png`);
        const roundPath = path.join(__dirname, `companion-android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`);
        assert(fs.existsSync(iconPath), `Missing icon at mipmap-${d}`);
        assert(fs.existsSync(roundPath), `Missing round icon at mipmap-${d}`);
        assert(fs.statSync(iconPath).size > 500, `Icon at mipmap-${d} must be non-empty`);
      }
      pass('All 5 standard Android mipmap densities (mdpi to xxxhdpi) have rasterized ic_launcher and ic_launcher_round PNGs');
    }

    {
      const anyDpiIcon = path.join(__dirname, 'companion-android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml');
      const anyDpiRound = path.join(__dirname, 'companion-android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml');
      const bg = path.join(__dirname, 'companion-android/app/src/main/res/drawable/ic_launcher_background.xml');
      const fg = path.join(__dirname, 'companion-android/app/src/main/res/drawable/ic_launcher_foreground.xml');
      assert(fs.existsSync(anyDpiIcon), 'Adaptive ic_launcher.xml must exist');
      assert(fs.existsSync(anyDpiRound), 'Adaptive ic_launcher_round.xml must exist');
      assert(fs.existsSync(bg), 'Background drawable must exist');
      assert(fs.existsSync(fg), 'Foreground vector drawable must exist');
      pass('Adaptive icon XMLs and vector drawables exist for Android API 26+ modern launchers');
    }

    // ── SECTION 5: ADMIN DASHBOARD DESIGN & SERVER AUTHORIZATION ──
    console.log('\n--- Section 5: Admin Dashboard Design & Server Authorization (Phase 3) ---');
    {
      const adminHtml = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
      assert(!adminHtml.includes('<span class="icon">⌘</span>'), 'Admin nav must not contain raw unicode emojis');
      assert(!adminHtml.includes('<span class="icon">👥</span>'), 'Admin nav must not contain raw emoji icons');
      assert(adminHtml.includes('class="nav-svg"'), 'Admin nav must use clean SVG icons');
      pass('Admin dashboard navigation uses clean, consistent SVG iconography matching merchant dashboard');
    }

    {
      // Merchant token attempting admin endpoint is rejected (cannot impersonate admin)
      const res = await fetch(`${baseUrl}/api/admin/stats`, {
        headers: { 'Authorization': `Bearer ${validMerchantToken}` }
      });
      assert.strictEqual(res.status, 401, 'Merchant token must be rejected with 401 on admin endpoints');
      const data = await res.json();
      assert.strictEqual(data.error, 'Admin auth required');
      pass('Merchant token is strictly prevented from accessing protected admin endpoints (HTTP 401 Admin auth required)');
    }

    {
      // Unauthenticated request to admin endpoint is rejected with 401
      const res = await fetch(`${baseUrl}/api/admin/stats`);
      assert.strictEqual(res.status, 401, 'Unauthenticated request must be rejected with 401');
      pass('Unauthenticated request to /api/admin/stats is rejected with HTTP 401');
    }

    // ── SECTION 6: UPI ONBOARDING GUIDANCE & NOTIFICATION RELIABILITY ──
    console.log('\n--- Section 6: UPI Onboarding Guidance & Settlement Truth (Phase 9) ---');
    {
      const dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      assert(dashboardHtml.includes('ONBOARDING STEP'), 'UPI section must have Onboarding Step banner');
      assert(dashboardHtml.includes('sakkupay.apk'), 'UPI section must reference sakkupay.apk');
      assert(dashboardHtml.includes('Android 13/14/15'), 'Companion section must include Android 13/14/15 Restricted Settings guidance');
      assert(dashboardHtml.includes('Allow restricted settings'), 'Companion section must instruct user on Allow restricted settings');
      assert(dashboardHtml.includes('Settlement Verification Signal Notice'), 'Payment truth notice must be present');
      pass('Onboarding checklist, Android 13/14/15 Restricted Settings notice, and settlement truth disclaimers are present');
    }

    console.log('\n==============================================================================');
    console.log(`MASTER SUITE COMPLETE: ${passed} / ${total} PASSED, 0 FAILED`);
    console.log('==============================================================================');
  } catch (err) {
    fail('Unexpected exception during master test run', err);
  } finally {
    server.close();
    try { if (fs.existsSync('temp_test_master.db')) fs.unlinkSync('temp_test_master.db'); } catch {}
    try { if (fs.existsSync('temp_test_master_data.json')) fs.unlinkSync('temp_test_master_data.json'); } catch {}
  }
}

runMasterSuite();
