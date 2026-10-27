/* ==============================================================================
   SakkuPay — Administrative Role-Based Access Control (RBAC) & Permissions
   Roles:
   - SuperAdmin: Full platform configuration, user management, and administrative operations.
   - OperationsSupport: Merchant and transaction investigation; explicitly permitted support actions.
   - ComplianceAuditor: Read-only investigation records and audit history without mutations.
   ============================================================================== */
'use strict';

const crypto = require('node:crypto');

const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'SuperAdmin',
  OPERATIONS_SUPPORT: 'OperationsSupport',
  COMPLIANCE_AUDITOR: 'ComplianceAuditor'
});

const ROLE_PERMISSIONS = Object.freeze({
  [ADMIN_ROLES.SUPER_ADMIN]: new Set([
    'admin.users.read',
    'admin.users.write',
    'audit.read',
    'merchants.read',
    'merchants.write',
    'transactions.read',
    'transactions.investigate',
    'transactions.reconcile',
    'system.health.read',
    'system.whatsapp.manage',
    'errors.read',
    'errors.clear'
  ]),
  [ADMIN_ROLES.OPERATIONS_SUPPORT]: new Set([
    'merchants.read',
    'transactions.read',
    'transactions.investigate',
    'transactions.reconcile',
    'system.health.read',
    'errors.read'
  ]),
  [ADMIN_ROLES.COMPLIANCE_AUDITOR]: new Set([
    'audit.read',
    'merchants.read',
    'transactions.read',
    'transactions.investigate',
    'system.health.read',
    'errors.read'
  ])
});

const REASON_CODES = Object.freeze({
  OFFICIAL_BANK_STATEMENT_PROOF: 'OFFICIAL_BANK_STATEMENT_PROOF',
  GATEWAY_PORTAL_CONFIRMED: 'GATEWAY_PORTAL_CONFIRMED',
  CHARGEBACK_RESOLVED: 'CHARGEBACK_RESOLVED',
  DUPLICATE_RESOLVED_MANUAL: 'DUPLICATE_RESOLVED_MANUAL',
  SUSPECTED_FRAUD: 'SUSPECTED_FRAUD',
  CUSTOMER_DISPUTE_SETTLED: 'CUSTOMER_DISPUTE_SETTLED',
  PAYMENT_TIMED_OUT: 'PAYMENT_TIMED_OUT',
  MERCHANT_KYC_FAILED: 'MERCHANT_KYC_FAILED',
  MERCHANT_STATUS_UPDATE: 'MERCHANT_STATUS_UPDATE',
  ADMIN_SECURITY_OVERRIDE: 'ADMIN_SECURITY_OVERRIDE',
  COMPLIANCE_HOLD: 'COMPLIANCE_HOLD'
});

/**
 * Checks whether a given role holds the requested permission.
 */
function hasPermission(role, permission) {
  if (!role || !permission) return false;
  // Normalize legacy 'admin' to 'SuperAdmin'
  const normalizedRole = role === 'admin' ? ADMIN_ROLES.SUPER_ADMIN : role;
  const perms = ROLE_PERMISSIONS[normalizedRole];
  if (!perms) return false;
  return perms.has(permission);
}

/**
 * Validates if the role name is an authorized system role.
 */
function isValidRole(role) {
  return Object.values(ADMIN_ROLES).includes(role);
}

/**
 * Validates a reason code against the official catalog or standard format.
 */
function isValidReasonCode(code) {
  if (typeof code !== 'string') return false;
  const trimmed = code.trim();
  if (trimmed.length < 3 || trimmed.length > 50) return false;
  return /^[A-Z0-9_]+$/.test(trimmed);
}

/**
 * Secure password hashing using PBKDF2 with SHA-512 and random salt.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verifies a password against a stored salt:hash string in constant time.
 */
function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHash] = parts;
  const computedHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  const bufExpected = Buffer.from(expectedHash, 'hex');
  const bufComputed = Buffer.from(computedHash, 'hex');
  if (bufExpected.length !== bufComputed.length) return false;
  return crypto.timingSafeEqual(bufExpected, bufComputed);
}

module.exports = {
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  REASON_CODES,
  hasPermission,
  isValidRole,
  isValidReasonCode,
  hashPassword,
  verifyPassword
};
