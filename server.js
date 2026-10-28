/* SakkuPay application server. Uses Node's built-in HTTP, crypto and file APIs. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { getDatabase } = require('./src/db/connection');
const { migrateJsonToSqlite } = require('./src/db/migrate');
const { getRepository } = require('./src/db/repository');
const {
  VALID_TRANSITIONS,
  RECON_STATUS,
  isValidTransition,
  appendAuditLog,
  reconcileCompanionPayment,
  reconcileProviderWebhook
} = require('./src/services/paymentLifecycle');
const {
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  REASON_CODES,
  hasPermission,
  isValidRole,
  isValidReasonCode,
  hashPassword,
  verifyPassword
} = require('./src/services/adminRbac');
const { logAdminAudit, sanitizeAuditState } = require('./src/services/adminAudit');

let wa = null;
try { wa = require('./admin-whatsapp'); } catch(e) { console.warn('WhatsApp module not loaded:', e.message); }

const ROOT = __dirname, STORE = process.env.DATA_JSON_PATH ? path.resolve(process.env.DATA_JSON_PATH) : path.join(ROOT, 'data.json');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const sqliteDb = getDatabase();
// Atomic, repeatable migration from data.json to SQLite on server boot
migrateJsonToSqlite(sqliteDb, STORE);
const repository = getRepository(sqliteDb);

// Populate legacy snapshot for backwards compatibility with tests and callers
let db = repository.getLegacyDbSnapshot();
db.adminSessions ||= [];

const eventClients = new Map();

/* ─── Production Secret Validation (Task 4) ─────────────────────────────────── */
const INSECURE_TOKEN_SECRETS = new Set([
  'development-only-change-this-secret',
  'sakkupay-vault-secret-key-2026',
  'secret', 'changeme', 'password', '12345678'
]);
const INSECURE_VAULT_SECRETS = new Set([
  'vault-encryption-secret-key-change-in-production',
  'sakkupay-vault-secret-key-2026',
  'development-only-change-this-secret'
]);
const INSECURE_ADMIN_PASSWORDS = new Set([
  'changeme123', 'admin', 'password', '123456', 'admin123'
]);

function validateProductionEnvironment() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) return true;

  const errors = [];
  const tokenSec = process.env.SAKKUPAY_TOKEN_SECRET || '';
  const vaultSec = process.env.VAULT_SECRET || '';
  const adminPw = process.env.ADMIN_PASSWORD || '';

  if (!tokenSec || INSECURE_TOKEN_SECRETS.has(tokenSec) || tokenSec.length < 32) {
    errors.push('SAKKUPAY_TOKEN_SECRET must be explicitly set to a random string of at least 32 characters in production.');
  }
  if (!vaultSec || INSECURE_VAULT_SECRETS.has(vaultSec) || vaultSec.length < 32) {
    errors.push('VAULT_SECRET must be explicitly set to a dedicated random 32+ character string in production.');
  }
  if (!adminPw || INSECURE_ADMIN_PASSWORDS.has(adminPw) || adminPw.length < 12) {
    errors.push('ADMIN_PASSWORD must be explicitly set to a secure password of at least 12 characters in production.');
  }

  if (errors.length > 0) {
    console.error('CRITICAL [SakkuPay Security]: Missing or insecure secrets in production:');
    for (const e of errors) console.error('  - ' + e);
    if (require.main === module) process.exit(1);
    throw new Error('Production secret validation failed: ' + errors.join('; '));
  }
  return true;
}

const VAULT_KEY = crypto.createHash('sha256').update(process.env.VAULT_SECRET || process.env.SAKKUPAY_TOKEN_SECRET || 'sakkupay-vault-secret-key-2026').digest();
function encryptToken(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  let encrypted = cipher.update(plain, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}
function decryptToken(cipherText) {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.includes(':')) return cipherText || '';
  try {
    const [ivHex, tagHex, encrypted] = cipherText.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return '';
  }
}
function maskSecret(str) {
  if (!str) return '';
  const plain = str.includes(':') ? decryptToken(str) : str;
  if (!plain) return '';
  if (plain.length <= 6) return '••••••';
  return plain.slice(0, 4) + '••••••••' + plain.slice(-4);
}

