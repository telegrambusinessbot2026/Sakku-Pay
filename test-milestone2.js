/* ==============================================================================
   SakkuPay Milestone 2 — Comprehensive Database & Repository Test Suite
   Verifies:
   1. Atomic JSON -> SQLite migration with SHA-256 verification
   2. Exact entity counts matching source data.json
   3. Integer paise precision (amount_paise) & exact accounting
   4. Migration idempotency (no duplicate rows on re-run)
   5. Atomic rollback on migration failure
   6. Repository CRUD with parameterized prepared statements
   7. Foreign key referential integrity & cascade deletes
   8. SQLite WAL mode & concurrent connection handling
   9. Milestone 1 security regression verification
   ============================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createDatabaseConnection } = require('./src/db/connection');
const { initSchema } = require('./src/db/schema');
const { migrateJsonToSqlite } = require('./src/db/migrate');
const { createRepository } = require('./src/db/repository');
const {
  server,
  repository: serverRepo,
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

async function runMilestone2Tests() {
  console.log('==============================================================================');
  console.log('SakkuPay Milestone 2: SQLite Migration & Repository Layer Test Suite');
  console.log('==============================================================================\n');

  const jsonStorePath = fs.existsSync(path.join(__dirname, 'data.json'))
    ? path.join(__dirname, 'data.json')
    : path.join(__dirname, 'data.json.example');
  const sourceBytes = fs.readFileSync(jsonStorePath);
  const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const sourceData = JSON.parse(sourceBytes.toString('utf8'));

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 1: MIGRATION VERIFICATION & SHA-256 RECORDING
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('--- Section 1: Migration Verification & Entity Counts ---');
  const testDbFile = path.join(__dirname, 'temp_test_milestone2.db');
  if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);

  const testDb = createDatabaseConnection(testDbFile);
  const migResult = migrateJsonToSqlite(testDb, jsonStorePath);

  assert(migResult.status === 'migrated_successfully', 'Migration returns status "migrated_successfully"');
  assert(migResult.sourceHash === sourceSha256, 'Recorded source SHA-256 hash strictly matches data.json');

  // Verify entity counts match source data.json exactly
  const countMerchants = testDb.prepare('SELECT COUNT(*) as c FROM merchants').get().c;
  const countUpis = testDb.prepare('SELECT COUNT(*) as c FROM upis').get().c;
  const countLinks = testDb.prepare('SELECT COUNT(*) as c FROM links').get().c;
  const countTxs = testDb.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
  const countKeys = testDb.prepare('SELECT COUNT(*) as c FROM apiKeys').get().c;
  const countBiz = testDb.prepare('SELECT COUNT(*) as c FROM businessAccounts').get().c;

  assert(countMerchants === (sourceData.merchants || []).length, `Merchants count (${countMerchants}) matches source (${sourceData.merchants.length})`);
  assert(countUpis === (sourceData.upis || []).length, `UPI accounts count (${countUpis}) matches source (${sourceData.upis.length})`);
  assert(countLinks === (sourceData.links || []).length, `Payment links count (${countLinks}) matches source (${sourceData.links.length})`);
  assert(countTxs === (sourceData.transactions || []).length, `Transactions count (${countTxs}) matches source (${sourceData.transactions.length})`);
  assert(countKeys === (sourceData.apiKeys || []).length, `API keys count (${countKeys}) matches source (${sourceData.apiKeys.length})`);
  assert(countBiz === (sourceData.businessAccounts || []).length, `Business accounts count (${countBiz}) matches source (${sourceData.businessAccounts.length})`);

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 2: MIGRATION IDEMPOTENCY & ROLLBACK SAFETY
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 2: Migration Idempotency & Rollback Safety ---');
  // Re-running migration on an already migrated DB
  const rerunResult = migrateJsonToSqlite(testDb, jsonStorePath);
  assert(rerunResult.status === 'already_migrated', 'Re-running migration returns "already_migrated"');
  assert(rerunResult.counts.merchants === countMerchants, 'Merchant count unchanged after rerun');
  assert(rerunResult.counts.transactions === countTxs, 'Transaction count unchanged after rerun');

  // Test atomic rollback on corrupt data
  const rollbackDb = createDatabaseConnection(':memory:');
  initSchema(rollbackDb);
  const badTempJson = path.join(__dirname, 'temp_bad_data.json');
  fs.writeFileSync(badTempJson, JSON.stringify({
    merchants: [{ id: 'm1', email: 'm1@corp.in', businessName: 'M1' }],
    // Violates NOT NULL on reference in transactions
    transactions: [{ id: 't1', merchantId: 'm1', reference: null, amount: 100 }]
  }));

  let rollbackThrew = false;
  try {
    migrateJsonToSqlite(rollbackDb, badTempJson);
  } catch (err) {
    rollbackThrew = true;
  } finally {
    if (fs.existsSync(badTempJson)) fs.unlinkSync(badTempJson);
  }
  assert(rollbackThrew, 'Corrupted data migration raises error and triggers rollback');
  const merchantCountAfterRollback = rollbackDb.prepare('SELECT COUNT(*) as c FROM merchants').get().c;
  assert(merchantCountAfterRollback === 0, 'Rolled back completely: merchants table has 0 rows');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 3: INTEGER PAISE PRECISION & EXACT ACCOUNTING
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 3: Integer Paise Accounting Precision ---');
  const testRepo = createRepository(testDb);

  // Check migrated transactions have valid integer amount_paise
  const txRows = testDb.prepare('SELECT amount, amount_paise FROM transactions').all();
  let allPaiseValid = true;
  for (const r of txRows) {
    const expectedPaise = Math.round(Number(r.amount) * 100);
    if (r.amount_paise !== expectedPaise || !Number.isInteger(r.amount_paise)) {
      allPaiseValid = false;
      break;
    }
  }
  assert(allPaiseValid, 'All migrated transactions contain exact integer amount_paise = round(amount * 100)');

  // Test precision handling with decimal amounts
  const sampleMerchant = testRepo.merchants.create({
    id: 'mer_paise_test',
    email: 'paise_test@corp.in',
    businessName: 'Paise Test Store'
  });

  const decimalTx1 = testRepo.transactions.create({
    id: 'txn_paise_1',
    merchantId: sampleMerchant.id,
    reference: 'SP_PAISE_1',
    amount: 199.99,
    status: 'success'
  });
  const decimalTx2 = testRepo.transactions.create({
    id: 'txn_paise_2',
    merchantId: sampleMerchant.id,
    reference: 'SP_PAISE_2',
    amount: 0.01,
    status: 'success'
  });

  assert(decimalTx1.amount_paise === 19999, 'Amount ₹199.99 is stored as exactly 19999 paise');
  assert(decimalTx2.amount_paise === 1, 'Amount ₹0.01 is stored as exactly 1 paise');

  const stats = testRepo.transactions.getMerchantOverviewStats(sampleMerchant.id);
  assert(stats.volumePaise === 20000, 'Sum of volume in paise is exact integer 20000 paise (₹200.00)');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 4: REPOSITORY CRUD & PARAMETERIZED QUERIES
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 4: Repository CRUD & Constraints ---');

  // 1. Merchants
  const foundByEmail = testRepo.merchants.findByEmail('PAISE_TEST@CORP.IN');
  assert(foundByEmail !== null && foundByEmail.id === sampleMerchant.id, 'Case-insensitive merchant lookup by email works');
  testRepo.merchants.update(sampleMerchant.id, { businessName: 'Updated Store Name', suspended: true });
  const updatedM = testRepo.merchants.findById(sampleMerchant.id);
  assert(updatedM.businessName === 'Updated Store Name', 'Merchant businessName updated correctly');
  assert(updatedM.suspended === true, 'Merchant suspension state updated correctly');

  // 2. UPI Destinations & Default Flag Atomicity
  const u1 = testRepo.upis.create({
    id: 'upi_crud_1',
    merchantId: sampleMerchant.id,
    label: 'Primary UPI',
    upiId: 'paise1@oksbi',
    phoneNumber: '9876543210',
    default: true
  });
  const u2 = testRepo.upis.create({
    id: 'upi_crud_2',
    merchantId: sampleMerchant.id,
    label: 'Secondary UPI',
    upiId: 'paise2@okhdfc',
    phoneNumber: '9876543210',
    default: false
  });
  assert(u1.default === true, 'First UPI created as default');
  assert(u2.default === false, 'Second UPI created as non-default');

  // Toggle default to u2
  testRepo.upis.setDefault(sampleMerchant.id, u2.id);
  const upisAfterToggle = testRepo.upis.findByMerchant(sampleMerchant.id);
  const newU1 = upisAfterToggle.find(x => x.id === u1.id);
  const newU2 = upisAfterToggle.find(x => x.id === u2.id);
  assert(newU1.default === false && newU2.default === true, 'Atomic setDefault switched default to u2 and unset u1');

  // 3. Payment Links & Slug Uniqueness
  const link1 = testRepo.links.create({
    id: 'lnk_crud_1',
    merchantId: sampleMerchant.id,
    upiId: u2.upiId,
    name: 'Standard Subscription',
    slug: 'standard-sub',
    amount: 999,
    amountType: 'fixed',
    active: true
  });
  assert(testRepo.links.slugExists('standard-sub') === true, 'slugExists returns true for existing slug');
  assert(testRepo.links.slugExists('non-existent-slug') === false, 'slugExists returns false for unused slug');
  assert(link1.amount_paise === 99900, 'Link amount_paise correctly calculated as 99900');

  // 4. API Keys
  const testKeyPlain = 'sk_live_repo_test_key_secret_123';
  const testKeyHash = crypto.createHash('sha256').update(testKeyPlain).digest('hex');
  const apiKey = testRepo.apiKeys.create({
    id: 'key_crud_1',
    merchantId: sampleMerchant.id,
    name: 'Repository Test Key',
    prefix: testKeyPlain.slice(0, 12),
    hash: testKeyHash
  });
  const foundKey = testRepo.apiKeys.findByHash(testKeyHash);
  assert(foundKey !== null && foundKey.id === apiKey.id, 'API key lookup by hash matches');
  testRepo.apiKeys.updateLastUsed(apiKey.id);
  const keyAfterUse = testRepo.apiKeys.findById(apiKey.id);
  assert(keyAfterUse.lastUsedAt !== null, 'API key lastUsedAt updated');

  // 5. Business Accounts
  const bizAcc = testRepo.businessAccounts.create({
    id: 'biz_crud_1',
    merchantId: sampleMerchant.id,
    provider: 'phonepe',
    accountName: 'PhonePe Test Business',
    phoneNumber: '9876543210',
    merchantIdRef: 'PHONEPE_TEST_REF',
    token: encryptToken('test_salt'),
    saltIndex: '1',
    status: 'connected'
  });
  const foundBiz = testRepo.businessAccounts.findByProviderAndMid('phonepe', 'PHONEPE_TEST_REF');
  assert(foundBiz !== null && foundBiz.id === bizAcc.id, 'Business account lookup by provider and merchantIdRef matches');

  // 6. OAuth States (Single-Use Token Consumption)
  const oauthStateVal = 'oauth_state_secure_random_abc';
  testRepo.oauthStates.create(oauthStateVal, Date.now() + 60000);
  const firstConsume = testRepo.oauthStates.consume(oauthStateVal);
  assert(firstConsume === true, 'First OAuth state consumption succeeds');
  const secondConsume = testRepo.oauthStates.consume(oauthStateVal);
  assert(secondConsume === false, 'Second OAuth state consumption returns false (single-use enforced)');

  // 7. Error Logging & Diagnostics
  testRepo.errors.log({
    id: 'err_crud_1',
    merchantId: sampleMerchant.id,
    message: 'Test client error',
    url: 'https://sakkupay.onrender.com/pay/test'
  });
  const errList = testRepo.errors.list({ limit: 10 });
  assert(errList.some(e => e.id === 'err_crud_1'), 'Logged error appears in repository error list');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 5: REFERENTIAL INTEGRITY & CASCADE DELETION
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 5: Referential Integrity & Cascade Deletes ---');
  // Deleting sampleMerchant must cascade delete its upis, links, apiKeys, businessAccounts, and transactions
  testRepo.merchants.delete(sampleMerchant.id);
  const upisAfterCascade = testDb.prepare('SELECT COUNT(*) as c FROM upis WHERE merchantId = ?').get(sampleMerchant.id).c;
  const linksAfterCascade = testDb.prepare('SELECT COUNT(*) as c FROM links WHERE merchantId = ?').get(sampleMerchant.id).c;
  const txsAfterCascade = testDb.prepare('SELECT COUNT(*) as c FROM transactions WHERE merchantId = ?').get(sampleMerchant.id).c;
  const keysAfterCascade = testDb.prepare('SELECT COUNT(*) as c FROM apiKeys WHERE merchantId = ?').get(sampleMerchant.id).c;
  const bizAfterCascade = testDb.prepare('SELECT COUNT(*) as c FROM businessAccounts WHERE merchantId = ?').get(sampleMerchant.id).c;

  assert(upisAfterCascade === 0, 'Foreign key cascade deleted UPIs for deleted merchant');
  assert(linksAfterCascade === 0, 'Foreign key cascade deleted Links for deleted merchant');
  assert(txsAfterCascade === 0, 'Foreign key cascade deleted Transactions for deleted merchant');
  assert(keysAfterCascade === 0, 'Foreign key cascade deleted API keys for deleted merchant');
  assert(bizAfterCascade === 0, 'Foreign key cascade deleted Business accounts for deleted merchant');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 6: SQLITE WAL MODE & CONCURRENCY
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 6: SQLite WAL Mode & Concurrency Verification ---');
  const journalMode = testDb.prepare('PRAGMA journal_mode;').get().journal_mode;
  const foreignKeys = testDb.prepare('PRAGMA foreign_keys;').get().foreign_keys;
  const busyTimeout = testDb.prepare('PRAGMA busy_timeout;').get().timeout;

  assert(journalMode.toLowerCase() === 'wal', `Database journal_mode is WAL (actual: ${journalMode})`);
  assert(foreignKeys === 1, `Foreign keys are strictly enforced (PRAGMA foreign_keys = 1)`);
  assert(busyTimeout >= 5000, `Busy timeout configured to ${busyTimeout}ms (>= 5000ms)`);

  // Concurrent second connection test
  const testDb2 = createDatabaseConnection(testDbFile);
  const testRepo2 = createRepository(testDb2);
  const testMerchant2 = testRepo.merchants.create({
    id: 'mer_concurrency',
    email: 'concurrent@corp.in',
    businessName: 'Concurrent Corp'
  });
  // Read from connection 2 while connection 1 just wrote
  const readFromConn2 = testRepo2.merchants.findById('mer_concurrency');
  assert(readFromConn2 !== null && readFromConn2.id === 'mer_concurrency', 'Connection 2 immediately reads unblocked row committed by Connection 1');

  // Cleanup test database connections & files
  testRepo.merchants.delete('mer_concurrency');

  /* ────────────────────────────────────────────────────────────────────────────
     SECTION 7: MILESTONE 1 REGRESSION TESTS OVER LIVE SQLITE BACKEND
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n--- Section 7: Milestone 1 Security & API Regressions with Live SQLite ---');

  // Start HTTP server on port 0
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Live HTTP server running at ${baseUrl}`);

  try {
    // 1. PhonePe signature verification with live server
    const testPhonePeMid = 'PHONEPE_M2_MID';
    const testPhonePeSalt = 'm2_test_phonepe_salt_9876543210';
    const m2Merchant = serverRepo.merchants.create({
      id: 'mer_m2_sec',
      email: 'm2_sec@sakkupay.in',
      businessName: 'M2 Security Merchant'
    });
    serverRepo.businessAccounts.create({
      id: 'biz_m2_phonepe',
      merchantId: m2Merchant.id,
      provider: 'phonepe',
      accountName: 'M2 PhonePe Business',
      phoneNumber: '9876543210',
      merchantIdRef: testPhonePeMid,
      token: encryptToken(testPhonePeSalt),
      saltIndex: '1',
      status: 'connected'
    });
    serverRepo.transactions.create({
      id: 'txn_m2_phonepe',
      merchantId: m2Merchant.id,
      reference: 'SP_M2_PHONEPE',
      amount: 850,
      status: 'pending'
    });

    const m2Payload = {
      response: Buffer.from(JSON.stringify({
        success: true,
        code: 'PAYMENT_SUCCESS',
        data: { merchantId: testPhonePeMid, merchantTransactionId: 'SP_M2_PHONEPE', amount: 85000 }
      })).toString('base64')
    };
    const computedHash = crypto.createHash('sha256').update(m2Payload.response + testPhonePeSalt).digest('hex');
    const validXVerify = `${computedHash}###1`;

    const ppRes = await request(baseUrl, '/api/v1/webhook/phonepe', {
      method: 'POST',
      headers: { 'X-VERIFY': validXVerify },
      body: m2Payload
    });
    assert(ppRes.status === 200, 'Live PhonePe webhook returns HTTP 200 OK');
    assert(ppRes.data.verified === true, 'PhonePe webhook verified: true');

    const verifiedTx = serverRepo.transactions.findById('txn_m2_phonepe');
    assert(verifiedTx.status === 'success', 'Transaction in SQLite updated to success');
    assert(verifiedTx.amount_paise === 85000, 'Transaction has exact amount_paise 85000');
    assert(verifiedTx.verifiedBy === 'phonepe-direct', 'Verification method recorded as phonepe-direct');

    // 2. Block merchant self-approval regression test
    const patchRes = await request(baseUrl, `/api/transactions/txn_m2_phonepe`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token(m2Merchant)}` },
      body: { status: 'failed' }
    });
    assert(patchRes.status === 403, 'Merchant attempt to alter status returns HTTP 403 Forbidden');

    // 3. Legitimate merchant note update
    const noteRes = await request(baseUrl, `/api/transactions/txn_m2_phonepe`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token(m2Merchant)}` },
      body: { note: 'Verified by bank statement' }
    });
    assert(noteRes.status === 200, 'Legitimate merchant note update returns HTTP 200 OK');
    const noteTx = serverRepo.transactions.findById('txn_m2_phonepe');
    assert(noteTx.merchantNote === 'Verified by bank statement', 'Merchant note persisted to SQLite');

    // 4. Overview metrics API
    const overviewRes = await request(baseUrl, '/api/dashboard', {
      headers: { Authorization: `Bearer ${token(m2Merchant)}` }
    });
    assert(overviewRes.status === 200, 'Merchant dashboard overview returns HTTP 200 OK');
    assert(overviewRes.data.stats.volume === 850, 'Overview volume reflects ₹850');
    assert(overviewRes.data.stats.volumePaise === 85000, 'Overview volumePaise reflects 85000 paise');

    // Clean up test fixture
    serverRepo.merchants.delete(m2Merchant.id);

  } finally {
    await new Promise(resolve => server.close(resolve));
    console.log('Live HTTP test server closed cleanly.');
  }

  // Cleanup temporary test files
  try {
    if (fs.existsSync(testDbFile)) fs.unlinkSync(testDbFile);
    const walFile = testDbFile + '-wal';
    const shmFile = testDbFile + '-shm';
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
  } catch (_) {}

  /* ────────────────────────────────────────────────────────────────────────────
     SUMMARY
     ──────────────────────────────────────────────────────────────────────────── */
  console.log('\n==============================================================================');
  console.log(`TEST SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('==============================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runMilestone2Tests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

module.exports = { runMilestone2Tests };
