/* ==============================================================================
   SakkuPay — SQLite Repository & Data Access Layer
   Strongly-typed, prepared statement-backed repository layer for all entities.
   Includes integer paise precision, foreign key cascade, and legacy sync.
   ============================================================================== */
'use strict';

const crypto = require('node:crypto');
const { getDatabase } = require('./connection');
const { initSchema } = require('./schema');
const { logAdminAudit } = require('../services/adminAudit');

function createRepository(db = getDatabase()) {
  initSchema(db);

  // Helper row mappers
  function mapMerchant(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      businessName: row.businessName,
      supportEmail: row.supportEmail || null,
      description: row.description || '',
      whatsappNumber: row.whatsappNumber || '',
      googleSubject: row.googleSubject || null,
      googleVerified: Boolean(row.googleVerified),
      suspended: Boolean(row.suspended),
      createdAt: row.createdAt
    };
  }

  function mapUpi(row) {
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      label: row.label,
      upiId: row.upiId,
      phoneNumber: row.phoneNumber,
      default: Boolean(row.is_default),
      createdAt: row.createdAt
    };
  }

  function mapLink(row) {
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      upiId: row.upiId,
      name: row.name,
      description: row.description || '',
      slug: row.slug,
      amount: row.amount != null ? Number(row.amount) : null,
      amount_paise: row.amount_paise != null ? Number(row.amount_paise) : null,
      amountType: row.amountType,
      template: row.template || 'classic',
      active: Boolean(row.active),
      createdAt: row.createdAt
    };
  }

  function mapTransaction(row) {
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      linkId: row.linkId || null,
      reference: row.reference,
      customerName: row.customerName || '',
      customerEmail: row.customerEmail || '',
      customerUpi: row.customerUpi || null,
      amount: Number(row.amount),
      amount_paise: Number(row.amount_paise != null ? row.amount_paise : Math.round(Number(row.amount) * 100)),
      status: row.status,
      utr: row.utr || null,
      verifiedBy: row.verifiedBy || null,
      paidAt: row.paidAt || null,
      merchantNote: row.merchantNote || null,
      utrSubmittedAt: row.utrSubmittedAt || null,
      reconciliationStatus: row.reconciliationStatus || 'unreconciled',
      ambiguityReason: row.ambiguityReason || null,
      providerReference: row.providerReference || null,
      verifiedAt: row.verifiedAt || null,
      auditLog: row.auditLog || null,
      createdAt: row.createdAt,
      cashierId: row.cashierId || null
    };
  }

  function mapApiKey(row) {
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      name: row.name,
      prefix: row.prefix,
      hash: row.hash,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt || null
    };
  }

  function mapBusinessAccount(row) {
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId,
      provider: row.provider,
      accountName: row.accountName,
      phoneNumber: row.phoneNumber,
      merchantIdRef: row.merchantIdRef,
      token: row.token,
      saltIndex: row.saltIndex || '1',
      status: row.status,
      autoVerify: Boolean(row.autoVerify),
      lastSyncedAt: row.lastSyncedAt || null,
      createdAt: row.createdAt
    };
  }

  function mapOAuthState(row) {
    if (!row) return null;
    return {
      state: row.state,
      expiresAt: Number(row.expiresAt)
    };
  }

  function mapError(row) {
    if (!row) return null;
    return {
      id: row.id,
      merchantId: row.merchantId || null,
      message: row.message,
      stack: row.stack || null,
      url: row.url || null,
      line: row.line != null ? Number(row.line) : null,
      col: row.col != null ? Number(row.col) : null,
      createdAt: row.createdAt
    };
  }

  function mapAdminUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      role: row.role,
      active: Boolean(row.active),
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt || null
    };
  }

  function mapAdminAudit(row) {
    if (!row) return null;
    let beforeState = null, afterState = null;
    try { if (row.beforeState) beforeState = JSON.parse(row.beforeState); } catch (_) {}
    try { if (row.afterState) afterState = JSON.parse(row.afterState); } catch (_) {}
    return {
      id: row.id,
      actorId: row.actorId,
      actorEmail: row.actorEmail,
      actorRole: row.actorRole,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId || null,
      reasonCode: row.reasonCode,
      justification: row.justification,
      beforeState,
      afterState,
      correlationId: row.correlationId || null,
      ipAddress: row.ipAddress || null,
      outcome: row.outcome,
      createdAt: row.createdAt
    };
  }

  // Prepared statements
  const stmts = {
    // Merchants
    merchantFindById: db.prepare('SELECT * FROM merchants WHERE id = ?'),
    merchantFindByEmail: db.prepare('SELECT * FROM merchants WHERE LOWER(email) = LOWER(?)'),
    merchantFindByGoogleSubject: db.prepare('SELECT * FROM merchants WHERE googleSubject = ?'),
    merchantListAll: db.prepare('SELECT * FROM merchants ORDER BY createdAt DESC'),
    merchantInsert: db.prepare(`
      INSERT INTO merchants (id, email, businessName, supportEmail, description, whatsappNumber, googleSubject, googleVerified, suspended, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email,
        businessName=excluded.businessName,
        supportEmail=excluded.supportEmail,
        description=excluded.description,
        whatsappNumber=excluded.whatsappNumber,
        googleSubject=excluded.googleSubject,
        googleVerified=excluded.googleVerified,
        suspended=excluded.suspended
    `),
    merchantDelete: db.prepare('DELETE FROM merchants WHERE id = ?'),

    // UPIs
    upiFindById: db.prepare('SELECT * FROM upis WHERE id = ?'),
    upiFindByMerchant: db.prepare('SELECT * FROM upis WHERE merchantId = ? ORDER BY is_default DESC, createdAt ASC'),
    upiListAll: db.prepare('SELECT * FROM upis ORDER BY createdAt ASC'),
    upiInsert: db.prepare(`
      INSERT INTO upis (id, merchantId, label, upiId, phoneNumber, is_default, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label=excluded.label,
        upiId=excluded.upiId,
        phoneNumber=excluded.phoneNumber,
        is_default=excluded.is_default
    `),
    upiSetAllNonDefault: db.prepare('UPDATE upis SET is_default = 0 WHERE merchantId = ?'),
    upiSetDefault: db.prepare('UPDATE upis SET is_default = 1 WHERE id = ? AND merchantId = ?'),
    upiDelete: db.prepare('DELETE FROM upis WHERE id = ?'),

    // Links
    linkFindById: db.prepare('SELECT * FROM links WHERE id = ?'),
    linkFindBySlug: db.prepare('SELECT * FROM links WHERE slug = ?'),
    linkFindByMerchant: db.prepare('SELECT * FROM links WHERE merchantId = ? ORDER BY createdAt DESC'),
    linkListAll: db.prepare('SELECT * FROM links ORDER BY createdAt DESC'),
    linkInsert: db.prepare(`
      INSERT INTO links (id, merchantId, upiId, name, description, slug, amount, amount_paise, amountType, template, active, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        upiId=excluded.upiId,
        name=excluded.name,
        description=excluded.description,
        slug=excluded.slug,
        amount=excluded.amount,
        amount_paise=excluded.amount_paise,
        amountType=excluded.amountType,
        template=excluded.template,
        active=excluded.active
    `),
    linkDelete: db.prepare('DELETE FROM links WHERE id = ?'),

    // Transactions
    txFindById: db.prepare('SELECT * FROM transactions WHERE id = ?'),
    txFindByReference: db.prepare('SELECT * FROM transactions WHERE reference = ?'),
    txFindByMerchant: db.prepare('SELECT * FROM transactions WHERE merchantId = ? ORDER BY createdAt DESC'),
    txListAll: db.prepare('SELECT * FROM transactions ORDER BY createdAt DESC'),
    txInsert: db.prepare(`
      INSERT INTO transactions (id, merchantId, linkId, reference, customerName, customerEmail, customerUpi, amount, amount_paise, status, utr, verifiedBy, paidAt, merchantNote, utrSubmittedAt, reconciliationStatus, ambiguityReason, providerReference, verifiedAt, auditLog, createdAt, cashierId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        linkId=excluded.linkId,
        reference=excluded.reference,
        customerName=excluded.customerName,
        customerEmail=excluded.customerEmail,
        customerUpi=excluded.customerUpi,
        amount=excluded.amount,
        amount_paise=excluded.amount_paise,
        status=excluded.status,
        utr=excluded.utr,
        verifiedBy=excluded.verifiedBy,
        paidAt=excluded.paidAt,
        merchantNote=excluded.merchantNote,
        utrSubmittedAt=excluded.utrSubmittedAt,
        reconciliationStatus=excluded.reconciliationStatus,
        ambiguityReason=excluded.ambiguityReason,
        providerReference=excluded.providerReference,
        verifiedAt=excluded.verifiedAt,
        auditLog=excluded.auditLog,
        cashierId=excluded.cashierId
    `),
    txDelete: db.prepare('DELETE FROM transactions WHERE id = ?'),

    // API Keys
    keyFindById: db.prepare('SELECT * FROM apiKeys WHERE id = ?'),
    keyFindByHash: db.prepare('SELECT * FROM apiKeys WHERE hash = ?'),
    keyFindByMerchant: db.prepare('SELECT * FROM apiKeys WHERE merchantId = ? ORDER BY createdAt DESC'),
    keyListAll: db.prepare('SELECT * FROM apiKeys ORDER BY createdAt DESC'),
    keyInsert: db.prepare(`
      INSERT INTO apiKeys (id, merchantId, name, prefix, hash, createdAt, lastUsedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        lastUsedAt=excluded.lastUsedAt
    `),
    keyUpdateLastUsed: db.prepare('UPDATE apiKeys SET lastUsedAt = ? WHERE id = ?'),
    keyDelete: db.prepare('DELETE FROM apiKeys WHERE id = ? AND merchantId = ?'),

    // Business Accounts
    bizFindById: db.prepare('SELECT * FROM businessAccounts WHERE id = ?'),
    bizFindByMerchant: db.prepare('SELECT * FROM businessAccounts WHERE merchantId = ? ORDER BY createdAt ASC'),
    bizFindByProviderAndMid: db.prepare('SELECT * FROM businessAccounts WHERE provider = ? AND merchantIdRef = ? AND status = ?'),
    bizListAll: db.prepare('SELECT * FROM businessAccounts ORDER BY createdAt ASC'),
    bizInsert: db.prepare(`
      INSERT INTO businessAccounts (id, merchantId, provider, accountName, phoneNumber, merchantIdRef, token, saltIndex, status, autoVerify, lastSyncedAt, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        accountName=excluded.accountName,
        phoneNumber=excluded.phoneNumber,
        merchantIdRef=excluded.merchantIdRef,
        token=excluded.token,
        saltIndex=excluded.saltIndex,
        status=excluded.status,
        autoVerify=excluded.autoVerify,
        lastSyncedAt=excluded.lastSyncedAt
    `),
    bizDelete: db.prepare('DELETE FROM businessAccounts WHERE id = ? AND merchantId = ?'),

    // OAuth States
    oauthFind: db.prepare('SELECT * FROM oauthStates WHERE state = ? AND expiresAt > ?'),
    oauthInsert: db.prepare('INSERT INTO oauthStates (state, expiresAt) VALUES (?, ?) ON CONFLICT(state) DO UPDATE SET expiresAt=excluded.expiresAt'),
    oauthDelete: db.prepare('DELETE FROM oauthStates WHERE state = ?'),
    oauthPrune: db.prepare('DELETE FROM oauthStates WHERE expiresAt <= ?'),
    oauthListAll: db.prepare('SELECT * FROM oauthStates WHERE expiresAt > ?'),

    // Errors
    errInsert: db.prepare(`
      INSERT INTO errors (id, merchantId, message, stack, url, line, col, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `),
    errList: db.prepare('SELECT * FROM errors ORDER BY createdAt DESC LIMIT ?'),
    errClear: db.prepare('DELETE FROM errors'),
    errCount: db.prepare('SELECT COUNT(*) as c FROM errors')
  };

  const repository = {
    // ── Merchants ─────────────────────────────────────────────────────────────
    merchants: {
      findById(id) {
        if (!id) return null;
        return mapMerchant(stmts.merchantFindById.get(id));
      },
      findByEmail(email) {
        if (!email) return null;
        return mapMerchant(stmts.merchantFindByEmail.get(email));
      },
      findByGoogleSubject(sub) {
        if (!sub) return null;
        return mapMerchant(stmts.merchantFindByGoogleSubject.get(sub));
      },
      listAll(options = {}) {
        const rows = stmts.merchantListAll.all();
        let list = rows.map(mapMerchant);
        if (options.query) {
          const q = String(options.query).toLowerCase();
          list = list.filter(m => `${m.email} ${m.businessName} ${m.whatsappNumber || ''}`.toLowerCase().includes(q));
        }
        return list;
      },
      create(merchant) {
        stmts.merchantInsert.run(
          merchant.id,
          merchant.email,
          merchant.businessName,
          merchant.supportEmail || null,
          merchant.description || null,
          merchant.whatsappNumber || null,
          merchant.googleSubject || null,
          merchant.googleVerified !== false ? 1 : 0,
          merchant.suspended ? 1 : 0,
          merchant.createdAt || new Date().toISOString()
        );
        return this.findById(merchant.id);
      },
      update(id, partial) {
        const current = this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        stmts.merchantInsert.run(
          merged.id,
          merged.email,
          merged.businessName,
          merged.supportEmail || null,
          merged.description || null,
          merged.whatsappNumber || null,
          merged.googleSubject || null,
          merged.googleVerified ? 1 : 0,
          merged.suspended ? 1 : 0,
          merged.createdAt
        );
        return this.findById(id);
      },
      delete(id) {
        const res = stmts.merchantDelete.run(id);
        return res.changes > 0;
      },
      count() {
        return db.prepare('SELECT COUNT(*) as c FROM merchants').get().c;
      }
    },

    // ── UPI Destinations ──────────────────────────────────────────────────────
    upis: {
      findById(id) {
        if (!id) return null;
        return mapUpi(stmts.upiFindById.get(id));
      },
      findByMerchant(merchantId) {
        if (!merchantId) return [];
        return stmts.upiFindByMerchant.all(merchantId).map(mapUpi);
      },
      listAll() {
        return stmts.upiListAll.all().map(mapUpi);
      },
      create(upi) {
        stmts.upiInsert.run(
          upi.id,
          upi.merchantId,
          upi.label || 'UPI Account',
          upi.upiId,
          upi.phoneNumber || '',
          upi.default ? 1 : 0,
          upi.createdAt || new Date().toISOString()
        );
        return this.findById(upi.id);
      },
      update(id, partial) {
        const current = this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        stmts.upiInsert.run(
          merged.id,
          merged.merchantId,
          merged.label,
          merged.upiId,
          merged.phoneNumber,
          merged.default ? 1 : 0,
          merged.createdAt
        );
        return this.findById(id);
      },
      setDefault(merchantId, upiId) {
        db.exec('BEGIN TRANSACTION;');
        try {
          stmts.upiSetAllNonDefault.run(merchantId);
          stmts.upiSetDefault.run(upiId, merchantId);
          db.exec('COMMIT;');
          return true;
        } catch (e) {
          db.exec('ROLLBACK;');
          throw e;
        }
      },
      delete(id) {
        const res = stmts.upiDelete.run(id);
        return res.changes > 0;
      },
      count() {
        return db.prepare('SELECT COUNT(*) as c FROM upis').get().c;
      }
    },

    // ── Payment Links ─────────────────────────────────────────────────────────
    links: {
      findById(id) {
        if (!id) return null;
        return mapLink(stmts.linkFindById.get(id));
      },
      findBySlug(slug) {
        if (!slug) return null;
        return mapLink(stmts.linkFindBySlug.get(slug));
      },
      findByMerchant(merchantId) {
        if (!merchantId) return [];
        return stmts.linkFindByMerchant.all(merchantId).map(mapLink);
      },
      listAll() {
        return stmts.linkListAll.all().map(mapLink);
      },
      slugExists(slug) {
        const row = db.prepare('SELECT 1 FROM links WHERE slug = ?').get(slug);
        return Boolean(row);
      },
      create(link) {
        const amount = link.amount != null ? Number(link.amount) : null;
        const amountPaise = amount != null ? Math.round(amount * 100) : null;
        stmts.linkInsert.run(
          link.id,
          link.merchantId,
          link.upiId || null,
          link.name,
          link.description || null,
          link.slug,
          amount,
          amountPaise,
          link.amountType || (amount != null ? 'fixed' : 'open'),
          link.template || 'classic',
          link.active !== false ? 1 : 0,
          link.createdAt || new Date().toISOString()
        );
        return this.findById(link.id);
      },
      update(id, partial) {
        const current = this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const amount = merged.amount != null ? Number(merged.amount) : null;
        const amountPaise = amount != null ? Math.round(amount * 100) : null;
        stmts.linkInsert.run(
          merged.id,
          merged.merchantId,
          merged.upiId,
          merged.name,
          merged.description || null,
          merged.slug,
          amount,
          amountPaise,
          merged.amountType,
          merged.template || 'classic',
          merged.active !== false ? 1 : 0,
          merged.createdAt
        );
        return this.findById(id);
      },
      delete(id) {
        const res = stmts.linkDelete.run(id);
        return res.changes > 0;
      },
      count() {
        return db.prepare('SELECT COUNT(*) as c FROM links').get().c;
      }
    },

    // ── Transactions Ledger ───────────────────────────────────────────────────
    transactions: {
      findById(id) {
        if (!id) return null;
        return mapTransaction(stmts.txFindById.get(id));
      },
      findByReference(ref) {
        if (!ref) return null;
        return mapTransaction(stmts.txFindByReference.get(ref));
      },
      findByUtr(merchantId, utr) {
        if (!merchantId || !utr) return null;
        const raw = String(utr).trim();
        const sanitized = raw.replace(/[^a-zA-Z0-9]/g, '');
        const row = db.prepare(`
          SELECT * FROM transactions
          WHERE merchantId = ? AND (utr = ? OR utr = ? OR REPLACE(REPLACE(utr, '-', ''), '_', '') = ?)
        `).get(merchantId, raw, sanitized, sanitized);
        return mapTransaction(row);
      },
      findForCheckout(merchantId, { txId, ref }) {
        if (!merchantId) return null;
        if (txId && ref) {
          const row = db.prepare('SELECT * FROM transactions WHERE merchantId = ? AND (id = ? OR reference = ?)').get(merchantId, txId, ref);
          return mapTransaction(row);
        }
        if (txId) {
          const row = db.prepare('SELECT * FROM transactions WHERE merchantId = ? AND id = ?').get(merchantId, txId);
          return mapTransaction(row);
        }
        if (ref) {
          const row = db.prepare('SELECT * FROM transactions WHERE merchantId = ? AND reference = ?').get(merchantId, ref);
          return mapTransaction(row);
        }
        return null;
      },
      findByMerchant(merchantId, options = {}) {
        if (!merchantId) return [];
        let list = stmts.txFindByMerchant.all(merchantId).map(mapTransaction);
        if (options.status && options.status !== 'all') {
          list = list.filter(x => x.status === options.status);
        }
        if (options.q) {
          const q = String(options.q).toLowerCase();
          list = list.filter(x => `${x.reference} ${x.customerName} ${x.customerEmail}`.toLowerCase().includes(q));
        }
        const now = Date.now();
        if (options.range === 'today') {
          list = list.filter(x => new Date(x.createdAt).toDateString() === new Date().toDateString());
        } else if (options.range === 'month') {
          list = list.filter(x => now - new Date(x.createdAt).getTime() < 30 * 864e5);
        }
        if (options.start) {
          list = list.filter(x => x.createdAt >= options.start);
        }
        if (options.end) {
          list = list.filter(x => x.createdAt <= options.end + 'T23:59:59.999Z');
        }
        if (options.limit && Number.isFinite(options.limit)) {
          list = list.slice(0, options.limit);
        }
        return list;
      },
      findPendingForCompanion(merchantId) {
        const rows = db.prepare("SELECT * FROM transactions WHERE merchantId = ? AND status = 'pending' ORDER BY createdAt DESC").all(merchantId);
        return rows.map(mapTransaction);
      },
      listAll(options = {}) {
        let list = stmts.txListAll.all().map(mapTransaction);
        if (options.merchantId) {
          list = list.filter(x => x.merchantId === options.merchantId);
        }
        if (options.status && options.status !== 'all') {
          list = list.filter(x => x.status === options.status);
        }
        if (options.q) {
          const q = String(options.q).toLowerCase();
          list = list.filter(x => `${x.reference} ${x.customerName} ${x.customerEmail}`.toLowerCase().includes(q));
        }
        if (options.limit && Number.isFinite(options.limit)) {
          list = list.slice(0, options.limit);
        }
        return list;
      },
      create(tx) {
        const amount = Number(tx.amount || 0);
        const amountPaise = Number.isFinite(tx.amount_paise) ? tx.amount_paise : Math.round(amount * 100);
        stmts.txInsert.run(
          tx.id,
          tx.merchantId,
          tx.linkId || null,
          tx.reference,
          tx.customerName || null,
          tx.customerEmail || null,
          tx.customerUpi || null,
          amount,
          amountPaise,
          tx.status || 'pending',
          tx.utr || null,
          tx.verifiedBy || null,
          tx.paidAt || null,
          tx.merchantNote || null,
          tx.utrSubmittedAt || null,
          tx.reconciliationStatus || 'unreconciled',
          tx.ambiguityReason || null,
          tx.providerReference || null,
          tx.verifiedAt || null,
          tx.auditLog || null,
          tx.createdAt || new Date().toISOString(),
          tx.cashierId || null
        );
        return this.findById(tx.id);
      },
      update(id, partial) {
        const current = this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const amount = Number(merged.amount || 0);
        const amountPaise = Number.isFinite(merged.amount_paise) ? merged.amount_paise : Math.round(amount * 100);
        stmts.txInsert.run(
          merged.id,
          merged.merchantId,
          merged.linkId || null,
          merged.reference,
          merged.customerName || null,
          merged.customerEmail || null,
          merged.customerUpi || null,
          amount,
          amountPaise,
          merged.status,
          merged.utr || null,
          merged.verifiedBy || null,
          merged.paidAt || null,
          merged.merchantNote || null,
          merged.utrSubmittedAt || null,
          merged.reconciliationStatus || 'unreconciled',
          merged.ambiguityReason || null,
          merged.providerReference || null,
          merged.verifiedAt || null,
          merged.auditLog || null,
          merged.createdAt,
          merged.cashierId || null
        );
        return this.findById(id);
      },
      delete(id) {
        const res = stmts.txDelete.run(id);
        return res.changes > 0;
      },
      count() {
        return db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
      },
      getMerchantOverviewStats(merchantId, range = 'month') {
        const allTx = this.findByMerchant(merchantId, { range });
        const success = allTx.filter(x => x.status === 'success');
        const pending = allTx.filter(x => x.status === 'pending');
        const links = repository.links.findByMerchant(merchantId);
        return {
          volume: success.reduce((sum, x) => sum + x.amount, 0),
          volumePaise: success.reduce((sum, x) => sum + x.amount_paise, 0),
          successful: success.length,
          pending: pending.length,
          activeLinks: links.filter(x => x.active).length,
          recent: allTx.slice(0, 5)
        };
      },
      getGlobalMetrics() {
        const totalMerchants = db.prepare('SELECT COUNT(*) as c FROM merchants').get().c;
        const activeMerchants = db.prepare('SELECT COUNT(*) as c FROM merchants WHERE suspended = 0').get().c;
        const suspendedMerchants = db.prepare('SELECT COUNT(*) as c FROM merchants WHERE suspended = 1').get().c;
        const totalTransactions = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
        const totalLinks = db.prepare('SELECT COUNT(*) as c FROM links').get().c;
        const activeLinks = db.prepare('SELECT COUNT(*) as c FROM links WHERE active = 1').get().c;
        const totalErrors = db.prepare('SELECT COUNT(*) as c FROM errors').get().c;

        const successTx = db.prepare("SELECT amount, amount_paise FROM transactions WHERE status = 'success'").all();
        const totalVolume = successTx.reduce((sum, x) => sum + Number(x.amount), 0);
        const totalVolumePaise = successTx.reduce((sum, x) => sum + Number(x.amount_paise), 0);

        return {
          totalVolume,
          totalVolumePaise,
          successfulTransactions: successTx.length,
          totalMerchants,
          activeMerchants,
          suspendedMerchants,
          totalTransactions,
          totalLinks,
          activeLinks,
          totalErrors
        };
      },
      search(options = {}) {
        let sql = 'SELECT * FROM transactions WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as c FROM transactions WHERE 1=1';
        const params = [];
        const countParams = [];

        if (options.merchantId) {
          sql += ' AND merchantId = ?';
          countSql += ' AND merchantId = ?';
          params.push(options.merchantId);
          countParams.push(options.merchantId);
        }
        if (options.status && options.status !== 'all') {
          sql += ' AND status = ?';
          countSql += ' AND status = ?';
          params.push(options.status);
          countParams.push(options.status);
        }
        if (options.reconciliationStatus && options.reconciliationStatus !== 'all') {
          sql += ' AND reconciliationStatus = ?';
          countSql += ' AND reconciliationStatus = ?';
          params.push(options.reconciliationStatus);
          countParams.push(options.reconciliationStatus);
        }
        if (options.utr) {
          sql += " AND (utr LIKE ? OR REPLACE(REPLACE(utr, '-', ''), '_', '') LIKE ?)";
          countSql += " AND (utr LIKE ? OR REPLACE(REPLACE(utr, '-', ''), '_', '') LIKE ?)";
          const p = `%${options.utr.trim()}%`;
          const pClean = `%${options.utr.trim().replace(/[^a-zA-Z0-9]/g, '')}%`;
          params.push(p, pClean);
          countParams.push(p, pClean);
        }
        if (options.providerReference) {
          sql += ' AND providerReference LIKE ?';
          countSql += ' AND providerReference LIKE ?';
          const p = `%${options.providerReference.trim()}%`;
          params.push(p);
          countParams.push(p);
        }
        if (options.q) {
          const q = `%${options.q.trim().toLowerCase()}%`;
          sql += ' AND (LOWER(reference) LIKE ? OR LOWER(customerName) LIKE ? OR LOWER(customerEmail) LIKE ? OR id LIKE ?)';
          countSql += ' AND (LOWER(reference) LIKE ? OR LOWER(customerName) LIKE ? OR LOWER(customerEmail) LIKE ? OR id LIKE ?)';
          params.push(q, q, q, q);
          countParams.push(q, q, q, q);
        }
        if (options.start) {
          sql += ' AND createdAt >= ?';
          countSql += ' AND createdAt >= ?';
          params.push(options.start);
          countParams.push(options.start);
        }
        if (options.end) {
          sql += ' AND createdAt <= ?';
          countSql += ' AND createdAt <= ?';
          params.push(options.end);
          countParams.push(options.end);
        }

        const total = db.prepare(countSql).get(...countParams)?.c || 0;

        sql += ' ORDER BY createdAt DESC';
        const limit = Math.min(Number(options.limit) || 50, 200);
        const offset = Math.max(Number(options.offset) || 0, 0);
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = db.prepare(sql).all(...params).map(mapTransaction);
        return { total, limit, offset, items: rows };
      },
      getInvestigation(txId) {
        const tx = this.findById(txId);
        if (!tx) return null;
        const merchant = repository.merchants.findById(tx.merchantId);

        // Gather timeline events
        const timeline = [];

        // 1. Creation event
        timeline.push({
          timestamp: tx.createdAt,
          type: 'order_created',
          source: 'checkout',
          title: 'Order Created',
          description: `Checkout session created for ₹${tx.amount}`,
          details: { reference: tx.reference, customerName: tx.customerName, amount: tx.amount }
        });

        // 2. Customer UTR submission event
        if (tx.utrSubmittedAt) {
          timeline.push({
            timestamp: tx.utrSubmittedAt,
            type: 'customer_utr_submitted',
            source: 'customer_checkout',
            title: 'Customer Submitted UTR Evidence',
            description: `Customer submitted unverified UTR: ${tx.utr}`,
            details: { utr: tx.utr }
          });
        }

        // 3. Parse transaction-level auditLog
        if (tx.auditLog) {
          try {
            const parsed = typeof tx.auditLog === 'string' ? JSON.parse(tx.auditLog) : tx.auditLog;
            if (Array.isArray(parsed)) {
              for (const entry of parsed) {
                timeline.push({
                  timestamp: entry.timestamp || tx.createdAt,
                  type: entry.action || 'lifecycle_event',
                  source: entry.source || 'lifecycle_engine',
                  title: entry.action?.replace(/_/g, ' ') || 'Lifecycle Event',
                  description: entry.details || '',
                  details: {
                    fromStatus: entry.fromStatus,
                    toStatus: entry.toStatus,
                    reconciliationStatus: entry.reconciliationStatus,
                    providerReference: entry.providerReference,
                    utr: entry.utr
                  }
                });
              }
            }
          } catch (_) {}
        }

        // 4. Admin audit trail events for this transaction
        const adminAudits = db.prepare(`
          SELECT * FROM admin_audit_trail WHERE targetId = ? ORDER BY createdAt ASC
        `).all(tx.id).map(mapAdminAudit);

        for (const a of adminAudits) {
          timeline.push({
            timestamp: a.createdAt,
            type: 'admin_reconciliation',
            source: `admin:${a.actorRole}`,
            title: `Admin Action: ${a.action}`,
            description: `${a.justification} (Reason: ${a.reasonCode})`,
            details: {
              actorEmail: a.actorEmail,
              actorRole: a.actorRole,
              reasonCode: a.reasonCode,
              outcome: a.outcome,
              before: a.beforeState,
              after: a.afterState
            }
          });
        }

        // Sort timeline chronologically
        timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        // Construct diagnostics summary
        const diagnostics = {
          isAmbiguous: tx.reconciliationStatus === 'flagged_ambiguous' || Boolean(tx.ambiguityReason),
          ambiguityReason: tx.ambiguityReason || null,
          reconciliationStatus: tx.reconciliationStatus,
          isTerminal: ['success', 'failed', 'expired'].includes(tx.status),
          status: tx.status,
          verifiedBy: tx.verifiedBy || null,
          verifiedAt: tx.verifiedAt || null,
          providerReference: tx.providerReference || null,
          utr: tx.utr || null
        };

        return {
          transaction: tx,
          merchant: merchant ? {
            id: merchant.id,
            email: merchant.email,
            businessName: merchant.businessName,
            suspended: Boolean(merchant.suspended)
          } : null,
          diagnostics,
          timeline
        };
      }
    },

    // ── API Keys ──────────────────────────────────────────────────────────────
    apiKeys: {
      findById(id) {
        if (!id) return null;
        return mapApiKey(stmts.keyFindById.get(id));
      },
      findByHash(hash) {
        if (!hash) return null;
        return mapApiKey(stmts.keyFindByHash.get(hash));
      },
      findByMerchant(merchantId) {
        if (!merchantId) return [];
        return stmts.keyFindByMerchant.all(merchantId).map(mapApiKey);
      },
      listAll() {
        return stmts.keyListAll.all().map(mapApiKey);
      },
      create(key) {
        stmts.keyInsert.run(
          key.id,
          key.merchantId,
          key.name || 'Live API key',
          key.prefix,
          key.hash,
          key.createdAt || new Date().toISOString(),
          key.lastUsedAt || null
        );
        return this.findById(key.id);
      },
      updateLastUsed(id, lastUsedAt = new Date().toISOString()) {
        const res = stmts.keyUpdateLastUsed.run(lastUsedAt, id);
        return res.changes > 0;
      },
      delete(id, merchantId) {
        const res = stmts.keyDelete.run(id, merchantId);
        return res.changes > 0;
      }
    },

    // ── Business Accounts ─────────────────────────────────────────────────────
    businessAccounts: {
      findById(id) {
        if (!id) return null;
        return mapBusinessAccount(stmts.bizFindById.get(id));
      },
      findByMerchant(merchantId) {
        if (!merchantId) return [];
        return stmts.bizFindByMerchant.all(merchantId).map(mapBusinessAccount);
      },
      findByProviderAndMid(provider, merchantIdRef) {
        if (!provider || !merchantIdRef) return null;
        return mapBusinessAccount(stmts.bizFindByProviderAndMid.get(provider, merchantIdRef, 'connected'));
      },
      listAll() {
        return stmts.bizListAll.all().map(mapBusinessAccount);
      },
      create(acc) {
        stmts.bizInsert.run(
          acc.id,
          acc.merchantId,
          acc.provider,
          acc.accountName,
          acc.phoneNumber,
          acc.merchantIdRef,
          acc.token,
          acc.saltIndex || '1',
          acc.status || 'connected',
          acc.autoVerify !== false ? 1 : 0,
          acc.lastSyncedAt || null,
          acc.createdAt || new Date().toISOString()
        );
        return this.findById(acc.id);
      },
      update(id, partial) {
        const current = this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        stmts.bizInsert.run(
          merged.id,
          merged.merchantId,
          merged.provider,
          merged.accountName,
          merged.phoneNumber,
          merged.merchantIdRef,
          merged.token,
          merged.saltIndex || '1',
          merged.status,
          merged.autoVerify !== false ? 1 : 0,
          merged.lastSyncedAt || null,
          merged.createdAt
        );
        return this.findById(id);
      },
      delete(id, merchantId) {
        const res = stmts.bizDelete.run(id, merchantId);
        return res.changes > 0;
      }
    },

    // ── OAuth States ──────────────────────────────────────────────────────────
    oauthStates: {
      create(state, expiresAt) {
        stmts.oauthInsert.run(state, expiresAt);
        return { state, expiresAt };
      },
      consume(state) {
        if (!state) return false;
        const row = stmts.oauthFind.get(state, Date.now());
        if (!row) return false;
        stmts.oauthDelete.run(state);
        return true;
      },
      pruneExpired() {
        const res = stmts.oauthPrune.run(Date.now());
        return res.changes;
      },
      listAll() {
        return stmts.oauthListAll.all(Date.now()).map(mapOAuthState);
      }
    },

    // ── Client Diagnostics & Errors ───────────────────────────────────────────
    errors: {
      log(err) {
        stmts.errInsert.run(
          err.id,
          err.merchantId || null,
          String(err.message || '').slice(0, 500),
          String(err.stack || '').slice(0, 2000),
          String(err.url || '').slice(0, 300),
          err.line || null,
          err.col || null,
          err.createdAt || new Date().toISOString()
        );
        return err;
      },
      list(options = {}) {
        const limit = Math.min(Number(options.limit || 200), 1000);
        return stmts.errList.all(limit).map(mapError);
      },
      clear() {
        const res = stmts.errClear.run();
        return res.changes;
      },
      count() {
        return stmts.errCount.get().c;
      }
    },

    // ── Administrative RBAC Users (Milestone 4) ──────────────────────────────
    adminUsers: {
      findById(id) {
        if (!id) return null;
        return mapAdminUser(db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id));
      },
      findByEmail(email) {
        if (!email) return null;
        return mapAdminUser(db.prepare('SELECT * FROM admin_users WHERE LOWER(email) = LOWER(?)').get(email));
      },
      listAll(options = {}) {
        let sql = 'SELECT * FROM admin_users WHERE 1=1';
        const params = [];
        if (options.role) {
          sql += ' AND role = ?';
          params.push(options.role);
        }
        if (typeof options.active === 'boolean') {
          sql += ' AND active = ?';
          params.push(options.active ? 1 : 0);
        }
        sql += ' ORDER BY createdAt DESC';
        if (options.limit) {
          sql += ' LIMIT ?';
          params.push(Math.min(Number(options.limit), 200));
          if (options.offset) {
            sql += ' OFFSET ?';
            params.push(Math.max(Number(options.offset), 0));
          }
        }
        return db.prepare(sql).all(...params).map(mapAdminUser);
      },
      create(user) {
        const id = user.id || `adm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const createdAt = user.createdAt || new Date().toISOString();
        db.prepare(`
          INSERT INTO admin_users (id, email, name, passwordHash, role, active, createdAt, lastLoginAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET
            name = excluded.name,
            passwordHash = excluded.passwordHash,
            role = excluded.role,
            active = excluded.active
        `).run(
          id,
          user.email.toLowerCase().trim(),
          user.name.trim(),
          user.passwordHash,
          user.role,
          user.active !== false ? 1 : 0,
          createdAt,
          user.lastLoginAt || null
        );
        return this.findById(id) || this.findByEmail(user.email);
      },
      update(id, partial) {
        const current = this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        db.prepare(`
          UPDATE admin_users
          SET email = ?, name = ?, passwordHash = ?, role = ?, active = ?, lastLoginAt = ?
          WHERE id = ?
        `).run(
          merged.email.toLowerCase().trim(),
          merged.name.trim(),
          merged.passwordHash,
          merged.role,
          merged.active ? 1 : 0,
          merged.lastLoginAt || null,
          id
        );
        return this.findById(id);
      },
      delete(id) {
        const res = db.prepare('DELETE FROM admin_users WHERE id = ?').run(id);
        return res.changes > 0;
      },
      count() {
        return db.prepare('SELECT COUNT(*) as c FROM admin_users').get().c;
      }
    },

    // ── Append-Only Administrative Audit Trail (Milestone 4) ───────────────────
    adminAudit: {
      create(entry) {
        return logAdminAudit(db, entry);
      },
      list(options = {}) {
        let sql = 'SELECT * FROM admin_audit_trail WHERE 1=1';
        const params = [];
        if (options.actorId) {
          sql += ' AND actorId = ?';
          params.push(options.actorId);
        }
        if (options.action) {
          sql += ' AND action = ?';
          params.push(options.action);
        }
        if (options.targetType) {
          sql += ' AND targetType = ?';
          params.push(options.targetType);
        }
        if (options.targetId) {
          sql += ' AND targetId = ?';
          params.push(options.targetId);
        }
        if (options.reasonCode) {
          sql += ' AND reasonCode = ?';
          params.push(options.reasonCode);
        }
        if (options.outcome) {
          sql += ' AND outcome = ?';
          params.push(options.outcome);
        }
        if (options.start) {
          sql += ' AND createdAt >= ?';
          params.push(options.start);
        }
        if (options.end) {
          sql += ' AND createdAt <= ?';
          params.push(options.end);
        }
        sql += ' ORDER BY createdAt DESC';
        const limit = Math.min(Number(options.limit) || 50, 200);
        const offset = Math.max(Number(options.offset) || 0, 0);
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);
        return db.prepare(sql).all(...params).map(mapAdminAudit);
      },
      count(options = {}) {
        let sql = 'SELECT COUNT(*) as c FROM admin_audit_trail WHERE 1=1';
        const params = [];
        if (options.actorId) { sql += ' AND actorId = ?'; params.push(options.actorId); }
        if (options.action) { sql += ' AND action = ?'; params.push(options.action); }
        if (options.targetType) { sql += ' AND targetType = ?'; params.push(options.targetType); }
        if (options.targetId) { sql += ' AND targetId = ?'; params.push(options.targetId); }
        return db.prepare(sql).get(...params)?.c || 0;
      },
      findById(id) {
        if (!id) return null;
        return mapAdminAudit(db.prepare('SELECT * FROM admin_audit_trail WHERE id = ?').get(id));
      }
    },

    // ── Merchant Support Queries ──────────────────────────────────────────────
    supportQueries: {
      create(q) {
        db.prepare(`
          INSERT INTO support_queries (id, merchantId, category, subject, message, status, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          q.id,
          q.merchantId,
          q.category || 'general',
          q.subject,
          q.message,
          q.status || 'open',
          q.createdAt || new Date().toISOString()
        );
        return this.findById(q.id);
      },
      findById(id) {
        if (!id) return null;
        return db.prepare('SELECT * FROM support_queries WHERE id = ?').get(id) || null;
      },
      findByMerchant(merchantId) {
        if (!merchantId) return [];
        return db.prepare('SELECT * FROM support_queries WHERE merchantId = ? ORDER BY createdAt DESC').all(merchantId);
      },
      listAll(limit = 100) {
        return db.prepare('SELECT * FROM support_queries ORDER BY createdAt DESC LIMIT ?').all(limit);
      }
    },

    // ── Cashiers (Milestone 8) ────────────────────────────────────────────────
    cashiers: {
      create(c) {
        db.prepare(`
          INSERT INTO cashiers (id, merchantId, name, provider, phoneNumber, upiId, status, pairedAt, lastSeenAt, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          c.id,
          c.merchantId,
          c.name,
          c.provider || 'phonepe',
          c.phoneNumber,
          c.upiId,
          c.status || 'pending_pairing',
          c.pairedAt || null,
          c.lastSeenAt || null,
          c.createdAt || new Date().toISOString()
        );
        return this.findById(c.id);
      },
      findById(id) {
        if (!id) return null;
        return db.prepare('SELECT * FROM cashiers WHERE id = ?').get(id) || null;
      },
      findByMerchant(merchantId) {
        if (!merchantId) return [];
        return db.prepare('SELECT * FROM cashiers WHERE merchantId = ? ORDER BY createdAt DESC').all(merchantId);
      },
      update(id, fields) {
        const existing = this.findById(id);
        if (!existing) return null;
        const merged = { ...existing, ...fields };
        db.prepare(`
          UPDATE cashiers SET
            name = ?,
            provider = ?,
            phoneNumber = ?,
            upiId = ?,
            status = ?,
            pairedAt = ?,
            lastSeenAt = ?
          WHERE id = ?
        `).run(
          merged.name,
          merged.provider,
          merged.phoneNumber,
          merged.upiId,
          merged.status,
          merged.pairedAt,
          merged.lastSeenAt,
          id
        );
        return this.findById(id);
      },
      delete(id) {
        if (!id) return false;
        const res = db.prepare('DELETE FROM cashiers WHERE id = ?').run(id);
        return res.changes > 0;
      }
    },

    // ── Cashier Pairing Sessions (Milestone 8) ────────────────────────────────
    cashierPairingSessions: {
      create(s) {
        db.prepare(`
          INSERT INTO cashier_pairing_sessions (id, merchantId, cashierId, serverCodeHash, appCodeHash, status, attempts, expiresAt, completedAt, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          s.id,
          s.merchantId,
          s.cashierId,
          s.serverCodeHash,
          s.appCodeHash || null,
          s.status || 'pending_server_code',
          s.attempts || 0,
          s.expiresAt,
          s.completedAt || null,
          s.createdAt || new Date().toISOString()
        );
        return this.findById(s.id);
      },
      findById(id) {
        if (!id) return null;
        return db.prepare('SELECT * FROM cashier_pairing_sessions WHERE id = ?').get(id) || null;
      },
      findByServerCodeHash(hash) {
        if (!hash) return null;
        return db.prepare('SELECT * FROM cashier_pairing_sessions WHERE serverCodeHash = ? ORDER BY createdAt DESC LIMIT 1').get(hash) || null;
      },
      findByAppCodeHash(hash) {
        if (!hash) return null;
        return db.prepare('SELECT * FROM cashier_pairing_sessions WHERE appCodeHash = ? ORDER BY createdAt DESC LIMIT 1').get(hash) || null;
      },
      findActiveByMerchant(merchantId) {
        if (!merchantId) return [];
        const now = new Date().toISOString();
        return db.prepare(`
          SELECT * FROM cashier_pairing_sessions
          WHERE merchantId = ? AND status IN ('pending_server_code', 'server_code_verified', 'app_code_generated') AND expiresAt > ?
          ORDER BY createdAt DESC
        `).all(merchantId, now);
      },
      update(id, fields) {
        const existing = this.findById(id);
        if (!existing) return null;
        const merged = { ...existing, ...fields };
        db.prepare(`
          UPDATE cashier_pairing_sessions SET
            appCodeHash = ?,
            status = ?,
            attempts = ?,
            completedAt = ?
          WHERE id = ?
        `).run(
          merged.appCodeHash,
          merged.status,
          merged.attempts,
          merged.completedAt,
          id
        );
        return this.findById(id);
      }
    },

    // ── Cashier Audit Logs (Milestone 8) ──────────────────────────────────────
    cashierLogs: {
      create(l) {
        db.prepare(`
          INSERT INTO cashier_logs (id, merchantId, cashierId, event, details, ipAddress, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          l.id,
          l.merchantId,
          l.cashierId || null,
          l.event,
          l.details || null,
          l.ipAddress || null,
          l.createdAt || new Date().toISOString()
        );
        return db.prepare('SELECT * FROM cashier_logs WHERE id = ?').get(l.id) || null;
      },
      findByMerchant(merchantId, limit = 50) {
        if (!merchantId) return [];
        return db.prepare('SELECT * FROM cashier_logs WHERE merchantId = ? ORDER BY createdAt DESC LIMIT ?').all(merchantId, limit);
      },
      findByCashier(cashierId, limit = 50) {
        if (!cashierId) return [];
        return db.prepare('SELECT * FROM cashier_logs WHERE cashierId = ? ORDER BY createdAt DESC LIMIT ?').all(cashierId, limit);
      }
    },

    // ── Legacy Compatibility & Snapshots ──────────────────────────────────────
    getLegacyDbSnapshot() {
      return {
        merchants: this.merchants.listAll(),
        upis: this.upis.listAll(),
        links: this.links.listAll(),
        transactions: this.transactions.listAll(),
        apiKeys: this.apiKeys.listAll(),
        businessAccounts: this.businessAccounts.listAll(),
        oauthStates: this.oauthStates.listAll(),
        errors: this.errors.list({ limit: 1000 })
      };
    },

    syncFromLegacy(legacyDb) {
      if (!legacyDb) return;
      db.exec('BEGIN TRANSACTION;');
      try {
        if (Array.isArray(legacyDb.merchants)) {
          for (const m of legacyDb.merchants) this.merchants.create(m);
        }
        if (Array.isArray(legacyDb.upis)) {
          for (const u of legacyDb.upis) this.upis.create(u);
        }
        if (Array.isArray(legacyDb.links)) {
          for (const l of legacyDb.links) this.links.create(l);
        }
        if (Array.isArray(legacyDb.transactions)) {
          for (const t of legacyDb.transactions) this.transactions.create(t);
        }
        if (Array.isArray(legacyDb.apiKeys)) {
          for (const k of legacyDb.apiKeys) this.apiKeys.create(k);
        }
        if (Array.isArray(legacyDb.businessAccounts)) {
          for (const b of legacyDb.businessAccounts) this.businessAccounts.create(b);
        }
        if (Array.isArray(legacyDb.oauthStates)) {
          for (const o of legacyDb.oauthStates) this.oauthStates.create(o.state, o.expiresAt);
        }
        if (Array.isArray(legacyDb.errors)) {
          for (const e of legacyDb.errors) this.errors.log(e);
        }
        db.exec('COMMIT;');
      } catch (e) {
        db.exec('ROLLBACK;');
        throw e;
      }
    }
  };

  return repository;
}

let defaultRepositoryInstance = null;

function getRepository(db) {
  if (db) return createRepository(db);
  if (!defaultRepositoryInstance) {
    defaultRepositoryInstance = createRepository();
  }
  return defaultRepositoryInstance;
}

module.exports = {
  createRepository,
  getRepository
};
