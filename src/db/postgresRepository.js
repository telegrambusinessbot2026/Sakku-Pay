/* ==============================================================================
   SakkuPay — Managed PostgreSQL Repository & Data Access Layer
   Fully asynchronous, parameterized SQL ($1, $2, ...) repository layer.
   Provides ACID transactions, integer paise precision, foreign key cascades,
   and complete merchant data isolation.
   ============================================================================== */
'use strict';

const crypto = require('node:crypto');
const { getPostgresPool } = require('./connection');
const { applyPostgresMigrations } = require('./postgresSchema');

/**
 * Normalizes SQL row timestamps to ISO-8601 strings for consistent API output.
 */
function toIso(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

// ── Row Mappers ─────────────────────────────────────────────────────────────

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
    createdAt: toIso(row.createdAt)
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
    createdAt: toIso(row.createdAt)
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
    createdAt: toIso(row.createdAt)
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
    paidAt: toIso(row.paidAt),
    merchantNote: row.merchantNote || null,
    utrSubmittedAt: toIso(row.utrSubmittedAt),
    reconciliationStatus: row.reconciliationStatus || 'unreconciled',
    ambiguityReason: row.ambiguityReason || null,
    providerReference: row.providerReference || null,
    verifiedAt: toIso(row.verifiedAt),
    auditLog: row.auditLog || null,
    createdAt: toIso(row.createdAt),
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
    createdAt: toIso(row.createdAt),
    lastUsedAt: toIso(row.lastUsedAt)
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
    lastSyncedAt: toIso(row.lastSyncedAt),
    createdAt: toIso(row.createdAt)
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
    createdAt: toIso(row.createdAt),
    lastLoginAt: toIso(row.lastLoginAt),
    active: row.active !== undefined ? Boolean(row.active) : true
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
    createdAt: toIso(row.createdAt)
  };
}

function mapSupportQuery(row) {
  if (!row) return null;
  return {
    id: row.id,
    merchantId: row.merchantId,
    category: row.category,
    subject: row.subject,
    message: row.message,
    status: row.status || 'open',
    createdAt: toIso(row.createdAt)
  };
}

function mapCashier(row) {
  if (!row) return null;
  return {
    id: row.id,
    merchantId: row.merchantId,
    name: row.name,
    provider: row.provider,
    phoneNumber: row.phoneNumber,
    upiId: row.upiId,
    status: row.status,
    pairedAt: toIso(row.pairedAt),
    lastSeenAt: toIso(row.lastSeenAt),
    createdAt: toIso(row.createdAt)
  };
}

function mapPairingSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    merchantId: row.merchantId,
    cashierId: row.cashierId,
    serverCodeHash: row.serverCodeHash,
    appCodeHash: row.appCodeHash || null,
    status: row.status,
    attempts: Number(row.attempts || 0),
    expiresAt: toIso(row.expiresAt),
    completedAt: toIso(row.completedAt),
    createdAt: toIso(row.createdAt)
  };
}

function mapCashierLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    merchantId: row.merchantId,
    cashierId: row.cashierId || null,
    event: row.event,
    details: row.details || null,
    ipAddress: row.ipAddress || null,
    createdAt: toIso(row.createdAt)
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
    createdAt: toIso(row.createdAt)
  };
}

/**
 * Creates an asynchronous, strongly-typed PostgreSQL repository instance.
 * Accepts either a connection pool or an isolated client (for transactions).
 */