function persist() {
  try {
    // 1. Sync legacy db in-memory objects to SQLite
    repository.syncFromLegacy(db);
  } catch (err) {
    console.error('Error synchronizing to SQLite:', err.message);
  }
  try {
    // 2. Also keep data.json updated as a non-breaking rollback fallback
    const temp = STORE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(db, null, 2));
    fs.renameSync(temp, STORE);
  } catch (_) {}
}
function id(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function read(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let exceeded = false;
    req.on('data', c => {
      if (exceeded) return;
      raw += c;
      if (raw.length > 1e6) {
        exceeded = true;
        req.pause();
        return reject(new Error('Payload too large'));
      }
    });
    req.on('error', err => reject(err));
    req.on('end', () => {
      if (exceeded) return;
      req.rawBody = raw;
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        try {
          const parsedParams = Object.fromEntries(new URLSearchParams(raw));
          if (Object.keys(parsedParams).length > 0) return resolve(parsedParams);
        } catch (_) {}
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

const secret = process.env.SAKKUPAY_TOKEN_SECRET || 'development-only-change-this-secret';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';

// Seed default SuperAdmin user if none exists
try {
  if (repository.adminUsers && repository.adminUsers.count() === 0) {
    repository.adminUsers.create({
      id: 'adm_default_superadmin',
      email: (process.env.ADMIN_EMAIL || `${ADMIN_USERNAME}@sakkupay.local`).toLowerCase(),
      name: 'Primary SuperAdmin',
      passwordHash: hashPassword(ADMIN_PASSWORD),
      role: ADMIN_ROLES.SUPER_ADMIN,
      active: true
    });
  }
} catch (e) {
  console.warn('SuperAdmin seed check:', e.message);
}

function token(merchant) {
  let body = Buffer.from(JSON.stringify({ sub: merchant.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString('base64url');
  let sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}
function adminToken(userOrRole) {
  let sub = 'adm_default_superadmin';
  let email = `${ADMIN_USERNAME}@sakkupay.local`;
  let role = ADMIN_ROLES.SUPER_ADMIN;

  if (typeof userOrRole === 'string') {
    if (isValidRole(userOrRole)) {
      role = userOrRole;
    } else if (userOrRole === 'admin') {
      role = ADMIN_ROLES.SUPER_ADMIN;
    } else {
      sub = userOrRole;
      email = `${userOrRole}@sakkupay.local`;
      role = ADMIN_ROLES.SUPER_ADMIN;
    }
  } else if (typeof userOrRole === 'object' && userOrRole !== null) {
    sub = userOrRole.id || userOrRole.sub || sub;
    email = userOrRole.email || email;
    role = userOrRole.role === 'admin' ? ADMIN_ROLES.SUPER_ADMIN : (userOrRole.role || role);
  }

  let body = Buffer.from(JSON.stringify({
    role: role,
    sub: sub,
    email: email,
    exp: Date.now() + 24 * 60 * 60 * 1000
  })).toString('base64url');
  let sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}
function _verifyToken(raw) {
  let [body, sig] = String(raw || '').split('.');
  let expected = body ? crypto.createHmac('sha256', secret).update(body).digest('base64url') : '';
  if (!body || !sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    let data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}
function auth(req) {
  let value = req.headers.authorization || '';
  if (!value) {
    try {
      // Security Hardening: Token in query string is strictly restricted to Server-Sent Events (/api/events)
      // where browser EventSource API cannot provide custom Authorization headers.
      if (req.url && (req.url.startsWith('/api/events') || req.url.includes('/api/events'))) {
        let u = new URL(req.url, 'http://localhost');
        let q = u.searchParams.get('token') || u.searchParams.get('access_token');
        if (q) value = 'Bearer ' + q;
      }
    } catch {}
  }
  let raw = value.replace(/^Bearer\s+/i, '').trim();
  let data = _verifyToken(raw);
  if (!data || data.role === 'admin' || isValidRole(data.role)) return null;
  return repository.merchants.findById(data.sub) || (db.merchants && db.merchants.find(m => m.id === data.sub)) || null;
}
function authAdmin(req, requiredPermission = null) {
  // Security Hardening: Admin tokens are strictly rejected via URL query strings (CWE-598).
  // Admin requests must provide Authorization: Bearer <token>.
  let value = req.headers.authorization || '';
  let raw = value.replace(/^Bearer\s+/i, '').trim();
  let data = _verifyToken(raw);
  if (!data) return null;

  // Legacy compatibility: normalize 'admin' to 'SuperAdmin'
  let role = data.role;
  if (role === 'admin') role = ADMIN_ROLES.SUPER_ADMIN;
  if (!isValidRole(role)) return null;

  // Deny-by-default: if user exists in database, verify they are still active
  if (data.sub && data.sub !== 'admin' && data.sub !== 'adm_env_superadmin') {
    const userInDb = repository.adminUsers.findById(data.sub);
    if (userInDb && !userInDb.active) {
      return { denied: true, deactivated: true, role, permission: requiredPermission };
    }
  }

  // Check specific required permission if specified
  if (requiredPermission && !hasPermission(role, requiredPermission)) {
    return { denied: true, role, permission: requiredPermission };
  }

  return {
    sub: data.sub || 'adm_default_superadmin',
    actorId: data.sub || 'adm_default_superadmin',
    actorEmail: data.email || `${ADMIN_USERNAME}@sakkupay.local`,
    actorRole: role,
    role: role
  };
}

function requireAdmin(req, res, requiredPermission = null) {
  const auth = authAdmin(req, requiredPermission);
  if (!auth) {
    json(res, 401, { error: 'Admin auth required' });
    return null;
  }
  if (auth.denied) {
    if (auth.deactivated) {
      json(res, 403, { error: 'Admin account has been deactivated' });
      return null;
    }
    json(res, 403, { error: `Forbidden: Role '${auth.role}' lacks required permission '${auth.permission}'` });
    return null;
  }
  return auth;
}

function merchantSafe(m) {
  return {
    id: m.id,
    email: m.email,
    businessName: m.businessName,
    supportEmail: m.supportEmail,
    description: m.description,
    whatsappNumber: m.whatsappNumber || '',
    createdAt: m.createdAt
  };
}
function required(req, res) {
  let m = auth(req);
  if (!m) { json(res, 401, { error: 'Authentication required' }); return null; }
  if (m.suspended) { json(res, 403, { error: 'Account suspended. Contact support.' }); return null; }
  return m;
}
function own(collection, merchant, id) {
  if (collection === 'upis') {
    const item = repository.upis.findById(id);
    if (item && item.merchantId === merchant.id) return item;
  } else if (collection === 'links') {
    const item = repository.links.findById(id);
    if (item && item.merchantId === merchant.id) return item;
  } else if (collection === 'transactions') {
    const item = repository.transactions.findById(id);
    if (item && item.merchantId === merchant.id) return item;
  }
  return db[collection]?.find(x => x.id === id && x.merchantId === merchant.id) || null;
}
function slugify(value) {
  return String(value || 'payment').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 45) || 'payment';
}
function uniqueSlug(value) {
  let base = slugify(value), slug = base, i = 1;
  while (repository.links.slugExists(slug) || (db.links && db.links.some(l => l.slug === slug))) {
    slug = `${base}-${i++}`;
  }
  return slug;
}
function publish(merchantId, event, data) {
  let clients = eventClients.get(merchantId);
  if (!clients) return;
  let frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}
function publicLink(link) {
  let m = repository.merchants.findById(link.merchantId) || (db.merchants && db.merchants.find(x => x.id === link.merchantId));
  let upiVpa = link.upiId;
  if (upiVpa && upiVpa.startsWith('upi_')) {
    const u = repository.upis.findById(upiVpa) || (db.upis && db.upis.find(x => x.id === upiVpa));
    if (u?.upiId) upiVpa = u.upiId;
  }
  return {
    id: link.id,
    slug: link.slug,
    name: link.name,
    description: link.description,
    amount: link.amount,
    amountType: link.amountType,
    template: link.template || 'classic',
    upiId: upiVpa,
    businessName: m?.businessName || 'Merchant',
    whatsappNumber: m?.whatsappNumber || '',
    active: Boolean(link.active)
  };
}

/* ─── Rate Limiter (Task 5) ─────────────────────────────────────────────────── */
const rateLimitMap = new Map();
const MAX_RATE_LIMIT_ENTRIES = 5000;

function pruneRateLimitStore() {
  const now = Date.now();
  for (const [key, record] of rateLimitMap.entries()) {
    if (record.resetAt <= now) rateLimitMap.delete(key);
  }
}
const rateLimitPruneTimer = setInterval(pruneRateLimitStore, 5 * 60 * 1000);
if (rateLimitPruneTimer.unref) rateLimitPruneTimer.unref();

function getClientIp(req) {
  if (process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1') {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

function checkRateLimit(ip, scope, maxRequests, windowMs) {
  const now = Date.now();
  const key = `${scope}:${ip}`;

  if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES && !rateLimitMap.has(key)) {
    pruneRateLimitStore();
    if (rateLimitMap.size >= MAX_RATE_LIMIT_ENTRIES) {
      const oldestKey = rateLimitMap.keys().next().value;
      if (oldestKey) rateLimitMap.delete(oldestKey);
    }
  }

  const record = rateLimitMap.get(key);
  if (!record || record.resetAt <= now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1, resetAfterSec: Math.ceil(windowMs / 1000) };
  }

  if (record.count >= maxRequests) {
    const resetAfterSec = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, resetAfterSec };
  }

  record.count++;
  return { allowed: true, remaining: maxRequests - record.count, resetAfterSec: Math.ceil((record.resetAt - now) / 1000) };
}

function recordFailedAdminLogin(ip) {
  const now = Date.now();
  const key = `admin_login_fail:${ip}`;
  const windowMs = 15 * 60 * 1000; // 15 mins
  const record = rateLimitMap.get(key);
  if (!record || record.resetAt <= now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    record.count++;
  }
}

function checkAdminLoginAllowed(ip) {
  const now = Date.now();
  const key = `admin_login_fail:${ip}`;
  const record = rateLimitMap.get(key);
  if (!record || record.resetAt <= now) {
    return { allowed: true, remaining: 5, resetAfterSec: 0 };
  }
  if (record.count >= 5) {
    const resetAfterSec = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    return { allowed: false, remaining: 0, resetAfterSec };
  }
  return { allowed: true, remaining: 5 - record.count, resetAfterSec: Math.ceil((record.resetAt - now) / 1000) };
}

function clearAdminLoginFailures(ip) {
  rateLimitMap.delete(`admin_login_fail:${ip}`);
}

/* ─── Paytm Checksum Verification Utility (Task 2) ────────────────────────── */
function verifyPaytmChecksum(params, receivedChecksum, merchantKey) {
  if (!receivedChecksum || !merchantKey || typeof params !== 'object') return false;

  const keys = Object.keys(params).filter(k => k !== 'CHECKSUMHASH' && k !== 'checksum').sort();
  const paramString = keys.map(k => `${k}=${params[k]}`).join('|');
  const paramStringValuesOnly = keys.map(k => params[k]).join('|');

  const candidates = [
    crypto.createHmac('sha256', merchantKey).update(paramString).digest('hex'),
    crypto.createHmac('sha256', merchantKey).update(paramString).digest('base64'),
    crypto.createHmac('sha256', merchantKey).update(paramStringValuesOnly).digest('hex'),
    crypto.createHmac('sha256', merchantKey).update(paramStringValuesOnly).digest('base64')
  ];

  const recBuf = Buffer.from(receivedChecksum.trim());
  for (const cand of candidates) {
    const candBuf = Buffer.from(cand);
    if (candBuf.length === recBuf.length && crypto.timingSafeEqual(candBuf, recBuf)) {
      return true;
    }
  }
  return false;
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/* ─── Application Router ────────────────────────────────────────────────────── */
async function route(req, res) {
  applySecurityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;
  const clientIp = getClientIp(req);

  /* ── Admin login ── */
  if (method === 'POST' && p === '/api/admin/login') {
    const gate = checkAdminLoginAllowed(clientIp);
    if (!gate.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(gate.resetAfterSec) });
      return res.end(JSON.stringify({
        error: 'Too many failed login attempts. Account temporarily locked for 15 minutes.',
        retryAfter: gate.resetAfterSec
      }));
    }

    let b = await read(req);
    let u = String(b.username || b.email || '').trim();
    let pw = String(b.password || '');

    // Check database admin users first
    let adminUser = repository.adminUsers.findByEmail(u);
    let authSuccess = false;
    let matchedUser = null;

    if (adminUser) {
      if (adminUser.active && verifyPassword(pw, adminUser.passwordHash)) {
        authSuccess = true;
        matchedUser = adminUser;
        repository.adminUsers.update(adminUser.id, { lastLoginAt: new Date().toISOString() });
      }
    }

    // Fallback: check environment ADMIN_USERNAME and ADMIN_PASSWORD
    if (!authSuccess) {
      let uBuf = Buffer.from(u), expUBuf = Buffer.from(ADMIN_USERNAME);
      let pwBuf = Buffer.from(pw), expPwBuf = Buffer.from(ADMIN_PASSWORD);
      let uOk = uBuf.length === expUBuf.length && crypto.timingSafeEqual(uBuf, expUBuf);
      let pwOk = pwBuf.length === expPwBuf.length && crypto.timingSafeEqual(pwBuf, expPwBuf);
      if (uOk && pwOk) {
        authSuccess = true;
        matchedUser = {
          id: 'adm_default_superadmin',
          email: `${ADMIN_USERNAME}@sakkupay.local`,
          name: 'SuperAdmin',
          role: ADMIN_ROLES.SUPER_ADMIN
        };
      }
    }

    if (!authSuccess) {
      recordFailedAdminLogin(clientIp);
      try {
        logAdminAudit(sqliteDb, {
          actorId: 'anonymous',
          actorEmail: u || 'unknown',
          actorRole: 'Unauthenticated',
          action: 'admin.login',
          targetType: 'admin_session',
          reasonCode: 'FAILED_AUTHENTICATION',
          justification: 'Failed admin login attempt with incorrect credentials',
          ipAddress: clientIp,
          outcome: 'failed'
        });
      } catch (_) {}
      return json(res, 401, { error: 'Invalid credentials' });
    }

    clearAdminLoginFailures(clientIp);

    const adminJwt = adminToken({
      id: matchedUser.id,
      email: matchedUser.email,
      role: matchedUser.role
    });

    try {
      logAdminAudit(sqliteDb, {
        actorId: matchedUser.id,
        actorEmail: matchedUser.email,
        actorRole: matchedUser.role,
        action: 'admin.login',
        targetType: 'admin_session',
        reasonCode: 'ADMIN_LOGIN_SUCCESS',
        justification: `Admin logged in successfully with role ${matchedUser.role}`,
        ipAddress: clientIp,
        outcome: 'success'
      });
    } catch (_) {}

    return json(res, 200, {
      token: adminJwt,
      role: matchedUser.role,
      name: matchedUser.name || 'Admin'
    });
  }

  /* ── Admin stats ── */
  if (method === 'GET' && p === '/api/admin/stats') {
    const adm = requireAdmin(req, res, 'system.health.read');
    if (!adm) return;
    const metrics = repository.transactions.getGlobalMetrics();
    return json(res, 200, {
      totalMerchants: metrics.totalMerchants,
      activeMerchants: metrics.activeMerchants,
      suspendedMerchants: metrics.suspendedMerchants,
      totalTransactions: metrics.totalTransactions,
      successfulTransactions: metrics.successfulTransactions,
      totalVolume: metrics.totalVolume,
      totalVolumePaise: metrics.totalVolumePaise,
      totalLinks: metrics.totalLinks,
      activeLinks: metrics.activeLinks,
      totalErrors: metrics.totalErrors
    });
  }

  /* ── Admin staff users management (SuperAdmin only) ── */
  if (p === '/api/admin/staff') {
    if (method === 'GET') {
      const adm = requireAdmin(req, res, 'admin.users.read');
      if (!adm) return;
      const role = url.searchParams.get('role');
      const activeParam = url.searchParams.get('active');
      const active = activeParam !== null ? (activeParam === 'true' || activeParam === '1') : undefined;
      const list = repository.adminUsers.listAll({ role, active }).map(({ passwordHash, ...u }) => u);
      return json(res, 200, list);
    }
    if (method === 'POST') {
      const adm = requireAdmin(req, res, 'admin.users.write');
      if (!adm) return;
      const b = await read(req);
      const email = String(b.email || '').toLowerCase().trim();
      const name = String(b.name || '').trim();
      const password = String(b.password || '');
      const role = String(b.role || '').trim();

      if (!name) return json(res, 400, { error: 'Name is required' });
      if (!email || !email.includes('@')) return json(res, 400, { error: 'Valid email is required' });
      if (!password || password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
      if (!isValidRole(role)) return json(res, 400, { error: `Invalid role. Allowed: ${Object.values(ADMIN_ROLES).join(', ')}` });

      const existing = repository.adminUsers.findByEmail(email);
      if (existing) return json(res, 409, { error: 'Admin user with this email already exists' });

      const user = repository.adminUsers.create({
        email,
        name,
        passwordHash: hashPassword(password),
        role,
        active: b.active !== false
      });

      logAdminAudit(sqliteDb, {
        actorId: adm.actorId,
        actorEmail: adm.actorEmail,
        actorRole: adm.actorRole,
        action: 'admin.create_user',
        targetType: 'admin_user',
        targetId: user.id,
        reasonCode: 'STAFF_ONBOARDING',
        justification: `Created admin user ${email} with role ${role}`,
        beforeState: null,
        afterState: { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active },
        ipAddress: clientIp,
        outcome: 'success'
      });

      const { passwordHash, ...safeUser } = user;
      return json(res, 201, safeUser);
    }
  }

  if (p.startsWith('/api/admin/staff/')) {
    const staffId = p.slice(17);
    if (method === 'PATCH') {
      const adm = requireAdmin(req, res, 'admin.users.write');
      if (!adm) return;
      const target = repository.adminUsers.findById(staffId);
      if (!target) return json(res, 404, { error: 'Admin staff user not found' });

      const b = await read(req);
      const partial = {};

      if (b.role !== undefined) {
        if (!isValidRole(b.role)) return json(res, 400, { error: 'Invalid role' });
        // Prevent self-role modification (privilege escalation or demotion)
        if (target.id === adm.actorId && b.role !== adm.actorRole) {
          return json(res, 400, { error: 'Admins cannot alter their own role' });
        }
        partial.role = b.role;
      }

      if (typeof b.active === 'boolean') {
        // Prevent self-deactivation
        if (target.id === adm.actorId && b.active === false) {
          return json(res, 400, { error: 'Admins cannot deactivate their own account' });
        }
        partial.active = b.active;
      }

      if (typeof b.name === 'string' && b.name.trim()) {
        partial.name = b.name.trim();
      }

      if (b.password && typeof b.password === 'string' && b.password.length >= 8) {
        partial.passwordHash = hashPassword(b.password);
      }

      const updated = repository.adminUsers.update(target.id, partial);

      logAdminAudit(sqliteDb, {
        actorId: adm.actorId,
        actorEmail: adm.actorEmail,
        actorRole: adm.actorRole,
        action: 'admin.update_user',
        targetType: 'admin_user',
        targetId: target.id,
        reasonCode: 'STAFF_UPDATE',
        justification: `Updated admin staff user ${target.email}`,
        beforeState: { id: target.id, email: target.email, role: target.role, active: target.active },
        afterState: { id: updated.id, email: updated.email, role: updated.role, active: updated.active },
        ipAddress: clientIp,
        outcome: 'success'
      });

      const { passwordHash, ...safeUser } = updated;
      return json(res, 200, safeUser);
    }

    if (method === 'DELETE') {
      const adm = requireAdmin(req, res, 'admin.users.write');
      if (!adm) return;
      if (staffId === adm.actorId) {
        return json(res, 400, { error: 'Admins cannot delete their own account' });
      }
      const target = repository.adminUsers.findById(staffId);
      if (!target) return json(res, 404, { error: 'Admin staff user not found' });

      repository.adminUsers.delete(staffId);

      logAdminAudit(sqliteDb, {
        actorId: adm.actorId,
        actorEmail: adm.actorEmail,
        actorRole: adm.actorRole,
        action: 'admin.delete_user',
        targetType: 'admin_user',
        targetId: staffId,
        reasonCode: 'STAFF_OFFBOARDING',
        justification: `Deleted admin staff user ${target.email}`,
        beforeState: { id: target.id, email: target.email, role: target.role },
        afterState: null,
        ipAddress: clientIp,
        outcome: 'success'
      });

      return json(res, 204, {});
    }
  }

  /* ── Admin audit trail API (SuperAdmin & ComplianceAuditor) ── */
  if (method === 'GET' && (p === '/api/admin/audit-trail' || p === '/api/admin/audit-logs')) {
    const adm = requireAdmin(req, res, 'audit.read');
    if (!adm) return;
    const actorId = url.searchParams.get('actorId') || undefined;
    const action = url.searchParams.get('action') || undefined;
    const targetType = url.searchParams.get('targetType') || undefined;
    const targetId = url.searchParams.get('targetId') || undefined;
    const reasonCode = url.searchParams.get('reasonCode') || undefined;
    const outcome = url.searchParams.get('outcome') || undefined;
    const start = url.searchParams.get('start') || undefined;
    const end = url.searchParams.get('end') || undefined;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

    const items = repository.adminAudit.list({
      actorId, action, targetType, targetId, reasonCode, outcome, start, end, limit, offset
    });
    const total = repository.adminAudit.count({ actorId, action, targetType, targetId });

    return json(res, 200, { total, limit, offset, items });
  }

  /* ── Payment investigation workspace APIs (Task 3) ── */
  if (method === 'GET' && p === '/api/admin/investigation/search') {
    const adm = requireAdmin(req, res, 'transactions.investigate');
    if (!adm) return;

    const q = url.searchParams.get('q') || undefined;
    const utr = url.searchParams.get('utr') || undefined;
    const providerReference = url.searchParams.get('providerReference') || undefined;
    const merchantId = url.searchParams.get('merchantId') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const reconciliationStatus = url.searchParams.get('reconciliationStatus') || undefined;
    const start = url.searchParams.get('start') || undefined;
    const end = url.searchParams.get('end') || undefined;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

    const result = repository.transactions.search({
      q, utr, providerReference, merchantId, status, reconciliationStatus, start, end, limit, offset
    });

    return json(res, 200, result);
  }

  if (method === 'GET' && p.startsWith('/api/admin/transactions/') && (p.endsWith('/timeline') || p.endsWith('/investigation'))) {
    const adm = requireAdmin(req, res, 'transactions.investigate');
    if (!adm) return;

    const isTimeline = p.endsWith('/timeline');
    const tid = isTimeline ? p.slice(24, -9) : p.slice(24, -14);
    const investigation = repository.transactions.getInvestigation(tid);
    if (!investigation) return json(res, 404, { error: 'Transaction not found' });

    return json(res, 200, investigation);
  }

  /* ── Safe manual reconciliation (Task 4) ── */
  if (method === 'POST' && p.startsWith('/api/admin/transactions/') && p.endsWith('/reconcile')) {
    const adm = requireAdmin(req, res, 'transactions.reconcile');
    if (!adm) return;

    const tid = p.slice(24, -10);
    const tx = repository.transactions.findById(tid);
    if (!tx) return json(res, 404, { error: 'Transaction not found' });

    const b = await read(req);
    const action = String(b.action || '').trim();
    const reasonCode = String(b.reasonCode || '').trim();
    const justification = String(b.justification || '').trim();
    const expectedCurrentStatus = b.expectedCurrentStatus ? String(b.expectedCurrentStatus).trim() : null;

    if (!isValidReasonCode(reasonCode)) {
      return json(res, 400, {
        error: 'A valid reasonCode is required (e.g. OFFICIAL_BANK_STATEMENT_PROOF, GATEWAY_PORTAL_CONFIRMED, CHARGEBACK_RESOLVED, DUPLICATE_RESOLVED_MANUAL, SUSPECTED_FRAUD)'
      });
    }

    if (!justification || justification.length < 10) {
      return json(res, 400, {
        error: 'A written justification (minimum 10 characters) is required for audited manual reconciliation'
      });
    }

    // Optimistic Concurrency Check
    if (expectedCurrentStatus && tx.status !== expectedCurrentStatus) {
      logAdminAudit(sqliteDb, {
        actorId: adm.actorId,
        actorEmail: adm.actorEmail,
        actorRole: adm.actorRole,
        action: 'transaction.reconcile.concurrency_conflict',
        targetType: 'transaction',
        targetId: tx.id,
        reasonCode,
        justification: `Concurrency conflict: expected '${expectedCurrentStatus}', actual '${tx.status}'`,
        ipAddress: clientIp,
        outcome: 'failed'
      });
      return json(res, 409, {
        error: `Concurrent modification detected: expected status '${expectedCurrentStatus}' but transaction is currently '${tx.status}'`
      });
    }

    const nowIso = new Date().toISOString();
    let partialUpdate = {};

    if (action === 'force_settle_with_proof') {
      // Idempotency: If already success, return safe acknowledgement
      if (tx.status === 'success') {
        return json(res, 200, {
          success: true,
          duplicate: true,
          verified: true,
          message: 'Transaction already settled',
          transaction: tx
        });
      }

      if (tx.status !== 'pending' && tx.status !== 'under_review') {
        return json(res, 400, {
          error: `Cannot settle transaction from terminal status '${tx.status}'`
        });
      }

      const inputUtr = b.utr ? String(b.utr).trim().replace(/[^a-zA-Z0-9]/g, '') : '';
      const inputRef = b.providerReference ? String(b.providerReference).trim() : '';

      if (!inputUtr && !inputRef) {
        return json(res, 400, {
          error: 'force_settle_with_proof requires verified providerReference or UTR proof'
        });
      }

      partialUpdate = {
        status: 'success',
        reconciliationStatus: RECON_STATUS.SETTLED,
        verifiedBy: 'admin-manual',
        verifiedAt: nowIso,
        paidAt: tx.paidAt || nowIso,
        ambiguityReason: null
      };
      if (inputUtr) partialUpdate.utr = inputUtr;
      if (inputRef) partialUpdate.providerReference = inputRef;

    } else if (action === 'mark_failed_with_proof') {
      // Terminal lock on settled payments
      if (tx.status === 'success') {
        return json(res, 400, {
          error: 'Cannot mark an already settled transaction as failed. Settlement is permanent.'
        });
      }

      if (tx.status !== 'pending' && tx.status !== 'under_review') {
        return json(res, 400, {
          error: `Cannot mark transaction failed from terminal status '${tx.status}'`
        });
      }

      partialUpdate = {
        status: 'failed',
        reconciliationStatus: RECON_STATUS.UNRECONCILED,
        verifiedBy: 'admin-manual',
        verifiedAt: nowIso
      };

    } else if (action === 'flag_for_review') {
      if (tx.status === 'success') {
        return json(res, 400, {
          error: 'Cannot flag an already settled transaction for review'
        });
      }

      partialUpdate = {
        reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
        ambiguityReason: justification
      };

    } else {
      return json(res, 400, {
        error: "Invalid reconciliation action. Allowed: 'force_settle_with_proof', 'mark_failed_with_proof', 'flag_for_review'"
      });
    }

    // Append to transaction-level auditLog
    partialUpdate.auditLog = appendAuditLog(tx.auditLog, {
      action: `admin_${action}`,
      fromStatus: tx.status,
      toStatus: partialUpdate.status || tx.status,
      reconciliationStatus: partialUpdate.reconciliationStatus || tx.reconciliationStatus,
      source: `admin:${adm.actorRole}`,
      details: justification,
      utr: partialUpdate.utr || tx.utr,
      providerReference: partialUpdate.providerReference || tx.providerReference
    });

    const updatedTx = repository.transactions.update(tx.id, partialUpdate);
    const inMem = db.transactions.find(t => t.id === tx.id);
    if (inMem) Object.assign(inMem, updatedTx);
    persist();
    publish(tx.merchantId, 'transaction.updated', updatedTx);

    // Record in dedicated immutable admin audit trail
    const auditRecord = logAdminAudit(sqliteDb, {
      actorId: adm.actorId,
      actorEmail: adm.actorEmail,
      actorRole: adm.actorRole,
      action: `transaction.reconcile.${action}`,
      targetType: 'transaction',
      targetId: tx.id,
      reasonCode,
      justification,
      beforeState: tx,
      afterState: updatedTx,
      correlationId: b.correlationId || null,
      ipAddress: clientIp,
      outcome: 'success'
    });

    return json(res, 200, {
      success: true,
      transaction: updatedTx,
      auditId: auditRecord.id
    });
  }

  /* ── Admin merchants paginated search & detail (Task 5) ── */
  if (p === '/api/admin/merchants') {
    if (method === 'GET') {
      const adm = requireAdmin(req, res, 'merchants.read');
      if (!adm) return;

      const q = (url.searchParams.get('q') || '').toLowerCase();
      const suspended = url.searchParams.get('suspended');
      let list = repository.merchants.listAll({ query: q });
      if (suspended !== null && suspended !== undefined) {
        const isSusp = suspended === 'true' || suspended === '1';
        list = list.filter(m => Boolean(m.suspended) === isSusp);
      }
      const total = list.length;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
      list = list.slice(offset, offset + limit);

      return json(res, 200, {
        total,
        limit,
        offset,
        items: list.map(m => {
          const mUpis = repository.upis.findByMerchant(m.id);
          const defaultUpi = mUpis.find(x => x.default) || mUpis[0];
          const mLinks = repository.links.findByMerchant(m.id);
          const mTx = repository.transactions.findByMerchant(m.id);
          const mSuccess = mTx.filter(x => x.status === 'success');
          return {
            ...merchantSafe(m),
            primaryUpi: defaultUpi?.upiId || '',
            suspended: Boolean(m.suspended),
            upiCount: mUpis.length,
            linkCount: mLinks.length,
            txCount: mTx.length,
            totalVolume: mSuccess.reduce((s, x) => s + x.amount, 0),
            createdAt: m.createdAt
          };
        })
      });
    }
  }

  if (p.startsWith('/api/admin/merchants/')) {
    const sub = p.slice(21);
    if (!sub.includes('/')) {
      // GET /api/admin/merchants/:id
      if (method === 'GET') {
        const adm = requireAdmin(req, res, 'merchants.read');
        if (!adm) return;
        const m = repository.merchants.findById(sub);
        if (!m) return json(res, 404, { error: 'Merchant not found' });
        const upis = repository.upis.findByMerchant(m.id);
        const links = repository.links.findByMerchant(m.id);
        const txs = repository.transactions.findByMerchant(m.id, { limit: 20 });
        const bizAccounts = (repository.businessAccounts.findByMerchant(m.id) || []).map(b => ({
          id: b.id,
          provider: b.provider,
          accountName: b.accountName,
          phoneNumber: b.phoneNumber,
          merchantIdRef: b.merchantIdRef,
          status: b.status,
          autoVerify: b.autoVerify,
          lastSyncedAt: b.lastSyncedAt,
          createdAt: b.createdAt
        }));
        return json(res, 200, {
          merchant: merchantSafe(m),
          suspended: Boolean(m.suspended),
          upis,
          links,
          recentTransactions: txs,
          businessAccounts: bizAccounts
        });
      }
    } else if (sub.endsWith('/suspend') && method === 'POST') {
      // POST /api/admin/merchants/:id/suspend
      const adm = requireAdmin(req, res, 'merchants.write');
      if (!adm) return;
      const mid = sub.slice(0, -8);
      const m = repository.merchants.findById(mid);
      if (!m) return json(res, 404, { error: 'Merchant not found' });

      const b = await read(req);
      if (typeof b.suspended !== 'boolean') {
        return json(res, 400, { error: 'suspended (boolean) is required' });
      }
      const reasonCode = String(b.reasonCode || 'MERCHANT_STATUS_UPDATE').trim();
      const justification = String(b.justification || 'Merchant suspension toggled by administrator').trim();

      const updated = repository.merchants.update(m.id, { suspended: b.suspended });
      const inMem = db.merchants.find(x => x.id === m.id);
      if (inMem) inMem.suspended = b.suspended;
      persist();

      logAdminAudit(sqliteDb, {
        actorId: adm.actorId,
        actorEmail: adm.actorEmail,
        actorRole: adm.actorRole,
        action: b.suspended ? 'merchant.suspend' : 'merchant.unsuspend',
        targetType: 'merchant',
        targetId: m.id,
        reasonCode,
        justification,
        beforeState: { id: m.id, email: m.email, suspended: Boolean(m.suspended) },
        afterState: { id: updated.id, email: updated.email, suspended: Boolean(updated.suspended) },
        ipAddress: clientIp,
        outcome: 'success'
      });

      return json(res, 200, { success: true, merchant: merchantSafe(updated), suspended: Boolean(updated.suspended) });
    }
  }

  /* ── Admin users (legacy endpoint for merchants) ── */
  if (method === 'GET' && p === '/api/admin/users') {
    const adm = requireAdmin(req, res, 'merchants.read');
    if (!adm) return;
    let q = (url.searchParams.get('q') || '').toLowerCase();
    let list = repository.merchants.listAll({ query: q });
    return json(res, 200, list.map(m => {
      const mUpis = repository.upis.findByMerchant(m.id);
      const defaultUpi = mUpis.find(x => x.default) || mUpis[0];
      const phone = defaultUpi?.phoneNumber || m.whatsappNumber || '';
      const mLinks = repository.links.findByMerchant(m.id);
      const mTx = repository.transactions.findByMerchant(m.id);
      const mSuccess = mTx.filter(x => x.status === 'success');
      return {
        ...merchantSafe(m),
        phone: phone,
        phoneNumber: phone,
        primaryUpi: defaultUpi?.upiId || '',
        upis: mUpis.map(u => ({ id: u.id, upiId: u.upiId, phoneNumber: u.phoneNumber, default: u.default })),
        suspended: !!m.suspended,
        upiCount: mUpis.length,
        linkCount: mLinks.length,
        txCount: mTx.length,
        txVolume: mSuccess.reduce((s, x) => s + x.amount, 0)
      };
    }));
  }

  /* ── Admin patch user (legacy endpoint for merchant suspension) ── */
  if (method === 'PATCH' && p.startsWith('/api/admin/users/')) {
    const adm = requireAdmin(req, res, 'merchants.write');
    if (!adm) return;
    let uid = p.slice(17), m = repository.merchants.findById(uid);
    if (!m) return json(res, 404, { error: 'Merchant not found' });
    let b = await read(req);
    if (typeof b.suspended === 'boolean') {
      const reasonCode = String(b.reasonCode || 'MERCHANT_STATUS_UPDATE').trim();
      const justification = String(b.justification || 'Merchant suspension toggled by administrator').trim();

      m = repository.merchants.update(uid, { suspended: b.suspended });
      const inMem = db.merchants.find(x => x.id === uid);
      if (inMem) inMem.suspended = b.suspended;

      logAdminAudit(sqliteDb, {
        actorId: adm.actorId,
        actorEmail: adm.actorEmail,
        actorRole: adm.actorRole,
        action: b.suspended ? 'merchant.suspend' : 'merchant.unsuspend',
        targetType: 'merchant',
        targetId: m.id,
        reasonCode,
        justification,
        beforeState: { id: m.id, email: m.email, suspended: !b.suspended },
        afterState: { id: m.id, email: m.email, suspended: b.suspended },
        ipAddress: clientIp,
        outcome: 'success'
      });
    }
    persist();
    return json(res, 200, { ...merchantSafe(m), suspended: !!m.suspended });
  }

  /* ── Admin delete user (Task 5 Guard: Never delete merchants with financial records) ── */
  if (method === 'DELETE' && p.startsWith('/api/admin/users/')) {
    const adm = requireAdmin(req, res, 'merchants.write');
    if (!adm) return;
    let uid = p.slice(17), m = repository.merchants.findById(uid);
    if (!m) return json(res, 404, { error: 'Merchant not found' });

    // Financial Data Protection: Do not permanently delete merchants with financial records
    const txCount = repository.transactions.findByMerchant(uid).length;
    if (txCount > 0) {
      return json(res, 400, {
        error: `Cannot permanently delete merchant with ${txCount} existing financial transaction records. Suspend merchant instead.`
      });
    }

    repository.merchants.delete(uid);
    db.merchants = db.merchants.filter(x => x.id !== uid);
    db.upis = db.upis.filter(x => x.merchantId !== uid);
    db.links = db.links.filter(x => x.merchantId !== uid);
    db.transactions = db.transactions.filter(x => x.merchantId !== uid);
    db.apiKeys = db.apiKeys.filter(x => x.merchantId !== uid);
    if (db.businessAccounts) db.businessAccounts = db.businessAccounts.filter(x => x.merchantId !== uid);
    db.errors = db.errors.filter(x => x.merchantId !== uid);
    persist();

    logAdminAudit(sqliteDb, {
      actorId: adm.actorId,
      actorEmail: adm.actorEmail,
      actorRole: adm.actorRole,
      action: 'merchant.delete',
      targetType: 'merchant',
      targetId: uid,
      reasonCode: 'MERCHANT_REMOVAL',
      justification: `Deleted merchant ${m.email} with zero financial records`,
      beforeState: { id: m.id, email: m.email, businessName: m.businessName },
      afterState: null,
      ipAddress: clientIp,
      outcome: 'success'
    });

    res.writeHead(204); return res.end();
  }

  /* ── Admin transactions ── */
  if (method === 'GET' && p === '/api/admin/transactions') {
    const adm = requireAdmin(req, res, 'transactions.read');
    if (!adm) return;
    let mid = url.searchParams.get('merchantId'), status = url.searchParams.get('status'), q = (url.searchParams.get('q') || '').toLowerCase(), limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
    let list = repository.transactions.listAll({ merchantId: mid, status, q, limit });
    list = list.map(tx => {
      let m = repository.merchants.findById(tx.merchantId);
      return { ...tx, merchantEmail: m?.email || '', merchantBusiness: m?.businessName || '' };
    });
    return json(res, 200, list);
  }

  /* ── Admin platform and database health (Task 5) ── */
  if (method === 'GET' && p === '/api/admin/system/health') {
    const adm = requireAdmin(req, res, 'system.health.read');
    if (!adm) return;

    let journalMode = 'unknown';
    let foreignKeys = false;
    let busyTimeout = 0;
    try {
      journalMode = sqliteDb.prepare('PRAGMA journal_mode;').get()?.journal_mode || 'unknown';
      foreignKeys = Boolean(sqliteDb.prepare('PRAGMA foreign_keys;').get()?.foreign_keys);
      busyTimeout = sqliteDb.prepare('PRAGMA busy_timeout;').get()?.timeout || 0;
    } catch (_) {}

    const tableCounts = {
      merchants: repository.merchants.count(),
      transactions: repository.transactions.count(),
      links: repository.links.count(),
      upis: repository.upis.count(),
      adminUsers: repository.adminUsers.count(),
      auditTrail: repository.adminAudit.count(),
      errors: repository.errors.count()
    };

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let recentErrorsCount = 0;
    let recentAmbiguousCount = 0;
    try {
      recentErrorsCount = sqliteDb.prepare('SELECT COUNT(*) as c FROM errors WHERE createdAt >= ?').get(oneDayAgo)?.c || 0;
      recentAmbiguousCount = sqliteDb.prepare("SELECT COUNT(*) as c FROM transactions WHERE reconciliationStatus = 'flagged_ambiguous' OR status = 'under_review'").get()?.c || 0;
    } catch (_) {}

    const mem = process.memoryUsage();

    return json(res, 200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      database: {
        engine: 'SQLite (better-sqlite3)',
        journalMode,
        foreignKeys,
        busyTimeoutMs: busyTimeout,
        tableCounts
      },
      monitoring: {
        recentErrors24h: recentErrorsCount,
        unreconciledExceptions: recentAmbiguousCount
      },
      process: {
        nodeVersion: process.version,
        memoryRssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024)
      }
    });
  }

  /* ── Admin errors ── */
  if (p === '/api/admin/errors') {
    if (method === 'GET') {
      const adm = requireAdmin(req, res, 'errors.read');
      if (!adm) return;
      let limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);
      let list = repository.errors.list({ limit }).map(e => {
        let m = e.merchantId ? repository.merchants.findById(e.merchantId) : null;
        return { ...e, merchantEmail: m?.email || '' };
      });
      return json(res, 200, list);
    }
    if (method === 'DELETE') {
      const adm = requireAdmin(req, res, 'errors.clear');
      if (!adm) return;
      repository.errors.clear();
      db.errors = [];
      persist();

      logAdminAudit(sqliteDb, {
        actorId: adm.actorId,
        actorEmail: adm.actorEmail,
        actorRole: adm.actorRole,
        action: 'errors.clear',
        targetType: 'system',
        reasonCode: 'ERROR_LOG_PURGE',
        justification: 'SuperAdmin purged client diagnostic error logs',
        ipAddress: clientIp,
        outcome: 'success'
      });

      res.writeHead(204);
      return res.end();
    }
  }

  /* ── Client error logging (merchant auth) ── */
  if (method === 'POST' && p === '/api/errors') {
    let m = auth(req); if (!m) return json(res, 401, { error: 'Authentication required' });
    let b = await read(req);
    const errObj = {
      id: id('err'),
      merchantId: m.id,
      message: String(b.message || '').slice(0, 500),
      stack: String(b.stack || '').slice(0, 2000),
      url: String(b.url || '').slice(0, 300),
      line: b.line || null,
      col: b.col || null,
      createdAt: new Date().toISOString()
    };
    repository.errors.log(errObj);
    db.errors.unshift(errObj);
    if (db.errors.length > 1000) db.errors = db.errors.slice(0, 1000);
    persist();
    res.writeHead(201); return res.end();
  }

  /* ── WhatsApp routes ── */
  if (p === '/api/admin/whatsapp/status') {
    const adm = requireAdmin(req, res, 'system.whatsapp.manage');
    if (!adm) return;
    return json(res, 200, wa ? wa.getStatus() : { available: false, connected: false, phone: null, qrReady: false });
  }
  if (method === 'POST' && p === '/api/admin/whatsapp/start') {
    const adm = requireAdmin(req, res, 'system.whatsapp.manage');
    if (!adm) return;
    if (!wa) return json(res, 200, { available: false, error: 'admin-whatsapp.js not loaded' });
    let result = await wa.start(); return json(res, 200, result);
  }
  if (method === 'GET' && p === '/api/admin/whatsapp/qr') {
    const adm = requireAdmin(req, res, 'system.whatsapp.manage');
    if (!adm) return;
    return json(res, 200, wa ? wa.getQR() : { qr: null });
  }
  if (method === 'POST' && p === '/api/admin/whatsapp/send') {
    const adm = requireAdmin(req, res, 'system.whatsapp.manage');
    if (!adm) return;
    let b = await read(req);
    if (!wa) return json(res, 200, { available: false });
    let result = await wa.sendMessage(String(b.to || ''), String(b.message || ''));
    return json(res, 200, result);
  }
  if (method === 'POST' && p === '/api/admin/whatsapp/disconnect') {
    const adm = requireAdmin(req, res, 'system.whatsapp.manage');
    if (!adm) return;
    if (!wa) return json(res, 200, { available: false });
    let result = await wa.disconnect(); return json(res, 200, result);
  }

  /* ── Google OAuth ── */
  if (method === 'GET' && p === '/api/auth/google/start') {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return json(res, 503, { error: 'Google OAuth is not configured on this server' });
    let state = crypto.randomBytes(24).toString('base64url'), redirectUri = process.env.GOOGLE_REDIRECT_URI || `${url.origin}/api/auth/google/callback`;
    const expiresAt = Date.now() + 10 * 60 * 1000;
    repository.oauthStates.create(state, expiresAt);
    db.oauthStates.push({ state, expiresAt });
    persist();
    let authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorize.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', 'openid email profile');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('prompt', 'select_account');
    res.writeHead(302, { Location: authorize.toString() });
    return res.end();
  }
  if (method === 'GET' && p === '/api/auth/google/callback') {
    let state = url.searchParams.get('state');
    const consumed = repository.oauthStates.consume(state);
    db.oauthStates = db.oauthStates.filter(x => x.state !== state);
    persist();
    if (!consumed || !url.searchParams.get('code')) {
      res.writeHead(302, { Location: '/login?oauth_error=invalid_state' });
      return res.end();
    }
    try {
      let redirectUri = process.env.GOOGLE_REDIRECT_URI || `${url.origin}/api/auth/google/callback`;
      let tokens = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: url.searchParams.get('code'),
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      }).then(r => r.ok ? r.json() : Promise.reject(new Error('Google token exchange failed')));
      let profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      }).then(r => r.ok ? r.json() : Promise.reject(new Error('Google profile request failed')));
      if (!profile.email_verified) return json(res, 403, { error: 'Google email must be verified' });
      let m = repository.merchants.findByGoogleSubject(profile.sub) || repository.merchants.findByEmail(String(profile.email).toLowerCase()) ||
        db.merchants.find(x => x.googleSubject === profile.sub) || db.merchants.find(x => x.email === String(profile.email).toLowerCase());
      if (!m) {
        m = {
          id: id('mer'),
          email: String(profile.email).toLowerCase(),
          businessName: profile.name || 'My business',
          supportEmail: String(profile.email).toLowerCase(),
          description: '',
          whatsappNumber: '',
          googleSubject: profile.sub,
          googleVerified: true,
          createdAt: new Date().toISOString()
        };
        m = repository.merchants.create(m);
        db.merchants.push(m);
      } else {
        m = repository.merchants.update(m.id, { googleSubject: profile.sub, googleVerified: true });
        const inMem = db.merchants.find(x => x.id === m.id);
        if (inMem) { inMem.googleSubject = profile.sub; inMem.googleVerified = true; }
      }
      persist();
      res.writeHead(302, { Location: `/dashboard#access_token=${encodeURIComponent(token(m))}` });
      return res.end();
    } catch (e) {
      console.error('Google OAuth callback failed', e.message);
      res.writeHead(302, { Location: '/login?oauth_error=google_signin_failed' });
      return res.end();
    }
  }

  /* ── Public checkout endpoints ── */
  if (method === 'GET' && p.startsWith('/api/checkout/') && p.endsWith('/status')) {
    let slug = decodeURIComponent(p.slice(14, -7)), link = repository.links.findBySlug(slug) || (db.links && db.links.find(l => l.slug === slug && l.active));
    if (!link || !link.active) return json(res, 404, { error: 'Payment link not found' });
    let txId = url.searchParams.get('txId') || url.searchParams.get('transactionId'), ref = url.searchParams.get('ref') || url.searchParams.get('reference');
    let tx = repository.transactions.findForCheckout(link.merchantId, { txId, ref }) ||
      (db.transactions && db.transactions.find(t => t.merchantId === link.merchantId && ((txId && t.id === txId) || (ref && t.reference === ref))));
    if (!tx) return json(res, 404, { error: 'Transaction not found' });
    return json(res, 200, { status: tx.status, reference: tx.reference, utr: tx.utr || '', paidAt: tx.paidAt || null, verifiedBy: tx.verifiedBy || null });
  }
  if (method === 'GET' && p.startsWith('/api/checkout/')) {
    let slug = decodeURIComponent(p.slice(14)).trim();
    if (!slug) return json(res, 400, { error: 'Payment link identifier is required', code: 'INVALID_SLUG' });
    let link = repository.links.findBySlug(slug) || repository.links.findById(slug) ||
      (db.links && db.links.find(l => (l.slug === slug || l.id === slug)));
    if (!link) {
      return json(res, 404, { error: 'Payment link not found', code: 'LINK_NOT_FOUND' });
    }
    if (!link.active) {
      return json(res, 404, { error: 'Payment link is inactive or has expired', code: 'LINK_INACTIVE' });
    }
    return json(res, 200, publicLink(link));
  }

  /* ── Checkout attempt (with rate limiting) ── */
  if (method === 'POST' && p.startsWith('/api/checkout/') && p.endsWith('/attempt')) {
    const rl = checkRateLimit(clientIp, 'checkout_attempt', 20, 60 * 1000);
    if (!rl.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(rl.resetAfterSec) });
      return res.end(JSON.stringify({ error: 'Too many checkout attempts. Please wait a moment.', retryAfter: rl.resetAfterSec }));
    }

    let slug = decodeURIComponent(p.slice(14, -8)), link = repository.links.findBySlug(slug) || (db.links && db.links.find(l => l.slug === slug && l.active));
    if (!link || !link.active) return json(res, 404, { error: 'Payment link not found' });
    let b = await read(req);
    let amount = link.amountType === 'fixed' ? link.amount : Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: 'A valid amount is required' });
    let nowIso = new Date().toISOString();
    let tx = {
      id: id('txn'),
      merchantId: link.merchantId,
      linkId: link.id,
      reference: 'SP' + crypto.randomBytes(5).toString('hex').toUpperCase(),
      customerName: b.customerName || 'UPI customer',
      customerEmail: b.customerEmail || '',
      amount,
      status: 'pending',
      reconciliationStatus: RECON_STATUS.UNRECONCILED,
      auditLog: appendAuditLog(null, {
        action: 'checkout_attempt_created',
        fromStatus: null,
        toStatus: 'pending',
        reconciliationStatus: RECON_STATUS.UNRECONCILED,
        source: 'checkout-customer',
        details: `Customer checkout attempt started for ₹${amount}`
      }),
      createdAt: nowIso
    };
    tx = repository.transactions.create(tx);
    db.transactions.unshift(tx);
    persist();
    publish(link.merchantId, 'transaction.updated', tx);
    return json(res, 201, { transaction: tx });
  }

  /* ── Checkout customer confirmation (UTR submission) ── */
  if (method === 'POST' && p.startsWith('/api/checkout/') && p.endsWith('/confirm')) {
    let slug = decodeURIComponent(p.slice(14, -8)), link = repository.links.findBySlug(slug) || (db.links && db.links.find(l => l.slug === slug && l.active));
    if (!link || !link.active) return json(res, 404, { error: 'Payment link not found' });
    let b = await read(req);
    let utr = String(b.utr || '').trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 30);
    let ref = String(b.reference || '').trim();
    let amount = link.amountType === 'fixed' ? link.amount : Number(b.amount);
    let tx = repository.transactions.findForCheckout(link.merchantId, { txId: b.transactionId, ref }) ||
      (db.transactions && db.transactions.find(t => t.merchantId === link.merchantId && (t.reference === ref || (b.transactionId && t.id === b.transactionId))));
    let nowIso = new Date().toISOString();
    if (!tx) {
      const initialLog = appendAuditLog(null, {
        action: 'checkout_order_created',
        fromStatus: null,
        toStatus: 'pending',
        reconciliationStatus: utr ? RECON_STATUS.UNVERIFIED_EVIDENCE : RECON_STATUS.UNRECONCILED,
        source: 'checkout-customer',
        details: 'Customer created pending checkout order'
      });
      const finalLog = utr ? appendAuditLog(initialLog, {
        action: 'customer_utr_submitted',
        fromStatus: 'pending',
        toStatus: 'pending',
        reconciliationStatus: RECON_STATUS.UNVERIFIED_EVIDENCE,
        source: 'checkout-customer',
        utr,
        details: 'Customer submitted unverified UTR evidence'
      }) : initialLog;
      tx = {
        id: id('txn'),
        merchantId: link.merchantId,
        linkId: link.id,
        reference: 'SP' + crypto.randomBytes(5).toString('hex').toUpperCase(),
        customerName: b.customerName || 'UPI customer',
        customerEmail: b.customerEmail || '',
        amount: Number.isFinite(amount) ? amount : 0,
        status: 'pending',
        reconciliationStatus: utr ? RECON_STATUS.UNVERIFIED_EVIDENCE : RECON_STATUS.UNRECONCILED,
        utr: utr || null,
        utrSubmittedAt: utr ? nowIso : null,
        auditLog: finalLog,
        createdAt: nowIso
      };
      tx = repository.transactions.create(tx);
      db.transactions.unshift(tx);
    } else {
      if (utr) {
        const updatedLog = appendAuditLog(tx.auditLog, {
          action: 'customer_utr_submitted',
          fromStatus: tx.status,
          toStatus: tx.status,
          reconciliationStatus: tx.status === 'success' ? tx.reconciliationStatus : RECON_STATUS.UNVERIFIED_EVIDENCE,
          source: 'checkout-customer',
          utr,
          details: 'Customer submitted unverified UTR evidence'
        });
        tx = repository.transactions.update(tx.id, {
          utr,
          utrSubmittedAt: nowIso,
          reconciliationStatus: tx.status === 'success' ? tx.reconciliationStatus : RECON_STATUS.UNVERIFIED_EVIDENCE,
          auditLog: updatedLog
        });
        const inMem = db.transactions.find(t => t.id === tx.id);
        if (inMem) {
          inMem.utr = utr;
          inMem.utrSubmittedAt = tx.utrSubmittedAt;
          inMem.reconciliationStatus = tx.reconciliationStatus;
          inMem.auditLog = tx.auditLog;
        }
      }
    }
    persist();
    publish(link.merchantId, 'transaction.updated', tx);
    return json(res, 200, { success: true, transaction: tx });
  }

  /* ── Integration API ── */
  if (method === 'POST' && p === '/api/integration/payment-links') {
    let supplied = req.headers['x-api-key'] || '';
    let hash = crypto.createHash('sha256').update(supplied).digest('hex');
    let key = repository.apiKeys.findByHash(hash) || (db.apiKeys && db.apiKeys.find(k => k.hash === hash));
    if (!key) return json(res, 401, { error: 'Invalid API key' });
    let merchant = repository.merchants.findById(key.merchantId) || (db.merchants && db.merchants.find(x => x.id === key.merchantId));
    let b = await read(req);
    let mUpis = repository.upis.findByMerchant(merchant.id);
    let upi = (mUpis.find(x => x.default) || mUpis[0]) || (db.upis && db.upis.find(x => x.merchantId === merchant.id && x.default));
    if (!upi || !b.name) return json(res, 400, { error: 'A default UPI and name are required' });
    let amountType = b.amountType === 'open' ? 'open' : 'fixed', amount = Number(b.amount);
    let link = {
      id: id('lnk'),
      merchantId: merchant.id,
      upiId: upi.upiId,
      name: b.name,
      description: b.description || '',
      slug: uniqueSlug(b.slug || b.name),
      amount: amountType === 'fixed' ? amount : null,
      amountType,
      active: true,
      createdAt: new Date().toISOString()
    };
    link = repository.links.create(link);
    db.links.unshift(link);
    repository.apiKeys.updateLastUsed(key.id);
    key.lastUsedAt = new Date().toISOString();
    persist();
    return json(res, 201, { ...link, url: `${url.origin}/pay/${link.slug}` });
  }

  /* ── Companion App Status & Protected APK Download ── */
  if (p === '/api/companion/status') {
    const candidatePaths = [
      path.join(ROOT, 'companion-android/app/build/outputs/apk/release/app-release.apk'),
      path.join(ROOT, 'downloads/sakkupay-companion.apk')
    ];
    const apkPath = candidatePaths.find(cand => fs.existsSync(cand));
    if (apkPath) {
      const stat = fs.statSync(apkPath);
      return json(res, 200, {
        available: true,
        version: '1.0',
        versionCode: 1,
        packageName: 'in.sakkupay.companion',
        filename: 'sakkupay-companion-v1.0.apk',
        sizeBytes: stat.size,
        sizeFormatted: (stat.size / (1024 * 1024)).toFixed(2) + ' MB'
      });
    } else {
      return json(res, 200, {
        available: false,
        version: '1.0',
        versionCode: 1,
        packageName: 'in.sakkupay.companion',
        message: 'Companion APK is not yet compiled on this server.'
      });
    }
  }

  if (p === '/api/companion/download' || p === '/downloads/sakkupay-companion.apk') {
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json', 'Allow': 'GET, HEAD' });
      return res.end(JSON.stringify({ error: 'Method Not Allowed', message: 'Only GET and HEAD requests are permitted.' }));
    }

    // Security & Authorization: Only authenticated merchants may download the companion app
    const merchant = auth(req);
    if (!merchant) {
      return json(res, 401, {
        error: 'Unauthorized',
        message: 'Authentication required. Please sign in to your SakkuPay merchant account to download the Companion APK.'
      });
    }

    const candidatePaths = [
      path.join(ROOT, 'companion-android/app/build/outputs/apk/release/app-release.apk'),
      path.join(ROOT, 'downloads/sakkupay-companion.apk')
    ];
    let apkPath = candidatePaths.find(cand => fs.existsSync(cand));

    if (apkPath) {
      const stat = fs.statSync(apkPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="sakkupay-companion-v1.0.apk"',
        'Cache-Control': 'private, no-cache, no-store, must-revalidate'
      });
      if (method === 'HEAD') {
        return res.end();
      }
      return fs.createReadStream(apkPath).pipe(res);
    } else {
      return json(res, 404, {
        available: false,
        name: 'SakkuPay Merchant Companion',
        version: '1.0',
        packageName: 'in.sakkupay.companion',
        message: 'Companion APK is not available on this server host.'
      });
    }
  }

  /* ── Automated Payment Verification Webhook (Android Companion) ── */
  if (p === '/api/v1/webhook/verify-payment') {
    const rl = checkRateLimit(clientIp, 'webhook_companion', 60, 60 * 1000);
    if (!rl.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rl.resetAfterSec) });
      return json(res, 429, { error: 'Webhook rate limit exceeded', retryAfter: rl.resetAfterSec });
    }

    let supplied = req.headers['x-api-key'] || (req.headers['authorization']?.replace(/^Bearer\s+/i, '')) || '';
    if (method === 'GET') {
      let hash = crypto.createHash('sha256').update(supplied).digest('hex');
      let key = supplied ? (repository.apiKeys.findByHash(hash) || (db.apiKeys && db.apiKeys.find(k => k.hash === hash))) : null;
      if (!key) return json(res, 401, { error: 'Invalid API key' });
      return json(res, 200, { ok: true, merchantId: key.merchantId, status: 'listening' });
    }
    if (method === 'POST') {
      let b = await read(req);
      if (!supplied && b.apiKey) supplied = b.apiKey;
      let hash = crypto.createHash('sha256').update(supplied).digest('hex');
      let key = supplied ? (repository.apiKeys.findByHash(hash) || (db.apiKeys && db.apiKeys.find(k => k.hash === hash))) : null;
      if (!key) return json(res, 401, { error: 'Invalid API key' });
      if (b.merchantId && b.merchantId !== key.merchantId) return json(res, 403, { error: 'Merchant ID mismatch' });
      let amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: 'A valid amount > 0 is required' });
      let utr = String(b.utr || '').trim().replace(/[^a-zA-Z0-9]/g, '');
      if (!utr || utr.length < 6) return json(res, 400, { error: 'A valid UTR/reference number (min 6 characters) is required' });
      let customerUpi = String(b.customerUpi || '').trim();
      let timestamp = b.timestamp && !isNaN(Date.parse(b.timestamp)) ? new Date(b.timestamp).toISOString() : new Date().toISOString();
      repository.apiKeys.updateLastUsed(key.id);
      key.lastUsedAt = new Date().toISOString();

      const reconResult = reconcileCompanionPayment({
        repository,
        merchantId: key.merchantId,
        amount,
        utr,
        customerUpi,
        timestamp
      });

      if (reconResult.ambiguous) {
        if (reconResult.transaction) {
          const inMem = db.transactions.find(t => t.id === reconResult.transaction.id);
          if (inMem) Object.assign(inMem, reconResult.transaction);
        } else if (reconResult.candidateReferences) {
          for (const cRef of reconResult.candidateReferences) {
            const fresh = repository.transactions.findByReference(cRef);
            const inMem = db.transactions.find(t => t.reference === cRef);
            if (fresh && inMem) Object.assign(inMem, fresh);
          }
        }
        persist();
        return json(res, 200, {
          verified: false,
          ambiguous: true,
          reason: reconResult.reason,
          candidateCount: reconResult.candidateCount,
          message: reconResult.message
        });
      }

      if (reconResult.duplicate) {
        return json(res, 200, {
          verified: true,
          duplicate: true,
          transaction: reconResult.transaction
        });
      }

      if (reconResult.matched) {
        const inMem = db.transactions.find(t => t.id === reconResult.transaction.id);
        if (inMem) Object.assign(inMem, reconResult.transaction);
        persist();
        publish(key.merchantId, 'transaction.updated', reconResult.transaction);
        return json(res, 200, {
          verified: true,
          matched: true,
          transaction: reconResult.transaction
        });
      }

      if (reconResult.direct) {
        db.transactions.unshift(reconResult.transaction);
        persist();
        publish(key.merchantId, 'transaction.updated', reconResult.transaction);
        return json(res, 200, {
          verified: true,
          matched: false,
          direct: true,
          transaction: reconResult.transaction
        });
      }
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  /* ── Direct PhonePe Business Webhook (Task 1) ── */
  if (method === 'POST' && p === '/api/v1/webhook/phonepe') {
    const rl = checkRateLimit(clientIp, 'webhook_phonepe', 60, 60 * 1000);
    if (!rl.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rl.resetAfterSec) });
      return res.end(JSON.stringify({ error: 'Rate limit exceeded for webhooks', retryAfter: rl.resetAfterSec }));
    }

    const xVerify = String(req.headers['x-verify'] || '').trim();
    if (!xVerify || !xVerify.includes('###')) {
      return json(res, 401, { error: 'Missing or malformed X-VERIFY signature header' });
    }

    let b = await read(req);
    if (!b || typeof b.response !== 'string' || !b.response.trim()) {
      return json(res, 400, { error: 'Payload must contain a valid base64 response string' });
    }

    const rawResponseBase64 = b.response.trim();
    let decodedJson = null;
    try {
      decodedJson = JSON.parse(Buffer.from(rawResponseBase64, 'base64').toString('utf8'));
    } catch {
      return json(res, 400, { error: 'Invalid base64 encoding in response payload' });
    }

    const data = decodedJson.data || decodedJson;
    const merchantIdRef = String(data.merchantId || decodedJson.merchantId || '').trim();
    if (!merchantIdRef) {
      return json(res, 400, { error: 'Missing merchantId in decoded webhook payload' });
    }

    const account = repository.businessAccounts.findByProviderAndMid('phonepe', merchantIdRef) ||
      (db.businessAccounts || []).find(a => a.provider === 'phonepe' && a.merchantIdRef === merchantIdRef && a.status === 'connected');
    if (!account) {
      return json(res, 401, { error: 'Unrecognized or inactive PhonePe merchant account' });
    }

    const saltKey = decryptToken(account.token);
    const saltIndex = String(account.saltIndex || '1').trim();
    if (!saltKey) {
      return json(res, 401, { error: 'Merchant credentials unavailable for signature verification' });
    }

    // Official PhonePe verification: SHA256(response_base64 + salt_key) + "###" + salt_index
    const expectedHash = crypto.createHash('sha256').update(rawResponseBase64 + saltKey).digest('hex');
    const expectedXVerify = `${expectedHash}###${saltIndex}`;

    const xVerifyBuf = Buffer.from(xVerify);
    const expectedBuf = Buffer.from(expectedXVerify);
    const isValidSignature = xVerifyBuf.length === expectedBuf.length && crypto.timingSafeEqual(xVerifyBuf, expectedBuf);
    if (!isValidSignature) {
      return json(res, 401, { error: 'PhonePe webhook signature verification failed' });
    }

    const merchantTransactionId = String(data.merchantTransactionId || data.transactionId || '').trim();
    const providerRef = String(data.providerReferenceId || data.transactionId || '').trim();
    const isSuccess = decodedJson.code === 'PAYMENT_SUCCESS' || decodedJson.success === true || data.responseCode === 'SUCCESS';

    const tx = repository.transactions.findForCheckout(account.merchantId, { txId: merchantTransactionId, ref: merchantTransactionId }) ||
      (db.transactions && db.transactions.find(t => t.merchantId === account.merchantId && (t.reference === merchantTransactionId || t.id === merchantTransactionId)));
    if (!tx) {
      return json(res, 404, { error: 'Transaction matching merchantTransactionId not found' });
    }

    // Webhook Amount Verification Guard: Ensure payload amount strictly matches expected order amount in paise
    if (isSuccess && data.amount !== undefined && data.amount !== null) {
      const expectedPaise = Number(tx.amount_paise || Math.round(tx.amount * 100));
      const receivedPaise = Number(data.amount);
      if (expectedPaise !== receivedPaise) {
        repository.transactions.update(tx.id, {
          reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
          ambiguityReason: `PhonePe amount mismatch: expected ${expectedPaise} paise, received ${receivedPaise} paise`,
          auditLog: appendAuditLog(tx.auditLog, {
            action: 'phonepe_amount_mismatch',
            fromStatus: tx.status,
            toStatus: tx.status,
            reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
            source: 'phonepe-direct',
            providerReference: providerRef,
            details: `Webhook reported amount of ${receivedPaise} paise does not match order amount of ${expectedPaise} paise.`
          })
        });
        return json(res, 400, { error: 'Payment amount does not match transaction order amount', transactionId: tx.id });
      }
    }

    const reconResult = reconcileProviderWebhook({
      repository,
      tx,
      isSuccess,
      provider: 'phonepe',
      providerRef,
      utr: providerRef
    });

    if (!reconResult.success) {
      return json(res, 400, { error: reconResult.error, transactionId: tx.id });
    }

    const updatedTx = reconResult.transaction;
    const inMem = db.transactions.find(t => t.id === updatedTx.id);
    if (inMem) Object.assign(inMem, updatedTx);
    persist();
    publish(account.merchantId, 'transaction.updated', updatedTx);

    if (reconResult.duplicate) {
      return json(res, 200, { success: true, verified: true, duplicate: true, transactionId: updatedTx.id });
    }
    if (reconResult.staleEventRejected) {
      return json(res, 200, { success: true, verified: true, staleEventRejected: true, transactionId: updatedTx.id });
    }
    if (updatedTx.status === 'failed') {
      return json(res, 200, { success: true, verified: true, status: 'failed', transaction: updatedTx });
    }
    return json(res, 200, { success: true, verified: true, transaction: updatedTx });
  }

  /* ── Direct Paytm Business Webhook (Task 2) ── */
  if (method === 'POST' && p === '/api/v1/webhook/paytm') {
    const rl = checkRateLimit(clientIp, 'webhook_paytm', 60, 60 * 1000);
    if (!rl.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(rl.resetAfterSec) });
      return res.end(JSON.stringify({ error: 'Rate limit exceeded for webhooks', retryAfter: rl.resetAfterSec }));
    }

    let b = await read(req);
    const mid = String(b.MID || b.mid || '').trim();
    if (!mid) {
      return json(res, 400, { error: 'Missing MID in Paytm webhook payload' });
    }

    const account = repository.businessAccounts.findByProviderAndMid('paytm', mid) ||
      (db.businessAccounts || []).find(a => a.provider === 'paytm' && a.merchantIdRef === mid && a.status === 'connected');
    if (!account) {
      return json(res, 401, { error: 'Unrecognized or inactive Paytm merchant account' });
    }

    const receivedChecksum = String(b.CHECKSUMHASH || b.checksum || req.headers['x-checksum'] || '').trim();
    if (!receivedChecksum) {
      return json(res, 401, { error: 'Missing required Paytm CHECKSUMHASH' });
    }

    const merchantKey = decryptToken(account.token);
    if (!merchantKey) {
      return json(res, 401, { error: 'Merchant credentials unavailable for checksum verification' });
    }

    const isValidChecksum = verifyPaytmChecksum(b, receivedChecksum, merchantKey);
    if (!isValidChecksum) {
      return json(res, 401, { error: 'Paytm CHECKSUMHASH verification failed' });
    }

    const orderId = String(b.ORDERID || b.orderId || '').trim();
    const txnId = String(b.TXNID || b.txnId || '').trim();
    const status = String(b.STATUS || b.status || '').trim();
    const isSuccess = status === 'TXN_SUCCESS' || status === 'SUCCESS';

    const tx = repository.transactions.findForCheckout(account.merchantId, { txId: orderId, ref: orderId }) ||
      (db.transactions && db.transactions.find(t => t.merchantId === account.merchantId && (t.reference === orderId || t.id === orderId)));
    if (!tx) {
      return json(res, 404, { error: 'Transaction matching ORDERID not found' });
    }

    // Webhook Amount Verification Guard: Ensure payload amount strictly matches expected order amount in rupees
    if (isSuccess && b.TXNAMOUNT !== undefined && b.TXNAMOUNT !== null) {
      const expectedAmount = Number(tx.amount);
      const receivedAmount = Number(b.TXNAMOUNT);
      if (Math.abs(expectedAmount - receivedAmount) > 0.01) {
        repository.transactions.update(tx.id, {
          reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
          ambiguityReason: `Paytm amount mismatch: expected ₹${expectedAmount}, received ₹${receivedAmount}`,
          auditLog: appendAuditLog(tx.auditLog, {
            action: 'paytm_amount_mismatch',
            fromStatus: tx.status,
            toStatus: tx.status,
            reconciliationStatus: RECON_STATUS.FLAGGED_AMBIGUOUS,
            source: 'paytm-direct',
            providerReference: txnId,
            details: `Webhook reported amount ₹${receivedAmount} does not match order amount ₹${expectedAmount}.`
          })
        });
        return json(res, 400, { error: 'Payment amount does not match transaction order amount', transactionId: tx.id });
      }
    }

    const reconResult = reconcileProviderWebhook({
      repository,
      tx,
      isSuccess,
      provider: 'paytm',
      providerRef: txnId,
      utr: txnId
    });

    if (!reconResult.success) {
      return json(res, 400, { error: reconResult.error, transactionId: tx.id });
    }

    const updatedTx = reconResult.transaction;
    const inMem = db.transactions.find(t => t.id === updatedTx.id);
    if (inMem) Object.assign(inMem, updatedTx);
    persist();
    publish(account.merchantId, 'transaction.updated', updatedTx);

    if (reconResult.duplicate) {
      return json(res, 200, { success: true, verified: true, duplicate: true, transactionId: updatedTx.id });
    }
    if (reconResult.staleEventRejected) {
      return json(res, 200, { success: true, verified: true, staleEventRejected: true, transactionId: updatedTx.id });
    }
    if (updatedTx.status === 'failed') {
      return json(res, 200, { success: true, verified: true, status: 'failed', transaction: updatedTx });
    }
    return json(res, 200, { success: true, verified: true, transaction: updatedTx });
  }

  let m = required(req, res); if (!m) return;

  /* ── Business Accounts (PhonePe & Paytm Direct Linking) ── */
  if (p === '/api/business-accounts') {
    if (method === 'GET') {
      let list = repository.businessAccounts.findByMerchant(m.id).map(acc => ({
        id: acc.id,
        merchantId: acc.merchantId,
        provider: acc.provider,
        accountName: acc.accountName,
        phoneNumber: acc.phoneNumber,
        merchantIdRef: acc.merchantIdRef,
        tokenMasked: maskSecret(acc.token),
        hasToken: !!acc.token,
        saltIndex: acc.saltIndex || '1',
        status: acc.status || 'connected',
        autoVerify: acc.autoVerify !== false,
        lastSyncedAt: acc.lastSyncedAt || null,
        createdAt: acc.createdAt
      }));
      return json(res, 200, list);
    }
    if (method === 'POST') {
      let b = await read(req);
      let provider = String(b.provider || '').toLowerCase().trim();
      if (!['phonepe', 'paytm'].includes(provider)) return json(res, 400, { error: 'Supported providers are "phonepe" or "paytm"' });
      let phone = String(b.phoneNumber || '').replace(/\D/g, '');
      if (!/^\d{10}$/.test(phone)) return json(res, 400, { error: 'Please enter a valid 10-digit registered phone number' });
      let merchantIdRef = String(b.merchantIdRef || '').trim();
      if (!merchantIdRef) return json(res, 400, { error: 'Merchant ID / MID is required' });
      let rawToken = String(b.token || '').trim();
      if (!rawToken) return json(res, 400, { error: 'API token or secret salt key is required' });

      let existing = repository.businessAccounts.findByMerchant(m.id).find(x => x.provider === provider) ||
        (db.businessAccounts || []).find(x => x.merchantId === m.id && x.provider === provider);
      if (existing) {
        const updated = repository.businessAccounts.update(existing.id, {
          accountName: (b.accountName || existing.accountName || (provider === 'phonepe' ? 'PhonePe Business' : 'Paytm Business')).trim(),
          phoneNumber: phone,
          merchantIdRef,
          token: encryptToken(rawToken),
          saltIndex: b.saltIndex ? String(b.saltIndex).trim() : (existing.saltIndex || '1'),
          autoVerify: b.autoVerify !== false,
          status: 'connected',
          lastSyncedAt: new Date().toISOString()
        });
        const inMem = db.businessAccounts.find(x => x.id === existing.id);
        if (inMem) Object.assign(inMem, updated);
        persist();
        return json(res, 200, {
          id: updated.id,
          provider: updated.provider,
          accountName: updated.accountName,
          phoneNumber: updated.phoneNumber,
          merchantIdRef: updated.merchantIdRef,
          tokenMasked: maskSecret(updated.token),
          status: updated.status,
          autoVerify: updated.autoVerify,
          lastSyncedAt: updated.lastSyncedAt
        });
      }

      let account = {
        id: id('biz'),
        merchantId: m.id,
        provider,
        accountName: (b.accountName || (provider === 'phonepe' ? 'PhonePe Business' : 'Paytm Business')).trim(),
        phoneNumber: phone,
        merchantIdRef,
        token: encryptToken(rawToken),
        saltIndex: String(b.saltIndex || '1').trim(),
        status: 'connected',
        autoVerify: b.autoVerify !== false,
        lastSyncedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      };
      account = repository.businessAccounts.create(account);
      db.businessAccounts.push(account);
      persist();
      return json(res, 201, {
        id: account.id,
        provider: account.provider,
        accountName: account.accountName,
        phoneNumber: account.phoneNumber,
        merchantIdRef: account.merchantIdRef,
        tokenMasked: maskSecret(account.token),
        status: account.status,
        autoVerify: account.autoVerify,
        lastSyncedAt: account.lastSyncedAt,
        createdAt: account.createdAt
      });
    }
  }

  if (p.startsWith('/api/business-accounts/')) {
    let sub = p.slice(23);
    if (sub === 'direct-verify' && method === 'POST') {
      let b = await read(req);
      let ref = String(b.reference || '').trim();
      let txId = String(b.transactionId || '').trim();
      let utr = String(b.utr || '').trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 30);
      let provider = String(b.provider || '').toLowerCase().trim();

      let tx = repository.transactions.findForCheckout(m.id, { txId, ref }) ||
        (db.transactions && db.transactions.find(t => t.merchantId === m.id && ((txId && t.id === txId) || (ref && t.reference === ref))));
      if (!tx) return json(res, 404, { error: 'Pending transaction not found' });

      if (tx.status === 'success') {
        return json(res, 200, { verified: true, alreadyVerified: true, transaction: tx });
      }

      let acc = repository.businessAccounts.findByMerchant(m.id).find(a => (provider ? a.provider === provider : true) && a.status === 'connected') ||
        (db.businessAccounts || []).find(a => a.merchantId === m.id && (provider ? a.provider === provider : true) && a.status === 'connected');
      if (!acc) return json(res, 400, { error: 'No active linked business account found for this verification' });

      // Security requirement (Task 3): Do NOT mark status = 'success' without verified webhook proof.
      if (utr) {
        const nowIso = new Date().toISOString();
        const updatedLog = appendAuditLog(tx.auditLog, {
          action: 'merchant_direct_verify_utr_submitted',
          fromStatus: tx.status,
          toStatus: tx.status,
          reconciliationStatus: RECON_STATUS.UNVERIFIED_EVIDENCE,
          source: 'merchant-dashboard',
          utr,
          details: `Merchant requested direct verification via ${acc.provider || provider || 'business_account'}`
        });
        tx = repository.transactions.update(tx.id, {
          utr,
          utrSubmittedAt: nowIso,
          reconciliationStatus: RECON_STATUS.UNVERIFIED_EVIDENCE,
          auditLog: updatedLog
        });
        const inMem = db.transactions.find(t => t.id === tx.id);
        if (inMem) {
          inMem.utr = utr;
          inMem.utrSubmittedAt = tx.utrSubmittedAt;
          inMem.reconciliationStatus = tx.reconciliationStatus;
          inMem.auditLog = tx.auditLog;
        }
        persist();
        publish(m.id, 'transaction.updated', tx);
      }
      return json(res, 200, {
        verified: false,
        pending: true,
        message: 'UTR receipt registered. Transaction will be confirmed once bank or provider webhook delivers proof.',
        transaction: tx
      });
    }

    let parts = sub.split('/');
    let accId = parts[0];
    let account = repository.businessAccounts.findById(accId) || (db.businessAccounts || []).find(x => x.id === accId && x.merchantId === m.id);
    if (!account || account.merchantId !== m.id) return json(res, 404, { error: 'Linked business account not found' });

    if (parts.length === 2 && parts[1] === 'test' && method === 'POST') {
      const updated = repository.businessAccounts.update(account.id, {
        lastSyncedAt: new Date().toISOString(),
        status: 'connected'
      });
      account.lastSyncedAt = updated.lastSyncedAt;
      account.status = updated.status;
      persist();
      return json(res, 200, { ok: true, status: 'connected', provider: account.provider, lastSyncedAt: account.lastSyncedAt });
    }

    if (method === 'PATCH' || method === 'PUT') {
      let b = await read(req);
      const partial = {};
      if (typeof b.accountName === 'string') partial.accountName = b.accountName.trim();
      if (typeof b.phoneNumber === 'string') {
        let p = b.phoneNumber.replace(/\D/g, '');
        if (/^\d{10}$/.test(p)) partial.phoneNumber = p;
      }
      if (typeof b.merchantIdRef === 'string' && b.merchantIdRef.trim()) partial.merchantIdRef = b.merchantIdRef.trim();
      if (typeof b.token === 'string' && b.token.trim()) partial.token = encryptToken(b.token.trim());
      if (typeof b.saltIndex === 'string') partial.saltIndex = b.saltIndex.trim();
      if (typeof b.autoVerify === 'boolean') partial.autoVerify = b.autoVerify;
      partial.lastSyncedAt = new Date().toISOString();

      const updated = repository.businessAccounts.update(account.id, partial);
      const inMem = db.businessAccounts.find(x => x.id === account.id);
      if (inMem) Object.assign(inMem, updated);
      persist();
      return json(res, 200, {
        id: updated.id,
        provider: updated.provider,
        accountName: updated.accountName,
        phoneNumber: updated.phoneNumber,
        merchantIdRef: updated.merchantIdRef,
        tokenMasked: maskSecret(updated.token),
        status: updated.status,
        autoVerify: updated.autoVerify,
        lastSyncedAt: updated.lastSyncedAt
      });
    }

    if (method === 'DELETE') {
      repository.businessAccounts.delete(account.id, m.id);
      db.businessAccounts = db.businessAccounts.filter(x => x.id !== account.id);
      persist();
      return json(res, 204, {});
    }
  }

  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    res.write('retry: 5000\n\n');
    let clients = eventClients.get(m.id) || new Set();
    clients.add(res);
    eventClients.set(m.id, clients);
    req.on('close', () => {
      clients.delete(res);
      if (!clients.size) eventClients.delete(m.id);
    });
    return;
  }

  if (method === 'GET' && p === '/api/dashboard') {
    let range = url.searchParams.get('range') || 'month';
    const overview = repository.transactions.getMerchantOverviewStats(m.id, range);
    return json(res, 200, {
      stats: {
        volume: overview.volume,
        volumePaise: overview.volumePaise,
        successful: overview.successful,
        pending: overview.pending,
        activeLinks: overview.activeLinks
      },
      recent: overview.recent
    });
  }

  if (p === '/api/profile') {
    if (method === 'GET') return json(res, 200, merchantSafe(m));
    if (method === 'PUT' || method === 'PATCH') {
      let b = await read(req);
      const partial = {};
      if (typeof b.businessName === 'string') {
        const bn = b.businessName.trim();
        if (bn.length < 2) return json(res, 400, { error: 'Business name must be at least 2 characters long' });
        partial.businessName = bn;
      }
      if (typeof b.supportEmail === 'string') {
        const se = b.supportEmail.trim();
        if (se && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(se)) return json(res, 400, { error: 'Please enter a valid customer support email address' });
        partial.supportEmail = se;
      }
      if (typeof b.description === 'string') partial.description = b.description.trim();
      if (typeof b.whatsappNumber === 'string') {
        let number = b.whatsappNumber.replace(/\D/g, '');
        if (number && !/^\d{10}$/.test(number)) return json(res, 400, { error: 'Enter a 10-digit WhatsApp number' });
        partial.whatsappNumber = number;
      }
      m = repository.merchants.update(m.id, partial);
      const inMem = db.merchants.find(x => x.id === m.id);
      if (inMem) Object.assign(inMem, m);
      persist();
      return json(res, 200, merchantSafe(m));
    }
  }

  if (p === '/api/upis') {
    if (method === 'GET') return json(res, 200, repository.upis.findByMerchant(m.id));
    if (method === 'POST') {
      let b = await read(req), upi = String(b.upiId || '').trim().toLowerCase(), phone = String(b.phoneNumber || '').replace(/\D/g, '');
      if (!/^[\w.-]+@[\w.-]+$/.test(upi)) return json(res, 400, { error: 'Enter a valid UPI ID (e.g. store@okaxis or name@upi)' });
      if (!/^\d{10}$/.test(phone)) return json(res, 400, { error: 'Enter a valid 10-digit mobile number linked to this UPI ID' });
      let autoLabel = (b.label || upi.split('@')[0] || 'UPI Account').trim();
      const existingUpis = repository.upis.findByMerchant(m.id);
      let account = {
        id: id('upi'),
        merchantId: m.id,
        label: autoLabel,
        upiId: upi,
        phoneNumber: phone,
        default: existingUpis.length === 0,
        createdAt: new Date().toISOString()
      };
      account = repository.upis.create(account);
      db.upis.push(account);
      if (!m.whatsappNumber) {
        m = repository.merchants.update(m.id, { whatsappNumber: phone });
        const inMem = db.merchants.find(x => x.id === m.id);
        if (inMem) inMem.whatsappNumber = phone;
      }
      persist();
      return json(res, 201, account);
    }
  }

  if (p.startsWith('/api/upis/')) {
    let rest = p.slice(10).split('/'), account = repository.upis.findById(rest[0]);
    if (!account || account.merchantId !== m.id) return json(res, 404, { error: 'UPI account not found' });
    if (method === 'DELETE') {
      repository.upis.delete(account.id);
      db.upis = db.upis.filter(x => x.id !== account.id);
      if (account.default) {
        let next = repository.upis.findByMerchant(m.id)[0];
        if (next) {
          repository.upis.setDefault(m.id, next.id);
          const inMemNext = db.upis.find(x => x.id === next.id);
          if (inMemNext) inMemNext.default = true;
        }
      }
      persist();
      return json(res, 204, {});
    }
    if (method === 'PATCH') {
      let b = await read(req);
      if (rest[1] === 'default') {
        repository.upis.setDefault(m.id, account.id);
        account.default = true;
        db.upis.filter(x => x.merchantId === m.id).forEach(x => x.default = x.id === account.id);
      }
      const partial = {};
      if (b.label) partial.label = b.label.trim();
      if (typeof b.phoneNumber === 'string') {
        let phone = b.phoneNumber.replace(/\D/g, '');
        if (!/^\d{10}$/.test(phone)) return json(res, 400, { error: 'Enter the 10-digit phone number linked to this UPI ID' });
        partial.phoneNumber = phone;
      }
      if (Object.keys(partial).length > 0) {
        account = repository.upis.update(account.id, partial);
        const inMem = db.upis.find(x => x.id === account.id);
        if (inMem) Object.assign(inMem, account);
      }
      persist();
      return json(res, 200, account);
    }
  }

  const ALLOWED_TEMPLATES = new Set(['classic', 'minimal', 'premium-dark', 'modern-gradient', 'compact-upi']);

  if (p === '/api/links') {
    if (method === 'GET') return json(res, 200, repository.links.findByMerchant(m.id));
    if (method === 'POST') {
      let b = await read(req);
      const mUpis = repository.upis.findByMerchant(m.id);
      let upi = (b.upiId && mUpis.find(u => u.id === b.upiId)) || mUpis.find(x => x.default) || mUpis[0] ||
        (db.upis && db.upis.find(x => x.merchantId === m.id && x.default));
      if (!b.name || !String(b.name).trim()) return json(res, 400, { error: 'Product or payment title is required' });
      if (!upi) return json(res, 400, { error: 'Please connect a receiving UPI account first before creating a payment link' });
      let amountType = b.amountType === 'open' ? 'open' : 'fixed', amount = Number(b.amount);
      if (amountType === 'fixed' && (!Number.isFinite(amount) || amount <= 0)) return json(res, 400, { error: 'A valid fixed amount greater than ₹0 is required' });
      
      const template = (b.template && ALLOWED_TEMPLATES.has(b.template)) ? b.template : 'classic';
      const rawSlug = (b.slug || b.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
      const cleanSlug = uniqueSlug(rawSlug || 'pay');

      let link = {
        id: id('lnk'),
        merchantId: m.id,
        upiId: upi.upiId,
        name: b.name.trim(),
        description: (b.description || '').trim(),
        slug: cleanSlug,
        amount: amountType === 'fixed' ? amount : null,
        amountType,
        template,
        active: true,
        createdAt: new Date().toISOString()
      };
      link = repository.links.create(link);
      db.links.unshift(link);
      persist();

      const host = req.headers['host'] || 'localhost:3000';
      const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
      const baseUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : `${proto}://${host}`;
      link.url = `${baseUrl}/pay/${link.slug}`;
      link.fullUrl = link.url;

      return json(res, 201, link);
    }
  }

  if (p.startsWith('/api/links/')) {
    let link = repository.links.findById(p.slice(11));
    if (!link || link.merchantId !== m.id) return json(res, 404, { error: 'Payment link not found' });
    if (method === 'PATCH') {
      let b = await read(req);
      const updates = {};
      if (typeof b.active === 'boolean') updates.active = b.active;
      if (typeof b.name === 'string' && b.name.trim()) updates.name = b.name.trim();
      if (typeof b.description === 'string') updates.description = b.description.trim();
      if (typeof b.template === 'string' && ALLOWED_TEMPLATES.has(b.template)) updates.template = b.template;

      link = repository.links.update(link.id, updates);
      const inMem = db.links.find(x => x.id === link.id);
      if (inMem) Object.assign(inMem, link);
      persist();

      const host = req.headers['host'] || 'localhost:3000';
      const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
      const baseUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/$/, '') : `${proto}://${host}`;
      link.url = `${baseUrl}/pay/${link.slug}`;
      link.fullUrl = link.url;

      return json(res, 200, link);
    }
    if (method === 'DELETE') {
      repository.links.delete(link.id);
      db.links = db.links.filter(x => x.id !== link.id);
      persist();
      return json(res, 204, {});
    }
  }

  /* ── Merchant Support Queries ── */
  if (p === '/api/support/query' && method === 'POST') {
    let b = await read(req);
    const subject = (b.subject || '').trim();
    const message = (b.message || '').trim();
    const category = (b.category || 'general').trim();
    if (!subject) return json(res, 400, { error: 'Support query subject is required' });
    if (!message) return json(res, 400, { error: 'Support query message is required' });

    const query = repository.supportQueries.create({
      id: id('sup'),
      merchantId: m.id,
      category,
      subject,
      message,
      status: 'open',
      createdAt: new Date().toISOString()
    });

    return json(res, 201, {
      success: true,
      ticketId: query.id,
      query,
      message: `Support ticket #${query.id} created successfully. Our engineering team has received your inquiry.`
    });
  }

  if (p === '/api/support/queries' && method === 'GET') {
    const list = repository.supportQueries.findByMerchant(m.id);
    return json(res, 200, list);
  }

  if (method === 'GET' && p === '/api/transactions') {
    let q = url.searchParams.get('q')?.toLowerCase() || '', status = url.searchParams.get('status'), range = url.searchParams.get('range') || 'month', start = url.searchParams.get('start'), end = url.searchParams.get('end');
    let list = repository.transactions.findByMerchant(m.id, { q, status, range, start, end });
    return json(res, 200, list);
  }

  /* ── Merchant Transaction Update (Task 3: Block Self-Approval) ── */
  if (p.startsWith('/api/transactions/') && method === 'PATCH') {
    let tid = p.slice(18), tx = repository.transactions.findById(tid) || (db.transactions && db.transactions.find(x => x.id === tid && x.merchantId === m.id));
    if (!tx || tx.merchantId !== m.id) return json(res, 404, { error: 'Transaction not found' });
    let b = await read(req);

    // BLOCK SELF-APPROVAL: Merchants cannot directly set status to 'success' or mutate financial status
    if (b.status !== undefined) {
      if (b.status === 'success' || (b.status !== tx.status && ['success', 'failed'].includes(b.status))) {
        return json(res, 403, {
          error: 'Merchants cannot directly alter transaction financial status. Automated verification or audited administrative reconciliation is required.'
        });
      }
    }

    let partial = {};
    // Allow non-financial metadata updates
    if (typeof b.note === 'string') {
      partial.merchantNote = b.note.trim().slice(0, 500);
    }
    // Allow saving unverified UTR reference as evidence without mutating status
    if (typeof b.utr === 'string' && b.utr.trim()) {
      const sanitizedUtr = b.utr.trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 30);
      if (sanitizedUtr && tx.utr !== sanitizedUtr) {
        partial.utr = sanitizedUtr;
        partial.utrSubmittedAt = new Date().toISOString();
        if (tx.status !== 'success') {
          partial.reconciliationStatus = RECON_STATUS.UNVERIFIED_EVIDENCE;
        }
      }
    }

    if (Object.keys(partial).length > 0) {
      partial.auditLog = appendAuditLog(tx.auditLog, {
        action: 'merchant_metadata_updated',
        fromStatus: tx.status,
        toStatus: tx.status,
        reconciliationStatus: partial.reconciliationStatus || tx.reconciliationStatus,
        source: 'merchant-dashboard',
        details: `Merchant updated metadata fields: ${Object.keys(partial).join(', ')}`
      });
      tx = repository.transactions.update(tx.id, partial);
      const inMem = db.transactions.find(t => t.id === tx.id);
      if (inMem) Object.assign(inMem, tx);
      persist();
      publish(m.id, 'transaction.updated', tx);
    }
    return json(res, 200, tx);
  }

  if (p === '/api/keys') {
    if (method === 'GET') return json(res, 200, repository.apiKeys.findByMerchant(m.id).map(({ hash, ...x }) => x));
    if (method === 'POST') {
      let plain = 'sk_live_' + crypto.randomBytes(22).toString('base64url'), key = {
        id: id('key'),
        merchantId: m.id,
        name: 'Live API key',
        prefix: plain.slice(0, 12),
        hash: crypto.createHash('sha256').update(plain).digest('hex'),
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      };
      key = repository.apiKeys.create(key);
      db.apiKeys.push(key);
      persist();
      return json(res, 201, { ...key, key: plain });
    }
  }
  if (p.startsWith('/api/keys/') && method === 'DELETE') {
    const keyId = p.slice(10);
    repository.apiKeys.delete(keyId, m.id);
    db.apiKeys = db.apiKeys.filter(x => !(x.id === keyId && x.merchantId === m.id));
    persist();
    return json(res, 204, {});
  }

  return json(res, 404, { error: 'Route not found' });
}

