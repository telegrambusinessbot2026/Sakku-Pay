/* ==============================================================================
   SakkuPay — Safe, Repeatable SQLite Migration Script
   Migrates data.json to SQLite within an atomic transaction.
   ============================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { initSchema } = require('./schema');

function migrateJsonToSqlite(db, jsonPath = path.join(__dirname, '../../data.json')) {
  if (!fs.existsSync(jsonPath)) {
    return { status: 'skipped', reason: 'data.json not found' };
  }

  initSchema(db);

  const fileBytes = fs.readFileSync(jsonPath);
  const sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
  const sourceData = JSON.parse(fileBytes.toString('utf8'));

  const sourceCounts = {
    merchants: (sourceData.merchants || []).length,
    upis: (sourceData.upis || []).length,
    links: (sourceData.links || []).length,
    transactions: (sourceData.transactions || []).length,
    apiKeys: (sourceData.apiKeys || []).length,
    businessAccounts: (sourceData.businessAccounts || []).length,
    oauthStates: (sourceData.oauthStates || []).length,
    errors: (sourceData.errors || []).length
  };

  // Check if migration has already been executed
  const existingMeta = db.prepare('SELECT * FROM migration_metadata WHERE id = 1').get();
  if (existingMeta) {
    const destCounts = {
      merchants: db.prepare('SELECT COUNT(*) as c FROM merchants').get().c,
      upis: db.prepare('SELECT COUNT(*) as c FROM upis').get().c,
      links: db.prepare('SELECT COUNT(*) as c FROM links').get().c,
      transactions: db.prepare('SELECT COUNT(*) as c FROM transactions').get().c,
      apiKeys: db.prepare('SELECT COUNT(*) as c FROM apiKeys').get().c,
      businessAccounts: db.prepare('SELECT COUNT(*) as c FROM businessAccounts').get().c
    };

    return {
      status: 'already_migrated',
      migratedAt: existingMeta.migrated_at,
      sourceHash: existingMeta.source_sha256,
      currentHash: sha256,
      counts: destCounts
    };
  }

  // Execute atomic migration inside a transaction
  db.exec('BEGIN TRANSACTION;');

  try {
    // 1. Merchants
    const insertMerchant = db.prepare(`
      INSERT INTO merchants (id, email, businessName, supportEmail, description, whatsappNumber, googleSubject, googleVerified, suspended, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of (sourceData.merchants || [])) {
      insertMerchant.run(
        m.id,
        m.email,
        m.businessName,
        m.supportEmail || null,
        m.description || null,
        m.whatsappNumber || null,
        m.googleSubject || null,
        m.googleVerified ? 1 : 0,
        m.suspended ? 1 : 0,
        m.createdAt || new Date().toISOString()
      );
    }

    // 2. UPI Destinations
    const insertUpi = db.prepare(`
      INSERT INTO upis (id, merchantId, label, upiId, phoneNumber, is_default, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const u of (sourceData.upis || [])) {
      insertUpi.run(
        u.id,
        u.merchantId,
        u.label || 'UPI Account',
        u.upiId,
        u.phoneNumber || '',
        u.default ? 1 : 0,
        u.createdAt || new Date().toISOString()
      );
    }

    // 3. Payment Links
    const insertLink = db.prepare(`
      INSERT INTO links (id, merchantId, upiId, name, description, slug, amount, amount_paise, amountType, active, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of (sourceData.links || [])) {
      const amountPaise = l.amount != null ? Math.round(Number(l.amount) * 100) : null;
      insertLink.run(
        l.id,
        l.merchantId,
        l.upiId,
        l.name,
        l.description || null,
        l.slug,
        l.amount != null ? Number(l.amount) : null,
        amountPaise,
        l.amountType || (l.amount != null ? 'fixed' : 'open'),
        l.active !== false ? 1 : 0,
        l.createdAt || new Date().toISOString()
      );
    }

    // 4. Transactions
    const insertTx = db.prepare(`
      INSERT INTO transactions (id, merchantId, linkId, reference, customerName, customerEmail, customerUpi, amount, amount_paise, status, utr, verifiedBy, paidAt, merchantNote, utrSubmittedAt, reconciliationStatus, ambiguityReason, providerReference, verifiedAt, auditLog, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of (sourceData.transactions || [])) {
      const amountPaise = Math.round(Number(t.amount || 0) * 100);
      insertTx.run(
        t.id,
        t.merchantId,
        t.linkId || null,
        t.reference,
        t.customerName || null,
        t.customerEmail || null,
        t.customerUpi || null,
        Number(t.amount || 0),
        amountPaise,
        t.status || 'pending',
        t.utr || null,
        t.verifiedBy || null,
        t.paidAt || null,
        t.merchantNote || null,
        t.utrSubmittedAt || null,
        t.reconciliationStatus || (t.status === 'success' ? 'settled' : 'unreconciled'),
        t.ambiguityReason || null,
        t.providerReference || null,
        t.verifiedAt || (t.status === 'success' ? t.paidAt : null),
        t.auditLog || null,
        t.createdAt || new Date().toISOString()
      );
    }

    // 5. API Keys
    const insertKey = db.prepare(`
      INSERT INTO apiKeys (id, merchantId, name, prefix, hash, createdAt, lastUsedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const k of (sourceData.apiKeys || [])) {
      insertKey.run(
        k.id,
        k.merchantId,
        k.name || 'API Key',
        k.prefix,
        k.hash,
        k.createdAt || new Date().toISOString(),
        k.lastUsedAt || null
      );
    }

    // 6. Business Accounts
    const insertBiz = db.prepare(`
      INSERT INTO businessAccounts (id, merchantId, provider, accountName, phoneNumber, merchantIdRef, token, saltIndex, status, autoVerify, lastSyncedAt, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const b of (sourceData.businessAccounts || [])) {
      insertBiz.run(
        b.id,
        b.merchantId,
        b.provider,
        b.accountName,
        b.phoneNumber,
        b.merchantIdRef,
        b.token,
        b.saltIndex || '1',
        b.status || 'connected',
        b.autoVerify !== false ? 1 : 0,
        b.lastSyncedAt || null,
        b.createdAt || new Date().toISOString()
      );
    }

    // 7. OAuth States
    const insertOAuth = db.prepare(`
      INSERT INTO oauthStates (state, expiresAt)
      VALUES (?, ?)
    `);
    for (const o of (sourceData.oauthStates || [])) {
      insertOAuth.run(o.state, o.expiresAt);
    }

    // 8. Client Diagnostics / Errors
    const insertErr = db.prepare(`
      INSERT INTO errors (id, merchantId, message, stack, url, line, col, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const e of (sourceData.errors || [])) {
      insertErr.run(
        e.id,
        e.merchantId || null,
        e.message,
        e.stack || null,
        e.url || null,
        e.line || null,
        e.col || null,
        e.createdAt || new Date().toISOString()
      );
    }

    // 9. Record Migration Metadata
    db.prepare(`
      INSERT INTO migration_metadata (id, migrated_at, source_sha256, source_counts_json)
      VALUES (1, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      sha256,
      JSON.stringify(sourceCounts)
    );

    // Verify destination counts match source counts before commit
    const destCounts = {
      merchants: db.prepare('SELECT COUNT(*) as c FROM merchants').get().c,
      upis: db.prepare('SELECT COUNT(*) as c FROM upis').get().c,
      links: db.prepare('SELECT COUNT(*) as c FROM links').get().c,
      transactions: db.prepare('SELECT COUNT(*) as c FROM transactions').get().c,
      apiKeys: db.prepare('SELECT COUNT(*) as c FROM apiKeys').get().c,
      businessAccounts: db.prepare('SELECT COUNT(*) as c FROM businessAccounts').get().c
    };

    for (const key of Object.keys(destCounts)) {
      if (destCounts[key] !== sourceCounts[key]) {
        throw new Error(`Migration verification failed: ${key} count mismatch (source: ${sourceCounts[key]}, dest: ${destCounts[key]})`);
      }
    }

    db.exec('COMMIT;');

    return {
      status: 'migrated_successfully',
      sourceHash: sha256,
      counts: destCounts
    };

  } catch (err) {
    db.exec('ROLLBACK;');
    throw new Error(`Migration aborted and rolled back: ${err.message}`);
  }
}

// Standalone execution support
if (require.main === module) {
  const { getDatabase } = require('./connection');
  const db = getDatabase();
  console.log('Starting SakkuPay data migration...');
  const res = migrateJsonToSqlite(db);
  console.log('Migration Result:', JSON.stringify(res, null, 2));
}

module.exports = {
  migrateJsonToSqlite
};