function createPostgresRepository(clientOrPool = getPostgresPool()) {
  const isClient = typeof clientOrPool.release === 'function';

  const repo = {
    /**
     * Executes an action inside an atomic PostgreSQL transaction.
     * Guarantees COMMIT on success, automatic ROLLBACK on failure, and safe connection release.
     */
    async withTransaction(callback) {
      if (isClient) {
        // Already inside a transaction client
        return callback(repo);
      }
      const client = await clientOrPool.connect();
      try {
        await client.query('BEGIN;');
        const trxRepo = createPostgresRepository(client);
        const result = await callback(trxRepo);
        await client.query('COMMIT;');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK;');
        } catch (_) {}
        throw err;
      } finally {
        client.release();
      }
    },

    // ── Merchants ─────────────────────────────────────────────────────────────
    merchants: {
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM merchants WHERE id = $1 LIMIT 1', [id]);
        return mapMerchant(res.rows[0]);
      },
      async findByEmail(email) {
        if (!email) return null;
        const res = await clientOrPool.query('SELECT * FROM merchants WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
        return mapMerchant(res.rows[0]);
      },
      async findByGoogleSubject(sub) {
        if (!sub) return null;
        const res = await clientOrPool.query('SELECT * FROM merchants WHERE "googleSubject" = $1 LIMIT 1', [sub]);
        return mapMerchant(res.rows[0]);
      },
      async listAll({ query = null } = {}) {
        let sql = 'SELECT * FROM merchants WHERE 1=1';
        const params = [];
        if (query) {
          params.push(`%${query.toLowerCase()}%`);
          sql += ` AND (LOWER(email) LIKE $${params.length} OR LOWER("businessName") LIKE $${params.length} OR id LIKE $${params.length})`;
        }
        sql += ' ORDER BY "createdAt" DESC';
        const res = await clientOrPool.query(sql, params);
        return res.rows.map(mapMerchant);
      },
      async create(m) {
        const id = m.id || `mer_${crypto.randomBytes(8).toString('hex')}`;
        const createdAt = m.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO merchants (
            id, email, "businessName", "supportEmail", description,
            "whatsappNumber", "googleSubject", "googleVerified", suspended, "createdAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email,
            "businessName" = EXCLUDED."businessName",
            "supportEmail" = EXCLUDED."supportEmail",
            description = EXCLUDED.description,
            "whatsappNumber" = EXCLUDED."whatsappNumber",
            "googleSubject" = EXCLUDED."googleSubject",
            "googleVerified" = EXCLUDED."googleVerified",
            suspended = EXCLUDED.suspended
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          m.email,
          m.businessName,
          m.supportEmail || null,
          m.description || '',
          m.whatsappNumber || '',
          m.googleSubject || null,
          Boolean(m.googleVerified),
          Boolean(m.suspended),
          createdAt
        ]);
        return mapMerchant(res.rows[0]);
      },
      async update(id, partial) {
        const current = await this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const sql = `
          UPDATE merchants SET
            email = $2,
            "businessName" = $3,
            "supportEmail" = $4,
            description = $5,
            "whatsappNumber" = $6,
            "googleSubject" = $7,
            "googleVerified" = $8,
            suspended = $9
          WHERE id = $1
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          merged.email,
          merged.businessName,
          merged.supportEmail || null,
          merged.description || '',
          merged.whatsappNumber || '',
          merged.googleSubject || null,
          Boolean(merged.googleVerified),
          Boolean(merged.suspended)
        ]);
        return mapMerchant(res.rows[0]);
      },
      async delete(id) {
        const res = await clientOrPool.query('DELETE FROM merchants WHERE id = $1', [id]);
        return (res.rowCount || 0) > 0;
      },
      async count() {
        const res = await clientOrPool.query('SELECT COUNT(*) as c FROM merchants');
        return Number(res.rows[0]?.c || 0);
      }
    },

    // ── UPI Destinations ───────────────────────────────────────────────────────
    upis: {
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM upis WHERE id = $1 LIMIT 1', [id]);
        return mapUpi(res.rows[0]);
      },
      async findByMerchant(merchantId) {
        if (!merchantId) return [];
        const res = await clientOrPool.query('SELECT * FROM upis WHERE "merchantId" = $1 ORDER BY "createdAt" ASC', [merchantId]);
        return res.rows.map(mapUpi);
      },
      async listAll() {
        const res = await clientOrPool.query('SELECT * FROM upis ORDER BY "createdAt" ASC');
        return res.rows.map(mapUpi);
      },
      async create(u) {
        const id = u.id || `upi_${crypto.randomBytes(8).toString('hex')}`;
        const createdAt = u.createdAt || new Date().toISOString();
        const isDefault = Boolean(u.default);

        // Atomic default switch if setting default
        if (isDefault) {
          await clientOrPool.query('UPDATE upis SET is_default = FALSE WHERE "merchantId" = $1', [u.merchantId]);
        }

        const sql = `
          INSERT INTO upis (id, "merchantId", label, "upiId", "phoneNumber", is_default, "createdAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET
            label = EXCLUDED.label,
            "upiId" = EXCLUDED."upiId",
            "phoneNumber" = EXCLUDED."phoneNumber",
            is_default = EXCLUDED.is_default
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          u.merchantId,
          u.label,
          u.upiId,
          u.phoneNumber,
          isDefault,
          createdAt
        ]);
        return mapUpi(res.rows[0]);
      },
      async update(id, partial) {
        const current = await this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        if (partial.default) {
          await clientOrPool.query('UPDATE upis SET is_default = FALSE WHERE "merchantId" = $1', [merged.merchantId]);
        }
        const sql = `
          UPDATE upis SET
            label = $2,
            "upiId" = $3,
            "phoneNumber" = $4,
            is_default = $5
          WHERE id = $1
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          merged.label,
          merged.upiId,
          merged.phoneNumber,
          Boolean(merged.default)
        ]);
        return mapUpi(res.rows[0]);
      },
      async setDefault(merchantId, upiId) {
        await clientOrPool.query('UPDATE upis SET is_default = FALSE WHERE "merchantId" = $1', [merchantId]);
        const res = await clientOrPool.query('UPDATE upis SET is_default = TRUE WHERE id = $1 AND "merchantId" = $2 RETURNING *', [upiId, merchantId]);
        return mapUpi(res.rows[0]);
      },
      async delete(id) {
        const res = await clientOrPool.query('DELETE FROM upis WHERE id = $1', [id]);
        return (res.rowCount || 0) > 0;
      },
      async count() {
        const res = await clientOrPool.query('SELECT COUNT(*) as c FROM upis');
        return Number(res.rows[0]?.c || 0);
      }
    },

    // ── Payment Links ─────────────────────────────────────────────────────────
    links: {
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM links WHERE id = $1 LIMIT 1', [id]);
        return mapLink(res.rows[0]);
      },
      async findBySlug(slug) {
        if (!slug) return null;
        const res = await clientOrPool.query('SELECT * FROM links WHERE slug = $1 LIMIT 1', [slug]);
        return mapLink(res.rows[0]);
      },
      async findByMerchant(merchantId) {
        if (!merchantId) return [];
        const res = await clientOrPool.query('SELECT * FROM links WHERE "merchantId" = $1 ORDER BY "createdAt" DESC', [merchantId]);
        return res.rows.map(mapLink);
      },
      async listAll() {
        const res = await clientOrPool.query('SELECT * FROM links ORDER BY "createdAt" DESC');
        return res.rows.map(mapLink);
      },
      async slugExists(slug) {
        if (!slug) return false;
        const res = await clientOrPool.query('SELECT 1 FROM links WHERE slug = $1 LIMIT 1', [slug]);
        return res.rows.length > 0;
      },
      async create(l) {
        const id = l.id || `lnk_${crypto.randomBytes(8).toString('hex')}`;
        const createdAt = l.createdAt || new Date().toISOString();
        const amount = l.amount != null ? Number(l.amount) : null;
        const amountPaise = l.amount_paise != null ? Number(l.amount_paise) : (amount != null ? Math.round(amount * 100) : null);
        const sql = `
          INSERT INTO links (
            id, "merchantId", "upiId", name, description, slug,
            amount, amount_paise, "amountType", template, active, "createdAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            slug = EXCLUDED.slug,
            amount = EXCLUDED.amount,
            amount_paise = EXCLUDED.amount_paise,
            "amountType" = EXCLUDED."amountType",
            template = EXCLUDED.template,
            active = EXCLUDED.active
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          l.merchantId,
          l.upiId || null,
          l.name,
          l.description || '',
          l.slug,
          amount,
          amountPaise,
          l.amountType || 'fixed',
          l.template || 'classic',
          l.active !== undefined ? Boolean(l.active) : true,
          createdAt
        ]);
        return mapLink(res.rows[0]);
      },
      async update(id, partial) {
        const current = await this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const amount = merged.amount != null ? Number(merged.amount) : null;
        const amountPaise = merged.amount_paise != null ? Number(merged.amount_paise) : (amount != null ? Math.round(amount * 100) : null);
        const sql = `
          UPDATE links SET
            name = $2,
            description = $3,
            slug = $4,
            amount = $5,
            amount_paise = $6,
            "amountType" = $7,
            template = $8,
            active = $9,
            "upiId" = $10
          WHERE id = $1
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          merged.name,
          merged.description || '',
          merged.slug,
          amount,
          amountPaise,
          merged.amountType,
          merged.template || 'classic',
          Boolean(merged.active),
          merged.upiId || null
        ]);
        return mapLink(res.rows[0]);
      },
      async delete(id) {
        const res = await clientOrPool.query('DELETE FROM links WHERE id = $1', [id]);
        return (res.rowCount || 0) > 0;
      },
      async count() {
        const res = await clientOrPool.query('SELECT COUNT(*) as c FROM links');
        return Number(res.rows[0]?.c || 0);
      }
    },

    // ── Transactions Ledger ───────────────────────────────────────────────────
    transactions: {
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM transactions WHERE id = $1 LIMIT 1', [id]);
        return mapTransaction(res.rows[0]);
      },
      async findByReference(ref) {
        if (!ref) return null;
        const res = await clientOrPool.query('SELECT * FROM transactions WHERE reference = $1 LIMIT 1', [ref]);
        return mapTransaction(res.rows[0]);
      },
      async findByUtr(merchantId, utr) {
        if (!merchantId || !utr) return null;
        const raw = String(utr).trim();
        const sanitized = raw.replace(/[^a-zA-Z0-9]/g, '');
        const sql = `
          SELECT * FROM transactions
          WHERE "merchantId" = $1 AND (utr = $2 OR utr = $3 OR REPLACE(REPLACE(utr, '-', ''), '_', '') = $3)
          LIMIT 1
        `;
        const res = await clientOrPool.query(sql, [merchantId, raw, sanitized]);
        return mapTransaction(res.rows[0]);
      },
      async findForCheckout(merchantId, { txId, ref } = {}) {
        if (!merchantId) return null;
        if (txId && ref) {
          const res = await clientOrPool.query(
            'SELECT * FROM transactions WHERE "merchantId" = $1 AND (id = $2 OR reference = $3) LIMIT 1',
            [merchantId, txId, ref]
          );
          return mapTransaction(res.rows[0]);
        }
        if (txId) {
          const res = await clientOrPool.query(
            'SELECT * FROM transactions WHERE "merchantId" = $1 AND id = $2 LIMIT 1',
            [merchantId, txId]
          );
          return mapTransaction(res.rows[0]);
        }
        if (ref) {
          const res = await clientOrPool.query(
            'SELECT * FROM transactions WHERE "merchantId" = $1 AND reference = $2 LIMIT 1',
            [merchantId, ref]
          );
          return mapTransaction(res.rows[0]);
        }
        return null;
      },
      async findByMerchant(merchantId, options = {}) {
        if (!merchantId) return [];
        let sql = 'SELECT * FROM transactions WHERE "merchantId" = $1';
        const params = [merchantId];

        if (options.status && options.status !== 'all') {
          params.push(options.status);
          sql += ` AND status = $${params.length}`;
        }
        if (options.q) {
          params.push(`%${options.q.toLowerCase()}%`);
          sql += ` AND (LOWER(reference) LIKE $${params.length} OR LOWER("customerName") LIKE $${params.length} OR LOWER("customerEmail") LIKE $${params.length})`;
        }
        if (options.start) {
          params.push(options.start);
          sql += ` AND "createdAt" >= $${params.length}`;
        }
        if (options.end) {
          params.push(options.end + 'T23:59:59.999Z');
          sql += ` AND "createdAt" <= $${params.length}`;
        }
        if (options.range === 'today') {
          sql += ` AND "createdAt" >= CURRENT_DATE`;
        } else if (options.range === 'month') {
          sql += ` AND "createdAt" >= NOW() - INTERVAL '30 days'`;
        }

        sql += ' ORDER BY "createdAt" DESC';
        if (options.limit && Number.isFinite(options.limit)) {
          params.push(options.limit);
          sql += ` LIMIT $${params.length}`;
        }

        const res = await clientOrPool.query(sql, params);
        return res.rows.map(mapTransaction);
      },
      async findPendingForCompanion(merchantId) {
        const sql = 'SELECT * FROM transactions WHERE "merchantId" = $1 AND status = \'pending\' ORDER BY "createdAt" DESC';
        const res = await clientOrPool.query(sql, [merchantId]);
        return res.rows.map(mapTransaction);
      },
      async listAll(options = {}) {
        let sql = 'SELECT * FROM transactions WHERE 1=1';
        const params = [];
        if (options.merchantId) {
          params.push(options.merchantId);
          sql += ` AND "merchantId" = $${params.length}`;
        }
        if (options.status && options.status !== 'all') {
          params.push(options.status);
          sql += ` AND status = $${params.length}`;
        }
        if (options.q) {
          params.push(`%${options.q.toLowerCase()}%`);
          sql += ` AND (LOWER(reference) LIKE $${params.length} OR LOWER("customerName") LIKE $${params.length} OR LOWER("customerEmail") LIKE $${params.length})`;
        }
        sql += ' ORDER BY "createdAt" DESC';
        if (options.limit && Number.isFinite(options.limit)) {
          params.push(options.limit);
          sql += ` LIMIT $${params.length}`;
        }
        const res = await clientOrPool.query(sql, params);
        return res.rows.map(mapTransaction);
      },
      async create(tx) {
        const id = tx.id || `txn_${crypto.randomBytes(8).toString('hex')}`;
        const amount = Number(tx.amount || 0);
        const amountPaise = Number.isFinite(tx.amount_paise) ? tx.amount_paise : Math.round(amount * 100);
        const createdAt = tx.createdAt || new Date().toISOString();

        const sql = `
          INSERT INTO transactions (
            id, "merchantId", "linkId", reference, "customerName", "customerEmail", "customerUpi",
            amount, amount_paise, status, utr, "verifiedBy", "paidAt", "merchantNote",
            "utrSubmittedAt", "reconciliationStatus", "ambiguityReason", "providerReference",
            "verifiedAt", "auditLog", "createdAt", "cashierId"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            utr = EXCLUDED.utr,
            "verifiedBy" = EXCLUDED."verifiedBy",
            "paidAt" = EXCLUDED."paidAt",
            "merchantNote" = EXCLUDED."merchantNote",
            "utrSubmittedAt" = EXCLUDED."utrSubmittedAt",
            "reconciliationStatus" = EXCLUDED."reconciliationStatus",
            "ambiguityReason" = EXCLUDED."ambiguityReason",
            "providerReference" = EXCLUDED."providerReference",
            "verifiedAt" = EXCLUDED."verifiedAt",
            "auditLog" = EXCLUDED."auditLog",
            "cashierId" = EXCLUDED."cashierId"
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
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
          createdAt,
          tx.cashierId || null
        ]);
        return mapTransaction(res.rows[0]);
      },
      async update(id, partial) {
        const current = await this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const amount = Number(merged.amount || 0);
        const amountPaise = Number.isFinite(merged.amount_paise) ? merged.amount_paise : Math.round(amount * 100);

        const sql = `
          UPDATE transactions SET
            "linkId" = $2,
            reference = $3,
            "customerName" = $4,
            "customerEmail" = $5,
            "customerUpi" = $6,
            amount = $7,
            amount_paise = $8,
            status = $9,
            utr = $10,
            "verifiedBy" = $11,
            "paidAt" = $12,
            "merchantNote" = $13,
            "utrSubmittedAt" = $14,
            "reconciliationStatus" = $15,
            "ambiguityReason" = $16,
            "providerReference" = $17,
            "verifiedAt" = $18,
            "auditLog" = $19,
            "cashierId" = $20
          WHERE id = $1
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
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
          merged.cashierId || null
        ]);
        return mapTransaction(res.rows[0]);
      },
      async updateVerified(id, partial) {
        return this.update(id, partial);
      },
      async delete(id) {
        const res = await clientOrPool.query('DELETE FROM transactions WHERE id = $1', [id]);
        return (res.rowCount || 0) > 0;
      },
      async count() {
        const res = await clientOrPool.query('SELECT COUNT(*) as c FROM transactions');
        return Number(res.rows[0]?.c || 0);
      },
      async getMerchantOverviewStats(merchantId, range = 'month') {
        const allTx = await this.findByMerchant(merchantId, { range });
        const success = allTx.filter(x => x.status === 'success');
        const pending = allTx.filter(x => x.status === 'pending');
        const linksRes = await clientOrPool.query('SELECT * FROM links WHERE "merchantId" = $1', [merchantId]);
        const links = linksRes.rows.map(mapLink);
        return {
          volume: success.reduce((sum, x) => sum + x.amount, 0),
          volumePaise: success.reduce((sum, x) => sum + x.amount_paise, 0),
          successful: success.length,
          pending: pending.length,
          activeLinks: links.filter(x => x.active).length,
          recent: allTx.slice(0, 5)
        };
      },
      async getGlobalMetrics() {
        const merchantsRes = await clientOrPool.query('SELECT COUNT(*) as c FROM merchants');
        const activeMerchantsRes = await clientOrPool.query('SELECT COUNT(*) as c FROM merchants WHERE suspended = FALSE');
        const suspendedMerchantsRes = await clientOrPool.query('SELECT COUNT(*) as c FROM merchants WHERE suspended = TRUE');
        const txCountRes = await clientOrPool.query('SELECT COUNT(*) as c FROM transactions');
        const linksCountRes = await clientOrPool.query('SELECT COUNT(*) as c FROM links');
        const activeLinksCountRes = await clientOrPool.query('SELECT COUNT(*) as c FROM links WHERE active = TRUE');
        const errorsCountRes = await clientOrPool.query('SELECT COUNT(*) as c FROM errors');
        const successTxRes = await clientOrPool.query('SELECT amount, amount_paise FROM transactions WHERE status = \'success\'');

        const totalMerchants = Number(merchantsRes.rows[0]?.c || 0);
        const activeMerchants = Number(activeMerchantsRes.rows[0]?.c || 0);
        const suspendedMerchants = Number(suspendedMerchantsRes.rows[0]?.c || 0);
        const totalTransactions = Number(txCountRes.rows[0]?.c || 0);
        const totalLinks = Number(linksCountRes.rows[0]?.c || 0);
        const activeLinks = Number(activeLinksCountRes.rows[0]?.c || 0);
        const totalErrors = Number(errorsCountRes.rows[0]?.c || 0);

        const totalVolume = successTxRes.rows.reduce((sum, r) => sum + Number(r.amount), 0);
        const totalVolumePaise = successTxRes.rows.reduce((sum, r) => sum + Number(r.amount_paise || Math.round(Number(r.amount) * 100)), 0);

        return {
          totalMerchants,
          activeMerchants,
          suspendedMerchants,
          totalTransactions,
          totalLinks,
          activeLinks,
          totalErrors,
          totalVolume,
          totalVolumePaise,
          settledTransactions: successTxRes.rows.length
        };
      },
      async search(options = {}) {
        let sql = 'SELECT * FROM transactions WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as c FROM transactions WHERE 1=1';
        const params = [];

        if (options.merchantId) {
          params.push(options.merchantId);
          sql += ` AND "merchantId" = $${params.length}`;
          countSql += ` AND "merchantId" = $${params.length}`;
        }
        if (options.status && options.status !== 'all') {
          params.push(options.status);
          sql += ` AND status = $${params.length}`;
          countSql += ` AND status = $${params.length}`;
        }
        if (options.reconciliationStatus && options.reconciliationStatus !== 'all') {
          params.push(options.reconciliationStatus);
          sql += ` AND "reconciliationStatus" = $${params.length}`;
          countSql += ` AND "reconciliationStatus" = $${params.length}`;
        }
        if (options.utr) {
          const raw = `%${options.utr.trim()}%`;
          const clean = `%${options.utr.trim().replace(/[^a-zA-Z0-9]/g, '')}%`;
          params.push(raw, clean);
          sql += ` AND (utr LIKE $${params.length - 1} OR REPLACE(REPLACE(utr, '-', ''), '_', '') LIKE $${params.length})`;
          countSql += ` AND (utr LIKE $${params.length - 1} OR REPLACE(REPLACE(utr, '-', ''), '_', '') LIKE $${params.length})`;
        }
        if (options.providerReference) {
          params.push(`%${options.providerReference.trim()}%`);
          sql += ` AND "providerReference" LIKE $${params.length}`;
          countSql += ` AND "providerReference" LIKE $${params.length}`;
        }
        if (options.q) {
          const q = `%${options.q.trim().toLowerCase()}%`;
          params.push(q);
          sql += ` AND (LOWER(reference) LIKE $${params.length} OR LOWER("customerName") LIKE $${params.length} OR LOWER("customerEmail") LIKE $${params.length} OR id LIKE $${params.length})`;
          countSql += ` AND (LOWER(reference) LIKE $${params.length} OR LOWER("customerName") LIKE $${params.length} OR LOWER("customerEmail") LIKE $${params.length} OR id LIKE $${params.length})`;
        }
        if (options.start) {
          params.push(options.start);
          sql += ` AND "createdAt" >= $${params.length}`;
          countSql += ` AND "createdAt" >= $${params.length}`;
        }
        if (options.end) {
          params.push(options.end + 'T23:59:59.999Z');
          sql += ` AND "createdAt" <= $${params.length}`;
          countSql += ` AND "createdAt" <= $${params.length}`;
        }

        const countRes = await clientOrPool.query(countSql, params);
        const total = Number(countRes.rows[0]?.c || 0);

        sql += ' ORDER BY "createdAt" DESC';
        const limit = Math.min(Number(options.limit) || 50, 200);
        const offset = Math.max(Number(options.offset) || 0, 0);

        params.push(limit);
        sql += ` LIMIT $${params.length}`;
        params.push(offset);
        sql += ` OFFSET $${params.length}`;

        const rowsRes = await clientOrPool.query(sql, params);
        return { total, limit, offset, items: rowsRes.rows.map(mapTransaction) };
      },
      async getInvestigation(txId) {
        const tx = await this.findById(txId);
        if (!tx) return null;
        const merchant = await repo.merchants.findById(tx.merchantId);

        const timeline = [];
        timeline.push({
          timestamp: tx.createdAt,
          type: 'order_created',
          source: 'checkout',
          title: 'Order Created',
          description: `Checkout session created for ₹${tx.amount}`,
          details: { reference: tx.reference, customerName: tx.customerName, amount: tx.amount }
        });

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

        const adminAuditsRes = await clientOrPool.query(
          'SELECT * FROM admin_audit_trail WHERE "targetId" = $1 ORDER BY "createdAt" ASC',
          [tx.id]
        );
        for (const a of adminAuditsRes.rows.map(mapAdminAudit)) {
          timeline.push({
            timestamp: a.createdAt,
            type: 'admin_reconciliation',
            source: 'admin_rbac',
            title: `Admin Action: ${a.action}`,
            description: `${a.actorEmail} (${a.actorRole}) - ${a.justification}`,
            details: {
              actorEmail: a.actorEmail,
              actorRole: a.actorRole,
              reasonCode: a.reasonCode,
              beforeState: a.beforeState,
              afterState: a.afterState,
              outcome: a.outcome
            }
          });
        }

        timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        return {
          transaction: tx,
          merchant,
          timeline,
          reconciliationStatus: tx.reconciliationStatus,
          ambiguityReason: tx.ambiguityReason,
          providerReference: tx.providerReference,
          terminalLocked: tx.status === 'success'
        };
      }
    },

    // ── API Keys ──────────────────────────────────────────────────────────────
    apiKeys: {
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM "apiKeys" WHERE id = $1 LIMIT 1', [id]);
        return mapApiKey(res.rows[0]);
      },
      async findByHash(hash) {
        if (!hash) return null;
        const res = await clientOrPool.query('SELECT * FROM "apiKeys" WHERE hash = $1 LIMIT 1', [hash]);
        return mapApiKey(res.rows[0]);
      },
      async findByMerchant(merchantId) {
        if (!merchantId) return [];
        const res = await clientOrPool.query('SELECT * FROM "apiKeys" WHERE "merchantId" = $1 ORDER BY "createdAt" DESC', [merchantId]);
        return res.rows.map(mapApiKey);
      },
      async listAll() {
        const res = await clientOrPool.query('SELECT * FROM "apiKeys" ORDER BY "createdAt" DESC');
        return res.rows.map(mapApiKey);
      },
      async create(k) {
        const id = k.id || `key_${crypto.randomBytes(8).toString('hex')}`;
        const createdAt = k.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO "apiKeys" (id, "merchantId", name, prefix, hash, "createdAt", "lastUsedAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET "lastUsedAt" = EXCLUDED."lastUsedAt"
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          k.merchantId,
          k.name,
          k.prefix,
          k.hash,
          createdAt,
          k.lastUsedAt || null
        ]);
        return mapApiKey(res.rows[0]);
      },
      async updateLastUsed(id, timestamp = new Date().toISOString()) {
        const res = await clientOrPool.query('UPDATE "apiKeys" SET "lastUsedAt" = $2 WHERE id = $1 RETURNING *', [id, timestamp]);
        return mapApiKey(res.rows[0]);
      },
      async delete(id, merchantId = null) {
        let sql = 'DELETE FROM "apiKeys" WHERE id = $1';
        const params = [id];
        if (merchantId) {
          params.push(merchantId);
          sql += ' AND "merchantId" = $2';
        }
        const res = await clientOrPool.query(sql, params);
        return (res.rowCount || 0) > 0;
      }
    },

    // ── Business Accounts Vault ────────────────────────────────────────────────
    businessAccounts: {
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM "businessAccounts" WHERE id = $1 LIMIT 1', [id]);
        return mapBusinessAccount(res.rows[0]);
      },
      async findByMerchant(merchantId) {
        if (!merchantId) return [];
        const res = await clientOrPool.query('SELECT * FROM "businessAccounts" WHERE "merchantId" = $1 ORDER BY "createdAt" ASC', [merchantId]);
        return res.rows.map(mapBusinessAccount);
      },
      async findByProviderAndMid(provider, midRef) {
        if (!provider || !midRef) return null;
        const res = await clientOrPool.query(
          'SELECT * FROM "businessAccounts" WHERE provider = $1 AND "merchantIdRef" = $2 LIMIT 1',
          [provider, midRef]
        );
        return mapBusinessAccount(res.rows[0]);
      },
      async listAll() {
        const res = await clientOrPool.query('SELECT * FROM "businessAccounts" ORDER BY "createdAt" ASC');
        return res.rows.map(mapBusinessAccount);
      },
      async create(b) {
        const id = b.id || `biz_${crypto.randomBytes(8).toString('hex')}`;
        const createdAt = b.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO "businessAccounts" (
            id, "merchantId", provider, "accountName", "phoneNumber", "merchantIdRef",
            token, "saltIndex", status, "autoVerify", "lastSyncedAt", "createdAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO UPDATE SET
            "accountName" = EXCLUDED."accountName",
            "phoneNumber" = EXCLUDED."phoneNumber",
            "merchantIdRef" = EXCLUDED."merchantIdRef",
            token = EXCLUDED.token,
            "saltIndex" = EXCLUDED."saltIndex",
            status = EXCLUDED.status,
            "autoVerify" = EXCLUDED."autoVerify",
            "lastSyncedAt" = EXCLUDED."lastSyncedAt"
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          b.merchantId,
          b.provider,
          b.accountName,
          b.phoneNumber,
          b.merchantIdRef,
          b.token,
          b.saltIndex || '1',
          b.status,
          b.autoVerify !== undefined ? Boolean(b.autoVerify) : true,
          b.lastSyncedAt || null,
          createdAt
        ]);
        return mapBusinessAccount(res.rows[0]);
      },
      async update(id, partial) {
        const current = await this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const sql = `
          UPDATE "businessAccounts" SET
            "accountName" = $2,
            "phoneNumber" = $3,
            "merchantIdRef" = $4,
            token = $5,
            "saltIndex" = $6,
            status = $7,
            "autoVerify" = $8,
            "lastSyncedAt" = $9
          WHERE id = $1
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          merged.accountName,
          merged.phoneNumber,
          merged.merchantIdRef,
          merged.token,
          merged.saltIndex || '1',
          merged.status,
          Boolean(merged.autoVerify),
          merged.lastSyncedAt || null
        ]);
        return mapBusinessAccount(res.rows[0]);
      },
      async delete(id, merchantId = null) {
        let sql = 'DELETE FROM "businessAccounts" WHERE id = $1';
        const params = [id];
        if (merchantId) {
          params.push(merchantId);
          sql += ' AND "merchantId" = $2';
        }
        const res = await clientOrPool.query(sql, params);
        return (res.rowCount || 0) > 0;
      }
    },

    // ── OAuth States ──────────────────────────────────────────────────────────
    oauthStates: {
      async create(state, expiresAt) {
        await clientOrPool.query(
          'INSERT INTO "oauthStates" (state, "expiresAt") VALUES ($1, $2) ON CONFLICT (state) DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt"',
          [state, Number(expiresAt)]
        );
        return { state, expiresAt: Number(expiresAt) };
      },
      async consume(state) {
        if (!state) return false;
        const now = Date.now();
        const res = await clientOrPool.query(
          'DELETE FROM "oauthStates" WHERE state = $1 AND "expiresAt" > $2 RETURNING state',
          [state, now]
        );
        return res.rows.length > 0;
      },
      async pruneExpired(now = Date.now()) {
        const res = await clientOrPool.query('DELETE FROM "oauthStates" WHERE "expiresAt" <= $1', [now]);
        return res.rowCount || 0;
      },
      async listAll() {
        const res = await clientOrPool.query('SELECT * FROM "oauthStates"');
        return res.rows.map(r => ({ state: r.state, expiresAt: Number(r.expiresAt) }));
      }
    },

    // ── Errors Log ────────────────────────────────────────────────────────────
    errors: {
      async log(e) {
        const id = `err_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const createdAt = e.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO errors (id, "merchantId", message, stack, url, line, col, "createdAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          e.merchantId || null,
          String(e.message || 'Unknown error').slice(0, 2000),
          e.stack ? String(e.stack).slice(0, 5000) : null,
          e.url ? String(e.url).slice(0, 500) : null,
          e.line != null ? Number(e.line) : null,
          e.col != null ? Number(e.col) : null,
          createdAt
        ]);
        return mapError(res.rows[0]);
      },
      async list({ limit = 100 } = {}) {
        const res = await clientOrPool.query('SELECT * FROM errors ORDER BY "createdAt" DESC LIMIT $1', [limit]);
        return res.rows.map(mapError);
      },
      async clear() {
        await clientOrPool.query('DELETE FROM errors');
        return true;
      },
      async count() {
        const res = await clientOrPool.query('SELECT COUNT(*) as c FROM errors');
        return Number(res.rows[0]?.c || 0);
      }
    },

    // ── Admin Users RBAC ───────────────────────────────────────────────────────
    adminUsers: {
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM admin_users WHERE id = $1 LIMIT 1', [id]);
        return mapAdminUser(res.rows[0]);
      },
      async findByEmail(email) {
        if (!email) return null;
        const res = await clientOrPool.query('SELECT * FROM admin_users WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
        return mapAdminUser(res.rows[0]);
      },
      async listAll({ role = null, active = null } = {}) {
        let sql = 'SELECT * FROM admin_users WHERE 1=1';
        const params = [];
        if (role) {
          params.push(role);
          sql += ` AND role = $${params.length}`;
        }
        if (active !== null && active !== undefined) {
          params.push(Boolean(active));
          sql += ` AND active = $${params.length}`;
        }
        sql += ' ORDER BY "createdAt" DESC';
        const res = await clientOrPool.query(sql, params);
        return res.rows.map(mapAdminUser);
      },
      async create(a) {
        const id = a.id || `adm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const createdAt = a.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO admin_users (id, email, name, "passwordHash", role, "createdAt", "lastLoginAt", active)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            "passwordHash" = EXCLUDED."passwordHash",
            active = EXCLUDED.active,
            "lastLoginAt" = EXCLUDED."lastLoginAt"
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          a.email,
          a.name,
          a.passwordHash,
          a.role,
          createdAt,
          a.lastLoginAt || null,
          a.active !== undefined ? Boolean(a.active) : true
        ]);
        return mapAdminUser(res.rows[0]);
      },
      async update(id, partial) {
        const current = await this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const sql = `
          UPDATE admin_users SET
            email = $2,
            name = $3,
            "passwordHash" = $4,
            role = $5,
            active = $6,
            "lastLoginAt" = $7
          WHERE id = $1
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          merged.email,
          merged.name,
          merged.passwordHash,
          merged.role,
          Boolean(merged.active),
          merged.lastLoginAt || null
        ]);
        return mapAdminUser(res.rows[0]);
      },
      async delete(id) {
        const res = await clientOrPool.query('DELETE FROM admin_users WHERE id = $1', [id]);
        return (res.rowCount || 0) > 0;
      },
      async count() {
        const res = await clientOrPool.query('SELECT COUNT(*) as c FROM admin_users');
        return Number(res.rows[0]?.c || 0);
      }
    },

    // ── Admin Audit Trail ─────────────────────────────────────────────────────
    adminAudit: {
      async create(entry) {
        const id = entry.id || `aud_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const createdAt = entry.createdAt || new Date().toISOString();
        const beforeJson = entry.beforeState ? (typeof entry.beforeState === 'string' ? entry.beforeState : JSON.stringify(entry.beforeState)) : null;
        const afterJson = entry.afterState ? (typeof entry.afterState === 'string' ? entry.afterState : JSON.stringify(entry.afterState)) : null;

        const sql = `
          INSERT INTO admin_audit_trail (
            id, "actorId", "actorEmail", "actorRole", action, "targetType", "targetId",
            "reasonCode", justification, "beforeState", "afterState",
            "correlationId", "ipAddress", outcome, "createdAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          String(entry.actorId || 'system').slice(0, 64),
          String(entry.actorEmail || 'system@sakkupay.local').slice(0, 255),
          String(entry.actorRole || 'System').slice(0, 64),
          String(entry.action || 'unknown').slice(0, 80),
          String(entry.targetType || 'system').slice(0, 50),
          entry.targetId ? String(entry.targetId).slice(0, 80) : null,
          String(entry.reasonCode || 'ADMIN_OPERATION').slice(0, 50),
          String(entry.justification || 'Action executed').slice(0, 1000),
          beforeJson,
          afterJson,
          entry.correlationId ? String(entry.correlationId).slice(0, 80) : null,
          entry.ipAddress ? String(entry.ipAddress).slice(0, 45) : null,
          ['success', 'denied', 'failed'].includes(entry.outcome) ? entry.outcome : 'success',
          createdAt
        ]);
        return mapAdminAudit(res.rows[0]);
      },
      async list(options = {}) {
        let sql = 'SELECT * FROM admin_audit_trail WHERE 1=1';
        const params = [];
        if (options.actorId) {
          params.push(options.actorId);
          sql += ` AND "actorId" = $${params.length}`;
        }
        if (options.action) {
          params.push(options.action);
          sql += ` AND action = $${params.length}`;
        }
        if (options.targetType) {
          params.push(options.targetType);
          sql += ` AND "targetType" = $${params.length}`;
        }
        if (options.targetId) {
          params.push(options.targetId);
          sql += ` AND "targetId" = $${params.length}`;
        }
        sql += ' ORDER BY "createdAt" DESC';
        const limit = Math.min(Number(options.limit) || 50, 200);
        const offset = Math.max(Number(options.offset) || 0, 0);
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
        params.push(offset);
        sql += ` OFFSET $${params.length}`;
        const res = await clientOrPool.query(sql, params);
        return res.rows.map(mapAdminAudit);
      },
      async count(options = {}) {
        let sql = 'SELECT COUNT(*) as c FROM admin_audit_trail WHERE 1=1';
        const params = [];
        if (options.actorId) {
          params.push(options.actorId);
          sql += ` AND "actorId" = $${params.length}`;
        }
        if (options.action) {
          params.push(options.action);
          sql += ` AND action = $${params.length}`;
        }
        if (options.targetType) {
          params.push(options.targetType);
          sql += ` AND "targetType" = $${params.length}`;
        }
        if (options.targetId) {
          params.push(options.targetId);
          sql += ` AND "targetId" = $${params.length}`;
        }
        const res = await clientOrPool.query(sql, params);
        return Number(res.rows[0]?.c || 0);
      },
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM admin_audit_trail WHERE id = $1 LIMIT 1', [id]);
        return mapAdminAudit(res.rows[0]);
      }
    },

    // ── Support Queries ───────────────────────────────────────────────────────
    supportQueries: {
      async create(q) {
        const id = q.id || `sup_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const createdAt = q.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO support_queries (id, "merchantId", category, subject, message, status, "createdAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          q.merchantId,
          q.category || 'general',
          q.subject,
          q.message,
          q.status || 'open',
          createdAt
        ]);
        return mapSupportQuery(res.rows[0]);
      },
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM support_queries WHERE id = $1 LIMIT 1', [id]);
        return mapSupportQuery(res.rows[0]);
      },
      async findByMerchant(merchantId) {
        if (!merchantId) return [];
        const res = await clientOrPool.query('SELECT * FROM support_queries WHERE "merchantId" = $1 ORDER BY "createdAt" DESC', [merchantId]);
        return res.rows.map(mapSupportQuery);
      },
      async listByMerchant(merchantId) {
        return this.findByMerchant(merchantId);
      },
      async listAll(limit = 100) {
        const res = await clientOrPool.query('SELECT * FROM support_queries ORDER BY "createdAt" DESC LIMIT $1', [limit]);
        return res.rows.map(mapSupportQuery);
      }
    },

    // ── Cashiers ──────────────────────────────────────────────────────────────
    cashiers: {
      async create(c) {
        const id = c.id || `csh_${crypto.randomBytes(8).toString('hex')}`;
        const createdAt = c.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO cashiers (id, "merchantId", name, provider, "phoneNumber", "upiId", status, "pairedAt", "lastSeenAt", "createdAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            provider = EXCLUDED.provider,
            "phoneNumber" = EXCLUDED."phoneNumber",
            "upiId" = EXCLUDED."upiId",
            status = EXCLUDED.status,
            "pairedAt" = EXCLUDED."pairedAt",
            "lastSeenAt" = EXCLUDED."lastSeenAt"
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          c.merchantId,
          c.name,
          c.provider,
          c.phoneNumber,
          c.upiId,
          c.status || 'pending_pairing',
          c.pairedAt || null,
          c.lastSeenAt || null,
          createdAt
        ]);
        return mapCashier(res.rows[0]);
      },
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM cashiers WHERE id = $1 LIMIT 1', [id]);
        return mapCashier(res.rows[0]);
      },
      async findByMerchant(merchantId) {
        if (!merchantId) return [];
        const res = await clientOrPool.query('SELECT * FROM cashiers WHERE "merchantId" = $1 ORDER BY "createdAt" DESC', [merchantId]);
        return res.rows.map(mapCashier);
      },
      async update(id, partial) {
        const current = await this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const sql = `
          UPDATE cashiers SET
            name = $2,
            provider = $3,
            "phoneNumber" = $4,
            "upiId" = $5,
            status = $6,
            "pairedAt" = $7,
            "lastSeenAt" = $8
          WHERE id = $1
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          merged.name,
          merged.provider,
          merged.phoneNumber,
          merged.upiId,
          merged.status,
          merged.pairedAt || null,
          merged.lastSeenAt || null
        ]);
        return mapCashier(res.rows[0]);
      },
      async delete(id) {
        const res = await clientOrPool.query('DELETE FROM cashiers WHERE id = $1', [id]);
        return (res.rowCount || 0) > 0;
      }
    },

    // ── Cashier Pairing Sessions ──────────────────────────────────────────────
    cashierPairingSessions: {
      async create(s) {
        const id = s.id || `pair_${crypto.randomBytes(8).toString('hex')}`;
        const createdAt = s.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO cashier_pairing_sessions (
            id, "merchantId", "cashierId", "serverCodeHash", "appCodeHash",
            status, attempts, "expiresAt", "completedAt", "createdAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          s.merchantId,
          s.cashierId,
          s.serverCodeHash,
          s.appCodeHash || null,
          s.status || 'pending_server_code',
          s.attempts || 0,
          s.expiresAt,
          s.completedAt || null,
          createdAt
        ]);
        return mapPairingSession(res.rows[0]);
      },
      async findById(id) {
        if (!id) return null;
        const res = await clientOrPool.query('SELECT * FROM cashier_pairing_sessions WHERE id = $1 LIMIT 1', [id]);
        return mapPairingSession(res.rows[0]);
      },
      async findByServerCodeHash(serverCodeHash) {
        if (!serverCodeHash) return null;
        const res = await clientOrPool.query(
          'SELECT * FROM cashier_pairing_sessions WHERE "serverCodeHash" = $1 ORDER BY "createdAt" DESC LIMIT 1',
          [serverCodeHash]
        );
        return mapPairingSession(res.rows[0]);
      },
      async findByAppCodeHash(appCodeHash) {
        if (!appCodeHash) return null;
        const res = await clientOrPool.query(
          'SELECT * FROM cashier_pairing_sessions WHERE "appCodeHash" = $1 ORDER BY "createdAt" DESC LIMIT 1',
          [appCodeHash]
        );
        return mapPairingSession(res.rows[0]);
      },
      async findActiveByMerchant(merchantId) {
        if (!merchantId) return null;
        const res = await clientOrPool.query(
          'SELECT * FROM cashier_pairing_sessions WHERE "merchantId" = $1 AND status NOT IN (\'completed\', \'expired\', \'revoked\') AND "expiresAt" > NOW() ORDER BY "createdAt" DESC LIMIT 1',
          [merchantId]
        );
        return mapPairingSession(res.rows[0]);
      },
      async update(id, partial) {
        const current = await this.findById(id);
        if (!current) return null;
        const merged = { ...current, ...partial };
        const sql = `
          UPDATE cashier_pairing_sessions SET
            "appCodeHash" = $2,
            status = $3,
            attempts = $4,
            "expiresAt" = $5,
            "completedAt" = $6
          WHERE id = $1
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          merged.appCodeHash || null,
          merged.status,
          merged.attempts || 0,
          merged.expiresAt,
          merged.completedAt || null
        ]);
        return mapPairingSession(res.rows[0]);
      }
    },

    // ── Cashier Security Logs ─────────────────────────────────────────────────
    cashierLogs: {
      async create(log) {
        const id = log.id || `clog_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const createdAt = log.createdAt || new Date().toISOString();
        const sql = `
          INSERT INTO cashier_logs (id, "merchantId", "cashierId", event, details, "ipAddress", "createdAt")
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `;
        const res = await clientOrPool.query(sql, [
          id,
          log.merchantId,
          log.cashierId || null,
          log.event,
          log.details || null,
          log.ipAddress || null,
          createdAt
        ]);
        return mapCashierLog(res.rows[0]);
      },
      async findByMerchant(merchantId, limit = 50) {
        if (!merchantId) return [];
        const res = await clientOrPool.query(
          'SELECT * FROM cashier_logs WHERE "merchantId" = $1 ORDER BY "createdAt" DESC LIMIT $2',
          [merchantId, limit]
        );
        return res.rows.map(mapCashierLog);
      },
      async listByMerchant(merchantId, limit = 50) {
        return this.findByMerchant(merchantId, limit);
      },
      async findByCashier(cashierId, limit = 50) {
        if (!cashierId) return [];
        const res = await clientOrPool.query(
          'SELECT * FROM cashier_logs WHERE "cashierId" = $1 ORDER BY "createdAt" DESC LIMIT $2',
          [cashierId, limit]
        );
        return res.rows.map(mapCashierLog);
      }
    }
  };

  return repo;
}

module.exports = {
  createPostgresRepository
};