/* ─── Static File Server ────────────────────────────────────────────────────── */
function staticFile(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/pay' || p === '/pay/' || p.startsWith('/pay/')) {
    const sub = p.startsWith('/pay/') ? p.slice(5) : '';
    // If the browser requested a static asset inside /pay/ (e.g. /pay/checkout.js, /pay/styles.css)
    if (sub && (sub === 'checkout.js' || sub === 'styles.css' || sub === 'app-extra.css' || sub.endsWith('.js') || sub.endsWith('.css') || sub.endsWith('.svg') || sub.endsWith('.png') || sub.endsWith('.ico'))) {
      p = '/' + sub;
    } else {
      p = '/checkout.html';
    }
  }
  else if (p === '/' || p === '/home' || p === '/home.html') p = '/home.html';
  else if (p === '/login' || p === '/login.html') p = '/login.html';
  else if (p === '/dashboard' || p === '/dashboard.html' || p === '/index.html' || p.startsWith('/dashboard/')) p = '/dashboard.html';
  else if (p === '/admin' || p === '/admin/' || p === '/admin/index.html' || p === '/admin.html') p = '/admin.html';

  // Security: Protect downloads and internal files from unauthenticated static exposure
  if (p.startsWith('/downloads/') || p.endsWith('.apk') || p.endsWith('.db') || p.endsWith('.sqlite') || p.includes('.env')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Forbidden', message: 'Direct static access prohibited. Use protected API endpoints.' }));
  }

  let target = path.normalize(path.join(ROOT, p));
  if (!target.startsWith(ROOT) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
}

