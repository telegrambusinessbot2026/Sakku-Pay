/* ==============================================================================
   SakkuPay — Database Connection Module (PostgreSQL & SQLite Dual Driver)
   Supports managed PostgreSQL via 'pg' driver with SSL & connection pooling,
   as well as high-performance SQLite via 'node:sqlite' in WAL mode.
   Strictly validates persistent configuration in production environments.
   ============================================================================== */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let pgModule = null;
try {
  pgModule = require('pg');
} catch {
  // pg is optional in local dev when DATABASE_URL is not set
}

const DEFAULT_DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../sakkupay.db');

/**
 * Validates database environment configuration for production safety.
 * Refuses to start on ephemeral container storage without persistent config.
 */
function validateDatabaseConfiguration() {
  const isProduction = process.env.NODE_ENV === 'production';
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
  const hasPersistentDisk = Boolean(process.env.DB_PATH && process.env.DB_PATH.trim());

  if (isProduction && !hasDatabaseUrl && !hasPersistentDisk) {
    const errorMsg = [
      'CRITICAL [SakkuPay Production Database Validation Failed]:',
      'Production deployment requires durable persistence to prevent data loss across container restarts.',
      'Configure either:',
      '  1. DATABASE_URL: Managed PostgreSQL connection string (Recommended for Render)',
      '  2. DB_PATH: Absolute path to a mounted Render Persistent Disk (e.g., /var/data/sakkupay.db)',
      'Silent fallback to an unmounted, ephemeral database is strictly prohibited.'
    ].join('\n');
    console.error(errorMsg);
    throw new Error('Missing required persistent database configuration in production.');
  }

  return {
    engine: hasDatabaseUrl ? 'postgres' : 'sqlite',
    isPersistent: isProduction ? (hasDatabaseUrl || hasPersistentDisk) : true
  };
}

let pgPoolInstance = null;

function getPostgresPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to create a PostgreSQL connection pool.');
  }

  if (!pgModule) {
    throw new Error('The "pg" package is required for PostgreSQL connections. Run: pnpm add pg');
  }

  if (!pgPoolInstance) {
    const isLocalhost = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
    pgPoolInstance = new pgModule.Pool({
      connectionString,
      ssl: isLocalhost ? false : { rejectUnauthorized: false }, // Standard cloud SSL mode (Render, Neon, AWS)
      max: Number(process.env.DB_POOL_MAX || 20),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    pgPoolInstance.on('error', (err) => {
      console.error('Unexpected PostgreSQL Pool Error:', err.message);
    });
  }

  return pgPoolInstance;
}

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

function getDatabaseEngine() {
  return process.env.DATABASE_URL ? 'postgres' : 'sqlite';
}

module.exports = {
  createDatabaseConnection,
  getDatabase,
  getPostgresPool,
  getDatabaseEngine,
  validateDatabaseConfiguration,
  DEFAULT_DB_PATH
};
