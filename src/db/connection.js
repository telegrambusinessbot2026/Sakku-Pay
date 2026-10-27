/* ==============================================================================
   SakkuPay — SQLite Database Connection Module
   Uses Node.js v22+ built-in node:sqlite with WAL mode and foreign keys.
   ============================================================================== */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../sakkupay.db');

function createDatabaseConnection(dbPath = DEFAULT_DB_PATH) {
  const db = new DatabaseSync(dbPath);

  // WAL mode for concurrent reads while writing, foreign keys for referential integrity
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  return db;
}

let defaultDbInstance = null;

function getDatabase(customPath) {
  if (customPath) {
    return createDatabaseConnection(customPath);
  }
  if (!defaultDbInstance) {
    defaultDbInstance = createDatabaseConnection();
  }
  return defaultDbInstance;
}

module.exports = {
  createDatabaseConnection,
  getDatabase,
  DEFAULT_DB_PATH
};
