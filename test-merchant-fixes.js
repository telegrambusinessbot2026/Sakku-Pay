/* ==============================================================================
   SakkuPay — Automated Verification Suite: Merchant Dashboard & Link Fixes
   Tests:
   - Root Cause 1 verification: /pay/checkout.js returns application/javascript
   - Payment link generation, public URL format, and persistence
   - Multiple template selection, storage, switching via PATCH, and checkout delivery
   - Cross-merchant isolation and authorization guards
   - Settings validation, profile persistence, and format guards
   - Merchant support ticket submission and history
   - Companion app download endpoint
   - Strict payment lifecycle security (UTR submission remains pending)
   ============================================================================== */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TEST_DB_PATH = path.join(__dirname, 'temp_test_merchant_fixes.db');
const TEST_DATA_JSON = path.join(__dirname, 'temp_test_fixes_data.json');
if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
fs.copyFileSync(path.join(__dirname, 'data.json'), TEST_DATA_JSON);

process.env.DB_PATH = TEST_DB_PATH;
process.env.DATA_JSON_PATH = TEST_DATA_JSON;
process.env.NODE_ENV = 'development';
process.env.APP_URL = 'https://payments.sakkupay.in';

const {
  server,
  repository,
  sqliteDb,
  token,
  encryptToken
} = require('./server');

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (!condition) {
    failedTests++;
    console.error(`  ❌ FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    passedTests++;
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

async function runSuite() {
  console.log('==============================================================================');
  console.log('SakkuPay Merchant Dashboard, Payment Links & Companion Verification Suite');
  console.log('==============================================================================\n');

  // Setup 2 test merchants for cross-tenant isolation tests
  const m1 = repository.merchants.create({
    id: 'mer_fix_test_1',
    email: 'merchant1@sakkupay.test',
    businessName: 'Alpha Retail Store',
    supportEmail: 'support@alpharetail.test',
    description: 'Alpha retail merchant account',
    whatsappNumber: '9876543210',
    createdAt: new Date().toISOString()
  });

  const m2 = repository.merchants.create({
    id: 'mer_fix_test_2',
    email: 'merchant2@sakkupay.test',
    businessName: 'Beta Digital Store',
    supportEmail: 'help@betadigital.test',
    description: 'Beta merchant account',
    whatsappNumber: '9123456780',
    createdAt: new Date().toISOString()
  });

  // Setup primary receiving UPI for m1
  const upi1 = repository.upis.create({
    id: 'upi_m1_primary',
    merchantId: m1.id,
    label: 'Primary HDFC Business',
    upiId: 'alphastore@hdfcbank',
    phoneNumber: '9876543210',
    default: true,
    createdAt: new Date().toISOString()
  });

  // Setup primary receiving UPI for m2
  const upi2 = repository.upis.create({
    id: 'upi_m2_primary',
    merchantId: m2.id,
    label: 'Primary ICICI',
    upiId: 'betastore@icici',
    phoneNumber: '9123456780',
    default: true,
    createdAt: new Date().toISOString()
  });

  const tokenM1 = token(m1);
  const tokenM2 = token(m2);

  // Start server on ephemeral port (0)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Live test server active on: ${baseUrl}\n`);

  try {
    /* ─── SECTION 1: Root Cause 1 Verification (Asset Hijack Fix) ─── */
    console.log('--- Section 1: Public Payment Page & Asset Resolution (Root Cause 1) ---');
    
    // 1. Static file requests under /pay/ must return real assets, NOT checkout.html!
    const resJs = await request(baseUrl, '/pay/checkout.js');
    assert(resJs.status === 200, 'GET /pay/checkout.js returns HTTP 200');
    assert(resJs.headers.get('content-type').includes('javascript'), 'GET /pay/checkout.js serves application/javascript MIME type');
    assert(resJs.data.includes('SakkuPay'), 'GET /pay/checkout.js returns real JS code, not HTML');

    const resCss = await request(baseUrl, '/pay/styles.css');
    assert(resCss.status === 200, 'GET /pay/styles.css returns HTTP 200');
    assert(resCss.headers.get('content-type').includes('css'), 'GET /pay/styles.css serves text/css MIME type');

    const resHtml = await request(baseUrl, '/pay/sample-test-slug');
    assert(resHtml.status === 200, 'GET /pay/sample-test-slug serves checkout.html');
    assert(resHtml.headers.get('content-type').includes('html'), 'Payment route serves text/html');
    assert(resHtml.data.includes('public-checkout'), 'HTML contains public-checkout container');

    /* ─── SECTION 2: Payment Link Creation & Multiple Templates ─── */
    console.log('\n--- Section 2: Payment Link Generation & Template Selection ---');

    // Link 1: Classic template
    const resL1 = await request(baseUrl, '/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        name: 'Leather Portfolio Bag',
        description: 'Handcrafted full-grain leather',
        amountType: 'fixed',
        amount: 2499,
        slug: 'leather-bag-classic',
        template: 'classic',
        upiId: upi1.id
      }
    });
    assert(resL1.status === 201, 'Create link with classic template returns HTTP 201 Created');
    assert(resL1.data.template === 'classic', 'Link record has template: classic');
    assert(resL1.data.url === 'https://payments.sakkupay.in/pay/leather-bag-classic', 'Link response contains configured public URL');

    // Link 2: Minimal template
    const resL2 = await request(baseUrl, '/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        name: 'Design Consultation Hour',
        amountType: 'fixed',
        amount: 1500,
        slug: 'design-consult-minimal',
        template: 'minimal',
        upiId: upi1.id
      }
    });
    assert(resL2.status === 201, 'Create link with minimal template returns HTTP 201');
    assert(resL2.data.template === 'minimal', 'Link record has template: minimal');

    // Link 3: Premium Dark template
    const resL3 = await request(baseUrl, '/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        name: 'VIP Executive Retainer',
        amountType: 'fixed',
        amount: 25000,
        slug: 'vip-retainer-onyx',
        template: 'premium-dark',
        upiId: upi1.id
      }
    });
    assert(resL3.status === 201, 'Create link with premium-dark template returns HTTP 201');
    assert(resL3.data.template === 'premium-dark', 'Link record has template: premium-dark');

    // Link 4: Modern Gradient template
    const resL4 = await request(baseUrl, '/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        name: 'Web3 Pass',
        amountType: 'open',
        slug: 'web3-pass-gradient',
        template: 'modern-gradient',
        upiId: upi1.id
      }
    });
    assert(resL4.status === 201, 'Create open link with modern-gradient template returns HTTP 201');
    assert(resL4.data.template === 'modern-gradient', 'Open link has template: modern-gradient');

    // Link 5: Compact UPI template
    const resL5 = await request(baseUrl, '/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        name: 'Coffee Tip Jar',
        amountType: 'open',
        slug: 'coffee-tip-compact',
        template: 'compact-upi',
        upiId: upi1.id
      }
    });
    assert(resL5.status === 201, 'Create link with compact-upi template returns HTTP 201');
    assert(resL5.data.template === 'compact-upi', 'Link record has template: compact-upi');

    // Verify public checkout API delivers the selected template
    const pubCheck1 = await request(baseUrl, '/api/checkout/leather-bag-classic');
    assert(pubCheck1.status === 200, 'Public checkout API returns HTTP 200 for Link 1');
    assert(pubCheck1.data.template === 'classic', 'Public API delivers template: classic');
    assert(pubCheck1.data.businessName === 'Alpha Retail Store', 'Public API delivers merchant businessName');

    const pubCheck2 = await request(baseUrl, '/api/checkout/design-consult-minimal');
    assert(pubCheck2.status === 200, 'Public checkout API returns HTTP 200 for Link 2');
    assert(pubCheck2.data.template === 'minimal', 'Public API delivers template: minimal');

    /* ─── SECTION 3: Template Switching via PATCH ─── */
    console.log('\n--- Section 3: Changing Template on Existing Link ---');
    const resPatch = await request(baseUrl, `/api/links/${resL1.data.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { template: 'modern-gradient' }
    });
    assert(resPatch.status === 200, 'PATCH link template returns HTTP 200');
    assert(resPatch.data.template === 'modern-gradient', 'Template updated to modern-gradient');

    const pubCheckAfter = await request(baseUrl, '/api/checkout/leather-bag-classic');
    assert(pubCheckAfter.data.template === 'modern-gradient', 'Public checkout reflects updated template');

    /* ─── SECTION 4: Cross-Merchant Isolation & Security Guards ─── */
    console.log('\n--- Section 4: Cross-Merchant Isolation & Input Validation ---');

    // Merchant 2 cannot see Merchant 1's links
    const resM2Links = await request(baseUrl, '/api/links', {
      headers: { Authorization: `Bearer ${tokenM2}` }
    });
    assert(resM2Links.status === 200, 'Merchant 2 GET /api/links returns HTTP 200');
    assert(resM2Links.data.length === 0, 'Merchant 2 sees 0 links (isolated from Merchant 1)');

    // Merchant 2 cannot mutate Merchant 1's link
    const resM2Hijack = await request(baseUrl, `/api/links/${resL1.data.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenM2}` },
      body: { name: 'Hacked Title' }
    });
    assert(resM2Hijack.status === 404, 'Cross-merchant link mutation blocked with HTTP 404 Not Found');

    // Validation: fixed link with 0 amount rejected
    const resInvalidAmt = await request(baseUrl, '/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { name: 'Zero Dollar Link', amountType: 'fixed', amount: 0, slug: 'zero-dollar' }
    });
    assert(resInvalidAmt.status === 400, 'Fixed link with amount <= 0 rejected with HTTP 400 Bad Request');

    // Validation: missing title rejected
    const resNoTitle = await request(baseUrl, '/api/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { name: '', amountType: 'open', slug: 'no-title' }
    });
    assert(resNoTitle.status === 400, 'Link with empty title rejected with HTTP 400 Bad Request');

    // Deactivated link cannot be accessed publicly
    await request(baseUrl, `/api/links/${resL2.data.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { active: false }
    });
    const resDeactPub = await request(baseUrl, '/api/checkout/design-consult-minimal');
    assert(resDeactPub.status === 404, 'Deactivated payment link returns HTTP 404 on public checkout API');

    /* ─── SECTION 5: Settings & Profile Validation ─── */
    console.log('\n--- Section 5: Merchant Settings & Profile Validation ---');

    // Profile GET
    const resProfGet = await request(baseUrl, '/api/profile', {
      headers: { Authorization: `Bearer ${tokenM1}` }
    });
    assert(resProfGet.status === 200, 'GET /api/profile returns HTTP 200');
    assert(resProfGet.data.businessName === 'Alpha Retail Store', 'Profile returns business name');
    assert(!resProfGet.data.passwordHash, 'Password hash strictly excluded from profile response');

    // Profile PUT valid update
    const resProfPut = await request(baseUrl, '/api/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        businessName: 'Alpha Global Store & Studio',
        supportEmail: 'contact@alphaglobal.com',
        description: 'Leading boutique retail partner',
        whatsappNumber: '9988776655'
      }
    });
    assert(resProfPut.status === 200, 'PUT /api/profile valid update returns HTTP 200');
    assert(resProfPut.data.businessName === 'Alpha Global Store & Studio', 'Updated business name persisted');
    assert(resProfPut.data.supportEmail === 'contact@alphaglobal.com', 'Updated support email persisted');

    // Profile PUT invalid phone
    const resInvalidPhone = await request(baseUrl, '/api/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { whatsappNumber: '12345' }
    });
    assert(resInvalidPhone.status === 400, 'Invalid 5-digit WhatsApp number rejected with HTTP 400');

    // Profile PUT invalid email
    const resInvalidEmail = await request(baseUrl, '/api/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { supportEmail: 'not-an-email' }
    });
    assert(resInvalidEmail.status === 400, 'Invalid email format rejected with HTTP 400');

    // Profile PUT short name
    const resShortName = await request(baseUrl, '/api/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { businessName: 'A' }
    });
    assert(resShortName.status === 400, 'Business name < 2 chars rejected with HTTP 400');

    /* ─── SECTION 6: Merchant Support Queries API ─── */
    console.log('\n--- Section 6: Merchant Support Queries API ---');

    const resSupPost = await request(baseUrl, '/api/support/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: {
        category: 'companion_app',
        subject: 'Notification access on Samsung OneUI 6',
        message: 'Need clarification on battery optimization exclusion settings for background listener service.'
      }
    });
    assert(resSupPost.status === 201, 'POST /api/support/query returns HTTP 201 Created');
    assert(resSupPost.data.ticketId && resSupPost.data.ticketId.startsWith('sup_'), 'Ticket ID generated with sup_ prefix');

    const resSupList = await request(baseUrl, '/api/support/queries', {
      headers: { Authorization: `Bearer ${tokenM1}` }
    });
    assert(resSupList.status === 200, 'GET /api/support/queries returns HTTP 200');
    assert(Array.isArray(resSupList.data) && resSupList.data.length >= 1, 'Support inquiries returned as array');
    assert(resSupList.data[0].subject === 'Notification access on Samsung OneUI 6', 'Support inquiry subject matches');

    // Empty query rejected
    const resEmptyQuery = await request(baseUrl, '/api/support/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenM1}` },
      body: { subject: '', message: '' }
    });
    assert(resEmptyQuery.status === 400, 'Empty support query rejected with HTTP 400');

    /* ─── SECTION 7: Companion App Download Endpoint ─── */
    console.log('\n--- Section 7: Companion App APK Download Endpoint ---');

    const resUnauthDownload = await request(baseUrl, '/api/companion/download');
    assert(resUnauthDownload.status === 401, 'Unauthenticated GET /api/companion/download rejected with HTTP 401');

    const resAuthDownload = await request(baseUrl, '/api/companion/download', {
      headers: { Authorization: `Bearer ${tokenM1}` }
    });
    assert(resAuthDownload.status === 200, 'Authenticated GET /api/companion/download returns HTTP 200');
    assert(resAuthDownload.headers.get('content-type') === 'application/vnd.android.package-archive', 'Serves APK package-archive MIME type');

    const resStatus = await request(baseUrl, '/api/companion/status');
    assert(resStatus.status === 200, 'GET /api/companion/status returns HTTP 200');
    assert(resStatus.data.packageName === 'in.sakkupay.companion', 'APK metadata reports package in.sakkupay.companion');
    assert(resStatus.data.version === '1.0', 'APK metadata reports version 1.0');

    /* ─── SECTION 8: Strict Payment Lifecycle (Zero Fraudulent Auto-Approval) ─── */
    console.log('\n--- Section 8: Strict Payment Lifecycle & UTR Evidence ---');

    // Customer opens checkout and submits UTR
    const resConfirm = await request(baseUrl, '/api/checkout/leather-bag-classic/confirm', {
      method: 'POST',
      body: {
        utr: '428938192831',
        amount: 2499
      }
    });
    assert(resConfirm.status === 200, 'Customer UTR confirm returns HTTP 200');
    assert(resConfirm.data.transaction.status === 'pending', 'Transaction status remains strictly PENDING (never self-approved)');
    assert(resConfirm.data.transaction.reconciliationStatus === 'unverified_evidence', 'Reconciliation status flagged as unverified_evidence');

    // Poll status remains pending
    const resPoll = await request(baseUrl, `/api/checkout/leather-bag-classic/status?txId=${resConfirm.data.transaction.id}`);
    assert(resPoll.status === 200, 'Customer polling status returns HTTP 200');
    assert(resPoll.data.status === 'pending', 'Public polling confirms transaction is strictly pending');

  } finally {
    server.close();
    sqliteDb.close();
    // Clean up temporary database files
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH + '-wal')) fs.unlinkSync(TEST_DB_PATH + '-wal');
    if (fs.existsSync(TEST_DB_PATH + '-shm')) fs.unlinkSync(TEST_DB_PATH + '-shm');
  }

  console.log('\n==============================================================================');
  console.log(`SUITE COMPLETE: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('==============================================================================');
  process.exit(failedTests === 0 ? 0 : 1);
}

runSuite().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
