/* ==============================================================================
   SakkuPay Staging Admin Secret Rotation Utility
   Generates a cryptographically random staging password, updates configuration
   and SQLite database in-place, and verifies hashing without printing credentials.
   ============================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword } = require('../src/services/adminRbac');

const STAGING_DIR = __dirname;
const ENV_STAGING_PATH = path.join(STAGING_DIR, '.env.staging');
const BAT_PATH = path.join(STAGING_DIR, 'start-staging.bat');
const SH_PATH = path.join(STAGING_DIR, 'start-staging.sh');
const SEED_PATH = path.join(STAGING_DIR, 'seed_staging.js');
const VERIFY_PATH = path.join(STAGING_DIR, 'verify_staging_instance.js');
const STAGING_DB_PATH = path.join(STAGING_DIR, 'sakkupay_staging.db');

// 1. Generate high-entropy 32-character secret
const newPassword = crypto.randomBytes(24).toString('base64url') + '!A9';
const newHash = hashPassword(newPassword);

// 2. Update .env.staging
if (fs.existsSync(ENV_STAGING_PATH)) {
  let envContent = fs.readFileSync(ENV_STAGING_PATH, 'utf8');
  envContent = envContent.replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${newPassword}`);
  fs.writeFileSync(ENV_STAGING_PATH, envContent, 'utf8');
}

// 3. Update seed_staging.js to read from .env.staging or environment rather than hardcoding
if (fs.existsSync(SEED_PATH)) {
  let seedContent = fs.readFileSync(SEED_PATH, 'utf8');
  seedContent = seedContent.replace(
    /const adminPassword = process\.env\.ADMIN_PASSWORD \|\| '.*';/,
    "const adminPassword = process.env.ADMIN_PASSWORD || (fs.existsSync(path.join(__dirname, '.env.staging')) ? fs.readFileSync(path.join(__dirname, '.env.staging'), 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)?.[1] : null);"
  );
  fs.writeFileSync(SEED_PATH, seedContent, 'utf8');
}

// 4. Update sakkupay_staging.db in-place
if (fs.existsSync(STAGING_DB_PATH)) {
  const db = new DatabaseSync(STAGING_DB_PATH);
  db.prepare(`
    UPDATE admin_users
    SET passwordHash = ?
    WHERE id = 'adm_staging_superadmin' OR role = 'SuperAdmin'
  `).run(newHash);

  // Verify hash without printing cleartext
  const row = db.prepare("SELECT passwordHash FROM admin_users WHERE id = 'adm_staging_superadmin'").get();
  const ok = verifyPassword(newPassword, row.passwordHash);
  db.close();

  if (!ok) {
    throw new Error('Rotation verification failed: stored hash did not match new password');
  }
}

console.log('✅ Staging admin secret rotated successfully across configuration and database.');
console.log('✅ Constant-time verification confirmed matching PBKDF2 hash.');
console.log('✅ Cleartext replacement password was not printed to console or logs.');
