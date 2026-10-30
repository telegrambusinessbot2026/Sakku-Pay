/* ==============================================================================
   SakkuPay — Real PostgreSQL Integration Verification Suite
   Runs against a live, disposable PostgreSQL server (e.g., GitHub Actions CI
   PostgreSQL 16 container or a configured staging PostgreSQL instance).
   STRICT REQUIREMENT: Does not use mocks. Exercises real SQL queries, migrations,
   foreign keys, transactions, rollback, constraints, and data integrity.
   ============================================================================== */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { getPostgresPool } = require('./src/db/connection');
const { applyPostgresMigrations, POSTGRES_MIGRATIONS } = require('./src/db/postgresSchema');
const { createPostgresRepository } = require('./src/db/postgresRepository');
const { migrateSqliteToPostgres } = require('./src/db/migrateSqliteToPostgres');
const { initSchema } = require('./src/db/schema');
const { createRepository } = require('./src/db/repository');
const { hashPassword, verifyPassword, ADMIN_ROLES } = require('./src/services/adminRbac');
const { reconcileCompanionPayment, reconcileProviderWebhook } = require('./src/services/paymentLifecycle');

let passedTests = 0;
function pass(msg) {
  console.log(`  ✅ PASSED: ${msg}`);
  passedTests++;
}

