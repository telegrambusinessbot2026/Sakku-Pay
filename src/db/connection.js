/* ==============================================================================
   SakkuPay — Database Connection Module (PostgreSQL & SQLite Dual Driver)
   Supports managed PostgreSQL via 'pg' driver with SSL & connection pooling,
   as well as high-performance SQLite via 'node:sqlite' in WAL mode.
   Strictly validates persistent configuration in production environments.
   ============================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let pgModule = null;
try {
  pgModule = require('pg');
} catch {
  // pg is optional in local dev when DATABASE_URL is not set
}

function getResolvedDbPath() {
  return process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '../../sakkupay.db');
}

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
      '  1. DB_PATH: Absolute path to a mounted Render Persistent Disk (e.g., /var/data/sakkupay.db) [Recommended for current synchronous SQLite architecture]',
      '  2. DATABASE_URL: Managed PostgreSQL connection string (Requires completing async repository layer)',
      'Silent fallback to an unmounted, ephemeral database is strictly prohibited.'
    ].join('\n');
    console.error(errorMsg);
    throw new Error('Missing required persistent database configuration in production.');
  }

  if (isProduction && hasPersistentDisk && !hasDatabaseUrl) {
    const configuredPath = process.env.DB_PATH.trim();
    if (!path.isAbsolute(configuredPath)) {
      const errorMsg = [
        'CRITICAL [SakkuPay Production Database Validation Failed]:',
        `DB_PATH "${configuredPath}" is a relative path.`,
        'In production on Render, DB_PATH must be an absolute path pointing to a mounted persistent volume (e.g., /var/data/sakkupay.db).',
        'Relative paths reside on ephemeral container storage that resets on every redeployment.'
      ].join('\n');
      console.error(errorMsg);
      throw new Error('In production, DB_PATH must be an absolute path to a mounted persistent disk.');
    }
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

function createDatabaseConnection(customPath) {
  // Validate persistence configuration before opening or creating database
  validateDatabaseConfiguration();

  const isMemory = customPath === ':memory:';
  const targetPath = isMemory ? ':memory:' : (customPath ? path.resolve(customPath) : getResolvedDbPath());

  if (!isMemory) {
    const parentDir = path.dirname(targetPath);
    if (!fs.existsSync(parentDir)) {
      try {
        fs.mkdirSync(parentDir, { recursive: true });
      } catch (err) {
        console.error(`[SakkuPay Database] Failed to create database directory ${parentDir}:`, err.message);
        throw new Error(`Database directory not accessible: ${parentDir}`);
      }
    }
  }

  const db = new DatabaseSync(targetPath);

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
  getResolvedDbPath
};
