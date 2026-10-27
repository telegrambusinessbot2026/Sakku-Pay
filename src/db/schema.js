/* ==============================================================================
   SakkuPay — SQLite Schema Definition
   Relational DDL with integrity constraints, indexes, and migration tracking.
   ============================================================================== */
'use strict';

const SCHEMA_SQL = `
-- 1. Merchants Table
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  businessName TEXT NOT NULL,
  supportEmail TEXT,
  description TEXT,
  whatsappNumber TEXT,
  googleSubject TEXT UNIQUE,
  googleVerified INTEGER DEFAULT 1,
  suspended INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL
);

-- 2. UPI Destinations Table
CREATE TABLE IF NOT EXISTS upis (
  id TEXT PRIMARY KEY,
  merchantId TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  upiId TEXT NOT NULL,
  phoneNumber TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL
);

-- 3. Payment Links Table
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  merchantId TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  upiId TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  slug TEXT UNIQUE NOT NULL,
  amount REAL,
  amount_paise INTEGER,
  amountType TEXT NOT NULL CHECK(amountType IN ('fixed', 'open')),
  active INTEGER DEFAULT 1,
  createdAt TEXT NOT NULL
);

-- 4. Transactions Ledger Table
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  merchantId TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  linkId TEXT REFERENCES links(id) ON DELETE SET NULL,
  reference TEXT UNIQUE NOT NULL,
  customerName TEXT,
  customerEmail TEXT,
  customerUpi TEXT,
  amount REAL NOT NULL,
  amount_paise INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'success', 'failed', 'under_review', 'expired')),
  utr TEXT,
  verifiedBy TEXT,
  paidAt TEXT,
  merchantNote TEXT,
  utrSubmittedAt TEXT,
  reconciliationStatus TEXT DEFAULT 'unreconciled',
  ambiguityReason TEXT,
  providerReference TEXT,
  verifiedAt TEXT,
  auditLog TEXT,
  createdAt TEXT NOT NULL
);

-- 5. API Keys Table
CREATE TABLE IF NOT EXISTS apiKeys (
  id TEXT PRIMARY KEY,
  merchantId TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT
);

-- 6. Business Accounts (Vault) Table
CREATE TABLE IF NOT EXISTS businessAccounts (
  id TEXT PRIMARY KEY,
  merchantId TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  accountName TEXT NOT NULL,
  phoneNumber TEXT NOT NULL,
  merchantIdRef TEXT NOT NULL,
  token TEXT NOT NULL,
  saltIndex TEXT DEFAULT '1',
  status TEXT NOT NULL,
  autoVerify INTEGER DEFAULT 1,
  lastSyncedAt TEXT,
  createdAt TEXT NOT NULL
);

-- 7. OAuth States Table (Temporary Tokens)
CREATE TABLE IF NOT EXISTS oauthStates (
  state TEXT PRIMARY KEY,
  expiresAt INTEGER NOT NULL
);

-- 8. Client Diagnostics & Error Logs Table
CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY,
  merchantId TEXT REFERENCES merchants(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  stack TEXT,
  url TEXT,
  line INTEGER,
  col INTEGER,
  createdAt TEXT NOT NULL
);

-- 9. Migration Metadata Table
CREATE TABLE IF NOT EXISTS migration_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  migrated_at TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_counts_json TEXT NOT NULL
);

-- 10. Schema Migrations History Table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  name TEXT NOT NULL
);

-- 11. Administrative RBAC Staff Table (Milestone 4)
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('SuperAdmin', 'OperationsSupport', 'ComplianceAuditor')),
  active INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  lastLoginAt TEXT
);

-- 12. Append-Only Administrative Audit Trail (Milestone 4)
CREATE TABLE IF NOT EXISTS admin_audit_trail (
  id TEXT PRIMARY KEY,
  actorId TEXT NOT NULL,
  actorEmail TEXT NOT NULL,
  actorRole TEXT NOT NULL,
  action TEXT NOT NULL,
  targetType TEXT NOT NULL,
  targetId TEXT,
  reasonCode TEXT NOT NULL,
  justification TEXT NOT NULL,
  beforeState TEXT,
  afterState TEXT,
  correlationId TEXT,
  ipAddress TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'denied', 'failed')),
  createdAt TEXT NOT NULL
);

-- Append-only trigger protections
CREATE TRIGGER IF NOT EXISTS prevent_admin_audit_update
BEFORE UPDATE ON admin_audit_trail
BEGIN
  SELECT RAISE(ABORT, 'admin_audit_trail is append-only: updates are forbidden');
END;

CREATE TRIGGER IF NOT EXISTS prevent_admin_audit_delete
BEFORE DELETE ON admin_audit_trail
BEGIN
  SELECT RAISE(ABORT, 'admin_audit_trail is append-only: deletes are forbidden');
END;

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions(merchantId);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_transactions_utr ON transactions(utr);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(createdAt);
CREATE INDEX IF NOT EXISTS idx_links_merchant ON links(merchantId);
CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);
CREATE INDEX IF NOT EXISTS idx_upis_merchant ON upis(merchantId);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON apiKeys(hash);
CREATE INDEX IF NOT EXISTS idx_biz_acc_provider_mid ON businessAccounts(provider, merchantIdRef);
CREATE INDEX IF NOT EXISTS idx_oauth_expires ON oauthStates(expiresAt);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_trail(action);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_trail(targetType, targetId);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_trail(actorId);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_trail(createdAt);
`;

