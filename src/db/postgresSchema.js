/* ==============================================================================
   SakkuPay — Managed PostgreSQL Schema & Versioned Migrations
   Strictly typed, ACID-compliant schema with foreign key cascades,
   merchant isolation constraints, and indexes for all 5 migrations.
   ============================================================================== */
'use strict';

const POSTGRES_MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      -- 1. Merchants Table
      CREATE TABLE IF NOT EXISTS merchants (
        id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        "businessName" VARCHAR(255) NOT NULL,
        "supportEmail" VARCHAR(255),
        description TEXT,
        "whatsappNumber" VARCHAR(20),
        "googleSubject" VARCHAR(255),
        "googleVerified" BOOLEAN DEFAULT FALSE,
        suspended BOOLEAN DEFAULT FALSE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 2. UPI Receiving Destinations
      CREATE TABLE IF NOT EXISTS upis (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        label VARCHAR(100) NOT NULL,
        "upiId" VARCHAR(100) NOT NULL,
        "phoneNumber" VARCHAR(20) NOT NULL,
        is_default BOOLEAN DEFAULT FALSE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 3. Payment Links
      CREATE TABLE IF NOT EXISTS links (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        "upiId" VARCHAR(64),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        slug VARCHAR(255) UNIQUE NOT NULL,
        amount NUMERIC(12,2),
        amount_paise BIGINT,
        "amountType" VARCHAR(32) NOT NULL,
        template VARCHAR(64) DEFAULT 'classic',
        active BOOLEAN DEFAULT TRUE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 4. Transactions Ledger
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        "linkId" VARCHAR(64) REFERENCES links(id) ON DELETE SET NULL,
        reference VARCHAR(64) UNIQUE NOT NULL,
        "customerName" VARCHAR(255),
        "customerEmail" VARCHAR(255),
        "customerUpi" VARCHAR(100),
        amount NUMERIC(12,2) NOT NULL,
        amount_paise BIGINT NOT NULL,
        status VARCHAR(32) NOT NULL CHECK(status IN ('pending', 'success', 'failed', 'under_review', 'expired')),
        utr VARCHAR(64),
        "verifiedBy" VARCHAR(64),
        "paidAt" TIMESTAMPTZ,
        "merchantNote" TEXT,
        "utrSubmittedAt" TIMESTAMPTZ,
        "reconciliationStatus" VARCHAR(64) DEFAULT 'unreconciled',
        "ambiguityReason" TEXT,
        "providerReference" VARCHAR(128),
        "verifiedAt" TIMESTAMPTZ,
        "auditLog" TEXT,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 5. API Keys
      CREATE TABLE IF NOT EXISTS "apiKeys" (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        prefix VARCHAR(32) NOT NULL,
        hash VARCHAR(128) UNIQUE NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "lastUsedAt" TIMESTAMPTZ
      );

      -- 6. Business Accounts Vault
      CREATE TABLE IF NOT EXISTS "businessAccounts" (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        provider VARCHAR(64) NOT NULL,
        "accountName" VARCHAR(255) NOT NULL,
        "phoneNumber" VARCHAR(20) NOT NULL,
        "merchantIdRef" VARCHAR(128) NOT NULL,
        token TEXT NOT NULL,
        "saltIndex" VARCHAR(32) DEFAULT '1',
        status VARCHAR(64) NOT NULL,
        "autoVerify" BOOLEAN DEFAULT TRUE,
        "lastSyncedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 7. OAuth States
      CREATE TABLE IF NOT EXISTS "oauthStates" (
        state VARCHAR(128) PRIMARY KEY,
        "expiresAt" BIGINT NOT NULL
      );

      -- 8. Errors Log
      CREATE TABLE IF NOT EXISTS errors (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) REFERENCES merchants(id) ON DELETE SET NULL,
        message TEXT NOT NULL,
        stack TEXT,
        url TEXT,
        line INTEGER,
        col INTEGER,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Migration metadata & schema migrations tracker
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        name VARCHAR(255) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS migration_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source_sha256 VARCHAR(128) NOT NULL,
        source_counts_json TEXT NOT NULL
      );

      -- Essential Performance Indexes
      CREATE INDEX IF NOT EXISTS idx_transactions_merchantId ON transactions("merchantId");
      CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
      CREATE INDEX IF NOT EXISTS idx_transactions_utr ON transactions(utr);
      CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);
      CREATE INDEX IF NOT EXISTS idx_links_merchantId ON links("merchantId");
      CREATE INDEX IF NOT EXISTS idx_upis_merchantId ON upis("merchantId");
      CREATE INDEX IF NOT EXISTS idx_apiKeys_hash ON "apiKeys"(hash);
    `
  },
  {
    version: 2,
    name: 'admin_users_rbac',
    sql: `
      CREATE TABLE IF NOT EXISTS admin_users (
        id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        "passwordHash" VARCHAR(255) NOT NULL,
        role VARCHAR(64) NOT NULL CHECK(role IN ('SuperAdmin', 'OperationsSupport', 'ComplianceAuditor')),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  },
  {
    version: 3,
    name: 'payment_lifecycle_and_settlement_truth',
    sql: `
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS "reconciliationStatus" VARCHAR(64) DEFAULT 'unreconciled';
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS "ambiguityReason" TEXT;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS "providerReference" VARCHAR(128);
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMPTZ;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS "auditLog" TEXT;
      CREATE INDEX IF NOT EXISTS idx_transactions_reconciliationStatus ON transactions("reconciliationStatus");
    `
  },
  {
    version: 4,
    name: 'checkout_templates_and_branding',
    sql: `
      ALTER TABLE links ADD COLUMN IF NOT EXISTS template VARCHAR(64) DEFAULT 'classic';
      CREATE INDEX IF NOT EXISTS idx_links_template ON links(template);
    `
  },
  {
    version: 5,
    name: 'cashier_app_pairing_and_attribution',
    sql: `
      -- 1. Cashiers Table
      CREATE TABLE IF NOT EXISTS cashiers (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        provider VARCHAR(32) NOT NULL CHECK(provider IN ('phonepe', 'paytm', 'gpay', 'other')),
        "phoneNumber" VARCHAR(20) NOT NULL,
        "upiId" VARCHAR(100) NOT NULL,
        status VARCHAR(32) NOT NULL CHECK(status IN ('pending_pairing', 'paired', 'active', 'revoked')),
        "pairedAt" TIMESTAMPTZ,
        "lastSeenAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 2. Cashier Pairing Sessions
      CREATE TABLE IF NOT EXISTS cashier_pairing_sessions (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        "cashierId" VARCHAR(64) NOT NULL REFERENCES cashiers(id) ON DELETE CASCADE,
        "serverCodeHash" VARCHAR(128) NOT NULL,
        "appCodeHash" VARCHAR(128),
        status VARCHAR(32) NOT NULL CHECK(status IN ('pending_server_code', 'server_code_verified', 'app_code_generated', 'completed', 'expired', 'revoked')),
        attempts INTEGER DEFAULT 0,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "completedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 3. Cashier Security Logs
      CREATE TABLE IF NOT EXISTS cashier_logs (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        "cashierId" VARCHAR(64) REFERENCES cashiers(id) ON DELETE SET NULL,
        event VARCHAR(64) NOT NULL,
        details TEXT,
        "ipAddress" VARCHAR(64),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 4. Attribution Column on Transactions
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS "cashierId" VARCHAR(64) REFERENCES cashiers(id) ON DELETE SET NULL;

      -- 5. Indexes
      CREATE INDEX IF NOT EXISTS idx_cashiers_merchantId ON cashiers("merchantId");
      CREATE INDEX IF NOT EXISTS idx_cashier_pairing_sessions_serverCodeHash ON cashier_pairing_sessions("serverCodeHash");
      CREATE INDEX IF NOT EXISTS idx_cashier_logs_merchantId ON cashier_logs("merchantId");
      CREATE INDEX IF NOT EXISTS idx_transactions_cashierId ON transactions("cashierId");
    `
  },
  {
    version: 6,
    name: 'admin_audit_trail_and_support_queries',
    sql: `
      -- 1. Administrative Audit Trail
      CREATE TABLE IF NOT EXISTS admin_audit_trail (
        id VARCHAR(64) PRIMARY KEY,
        "actorId" VARCHAR(64) NOT NULL,
        "actorEmail" VARCHAR(255) NOT NULL,
        "actorRole" VARCHAR(64) NOT NULL,
        action VARCHAR(80) NOT NULL,
        "targetType" VARCHAR(50) NOT NULL,
        "targetId" VARCHAR(80),
        "reasonCode" VARCHAR(50) NOT NULL,
        justification TEXT NOT NULL,
        "beforeState" TEXT,
        "afterState" TEXT,
        "correlationId" VARCHAR(80),
        "ipAddress" VARCHAR(45),
        outcome VARCHAR(32) NOT NULL CHECK(outcome IN ('success', 'denied', 'failed')),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 2. Support Queries
      CREATE TABLE IF NOT EXISTS support_queries (
        id VARCHAR(64) PRIMARY KEY,
        "merchantId" VARCHAR(64) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        category VARCHAR(64) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'open',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- 3. Ensure admin_users has lastLoginAt and active columns
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMPTZ;
      ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;

      -- 4. Indexes
      CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_actorId ON admin_audit_trail("actorId");
      CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_action ON admin_audit_trail(action);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_targetId ON admin_audit_trail("targetId");
      CREATE INDEX IF NOT EXISTS idx_admin_audit_trail_createdAt ON admin_audit_trail("createdAt");
      CREATE INDEX IF NOT EXISTS idx_support_queries_merchantId ON support_queries("merchantId");
      CREATE INDEX IF NOT EXISTS idx_support_queries_createdAt ON support_queries("createdAt");
    `
  }
];

async function applyPostgresMigrations(client) {
  // Ensure schema_migrations table exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      name VARCHAR(255) NOT NULL
    );
  `);

  const appliedRes = await client.query('SELECT version FROM schema_migrations ORDER BY version ASC;');
  const appliedSet = new Set(appliedRes.rows.map(r => r.version));

  for (const m of POSTGRES_MIGRATIONS) {
    if (!appliedSet.has(m.version)) {
      console.log(`[PostgreSQL Migration] Applying Migration ${m.version}: ${m.name}...`);
      await client.query('BEGIN;');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, NOW());',
          [m.version, m.name]
        );
        await client.query('COMMIT;');
        console.log(`[PostgreSQL Migration] Migration ${m.version} applied successfully.`);
      } catch (err) {
        await client.query('ROLLBACK;');
        console.error(`[PostgreSQL Migration] Migration ${m.version} FAILED:`, err.message);
        throw err;
      }
    }
  }

  const finalRes = await client.query('SELECT MAX(version) as current_version FROM schema_migrations;');
  return finalRes.rows[0]?.current_version || 0;
}

module.exports = {
  POSTGRES_MIGRATIONS,
  applyPostgresMigrations
};