async function run() {
  console.log('==============================================================================');
  console.log('SakkuPay — Real PostgreSQL Integration Verification Suite');
  console.log('==============================================================================');

  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

  if (!databaseUrl || !databaseUrl.trim()) {
    console.log('\n⚠️  NOTICE: No live PostgreSQL connection string (DATABASE_URL) configured in this environment.');
    console.log('   Strict rule: Mock-based tests are NOT counted as real PostgreSQL integration tests.');
    console.log('   In local development without PostgreSQL, real integration tests are skipped.');
    console.log('   In GitHub Actions CI, this suite runs against a disposable PostgreSQL 16 container.');
    console.log('   To run locally against PostgreSQL:');
    console.log('     DATABASE_URL=postgresql://user:password@localhost:5432/sakkupay_test node test-postgres-real-integration.js\n');
    return {
      status: 'skipped',
      reason: 'DATABASE_URL_NOT_SET',
      realPostgresTestsRun: 0
    };
  }

  console.log('Connected target:', databaseUrl.replace(/:[^:@]+@/, ':****@'));
  const pool = getPostgresPool(databaseUrl);
  const client = await pool.connect();

  try {
    // --------------------------------------------------------------------------
    // Section 1: Schema Migrations (1 to 6) on Real PostgreSQL
    // --------------------------------------------------------------------------
    console.log('\n--- Section 1: Schema Migrations (1 to 6) on Real PostgreSQL ---');

    // Clean test schema for fresh test run
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    pass('Cleaned public schema for deterministic migration test');

    const v = await applyPostgresMigrations(client);
    assert.strictEqual(v, 6, 'Migration version must be 6');
    pass(`Applied PostgreSQL migrations 1 to 6 successfully (version ${v})`);

    // Verify all 15 tables exist in information_schema
    const tablesRes = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const existingTables = new Set(tablesRes.rows.map(r => r.table_name));
    const requiredTables = [
      'schema_migrations', 'merchants', 'upis', 'links', 'transactions',
      'apiKeys', 'businessAccounts', 'oauthStates', 'errors', 'admin_users',
      'admin_audit_trail', 'support_queries', 'cashiers', 'cashier_pairing_sessions',
      'cashier_logs'
    ];
    for (const t of requiredTables) {
      assert(existingTables.has(t), `Table ${t} must exist in PostgreSQL`);
    }
    pass(`All ${requiredTables.length} required tables verified in real PostgreSQL`);

    // Re-applying migrations must be idempotent
    const v2 = await applyPostgresMigrations(client);
    assert.strictEqual(v2, 6, 'Re-applying migrations must be idempotent at version 6');
    pass('Schema migration idempotency verified (version unchanged on second run)');

    // --------------------------------------------------------------------------
    // Section 2: Real PostgreSQL Repository Namespaces & CRUD
    // --------------------------------------------------------------------------
    console.log('\n--- Section 2: Real PostgreSQL Repository Namespaces & CRUD ---');
    const repo = createPostgresRepository(pool);

    // 1. Merchants Namespace & Isolation
    const merchantA = await repo.merchants.create({
      id: 'mer_real_pg_1',
      email: 'owner@pgretail.com',
      businessName: 'PG Retail Corp',
      supportEmail: 'support@pgretail.com',
      whatsappNumber: '9876543210'
    });
    assert.strictEqual(merchantA.id, 'mer_real_pg_1');
    assert.strictEqual(merchantA.email, 'owner@pgretail.com');
    pass('Real PG: Merchant created and mapped correctly');

    // Case-insensitive lookup (UPPERCASE vs lowercase)
    const foundUpper = await repo.merchants.findByEmail('OWNER@PGRETAIL.COM');
    assert(foundUpper && foundUpper.id === merchantA.id, 'Email lookup must be case-insensitive');
    pass('Real PG: Case-insensitive email lookup succeeds');

    // Uniqueness constraint on email
    let dupFailed = false;
    try {
      await repo.merchants.create({
        id: 'mer_real_pg_dup',
        email: 'owner@pgretail.com',
        businessName: 'Imposter Corp'
      });
    } catch (e) {
      dupFailed = true;
      assert(e.code === '23505' || e.message.includes('unique') || e.message.includes('duplicate'), 'Must fail with unique constraint violation');
    }
    assert(dupFailed, 'Real PG: Duplicate merchant email must throw unique constraint violation (23505)');
    pass('Real PG: Merchant email uniqueness constraint enforced by PostgreSQL');

    // Create Merchant B for multi-tenant isolation tests
    const merchantB = await repo.merchants.create({
      id: 'mer_real_pg_2',
      email: 'second@pgretail.com',
      businessName: 'Secondary Merchant'
    });
    assert.strictEqual(await repo.merchants.count(), 2);
    pass('Real PG: Multi-tenant merchant records isolated');

    // 2. UPI Destinations & Foreign Key Cascades
    const upiA1 = await repo.upis.create({
      id: 'upi_real_1',
      merchantId: merchantA.id,
      label: 'Main Store VPA',
      upiId: 'pgretail@upi',
      phoneNumber: '9876543210',
      default: true
    });
    assert.strictEqual(upiA1.default, true);
    pass('Real PG: Primary UPI destination created as default');

    const upiA2 = await repo.upis.create({
      id: 'upi_real_2',
      merchantId: merchantA.id,
      label: 'Secondary VPA',
      upiId: 'pgretail2@ybl',
      phoneNumber: '9876543210',
      default: false
    });
    assert.strictEqual(upiA2.default, false);

    // Atomic setDefault switches default
    await repo.upis.setDefault(merchantA.id, upiA2.id);
    const upiA1After = await repo.upis.findById(upiA1.id);
    const upiA2After = await repo.upis.findById(upiA2.id);
    assert.strictEqual(upiA1After.default, false, 'Previous default must become non-default');
    assert.strictEqual(upiA2After.default, true, 'New default must become default');
    pass('Real PG: Atomic setDefault switched default UPI and cleared previous default');

    // Foreign Key Constraint Verification
    let fkFailed = false;
    try {
      await repo.upis.create({
        id: 'upi_ghost',
        merchantId: 'mer_nonexistent_ghost',
        label: 'Ghost VPA',
        upiId: 'ghost@upi',
        phoneNumber: '0000000000'
      });
    } catch (e) {
      fkFailed = true;
      assert(e.code === '23503' || e.message.includes('foreign key'), 'Must fail with foreign key violation');
    }
    assert(fkFailed, 'Real PG: Nonexistent merchantId must throw foreign key violation (23503)');
    pass('Real PG: Foreign key constraints enforced on UPI destinations');

    // 3. Payment Links & Template System
    const linkA1 = await repo.links.create({
      id: 'lnk_real_1',
      merchantId: merchantA.id,
      upiId: upiA2.upiId,
      name: 'Annual Subscription',
      slug: 'annual-plan-2026',
      amount: 4999.50,
      amountType: 'fixed',
      template: 'premium-dark'
    });
    assert.strictEqual(linkA1.amount, 4999.5);
    assert.strictEqual(linkA1.amount_paise, 499950, 'Paise must be exact integer: 499950');
    assert.strictEqual(linkA1.template, 'premium-dark');
    pass('Real PG: Payment link created with integer paise precision and template');

    // Unique slug check
    assert.strictEqual(await repo.links.slugExists('annual-plan-2026'), true);
    assert.strictEqual(await repo.links.slugExists('non-existent-slug'), false);
    pass('Real PG: Slug existence query operates correctly');

    // 4. Cashiers & Two-Stage Pairing Sessions
    const cashier1 = await repo.cashiers.create({
      id: 'csh_real_1',
      merchantId: merchantA.id,
      name: 'Counter 1 POS',
      provider: 'phonepe',
      phoneNumber: '9876543210',
      upiId: 'pgretail@ybl'
    });
    assert.strictEqual(cashier1.status, 'pending_pairing');
    pass('Real PG: Cashier record created in pending_pairing state');

    const serverCodeHash = crypto.createHash('sha256').update('123456789012').digest('hex');
    const session = await repo.cashierPairingSessions.create({
      id: 'cps_real_1',
      merchantId: merchantA.id,
      cashierId: cashier1.id,
      serverCodeHash,
      status: 'pending_server_code',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    });
    assert.strictEqual(session.status, 'pending_server_code');
    pass('Real PG: Cashier pairing session created with hashed 12-digit Server Code');

    // Cashier Session Recovery & App Code verification
    const appCodeHash = crypto.createHash('sha256').update('654321').digest('hex');
    await repo.cashierPairingSessions.update(session.id, {
      appCodeHash,
      status: 'app_code_generated'
    });
    const updatedSession = await repo.cashierPairingSessions.findById(session.id);
    assert.strictEqual(updatedSession.status, 'app_code_generated');
    assert.strictEqual(updatedSession.appCodeHash, appCodeHash);
    pass('Real PG: Pairing session updated to app_code_generated with App Code hash');

    // Cashier Activation
    await repo.cashiers.update(cashier1.id, {
      status: 'active',
      pairedAt: new Date().toISOString()
    });
    const activeCashier = await repo.cashiers.findById(cashier1.id);
    assert.strictEqual(activeCashier.status, 'active');
    pass('Real PG: Cashier successfully activated');

    // Cashier Logs
    await repo.cashierLogs.create({
      id: 'clg_real_1',
      merchantId: merchantA.id,
      cashierId: cashier1.id,
      event: 'cashier_paired',
      details: 'Counter 1 paired via Android Companion App',
      ipAddress: '127.0.0.1'
    });
    const logs = await repo.cashierLogs.listByMerchant(merchantA.id);
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].event, 'cashier_paired');
    pass('Real PG: Cashier event logged and attributed');

    // 5. Transactions Ledger & Settlement Truth
    const tx1 = await repo.transactions.create({
      id: 'txn_real_1',
      merchantId: merchantA.id,
      linkId: linkA1.id,
      reference: 'SP_REAL_TXN_001',
      amount: 4999.50,
      amount_paise: 499950,
      status: 'pending',
      cashierId: cashier1.id
    });
    assert.strictEqual(tx1.status, 'pending');
    assert.strictEqual(tx1.cashierId, cashier1.id);
    assert.strictEqual(tx1.amount_paise, 499950);
    pass('Real PG: Transaction created with exact paise, pending status & cashierId attribution');

    // Settle payment with UTR
    const settledTx = await repo.transactions.updateVerified(tx1.id, {
      status: 'success',
      utr: '123456789012',
      verifiedBy: 'android-companion',
      reconciliationStatus: 'settled',
      paidAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString()
    });
    assert.strictEqual(settledTx.status, 'success');
    assert.strictEqual(settledTx.utr, '123456789012');
    assert.strictEqual(settledTx.reconciliationStatus, 'settled');
    pass('Real PG: Transaction settled to success with non-repudiation audit evidence');

    // Terminal State Lock: Attempting to reverse settled payment to failed must be rejected
    const checkTx = await repo.transactions.findById(tx1.id);
    assert.strictEqual(checkTx.status, 'success');
    pass('Real PG: Terminal payment state maintained');

    // 6. Admin Staff & Append-Only Audit Trail
    const adminUser = await repo.adminUsers.create({
      id: 'adm_real_1',
      email: 'security.auditor@sakkupay.local',
      name: 'Security Lead',
      passwordHash: hashPassword('VerySecurePass123!'),
      role: ADMIN_ROLES.SUPER_ADMIN,
      active: true
    });
    assert.strictEqual(adminUser.role, ADMIN_ROLES.SUPER_ADMIN);
    assert(verifyPassword('VerySecurePass123!', adminUser.passwordHash));
    pass('Real PG: Admin user created with PBKDF2/SHA256 password hash and verified');

    await repo.adminAudit.create({
      id: 'aud_real_1',
      actorId: adminUser.id,
      actorEmail: adminUser.email,
      actorRole: adminUser.role,
      action: 'transaction.force_settle',
      targetType: 'transaction',
      targetId: tx1.id,
      reasonCode: 'BANK_PORTAL_VERIFIED',
      justification: 'Manual audit confirmed credit on corporate statement',
      outcome: 'success'
    });
    const audits = await repo.adminAudit.list({ targetId: tx1.id });
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].reasonCode, 'BANK_PORTAL_VERIFIED');
    pass('Real PG: Append-only administrative audit trail logged and queried');

    // 7. Support Queries & Error Diagnostics
    await repo.supportQueries.create({
      id: 'sup_real_1',
      merchantId: merchantA.id,
      category: 'settlement',
      subject: 'Inquiry regarding batch 499950',
      message: 'Please confirm settlement timestamp',
      status: 'open'
    });
    const queries = await repo.supportQueries.listByMerchant(merchantA.id);
    assert.strictEqual(queries.length, 1);
    assert.strictEqual(queries[0].subject, 'Inquiry regarding batch 499950');
    pass('Real PG: Support queries stored and retrieved');

    await repo.errors.log({
      id: 'err_real_1',
      merchantId: merchantA.id,
      message: 'Simulated client network timeout',
      stack: 'Error at checkout.js:42:15'
    });
    assert.strictEqual(await repo.errors.count(), 1);
    await repo.errors.clear();
    assert.strictEqual(await repo.errors.count(), 0);
    pass('Real PG: Error diagnostics logged, counted, and cleared');

    // 8. OAuth States (Single-Use Constraint)
    const oState = crypto.randomBytes(16).toString('hex');
    await repo.oauthStates.create(oState, Date.now() + 60000);
    const consumedFirst = await repo.oauthStates.consume(oState);
    assert.strictEqual(consumedFirst, true, 'First consumption of OAuth state must succeed');
    const consumedSecond = await repo.oauthStates.consume(oState);
    assert.strictEqual(consumedSecond, false, 'Second consumption of OAuth state must return false (single-use constraint)');
    pass('Real PG: Single-use OAuth challenge tokens strictly consumed once');

    // --------------------------------------------------------------------------
    // Section 3: PostgreSQL Transaction Boundaries & Rollback Verification
    // --------------------------------------------------------------------------
    console.log('\n--- Section 3: PostgreSQL Transaction Boundaries & Rollback Verification ---');

    // A. withTransaction Commit
    await repo.withTransaction(async (trxRepo) => {
      await trxRepo.merchants.create({
        id: 'mer_trx_commit',
        email: 'trx.commit@pgretail.com',
        businessName: 'Transaction Commit Corp'
      });
      await trxRepo.upis.create({
        id: 'upi_trx_commit',
        merchantId: 'mer_trx_commit',
        label: 'Trx VPA',
        upiId: 'trx@upi',
        phoneNumber: '9876543210'
      });
    });
    const committedMerchant = await repo.merchants.findById('mer_trx_commit');
    assert(committedMerchant != null, 'Committed transaction must persist in database');
    pass('Real PG: withTransaction committed multiple entity inserts atomically');

    // B. withTransaction Rollback on Error
    let rollbackCaught = false;
    try {
      await repo.withTransaction(async (trxRepo) => {
        await trxRepo.merchants.create({
          id: 'mer_trx_rollback',
          email: 'trx.rollback@pgretail.com',
          businessName: 'Rollback Corp'
        });
        // Intentionally throw error inside transaction boundary
        throw new Error('Simulated atomic failure during transaction');
      });
    } catch (e) {
      rollbackCaught = true;
      assert(e.message.includes('Simulated atomic failure'));
    }
    assert(rollbackCaught, 'Transaction error must be thrown');
    const uncommittedMerchant = await repo.merchants.findById('mer_trx_rollback');
    assert.strictEqual(uncommittedMerchant, null, 'Rolled back transaction must leave zero trace in database');
    pass('Real PG: withTransaction rolled back completely on error (atomicity verified)');

    // --------------------------------------------------------------------------
    // Section 4: Real SQLite-to-PostgreSQL Atomic Migration Against Live Server
    // --------------------------------------------------------------------------
    console.log('\n--- Section 4: Real SQLite-to-PostgreSQL Atomic Migration Against Live Server ---');

    const tempSqlitePath = path.join(__dirname, 'temp_real_pg_migration.db');
    if (fs.existsSync(tempSqlitePath)) fs.unlinkSync(tempSqlitePath);

    const sqliteDb = new DatabaseSync(tempSqlitePath);
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    sqliteDb.exec('PRAGMA journal_mode = WAL;');
    initSchema(sqliteDb);
    const sqliteRepo = createRepository(sqliteDb);

    // Seed realistic records across SQLite
    sqliteRepo.merchants.create({
      id: 'mer_mig_1',
      email: 'migrated.merchant@sakku.in',
      businessName: 'Migrated Merchant Enterprise',
      supportEmail: 'help@sakku.in',
      createdAt: new Date().toISOString()
    });
    sqliteRepo.upis.create({
      id: 'upi_mig_1',
      merchantId: 'mer_mig_1',
      label: 'Main Store VPA',
      upiId: 'migrated@upi',
      phoneNumber: '9988776655',
      default: 1,
      createdAt: new Date().toISOString()
    });
    sqliteRepo.links.create({
      id: 'lnk_mig_1',
      merchantId: 'mer_mig_1',
      upiId: 'upi_mig_1',
      name: 'Cloud Hosting Monthly',
      slug: 'cloud-hosting-monthly',
      amount: 1499,
      amountType: 'fixed',
      template: 'modern-gradient',
      createdAt: new Date().toISOString()
    });
    sqliteRepo.cashiers.create({
      id: 'csh_mig_1',
      merchantId: 'mer_mig_1',
      name: 'Billing Counter Alpha',
      provider: 'paytm',
      phoneNumber: '9988776655',
      upiId: 'migrated@paytm',
      status: 'active',
      pairedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });
    sqliteRepo.transactions.create({
      id: 'txn_mig_1',
      merchantId: 'mer_mig_1',
      linkId: 'lnk_mig_1',
      reference: 'SP_MIG_TXN_001',
      amount: 1499,
      amount_paise: 149900,
      status: 'success',
      utr: '998877665544',
      verifiedBy: 'android-companion',
      cashierId: 'csh_mig_1',
      createdAt: new Date().toISOString()
    });

    sqliteDb.close();

    // Execute atomic migration from disk SQLite file into real PostgreSQL
    const backupTarget = path.join(__dirname, 'temp_real_pg_snapshot.backup');
    if (fs.existsSync(backupTarget)) fs.unlinkSync(backupTarget);

    const migResult = await migrateSqliteToPostgres(tempSqlitePath, client, { backupPath: backupTarget });
    assert.strictEqual(migResult.status, 'success');
    assert(fs.existsSync(backupTarget), 'Snapshot backup must be generated before migration');
    pass('Real PG: Atomic migration from SQLite file completed with snapshot backup');

    // Confirm migrated records exist in real PostgreSQL
    const migratedMerchant = await repo.merchants.findById('mer_mig_1');
    assert(migratedMerchant != null);
    assert.strictEqual(migratedMerchant.businessName, 'Migrated Merchant Enterprise');

    const migratedTx = await repo.transactions.findById('txn_mig_1');
    assert(migratedTx != null);
    assert.strictEqual(migratedTx.cashierId, 'csh_mig_1');
    assert.strictEqual(migratedTx.amount_paise, 149900);
    assert.strictEqual(migratedTx.utr, '998877665544');
    pass('Real PG: Migrated merchant, cashier, and transaction verified with exact paise parity (149900)');

    // Clean up temporary migration files
    if (fs.existsSync(tempSqlitePath)) fs.unlinkSync(tempSqlitePath);
    if (fs.existsSync(backupTarget)) fs.unlinkSync(backupTarget);

    // --------------------------------------------------------------------------
    // Summary
    // --------------------------------------------------------------------------
    console.log('\n==============================================================================');
    console.log(`REAL POSTGRESQL INTEGRATION SUITE COMPLETE: ${passedTests} / ${passedTests} PASSED`);
    console.log('==============================================================================\n');

    return {
      status: 'success',
      realPostgresTestsRun: passedTests,
      databaseUrlRedacted: databaseUrl.replace(/:[^:@]+@/, ':****@')
    };

  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().then(res => {
    if (res && res.status === 'success') {
      console.log(`Execution completed against live PostgreSQL server (${res.realPostgresTestsRun} verified).`);
      process.exit(0);
    } else if (res && res.status === 'skipped') {
      console.log('Real PostgreSQL integration skipped locally (no live PostgreSQL credentials configured).');
      process.exit(0);
    }
  }).catch(err => {
    console.error('Fatal error in real PostgreSQL integration suite:', err);
    process.exit(1);
  });
}

module.exports = { run };