function applyMigrations(db) {
  // Ensure schema_migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL,
      name TEXT NOT NULL
    );
  `);

  // Migration Version 2: Milestone 3 Reconciliation & Lifecycle Hardening
  const v2 = db.prepare('SELECT version FROM schema_migrations WHERE version = 2').get();
  if (!v2) {
    const cols = db.prepare('PRAGMA table_info(transactions);').all().map(c => c.name);

    if (!cols.includes('reconciliationStatus')) {
      db.exec("ALTER TABLE transactions ADD COLUMN reconciliationStatus TEXT DEFAULT 'unreconciled';");
    }
    if (!cols.includes('ambiguityReason')) {
      db.exec("ALTER TABLE transactions ADD COLUMN ambiguityReason TEXT;");
    }
    if (!cols.includes('providerReference')) {
      db.exec("ALTER TABLE transactions ADD COLUMN providerReference TEXT;");
    }
    if (!cols.includes('verifiedAt')) {
      db.exec("ALTER TABLE transactions ADD COLUMN verifiedAt TEXT;");
    }
    if (!cols.includes('auditLog')) {
      db.exec("ALTER TABLE transactions ADD COLUMN auditLog TEXT;");
    }

    db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_recon ON transactions(reconciliationStatus);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_transactions_provider_ref ON transactions(providerReference);");

    db.prepare(`
      INSERT INTO schema_migrations (version, applied_at, name)
      VALUES (2, ?, 'milestone3_payment_lifecycle_reconciliation')
    `).run(new Date().toISOString());
  }

  // Migration Version 3: Milestone 4 Admin RBAC & Append-Only Audit Trail
  const v3 = db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get();
  if (!v3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        passwordHash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('SuperAdmin', 'OperationsSupport', 'ComplianceAuditor')),
        active INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        lastLoginAt TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_audit_trail (
        id TEXT PRIMARY KEY,
        actorId TEXT NOT NULL,
        actorEmail TEXT NOT NULL,
        actorRole TEXT NOT NULL,
        action TEXT NOT NULL,
        targetType TEXT NOT NULL,
        targetId TEXT,
        reasonCode TEXT NOT NULL,
        justification TEXT NOT NULL,
        beforeState TEXT,
        afterState TEXT,
        correlationId TEXT,
        ipAddress TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'denied', 'failed')),
        createdAt TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS prevent_admin_audit_update
      BEFORE UPDATE ON admin_audit_trail
      BEGIN
        SELECT RAISE(ABORT, 'admin_audit_trail is append-only: updates are forbidden');
      END;

      CREATE TRIGGER IF NOT EXISTS prevent_admin_audit_delete
      BEFORE DELETE ON admin_audit_trail
      BEGIN
        SELECT RAISE(ABORT, 'admin_audit_trail is append-only: deletes are forbidden');
      END;

      CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
      CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_trail(action);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_trail(targetType, targetId);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_trail(actorId);
      CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_trail(createdAt);
    `);

    db.prepare(`
      INSERT INTO schema_migrations (version, applied_at, name)
      VALUES (3, ?, 'milestone4_admin_rbac_and_audit_trail')
    `).run(new Date().toISOString());
  }
}

function initSchema(db) {
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
}

module.exports = {
  SCHEMA_SQL,
  initSchema,
  applyMigrations
};
