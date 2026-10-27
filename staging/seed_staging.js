/* ==============================================================================
   SakkuPay Staging Environment Seed Script
   Populates isolated staging database with purely synthetic entities.
   Zero production credentials or customer PII.
   ============================================================================== */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createDatabaseConnection } = require('../src/db/connection');
const { initSchema } = require('../src/db/schema');
const { createRepository } = require('../src/db/repository');
const { hashPassword, ADMIN_ROLES } = require('../src/services/adminRbac');

const STAGING_DB_PATH = path.join(__dirname, 'sakkupay_staging.db');
const STAGING_JSON_PATH = path.join(__dirname, 'data.json');
const STAGING_BACKUP_DIR = path.join(__dirname, 'backups');

if (!fs.existsSync(STAGING_BACKUP_DIR)) {
  fs.mkdirSync(STAGING_BACKUP_DIR, { recursive: true });
}

// Ensure clean slate for staging DB
if (fs.existsSync(STAGING_DB_PATH)) fs.unlinkSync(STAGING_DB_PATH);
if (fs.existsSync(STAGING_DB_PATH + '-wal')) fs.unlinkSync(STAGING_DB_PATH + '-wal');
if (fs.existsSync(STAGING_DB_PATH + '-shm')) fs.unlinkSync(STAGING_DB_PATH + '-shm');

console.log('Initializing isolated staging database at:', STAGING_DB_PATH);
const db = createDatabaseConnection(STAGING_DB_PATH);
initSchema(db);
const repo = createRepository(db);

// 1. Synthetic Merchant
console.log('Creating synthetic staging merchants...');
const merchant = repo.merchants.create({
  id: 'mer_staging_retailer_01',
  email: 'merchant@staging.sakkupay.local',
  businessName: 'Staging Beta Retailer',
  supportEmail: 'support@staging.sakkupay.local',
  description: 'Synthetic Merchant for Staging Verification',
  whatsappNumber: '9990001122',
  suspended: false,
  createdAt: new Date().toISOString()
});

// 2. Synthetic UPI Account
console.log('Creating synthetic staging UPI destinations...');
const upi = repo.upis.create({
  id: 'upi_staging_01',
  merchantId: merchant.id,
  label: 'HDFC Current Store Account',
  upiId: 'stagingstore@okhdfcbank',
  phoneNumber: '9990001122',
  default: true,
  createdAt: new Date().toISOString()
});

// 3. Synthetic Payment Link
console.log('Creating synthetic staging payment links...');
const link = repo.links.create({
  id: 'lnk_staging_order_01',
  merchantId: merchant.id,
  upiId: upi.upiId,
  name: 'Staging Beta Test Order',
  description: 'Verification checkout for staging deployment',
  slug: 'beta-test-order',
  amount: 299,
  amountType: 'fixed',
  active: true,
  createdAt: new Date().toISOString()
});

// 4. Synthetic Transactions
console.log('Creating synthetic staging transaction ledger records...');
const txSettled = repo.transactions.create({
  id: 'txn_staging_settled_001',
  merchantId: merchant.id,
  linkId: link.id,
  reference: 'SP_STG_SETTLED_001',
  customerName: 'Synthetic Tester A',
  customerEmail: 'tester_a@staging.local',
  amount: 299,
  status: 'success',
  utr: 'STGUTR9876543210',
  paidAt: new Date().toISOString(),
  verifiedAt: new Date().toISOString(),
  verifiedBy: 'phonepe-direct',
  reconciliationStatus: 'settled',
  createdAt: new Date().toISOString()
});

const txPending = repo.transactions.create({
  id: 'txn_staging_pending_002',
  merchantId: merchant.id,
  linkId: link.id,
  reference: 'SP_STG_PENDING_002',
  customerName: 'Synthetic Tester B',
  customerEmail: 'tester_b@staging.local',
  amount: 499,
  status: 'pending',
  reconciliationStatus: 'unreconciled',
  createdAt: new Date().toISOString()
});

// 5. Synthetic Admin Users (RBAC)
console.log('Creating synthetic staging administrative users...');
const adminPassword = process.env.ADMIN_PASSWORD || (fs.existsSync(path.join(__dirname, '.env.staging')) ? fs.readFileSync(path.join(__dirname, '.env.staging'), 'utf8').match(/^ADMIN_PASSWORD=(.*)$/m)?.[1] : null);

repo.adminUsers.create({
  id: 'adm_staging_superadmin',
  email: 'superadmin@staging.sakkupay.local',
  name: 'Staging SuperAdmin',
  passwordHash: hashPassword(adminPassword),
  role: ADMIN_ROLES.SUPER_ADMIN,
  active: true
});

repo.adminUsers.create({
  id: 'adm_staging_operations',
  email: 'operations@staging.sakkupay.local',
  name: 'Staging Ops Support',
  passwordHash: hashPassword(adminPassword),
  role: ADMIN_ROLES.OPERATIONS_SUPPORT,
  active: true
});

repo.adminUsers.create({
  id: 'adm_staging_auditor',
  email: 'auditor@staging.sakkupay.local',
  name: 'Staging Compliance Auditor',
  passwordHash: hashPassword(adminPassword),
  role: ADMIN_ROLES.COMPLIANCE_AUDITOR,
  active: true
});

// 6. Generate staging data.json snapshot & register migration_metadata
const stagingSnapshot = repo.getLegacyDbSnapshot();
const snapshotJson = JSON.stringify(stagingSnapshot, null, 2);
fs.writeFileSync(STAGING_JSON_PATH, snapshotJson);
const sha256 = crypto.createHash('sha256').update(snapshotJson).digest('hex');

db.prepare(`
  INSERT OR REPLACE INTO migration_metadata (id, migrated_at, source_sha256, source_counts_json)
  VALUES (1, ?, ?, ?)
`).run(new Date().toISOString(), sha256, JSON.stringify({
  merchants: 1, upis: 1, links: 1, transactions: 2, apiKeys: 0, businessAccounts: 0
}));

console.log('Staging seeding completed successfully.');
console.log('Table Counts in sakkupay_staging.db:');
['merchants', 'upis', 'links', 'transactions', 'admin_users'].forEach(t => {
  const c = db.prepare(`SELECT count(*) as c FROM ${t}`).get().c;
  console.log(`  ${t.padEnd(20)}: ${c}`);
});

db.close();
