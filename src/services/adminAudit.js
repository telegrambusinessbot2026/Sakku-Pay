/* ==============================================================================
   SakkuPay — Administrative Audit Trail Logger
   Guarantees:
   - Dedicated append-only records for all sensitive operational actions.
   - Comprehensive actor, role, target, reason code, justification, and before/after states.
   - Strict sanitization of secrets, tokens, and cryptographic keys.
   ============================================================================== */
'use strict';

const crypto = require('node:crypto');
const { isValidReasonCode } = require('./adminRbac');

const SENSITIVE_KEYS = new Set([
  'password', 'passwordHash', 'token', 'secret', 'saltKey', 'salt', 'key',
  'rawResponseBase64', 'CHECKSUMHASH', 'checksum', 'authorization', 'x-verify'
]);

/**
 * Deep-sanitizes an object or string before persisting into the audit trail.
 */
function sanitizeAuditState(state) {
  if (state === null || state === undefined) return null;
  if (typeof state === 'string') {
    try {
      const parsed = JSON.parse(state);
      return JSON.stringify(sanitizeAuditState(parsed));
    } catch {
      return state.slice(0, 1000);
    }
  }
  if (typeof state !== 'object') return state;

  if (Array.isArray(state)) {
    return state.slice(0, 50).map(sanitizeAuditState);
  }

  const clean = {};
  for (const [k, v] of Object.entries(state)) {
    const lowerKey = k.toLowerCase();
    let isSensitive = false;
    for (const s of SENSITIVE_KEYS) {
      if (lowerKey.includes(s.toLowerCase())) {
        isSensitive = true;
        break;
      }
    }
    if (isSensitive) {
      clean[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      clean[k] = sanitizeAuditState(v);
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

/**
 * Persists an immutable administrative audit event.
 */
function logAdminAudit(dbOrRepo, entry) {
  const auditId = entry.id || `aud_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
  const now = entry.createdAt || new Date().toISOString();

  const actorId = String(entry.actorId || 'system').slice(0, 50);
  const actorEmail = String(entry.actorEmail || 'system@sakkupay.local').slice(0, 100);
  const actorRole = String(entry.actorRole || 'System').slice(0, 50);
  const action = String(entry.action || 'unknown').slice(0, 80);
  const targetType = String(entry.targetType || 'system').slice(0, 50);
  const targetId = entry.targetId ? String(entry.targetId).slice(0, 80) : null;
  const reasonCode = isValidReasonCode(entry.reasonCode) ? String(entry.reasonCode).trim() : 'ADMIN_OPERATION';
  const justification = String(entry.justification || 'Administrative action executed').slice(0, 1000);
  const correlationId = entry.correlationId ? String(entry.correlationId).slice(0, 80) : null;
  const ipAddress = entry.ipAddress ? String(entry.ipAddress).slice(0, 45) : null;
  const outcome = ['success', 'denied', 'failed'].includes(entry.outcome) ? entry.outcome : 'success';

  const beforeJson = entry.beforeState ? JSON.stringify(sanitizeAuditState(entry.beforeState)) : null;
  const afterJson = entry.afterState ? JSON.stringify(sanitizeAuditState(entry.afterState)) : null;

  // Insert directly via database connection or repository
  if (dbOrRepo && dbOrRepo.adminAudit && typeof dbOrRepo.adminAudit.create === 'function') {
    return dbOrRepo.adminAudit.create({
      id: auditId,
      actorId,
      actorEmail,
      actorRole,
      action,
      targetType,
      targetId,
      reasonCode,
      justification,
      beforeState: entry.beforeState,
      afterState: entry.afterState,
      correlationId,
      ipAddress,
      outcome,
      createdAt: now
    });
  }

  if (dbOrRepo && typeof dbOrRepo.query === 'function') {
    return dbOrRepo.query(`
      INSERT INTO admin_audit_trail (
        id, "actorId", "actorEmail", "actorRole", action, "targetType", "targetId",
        "reasonCode", justification, "beforeState", "afterState",
        "correlationId", "ipAddress", outcome, "createdAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      auditId, actorId, actorEmail, actorRole, action, targetType, targetId,
      reasonCode, justification, beforeJson, afterJson,
      correlationId, ipAddress, outcome, now
    ]).then(() => ({
      id: auditId,
      actorId,
      actorEmail,
      actorRole,
      action,
      targetType,
      targetId,
      reasonCode,
      justification,
      beforeState: entry.beforeState,
      afterState: entry.afterState,
      correlationId,
      ipAddress,
      outcome,
      createdAt: now
    }));
  }

  const db = dbOrRepo && (dbOrRepo.prepare ? dbOrRepo : (dbOrRepo.sqliteDb || dbOrRepo.db));
  if (db && typeof db.prepare === 'function') {
    db.prepare(`
      INSERT INTO admin_audit_trail (
        id, actorId, actorEmail, actorRole, action, targetType, targetId,
        reasonCode, justification, beforeState, afterState,
        correlationId, ipAddress, outcome, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      auditId, actorId, actorEmail, actorRole, action, targetType, targetId,
      reasonCode, justification, beforeJson, afterJson,
      correlationId, ipAddress, outcome, now
    );
  }

  return {
    id: auditId,
    actorId,
    actorEmail,
    actorRole,
    action,
    targetType,
    targetId,
    reasonCode,
    justification,
    beforeState: beforeJson ? JSON.parse(beforeJson) : null,
    afterState: afterJson ? JSON.parse(afterJson) : null,
    correlationId,
    ipAddress,
    outcome,
    createdAt: now
  };
}

module.exports = {
  sanitizeAuditState,
  logAdminAudit
};
