/* ==============================================================================
   SakkuPay Staging Backup & Restore Verification Test
   Executes online atomic backup and verifies restoration integrity.
   Runs strictly against staging database only.
   ============================================================================== */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const STAGING_DB_PATH = path.join(__dirname, 'sakkupay_staging.db');
const BACKUP_PATH = path.join(__dirname, 'backups', 'sakkupay_staging_backup.db');
const RESTORED_PATH = path.join(__dirname, 'backups', 'sakkupay_staging_restored.db');

console.log('========================================================================');
console.log('STAGING DATABASE BACKUP & RESTORE INTEGRITY TEST');
console.log('========================================================================');

// 1. Clean previous backup artifacts if present
if (fs.existsSync(BACKUP_PATH)) fs.unlinkSync(BACKUP_PATH);
if (fs.existsSync(RESTORED_PATH)) fs.unlinkSync(RESTORED_PATH);

// 2. Open live staging DB and perform atomic online backup via VACUUM INTO
console.log('\n--- 1. Performing Atomic Online Backup via VACUUM INTO ---');
const liveDb = new DatabaseSync(STAGING_DB_PATH, { readOnly: true });

// Check live counts before backup
const liveMerchants = liveDb.prepare('SELECT count(*) as c FROM merchants').get().c;
const liveTxs = liveDb.prepare('SELECT count(*) as c FROM transactions').get().c;
const liveAdmins = liveDb.prepare('SELECT count(*) as c FROM admin_users').get().c;
console.log(`  Live Staging Source Counts: merchants=${liveMerchants}, transactions=${liveTxs}, admin_users=${liveAdmins}`);

// Perform backup
const backupDb = new DatabaseSync(STAGING_DB_PATH);
backupDb.exec(`VACUUM INTO '${BACKUP_PATH.replace(/\\/g, '/')}';`);
backupDb.close();
liveDb.close();

console.log(`  ✅ Online backup created at: ${BACKUP_PATH} (size: ${fs.statSync(BACKUP_PATH).size} bytes)`);

// 3. Test Restore Simulation
console.log('\n--- 2. Simulating Restore to Clean Target ---');
fs.copyFileSync(BACKUP_PATH, RESTORED_PATH);
console.log(`  Restored copy placed at: ${RESTORED_PATH}`);

const restoredDb = new DatabaseSync(RESTORED_PATH, { readOnly: true });

// 4. Verify Integrity and Parity
console.log('\n--- 3. Verifying Restored Database Integrity ---');
const integrity = restoredDb.prepare('PRAGMA integrity_check;').all();
console.log(`  PRAGMA integrity_check: ${integrity[0]?.integrity_check || 'ok'}`);
if (integrity[0]?.integrity_check !== 'ok') {
  throw new Error('Restored database failed integrity check!');
}

const fkCheck = restoredDb.prepare('PRAGMA foreign_key_check;').all();
console.log(`  PRAGMA foreign_key_check violations: ${fkCheck.length}`);
if (fkCheck.length > 0) {
  throw new Error('Restored database has foreign key violations!');
}

const restoredMerchants = restoredDb.prepare('SELECT count(*) as c FROM merchants').get().c;
const restoredTxs = restoredDb.prepare('SELECT count(*) as c FROM transactions').get().c;
const restoredAdmins = restoredDb.prepare('SELECT count(*) as c FROM admin_users').get().c;

console.log(`  Restored Entity Counts: merchants=${restoredMerchants}, transactions=${restoredTxs}, admin_users=${restoredAdmins}`);

if (liveMerchants !== restoredMerchants || liveTxs !== restoredTxs || liveAdmins !== restoredAdmins) {
  throw new Error('Entity count mismatch between live staging and restored database!');
}

console.log('  ✅ PASSED: 100% entity and integrity parity confirmed between staging and restored backup.');
restoredDb.close();
