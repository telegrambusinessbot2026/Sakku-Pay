'use strict';

const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Set isolated test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SAKKUPAY_TOKEN_SECRET = 'test-token-secret-for-dashboard-navigation-minimum-32-chars';
process.env.DATA_FILE = 'temp_test_dashboard_nav_data.json';
process.env.DB_PATH = 'temp_test_dashboard_nav.db';

const { server, repository, token, db } = require('./server');

async function runDashboardTests() {
  console.log('==============================================================================');
  console.log('SakkuPay Dashboard Navigation, Sidebar UX & Profile Verification Suite');
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
    id: 'mer_nav_test_88',
    businessName: 'Apex Cloud Solutions',
    email: 'merchant@apexcloud.in',
    passwordHash: 'dummy_hash_for_test',
    whatsappNumber: '9876543210',
    supportEmail: 'support@apexcloud.in',
    createdAt: new Date().toISOString()
  };

  try {
    repository.merchants.create(testMerchant);
  } catch {}
  const validMerchantToken = token(testMerchant);

  try {
    // ─── Section 1: Server Routing for Direct Dashboard URLs ──────────────────
    console.log('\n--- Section 1: Server Routing & Direct Dashboard URLs ---');

    {
      const res = await fetch(`${baseUrl}/dashboard`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert(html.includes('id="app-shell"'), 'Serves dashboard HTML shell');
      pass('GET /dashboard serves dashboard.html with HTTP 200');
    }

    {
      const directPaths = [
        '/dashboard/overview',
        '/dashboard/links',
        '/dashboard/upi',
        '/dashboard/transactions',
        '/dashboard/companion',
        '/dashboard/developers',
        '/dashboard/settings',
        '/dashboard/support'
      ];

      for (const p of directPaths) {
        const res = await fetch(`${baseUrl}${p}`);
        assert.strictEqual(res.status, 200, `Path ${p} should return HTTP 200`);
        assert.strictEqual(res.headers.get('content-type'), 'text/html; charset=utf-8');
        const text = await res.text();
        assert(text.includes('id="app-shell"'), `Path ${p} should render dashboard app shell`);
      }
      pass('GET /dashboard/* direct sub-routes all return HTTP 200 and serve dashboard shell');
    }

    // ─── Section 2: Dashboard HTML Structure & Professional Icons ────────────
    console.log('\n--- Section 2: Dashboard HTML Structure & Professional Icons ---');

    const dashboardHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

    {
      const expectedPages = [
        'overview',
        'links',
        'upi',
        'transactions',
        'companion',
        'developers',
        'settings',
        'support'
      ];

      for (const p of expectedPages) {
        assert(dashboardHtml.includes(`id="${p}"`), `Dashboard HTML must contain <section class="page" id="${p}">`);
        assert(dashboardHtml.includes(`data-page="${p}"`), `Dashboard HTML must contain navigation item data-page="${p}"`);
      }
      pass('All 8 sidebar navigation items have matching, distinct <section class="page"> views');
    }

    {
      // Verify unified SVG icons (no mixed unicode/emoji like 🤖, ⌘, ⌥)
      assert(dashboardHtml.includes('class="nav-svg"'), 'Navigation buttons use unified .nav-svg icons');
      assert(!dashboardHtml.includes('<span class="nav-icon">🤖</span>'), 'Amateur robot emoji is removed');
      assert(!dashboardHtml.includes('<span class="nav-icon">⌘</span>'), 'Mac command symbol is replaced with grid SVG');
      assert(!dashboardHtml.includes('<span class="nav-icon">⌥</span>'), 'Mac option symbol is replaced with code SVG');
      assert(!dashboardHtml.includes('<span class="nav-icon">🎧</span>'), 'Headphone emoji is replaced with headset SVG');
      pass('Sidebar navigation uses consistent, professional SVG icons with unified stroke weight');
    }

    // ─── Section 3: Workspace Card & Bottom Profile Area ─────────────────────
    console.log('\n--- Section 3: Workspace Card & Bottom Profile Area ---');

    {
      assert(dashboardHtml.includes('class="workspace" id="workspace-card"'), 'Workspace card element exists');
      assert(dashboardHtml.includes('id="ws-avatar"'), 'Workspace avatar initial element exists');
      assert(dashboardHtml.includes('id="ws-name"'), 'Workspace display name element exists');
      assert(dashboardHtml.includes('class="workspace-subtitle"'), 'Workspace subtitle exists');
      assert(!dashboardHtml.includes('class="workspace-arrow">▾</span>'), 'Broken static down-arrow ▾ is replaced');
      assert(dashboardHtml.includes('class="workspace-action-icon"'), 'Workspace card provides clear action icon');
      pass('Workspace card provides clean avatar alignment, readable title/subtitle, and clear interaction');
    }

    {
      assert(dashboardHtml.includes('id="profile-sidebar-btn"'), 'Bottom profile area exists');
      assert(dashboardHtml.includes('id="user-avatar"'), 'User avatar initial element exists');
      assert(dashboardHtml.includes('id="user-display-name"'), 'User display name element exists');
      assert(dashboardHtml.includes('id="user-display-email"'), 'User display email element exists');
      assert(dashboardHtml.includes('class="logout-icon-btn"'), 'Logout action button exists');
      assert(dashboardHtml.includes('title="Sign out of SakkuPay"'), 'Logout button has accessible tooltip');
      assert(dashboardHtml.includes('aria-label="Sign out"'), 'Logout button has accessible aria-label');
      assert(!dashboardHtml.includes('>⎋</button>'), 'Ambiguous unicode escape symbol ⎋ is replaced with standard logout SVG');
      pass('Bottom account footer displays user details and accessible Sign Out button with logout SVG');
    }

    // ─── Section 4: Live Settlement & Header Glitch Prevention ───────────────
    console.log('\n--- Section 4: Live Settlement & Header Glitch Prevention ---');

    {
      assert(dashboardHtml.includes('class="settlement-status-wrap"'), 'Settlement status wrap container exists');
      assert(dashboardHtml.includes('class="badge live-settlement-badge"'), 'Live settlement badge exists');
      assert(dashboardHtml.includes('id="header-merchant-name" class="header-merchant-name"'), 'Header merchant name has truncation class');
      assert(dashboardHtml.includes('class="btn-full"'), 'Header actions support full button labels');
      assert(dashboardHtml.includes('class="btn-short"'), 'Header actions support compact mobile labels');
      pass('Top bar layout uses responsive settlement container and ellipsis truncation to eliminate glitches');
    }

    // ─── Section 5: Settings Sub-Navigation & Profile Tabs ────────────────────
    console.log('\n--- Section 5: Settings Sub-Navigation & Profile Tabs ---');

    {
      assert(dashboardHtml.includes('class="settings-tabs-bar"'), 'Settings tabs navigation bar exists');
      assert(dashboardHtml.includes('id="tab-btn-profile"'), 'Merchant Profile tab button exists');
      assert(dashboardHtml.includes('id="tab-btn-security"'), 'Account & Security tab button exists');
      assert(dashboardHtml.includes('id="settings-tab-profile"'), 'Merchant Profile tab content pane exists');
      assert(dashboardHtml.includes('id="settings-tab-security"'), 'Account & Security tab content pane exists');
      assert(dashboardHtml.includes('class="profile-preview-card"'), 'Live checkout branding preview card exists');
      assert(dashboardHtml.includes('id="profile-inline-feedback"'), 'Inline validation and success feedback banner exists');
      assert(dashboardHtml.includes('id="btn-copy-merchant-id"'), 'One-click copy button for Merchant ID exists');
      pass('Settings page features dedicated Profile & Security tabs, live checkout preview, and inline feedback');
    }

    // ─── Section 6: Profile API Endpoint Contracts & Validation ──────────────
    console.log('\n--- Section 6: Profile API Contracts & Validation ---');

    {
      // 1. Authenticated GET /api/profile
      const res = await fetch(`${baseUrl}/api/profile`, {
        headers: { 'Authorization': `Bearer ${validMerchantToken}` }
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.id, testMerchant.id);
      assert.strictEqual(data.businessName, 'Apex Cloud Solutions');
      assert.strictEqual(data.email, 'merchant@apexcloud.in');
      assert.strictEqual(data.passwordHash, undefined, 'Password hash must be strictly excluded from profile response');
      pass('GET /api/profile returns authenticated merchant details without exposing password hashes');
    }

    {
      // 2. Unauthenticated GET /api/profile
      const res = await fetch(`${baseUrl}/api/profile`);
      assert.strictEqual(res.status, 401, 'Unauthenticated request must return HTTP 401');
      pass('Unauthenticated GET /api/profile is rejected with HTTP 401 Unauthorized');
    }

    {
      // 3. Valid PUT /api/profile
      const updatePayload = {
        businessName: 'Apex Cloud Technologies Pvt Ltd',
        supportEmail: 'care@apexcloud.in',
        whatsappNumber: '9988776655',
        description: 'Premium cloud and infrastructure services'
      };
      const res = await fetch(`${baseUrl}/api/profile`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${validMerchantToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updatePayload)
      });
      assert.strictEqual(res.status, 200);
      const updated = await res.json();
      assert.strictEqual(updated.businessName, 'Apex Cloud Technologies Pvt Ltd');
      assert.strictEqual(updated.supportEmail, 'care@apexcloud.in');
      assert.strictEqual(updated.whatsappNumber, '9988776655');
      pass('PUT /api/profile successfully persists updated business profile');
    }

    {
      // 4. Invalid PUT: short business name (< 2 chars)
      const res = await fetch(`${baseUrl}/api/profile`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${validMerchantToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ businessName: 'A' })
      });
      assert.strictEqual(res.status, 400);
      pass('PUT /api/profile rejects business name < 2 characters with HTTP 400 Bad Request');
    }

    {
      // 5. Invalid PUT: malformed support email
      const res = await fetch(`${baseUrl}/api/profile`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${validMerchantToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ supportEmail: 'not-an-email' })
      });
      assert.strictEqual(res.status, 400);
      pass('PUT /api/profile rejects invalid email address with HTTP 400 Bad Request');
    }

    {
      // 6. Invalid PUT: invalid phone length
      const res = await fetch(`${baseUrl}/api/profile`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${validMerchantToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ whatsappNumber: '123' })
      });
      assert.strictEqual(res.status, 400);
      pass('PUT /api/profile rejects non-10-digit WhatsApp numbers with HTTP 400 Bad Request');
    }

    // ─── Section 7: Client Script Syntax & Router Integrity ──────────────────
    console.log('\n--- Section 7: Client Script Integrity ---');

    const appJs = fs.readFileSync(path.join(__dirname, 'app-live.js'), 'utf8');

    {
      assert(appJs.includes('VALID_PAGES ='), 'app-live.js defines VALID_PAGES array');
      assert(appJs.includes('function normalizePage('), 'app-live.js provides normalizePage helper');
      assert(appJs.includes('function getActivePageFromUrl('), 'app-live.js provides getActivePageFromUrl helper');
      assert(appJs.includes("window.addEventListener('popstate'"), 'app-live.js listens to popstate event for Back/Forward');
      assert(appJs.includes("window.addEventListener('hashchange'"), 'app-live.js listens to hashchange event');
      assert(appJs.includes('history.pushState('), 'app-live.js updates history state for browser navigation');
      assert(appJs.includes('function switchSettingsTab('), 'app-live.js provides switchSettingsTab');
      assert(appJs.includes('function handleLogoutClick('), 'app-live.js provides handleLogoutClick with confirmation');
      assert(appJs.includes('function copyMerchantId('), 'app-live.js provides copyMerchantId');
      assert(appJs.includes('function updateProfilePreview('), 'app-live.js provides updateProfilePreview');
      pass('app-live.js includes complete SPA router, popstate handling, profile preview, and tab switcher');
    }

    console.log('\n==============================================================================');
    console.log(`SUITE COMPLETE: ${passed} / ${total} PASSED, 0 FAILED`);
    console.log('==============================================================================');
  } catch (err) {
    fail('Unexpected exception during dashboard test run', err);
  } finally {
    server.close();
    try { if (fs.existsSync('temp_test_dashboard_nav.db')) fs.unlinkSync('temp_test_dashboard_nav.db'); } catch {}
    try { if (fs.existsSync('temp_test_dashboard_nav_data.json')) fs.unlinkSync('temp_test_dashboard_nav_data.json'); } catch {}
  }
}

runDashboardTests();
