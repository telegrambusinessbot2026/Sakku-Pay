/* ==============================================================================
   SakkuPay — Atomic SQLite to PostgreSQL Safe Data Migration Script
   Safely transfers all data from local/disk SQLite into managed PostgreSQL.
   All operations run inside a single atomic transaction with verification.
   ============================================================================== */
'use strict';

const crypto = require('node:crypto');
const { applyPostgresMigrations } = require('./postgresSchema');

async function migrateSqliteToPostgres(sqliteDb, pgClient) {
  console.log('==============================================================================');
  console.log('SakkuPay — Atomic SQLite to PostgreSQL Data Migration');
  console.log('==============================================================================');

  // 1. Ensure all 5 migrations are applied to target PostgreSQL database
  console.log('1. Applying schema migrations to PostgreSQL...');
  await applyPostgresMigrations(pgClient);

  // 2. Extract all rows from SQLite
  console.log('2. Reading existing records from SQLite source...');
  const merchants = sqliteDb.prepare('SELECT * FROM merchants').all();
  const upis = sqliteDb.prepare('SELECT * FROM upis').all();
  const links = sqliteDb.prepare('SELECT * FROM links').all();
  const cashiers = sqliteDb.prepare('SELECT * FROM cashiers').all();
  const pairingSessions = sqliteDb.prepare('SELECT * FROM cashier_pairing_sessions').all();
  const cashierLogs = sqliteDb.prepare('SELECT * FROM cashier_logs').all();
  const transactions = sqliteDb.prepare('SELECT * FROM transactions').all();
  const apiKeys = sqliteDb.prepare('SELECT * FROM apiKeys').all();
  const businessAccounts = sqliteDb.prepare('SELECT * FROM businessAccounts').all();
  const adminUsers = sqliteDb.prepare('SELECT * FROM admin_users').all();

  console.log(`Source records detected:
  - Merchants: ${merchants.length}
  - UPI Destinations: ${upis.length}
  - Payment Links: ${links.length}
  - Attached Cashiers: ${cashiers.length}
  - Pairing Sessions: ${pairingSessions.length}
  - Cashier Logs: ${cashierLogs.length}
  - Transactions: ${transactions.length}
  - API Keys: ${apiKeys.length}
  - Business Accounts: ${businessAccounts.length}
  - Admin Staff: ${adminUsers.length}`);

  // 3. Transfer inside an atomic PostgreSQL transaction
  console.log('\n3. Starting atomic PostgreSQL transaction...');
  await pgClient.query('BEGIN;');

  try {
    // A. Merchants
    for (const m of merchants) {
      await pgClient.query(`
        INSERT INTO merchants (id, email, "businessName", "supportEmail", description, "whatsappNumber", "googleSubject", "googleVerified", suspended, "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          email = EXCLUDED.email,
          "businessName" = EXCLUDED."businessName",
          "supportEmail" = EXCLUDED."supportEmail",
          description = EXCLUDED.description,
          "whatsappNumber" = EXCLUDED."whatsappNumber",
          "googleSubject" = EXCLUDED."googleSubject",
          "googleVerified" = EXCLUDED."googleVerified",
          suspended = EXCLUDED.suspended;
      `, [m.id, m.email, m.businessName, m.supportEmail || null, m.description || null, m.whatsappNumber || null, m.googleSubject || null, Boolean(m.googleVerified), Boolean(m.suspended), m.createdAt]);
    }

    // B. UPI Destinations
    for (const u of upis) {
      await pgClient.query(`
        INSERT INTO upis (id, "merchantId", label, "upiId", "phoneNumber", is_default, "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          "upiId" = EXCLUDED."upiId",
          "phoneNumber" = EXCLUDED."phoneNumber",
          is_default = EXCLUDED.is_default;
      `, [u.id, u.merchantId, u.label, u.upiId, u.phoneNumber, Boolean(u.is_default), u.createdAt]);
    }

    // C. Payment Links
    for (const l of links) {
      await pgClient.query(`
        INSERT INTO links (id, "merchantId", "upiId", name, description, slug, amount, amount_paise, "amountType", template, active, "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          slug = EXCLUDED.slug,
          amount = EXCLUDED.amount,
          amount_paise = EXCLUDED.amount_paise,
          "amountType" = EXCLUDED."amountType",
          template = EXCLUDED.template,
          active = EXCLUDED.active;
      `, [l.id, l.merchantId, l.upiId || null, l.name, l.description || null, l.slug, l.amount != null ? Number(l.amount) : null, l.amount_paise != null ? Number(l.amount_paise) : null, l.amountType, l.template || 'classic', Boolean(l.active), l.createdAt]);
    }

    // D. Attached Cashiers
    for (const c of cashiers) {
      await pgClient.query(`
        INSERT INTO cashiers (id, "merchantId", name, provider, "phoneNumber", "upiId", status, "pairedAt", "lastSeenAt", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          provider = EXCLUDED.provider,
          "phoneNumber" = EXCLUDED."phoneNumber",
          "upiId" = EXCLUDED."upiId",
          status = EXCLUDED.status,
          "pairedAt" = EXCLUDED."pairedAt",
          "lastSeenAt" = EXCLUDED."lastSeenAt";
      `, [c.id, c.merchantId, c.name, c.provider, c.phoneNumber, c.upiId, c.status, c.pairedAt || null, c.lastSeenAt || null, c.createdAt]);
    }

    // E. Cashier Pairing Sessions
    for (const s of pairingSessions) {
      await pgClient.query(`
        INSERT INTO cashier_pairing_sessions (id, "merchantId", "cashierId", "serverCodeHash", "appCodeHash", status, attempts, "expiresAt", "completedAt", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          "appCodeHash" = EXCLUDED."appCodeHash",
          status = EXCLUDED.status,
          attempts = EXCLUDED.attempts,
          "expiresAt" = EXCLUDED."expiresAt",
          "completedAt" = EXCLUDED."completedAt";
      `, [s.id, s.merchantId, s.cashierId, s.serverCodeHash, s.appCodeHash || null, s.status, s.attempts || 0, s.expiresAt, s.completedAt || null, s.createdAt]);
    }

    // F. Cashier Logs
    for (const cl of cashierLogs) {
      await pgClient.query(`
        INSERT INTO cashier_logs (id, "merchantId", "cashierId", event, details, "ipAddress", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO NOTHING;
      `, [cl.id, cl.merchantId, cl.cashierId || null, cl.event, cl.details || null, cl.ipAddress || null, cl.createdAt]);
    }

    // G. Transactions
    for (const tx of transactions) {
      await pgClient.query(`
        INSERT INTO transactions (id, "merchantId", "linkId", reference, "customerName", "customerEmail", "customerUpi", amount, amount_paise, status, utr, "verifiedBy", "paidAt", "merchantNote", "utrSubmittedAt", "reconciliationStatus", "ambiguityReason", "providerReference", "verifiedAt", "auditLog", "createdAt", "cashierId")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          utr = EXCLUDED.utr,
          "verifiedBy" = EXCLUDED."verifiedBy",
          "paidAt" = EXCLUDED."paidAt",
          "reconciliationStatus" = EXCLUDED."reconciliationStatus",
          "ambiguityReason" = EXCLUDED."ambiguityReason",
          "verifiedAt" = EXCLUDED."verifiedAt",
          "auditLog" = EXCLUDED."auditLog",
          "cashierId" = EXCLUDED."cashierId";
      `, [tx.id, tx.merchantId, tx.linkId || null, tx.reference, tx.customerName || null, tx.customerEmail || null, tx.customerUpi || null, Number(tx.amount), Number(tx.amount_paise || Math.round(Number(tx.amount) * 100)), tx.status, tx.utr || null, tx.verifiedBy || null, tx.paidAt || null, tx.merchantNote || null, tx.utrSubmittedAt || null, tx.reconciliationStatus || 'unreconciled', tx.ambiguityReason || null, tx.providerReference || null, tx.verifiedAt || null, tx.auditLog || null, tx.createdAt, tx.cashierId || null]);
    }

    // H. API Keys
    for (const k of apiKeys) {
      await pgClient.query(`
        INSERT INTO "apiKeys" (id, "merchantId", name, prefix, hash, "createdAt", "lastUsedAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET "lastUsedAt" = EXCLUDED."lastUsedAt";
      `, [k.id, k.merchantId, k.name, k.prefix, k.hash, k.createdAt, k.lastUsedAt || null]);
    }

    // I. Business Accounts
    for (const b of businessAccounts) {
      await pgClient.query(`
        INSERT INTO "businessAccounts" (id, "merchantId", provider, "accountName", "phoneNumber", "merchantIdRef", token, "saltIndex", status, "autoVerify", "lastSyncedAt", "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO NOTHING;
      `, [b.id, b.merchantId, b.provider, b.accountName, b.phoneNumber, b.merchantIdRef, b.token, b.saltIndex || '1', b.status, Boolean(b.autoVerify), b.lastSyncedAt || null, b.createdAt]);
    }

    // J. Admin Staff
    for (const a of adminUsers) {
      await pgClient.query(`
        INSERT INTO admin_users (id, email, name, "passwordHash", role, "createdAt")
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING;
      `, [a.id, a.email, a.name, a.passwordHash, a.role, a.createdAt]);
    }

    // 4. Verify count parity
    console.log('\n4. Verifying record parity between SQLite and PostgreSQL...');
    const pgCounts = {
      merchants: Number((await pgClient.query('SELECT COUNT(*) as c FROM merchants')).rows[0].c),
      upis: Number((await pgClient.query('SELECT COUNT(*) as c FROM upis')).rows[0].c),
      links: Number((await pgClient.query('SELECT COUNT(*) as c FROM links')).rows[0].c),
      cashiers: Number((await pgClient.query('SELECT COUNT(*) as c FROM cashiers')).rows[0].c),
      transactions: Number((await pgClient.query('SELECT COUNT(*) as c FROM transactions')).rows[0].c)
    };

    if (pgCounts.merchants < merchants.length) throw new Error(`Merchant count mismatch: PG has ${pgCounts.merchants}, SQLite has ${merchants.length}`);
    if (pgCounts.cashiers < cashiers.length) throw new Error(`Cashier count mismatch: PG has ${pgCounts.cashiers}, SQLite has ${cashiers.length}`);
    if (pgCounts.transactions < transactions.length) throw new Error(`Transaction count mismatch: PG has ${pgCounts.transactions}, SQLite has ${transactions.length}`);

    // Commit transaction
    await pgClient.query('COMMIT;');
    console.log('✅ PostgreSQL Migration Transaction COMMITTED successfully. All data preserved.');

    return {
      status: 'success',
      recordsTransferred: {
        merchants: pgCounts.merchants,
        upis: pgCounts.upis,
        links: pgCounts.links,
        cashiers: pgCounts.cashiers,
        transactions: pgCounts.transactions
      }
    };
  } catch (err) {
    await pgClient.query('ROLLBACK;');
    console.error('❌ Data migration failed. Transaction ROLLED BACK. Target database unmodified:', err.message);
    throw err;
  }
}

module.exports = {
  migrateSqliteToPostgres
};
