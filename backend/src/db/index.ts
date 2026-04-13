import { Pool } from "pg";
import type { PoolConfig } from "pg";

import { loadEnvironment } from "../config/env.js";

let pool: Pool | null = null;
let initialized = false;

export function getDbPool(): Pool {
  loadEnvironment(true);

  if (!pool) {
    const rawConnectionString = process.env.DATABASE_URL;
    if (!rawConnectionString) {
      throw new Error("DATABASE_URL is required. Configure Neon connection string in environment.");
    }

    const ssl = resolveSslConfig(rawConnectionString);
    const connectionString = normalizeConnectionString(rawConnectionString);

    pool = new Pool({
      connectionString,
      ssl
    });
  }

  return pool;
}

function shouldUseSsl(connectionString: string): boolean {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return true;
  }

  const host = url.hostname.toLowerCase();
  return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local"));
}

function resolveSslConfig(connectionString: string): PoolConfig["ssl"] {
  if (!shouldUseSsl(connectionString)) {
    return false;
  }

  let url: URL | null = null;
  try {
    url = new URL(connectionString);
  } catch {
    // Keep strict validation when parsing fails.
    return { rejectUnauthorized: true };
  }

  const sslMode = (url.searchParams.get("sslmode") ?? "").toLowerCase();

  // Align behavior with libpq expectations:
  // - require/prefer/allow = TLS without CA validation
  // - verify-ca/verify-full = strict CA validation
  // - disable = no TLS
  if (sslMode === "disable") {
    return false;
  }

  if (sslMode === "verify-ca" || sslMode === "verify-full") {
    return { rejectUnauthorized: true };
  }

  if (sslMode === "require" || sslMode === "prefer" || sslMode === "allow") {
    return { rejectUnauthorized: false };
  }

  // Secure default when sslmode is absent.
  return { rejectUnauthorized: true };
}

function normalizeConnectionString(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  // We control SSL via the explicit `ssl` Pool option above.
  // Remove SSL-related URL params to avoid pg parser overrides.
  const sslParams = [
    "ssl",
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "sslcrl"
  ];

  for (const key of sslParams) {
    url.searchParams.delete(key);
  }

  return url.toString();
}

export async function initializeDatabase(): Promise<void> {
  if (initialized) {
    return;
  }

  const db = getDbPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS analysis_runs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      analysis_id TEXT NOT NULL,
      source TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_analysis_runs_user_created
    ON analysis_runs(user_id, created_at DESC);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_events (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_events_user_type_created
    ON ai_events(user_id, event_type, created_at DESC);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tokens_hash
    ON auth_tokens(token_hash);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_purpose
    ON auth_tokens(user_id, purpose, created_at DESC);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_login_attempts (
      attempt_key TEXT PRIMARY KEY,
      failed_count INTEGER NOT NULL DEFAULT 0,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_until TIMESTAMPTZ
    );
  `);

  initialized = true;
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    initialized = false;
  }
}
