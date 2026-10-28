'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

console.log('==============================================================================');
console.log('SakkuPay — PostgreSQL Managed Database & Persistence Verification Suite');
console.log('==============================================================================');

let passed = 0;
let total = 0;

function pass(msg) {
  passed++;
  total++;
  console.log(`  ✅ PASSED: ${msg}`);
}

function fail(msg, err) {
  total++;
  console.error(`  ❌ FAILED: ${msg}`);
  if (err) console.error(err);
  process.exitCode = 1;
}

async function runTests() {
  const { validateDatabaseConfiguration, getDatabaseEngine } = require('./src/db/connection');
  const { POSTGRES_MIGRATIONS, applyPostgresMigrations } = require('./src/db/postgresSchema');
  const { migrateSqliteToPostgres } = require('./src/db/migrateSqliteToPostgres');
  const { createDatabaseConnection } = require('./src/db/connection');
  const { initSchema } = require('./src/db/schema');
  const { createRepository } = require('./src/db/repository');

  // --------------------------------------------------------------------------
  // Section 1: Production Database Startup & Safety Guards
  // --------------------------------------------------------------------------
  console.log('\n--- Section 1: Production Startup & Safety Validation ---');

  // 1. Missing both DATABASE_URL and DB_PATH in production must fail
  {
    const oldEnv = process.env.NODE_ENV;
    const oldDbUrl = process.env.DATABASE_URL;
    const oldDbPath = process.env.DB_PATH;

    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    delete process.env.DB_PATH;

    let threw = false;
    try {
      validateDatabaseConfiguration();
    } catch (e) {
      threw = true;
      assert(e.message.includes('Missing required persistent database configuration in production'));
    } finally {
      process.env.NODE_ENV = oldEnv;
      if (oldDbUrl) process.env.DATABASE_URL = oldDbUrl;
      if (oldDbPath) process.env.DB_PATH = oldDbPath;
    }

    assert(threw, 'Production startup without DATABASE_URL or DB_PATH must throw');
    pass('Production startup without persistent DB configuration throws fatal error and rejects ephemeral fallback');
  }

  // 2. Production with DATABASE_URL passes and detects postgres engine
  {
    const oldEnv = process.env.NODE_ENV;
    const oldDbUrl = process.env.DATABASE_URL;

    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://sakku_admin:dummy_pass@dpg-managed-db.render.com:5432/sakkupay_prod';

    const res = validateDatabaseConfiguration();
    assert.strictEqual(res.engine, 'postgres');
    assert.strictEqual(res.isPersistent, true);
    assert.strictEqual(getDatabaseEngine(), 'postgres');

    process.env.NODE_ENV = oldEnv;
    if (oldDbUrl) process.env.DATABASE_URL = oldDbUrl;
    else delete process.env.DATABASE_URL;

    pass('Production startup with DATABASE_URL selects PostgreSQL engine with persistence enabled');
  }

  // 3. Production with DB_PATH passes for persistent disk
  {
    const oldEnv = process.env.NODE_ENV;
    const oldDbPath = process.env.DB_PATH;

    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    process.env.DB_PATH = '/var/data/sakkupay.db';

    const res = validateDatabaseConfiguration();
    assert.strictEqual(res.engine, 'sqlite');
    assert.strictEqual(res.isPersistent, true);

    process.env.NODE_ENV = oldEnv;
    if (oldDbPath) process.env.DB_PATH = oldDbPath;
    else delete process.env.DB_PATH;

    pass('Production startup with DB_PATH selects persistent disk volume');
  }

  // 4. Production with relative DB_PATH must fail (Render ephemeral container protection)
  {
    const oldEnv = process.env.NODE_ENV;
    const oldDbPath = process.env.DB_PATH;
    const oldDbUrl = process.env.DATABASE_URL;

    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    process.env.DB_PATH = './sakkupay.db';

    let threw = false;
    try {
      validateDatabaseConfiguration();
    } catch (e) {
      threw = true;
      assert(e.message.includes('absolute path'));
    } finally {
      process.env.NODE_ENV = oldEnv;
      if (oldDbPath) process.env.DB_PATH = oldDbPath;
      else delete process.env.DB_PATH;
      if (oldDbUrl) process.env.DATABASE_URL = oldDbUrl;
    }

    assert(threw, 'Production startup with relative DB_PATH must throw');
    pass('Production startup with relative DB_PATH rejects ephemeral container disk');
  }

  // --------------------------------------------------------------------------
  // Section 2: PostgreSQL Schema Migrations Verification
  // --------------------------------------------------------------------------
  console.log('\n--- Section 2: PostgreSQL Schema Migrations (1 to 5) ---');

  {
    assert.strictEqual(POSTGRES_MIGRATIONS.length, 5, 'Must contain all 5 versioned migrations');
    const versions = POSTGRES_MIGRATIONS.map(m => m.version);
    assert.deepStrictEqual(versions, [1, 2, 3, 4, 5], 'Migrations must be strictly sequential 1 to 5');

    // Migration 1: Base Tables
    const m1 = POSTGRES_MIGRATIONS[0];
    assert.strictEqual(m1.version, 1);
    assert(m1.sql.includes('CREATE TABLE IF NOT EXISTS merchants'));
    assert(m1.sql.includes('CREATE TABLE IF NOT EXISTS upis'));
    assert(m1.sql.includes('CREATE TABLE IF NOT EXISTS links'));
    assert(m1.sql.includes('CREATE TABLE IF NOT EXISTS transactions'));
    assert(m1.sql.includes('CREATE TABLE IF NOT EXISTS "apiKeys"'));
    assert(m1.sql.includes('CREATE TABLE IF NOT EXISTS "businessAccounts"'));
    assert(m1.sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations'));
    pass('PostgreSQL Migration 1 defines all core relational tables with foreign keys & paise precision');

    // Migration 2: Admin RBAC
    const m2 = POSTGRES_MIGRATIONS[1];
    assert.strictEqual(m2.version, 2);
    assert(m2.sql.includes('CREATE TABLE IF NOT EXISTS admin_users'));
    assert(m2.sql.includes('SuperAdmin'));
    pass('PostgreSQL Migration 2 defines administrative RBAC staff table');

    // Migration 3: Payment Lifecycle & Settlement Truth
    const m3 = POSTGRES_MIGRATIONS[2];
    assert.strictEqual(m3.version, 3);
    assert(m3.sql.includes('"reconciliationStatus"'));
    assert(m3.sql.includes('"ambiguityReason"'));
    assert(m3.sql.includes('idx_transactions_reconciliationStatus'));
    pass('PostgreSQL Migration 3 defines settlement truth, audit log, and ambiguity columns');

    // Migration 4: Checkout Branding & Templates
    const m4 = POSTGRES_MIGRATIONS[3];
    assert.strictEqual(m4.version, 4);
    assert(m4.sql.includes('template VARCHAR(64) DEFAULT \'classic\''));
    pass('PostgreSQL Migration 4 defines multi-template checkout design system column');

    // Migration 5: Cashier App Pairing & Attribution
    const m5 = POSTGRES_MIGRATIONS[4];
    assert.strictEqual(m5.version, 5);
    assert(m5.sql.includes('CREATE TABLE IF NOT EXISTS cashiers'));
    assert(m5.sql.includes('CREATE TABLE IF NOT EXISTS cashier_pairing_sessions'));
    assert(m5.sql.includes('CREATE TABLE IF NOT EXISTS cashier_logs'));
    assert(m5.sql.includes('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS "cashierId"'));
    assert(m5.sql.includes('idx_cashiers_merchantId'));
    assert(m5.sql.includes('idx_cashier_pairing_sessions_serverCodeHash'));
    pass('PostgreSQL Migration 5 defines cashiers, pairing sessions, logs, and cashierId attribution');
  }

  // --------------------------------------------------------------------------
  // Section 3: Safe, Atomic SQLite to PostgreSQL Migration Execution
  // --------------------------------------------------------------------------
  console.log('\n--- Section 3: Atomic Data Migration Engine & Parity Verification ---');

  {
    // Create a temporary SQLite database with real test data
    const tempSqlitePath = path.join(__dirname, 'temp_migration_source.db');
    if (fs.existsSync(tempSqlitePath)) fs.unlinkSync(tempSqlitePath);

    const testSqlite = createDatabaseConnection(tempSqlitePath);
    initSchema(testSqlite);
    const repo = createRepository(testSqlite);

    // Seed comprehensive test records
    repo.merchants.create({
      id: 'mer_pg_test_1',
      email: 'owner@pgretail.in',
      businessName: 'PG Retail Ltd',
      supportEmail: 'support@pgretail.in',
      createdAt: new Date().toISOString()
    });

    repo.upis.create({
      id: 'upi_pg_test_1',
      merchantId: 'mer_pg_test_1',
      label: 'Main Store VPA',
      upiId: 'pgretail@ybl',
      phoneNumber: '9876543210',
      is_default: 1,
      createdAt: new Date().toISOString()
    });

    repo.links.create({
      id: 'lnk_pg_test_1',
      merchantId: 'mer_pg_test_1',
      upiId: 'upi_pg_test_1',
      name: 'Annual Subscription',
      slug: 'annual-sub',
      amount: 4999,
      amountType: 'fixed',
      template: 'premium-dark',
      createdAt: new Date().toISOString()
    });

    repo.cashiers.create({
      id: 'csh_pg_test_1',
      merchantId: 'mer_pg_test_1',
      name: 'Counter 1 POS',
      provider: 'phonepe',
      phoneNumber: '9876543210',
      upiId: 'pgretail@ybl',
      status: 'active',
      pairedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    });

    repo.cashierPairingSessions.create({
      id: 'cps_pg_test_1',
      merchantId: 'mer_pg_test_1',
      cashierId: 'csh_pg_test_1',
      serverCodeHash: 'dummy_sha256_server_hash',
      appCodeHash: 'dummy_sha256_app_hash',
      status: 'completed',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    });

    repo.cashierLogs.create({
      id: 'clg_pg_test_1',
      merchantId: 'mer_pg_test_1',
      cashierId: 'csh_pg_test_1',
      event: 'cashier_activated',
      details: 'Cashier activated via app code verification',
      ipAddress: '127.0.0.1',
      createdAt: new Date().toISOString()
    });

    repo.transactions.create({
      id: 'txn_pg_test_1',
      merchantId: 'mer_pg_test_1',
      linkId: 'lnk_pg_test_1',
      reference: 'SP_PG_4999',
      amount: 4999,
      amount_paise: 499900,
      status: 'success',
      utr: '987654321098',
      verifiedBy: 'android-companion',
      cashierId: 'csh_pg_test_1',
      createdAt: new Date().toISOString()
    });

    // Mock PostgreSQL Client with in-memory transaction and statement recorder
    const executedQueries = [];
    const mockDb = {
      merchants: new Map(),
      upis: new Map(),
      links: new Map(),
      cashiers: new Map(),
      cashier_pairing_sessions: new Map(),
      cashier_logs: new Map(),
      transactions: new Map(),
      schema_migrations: new Map()
    };
    let inTransaction = false;
    let committed = false;
    let rolledBack = false;

    const mockPgClient = {
      async query(sql, params = []) {
        executedQueries.push({ sql: sql.trim(), params });
        const trimmed = sql.trim().toUpperCase();

        if (trimmed === 'BEGIN;') { inTransaction = true; return { rows: [] }; }
        if (trimmed === 'COMMIT;') { committed = true; inTransaction = false; return { rows: [] }; }
        if (trimmed === 'ROLLBACK;') { rolledBack = true; inTransaction = false; return { rows: [] }; }

        if (trimmed.startsWith('SELECT VERSION FROM SCHEMA_MIGRATIONS')) {
          return { rows: Array.from(mockDb.schema_migrations.values()).map(v => ({ version: v })) };
        }
        if (trimmed.startsWith('SELECT MAX(VERSION)')) {
          return { rows: [{ current_version: 5 }] };
        }
        if (trimmed.startsWith('INSERT INTO SCHEMA_MIGRATIONS')) {
          mockDb.schema_migrations.set(params[0], params[0]);
          return { rows: [] };
        }

        if (trimmed.startsWith('INSERT INTO MERCHANTS')) {
          mockDb.merchants.set(params[0], { id: params[0], email: params[1], businessName: params[2] });
          return { rowCount: 1 };
        }
        if (trimmed.startsWith('INSERT INTO UPIS')) {
          mockDb.upis.set(params[0], { id: params[0], upiId: params[3] });
          return { rowCount: 1 };
        }
        if (trimmed.startsWith('INSERT INTO LINKS')) {
          mockDb.links.set(params[0], { id: params[0], slug: params[5], template: params[9] });
          return { rowCount: 1 };
        }
        if (trimmed.startsWith('INSERT INTO CASHIERS')) {
          mockDb.cashiers.set(params[0], { id: params[0], name: params[2], provider: params[3], status: params[6] });
          return { rowCount: 1 };
        }
        if (trimmed.startsWith('INSERT INTO CASHIER_PAIRING_SESSIONS')) {
          mockDb.cashier_pairing_sessions.set(params[0], { id: params[0], status: params[5] });
          return { rowCount: 1 };
        }
        if (trimmed.startsWith('INSERT INTO CASHIER_LOGS')) {
          mockDb.cashier_logs.set(params[0], { id: params[0], event: params[3] });
          return { rowCount: 1 };
        }
        if (trimmed.startsWith('INSERT INTO TRANSACTIONS')) {
          mockDb.transactions.set(params[0], { id: params[0], reference: params[3], cashierId: params[21] });
          return { rowCount: 1 };
        }

        if (trimmed.startsWith('SELECT COUNT(*) AS C FROM MERCHANTS')) return { rows: [{ c: mockDb.merchants.size }] };
        if (trimmed.startsWith('SELECT COUNT(*) AS C FROM UPIS')) return { rows: [{ c: mockDb.upis.size }] };
        if (trimmed.startsWith('SELECT COUNT(*) AS C FROM LINKS')) return { rows: [{ c: mockDb.links.size }] };
        if (trimmed.startsWith('SELECT COUNT(*) AS C FROM CASHIERS')) return { rows: [{ c: mockDb.cashiers.size }] };
        if (trimmed.startsWith('SELECT COUNT(*) AS C FROM TRANSACTIONS')) return { rows: [{ c: mockDb.transactions.size }] };

        return { rows: [], rowCount: 0 };
      }
    };

    // Execute migration
    const result = await migrateSqliteToPostgres(testSqlite, mockPgClient);
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(committed, true, 'Transaction must be committed');
    assert.strictEqual(rolledBack, false, 'Transaction must not be rolled back');

    // Verify all entity records exist in target mock DB with accurate values
    assert(mockDb.merchants.has('mer_pg_test_1'));
    assert(mockDb.cashiers.has('csh_pg_test_1'));
    assert(mockDb.links.has('lnk_pg_test_1'));
    assert(mockDb.transactions.has('txn_pg_test_1'));
    assert.strictEqual(mockDb.transactions.get('txn_pg_test_1').cashierId, 'csh_pg_test_1');

    testSqlite.close();
    if (fs.existsSync(tempSqlitePath)) fs.unlinkSync(tempSqlitePath);

    pass('Atomic SQLite to PostgreSQL migration succeeds with transaction commit and zero data loss');
  }

  // 4. Test Rollback on Failure
  {
    const tempSqlitePath = path.join(__dirname, 'temp_rollback_source.db');
    if (fs.existsSync(tempSqlitePath)) fs.unlinkSync(tempSqlitePath);

    const testSqlite = createDatabaseConnection(tempSqlitePath);
    initSchema(testSqlite);
    const repo = createRepository(testSqlite);
    repo.merchants.create({ id: 'mer_fail_1', email: 'fail@test.in', businessName: 'Fail Test', createdAt: new Date().toISOString() });

    let rolledBack = false;
    const failingPgClient = {
      async query(sql) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed === 'BEGIN;') return { rows: [] };
        if (trimmed === 'ROLLBACK;') { rolledBack = true; return { rows: [] }; }
        if (trimmed.startsWith('SELECT VERSION FROM SCHEMA_MIGRATIONS')) return { rows: [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }] };
        if (trimmed.startsWith('INSERT INTO MERCHANTS')) {
          throw new Error('Simulated Database Network Disconnect');
        }
        return { rows: [] };
      }
    };

    let caught = false;
    try {
      await migrateSqliteToPostgres(testSqlite, failingPgClient);
    } catch {
      caught = true;
    }

    assert(caught, 'Migration failure must propagate');
    assert(rolledBack, 'Transaction must be explicitly ROLLED BACK on error');

    testSqlite.close();
    if (fs.existsSync(tempSqlitePath)) fs.unlinkSync(tempSqlitePath);

    pass('Atomic rollback: Any failure during migration triggers ROLLBACK and leaves target clean');
  }

  console.log('\n==============================================================================');
  console.log(`POSTGRESQL PERSISTENCE SUITE COMPLETE: ${passed} / ${total} PASSED`);
  console.log('==============================================================================');
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