/* ─── HTTP Server Instance ──────────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  applySecurityHeaders(res);
  if (req.url.startsWith('/api/') || req.url.startsWith('/downloads/')) {
    route(req, res).catch(e => {
      const isPayloadTooLarge = e.message === 'Payload too large';
      if (!isPayloadTooLarge) console.error(e);
      if (isPayloadTooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' });
        return res.end(JSON.stringify({ error: 'Payload too large' }));
      }
      json(res, 500, { error: 'An unexpected server error occurred' });
    });
  } else {
    staticFile(req, res);
  }
});

if (require.main === module) {
  validateProductionEnvironment();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('SakkuPay running at http://localhost:' + PORT));

  const shutdown = (signal) => {
    console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
    server.close(() => {
      console.log('HTTP server closed. Finalizing database state...');
      try {
        persist();
        sqliteDb.close();
      } catch (err) {
        console.error('Error closing database during shutdown:', err.message);
      }
      console.log('Graceful shutdown completed.');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Forced shutdown due to timeout.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  server,
  route,
  db,
  repository,
  sqliteDb,
  persist,
  encryptToken,
  decryptToken,
  token,
  adminToken,
  _verifyToken,
  validateProductionEnvironment,
  checkRateLimit,
  checkAdminLoginAllowed,
  recordFailedAdminLogin,
  clearAdminLoginFailures,
  verifyPaytmChecksum,
  VALID_TRANSITIONS,
  RECON_STATUS,
  isValidTransition,
  appendAuditLog,
  reconcileCompanionPayment,
  reconcileProviderWebhook,
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  REASON_CODES,
  hasPermission,
  isValidRole,
  isValidReasonCode,
  hashPassword,
  verifyPassword,
  logAdminAudit,
  sanitizeAuditState,
  requireAdmin
};
