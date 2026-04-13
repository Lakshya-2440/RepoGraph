import bcrypt from "bcryptjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";

import type { AuthUser } from "../../shared/src/index.js";
import { loadEnvironment } from "./config/env.js";
import { getDbPool } from "./db/index.js";
import { getClientIp, logSecurityEvent } from "./logging/security.js";

const PASSWORD_MIN_LENGTH = 8;
const EMAIL_VERIFICATION_TOKEN_TTL_HOURS = 24;
const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MINUTES = 15;

export class AuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: string | null;
  created_at: string;
}

interface AttemptRow {
  failed_count: number;
  window_started_at: string;
  locked_until: string | null;
}

let googleClient: OAuth2Client | null = null;

function getAllowedGoogleClientIds(): string[] {
  loadEnvironment(true);

  const values = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_IDS
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set(values));
}

function isGoogleAudienceStrict(): boolean {
  return (process.env.GOOGLE_AUTH_STRICT_AUDIENCE ?? "").trim().toLowerCase() === "true";
}

export async function registerUser(emailRaw: string, password: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  validateCredentials(email, password);

  const db = getDbPool();
  const passwordHash = await bcrypt.hash(password, 12);

  let userId: number | null = null;
  try {
    const result = await db.query<{ id: string }>(
      `
        INSERT INTO users(email, password_hash, email_verified_at)
        VALUES($1, $2, NULL)
        RETURNING id
      `,
      [email, passwordHash]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create user.");
    }
    userId = Number(row.id);
  } catch (error) {
    if (isDuplicateEmailError(error)) {
      throw new AuthError("Account already in use", 409);
    }

    throw error;
  }

  if (!userId) {
    throw new Error("Failed to create user.");
  }

  await createAndDispatchAuthToken({
    userId,
    email,
    purpose: "verify_email",
    ttlMs: EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000
  });
}

export async function loginUser(emailRaw: string, password: string, attemptKey: string): Promise<AuthUser> {
  const email = normalizeEmail(emailRaw);
  validateCredentials(email, password, false);

  await assertLoginNotRateLimited(attemptKey);

  const db = getDbPool();
  const result = await db.query<UserRow>(
    `
      SELECT id, email, password_hash, email_verified_at, created_at
      FROM users
      WHERE email = $1
      LIMIT 1
    `,
    [email]
  );

  const user = result.rows[0];
  if (!user) {
    await registerFailedLoginAttempt(attemptKey);
    throw new Error("Invalid email or password.");
  }

  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) {
    await registerFailedLoginAttempt(attemptKey);
    throw new Error("Invalid email or password.");
  }

  if (!user.email_verified_at) {
    throw new AuthError("Please verify your email before signing in.", 403);
  }

  await clearLoginAttempts(attemptKey);

  return {
    id: Number(user.id),
    email: user.email,
    createdAt: user.created_at
  };
}

export async function verifyEmailByToken(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  const db = getDbPool();

  await db.query("BEGIN");
  try {
    const tokenResult = await db.query<{ id: string; user_id: string; expires_at: string; consumed_at: string | null }>(
      `
        SELECT id, user_id, expires_at, consumed_at
        FROM auth_tokens
        WHERE token_hash = $1
          AND purpose = 'verify_email'
        LIMIT 1
      `,
      [tokenHash]
    );

    const tokenRow = tokenResult.rows[0];
    if (!tokenRow || tokenRow.consumed_at || new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      throw new Error("Verification token is invalid or expired.");
    }

    await db.query(
      `
        UPDATE users
        SET email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $1
      `,
      [tokenRow.user_id]
    );

    await db.query(
      `
        UPDATE auth_tokens
        SET consumed_at = now()
        WHERE id = $1
      `,
      [tokenRow.id]
    );

    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function requestPasswordReset(emailRaw: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return;
  }

  const db = getDbPool();
  const result = await db.query<{ id: string; email: string }>(
    `
      SELECT id, email
      FROM users
      WHERE email = $1
      LIMIT 1
    `,
    [email]
  );

  const user = result.rows[0];
  if (!user) {
    return;
  }

  const verification = await db.query<{ email_verified_at: string | null }>(
    `
      SELECT email_verified_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [user.id]
  );
  if (!verification.rows[0]?.email_verified_at) {
    return;
  }

  await createAndDispatchAuthToken({
    userId: Number(user.id),
    email: user.email,
    purpose: "password_reset",
    ttlMs: PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000
  });
}

export async function resetPasswordByToken(rawToken: string, newPassword: string): Promise<void> {
  validateCredentials("placeholder@example.com", newPassword);
  const tokenHash = hashToken(rawToken);
  const db = getDbPool();

  await db.query("BEGIN");
  try {
    const tokenResult = await db.query<{ id: string; user_id: string; expires_at: string; consumed_at: string | null }>(
      `
        SELECT id, user_id, expires_at, consumed_at
        FROM auth_tokens
        WHERE token_hash = $1
          AND purpose = 'password_reset'
        LIMIT 1
      `,
      [tokenHash]
    );

    const tokenRow = tokenResult.rows[0];
    if (!tokenRow || tokenRow.consumed_at || new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      throw new Error("Password reset token is invalid or expired.");
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      `
        UPDATE users
        SET password_hash = $1
        WHERE id = $2
      `,
      [passwordHash, tokenRow.user_id]
    );

    await db.query(
      `
        UPDATE auth_tokens
        SET consumed_at = now()
        WHERE user_id = $1
          AND purpose = 'password_reset'
          AND consumed_at IS NULL
      `,
      [tokenRow.user_id]
    );

    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function loginOrRegisterWithGoogle(idToken: string): Promise<AuthUser> {
  const email = await verifyGoogleIdToken(idToken);
  const db = getDbPool();

  const existing = await db.query<{ id: string; email: string; created_at: string }>(
    `
      SELECT id, email, created_at
      FROM users
      WHERE email = $1
      LIMIT 1
    `,
    [email]
  );

  const row = existing.rows[0];
  if (row) {
    await db.query(
      `
        UPDATE users
        SET email_verified_at = COALESCE(email_verified_at, now())
        WHERE id = $1
      `,
      [row.id]
    );

    return {
      id: Number(row.id),
      email: row.email,
      createdAt: row.created_at
    };
  }

  // Random high-entropy placeholder hash: password auth is not used for Google-created users.
  const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
  const inserted = await db.query<{ id: string; email: string; created_at: string }>(
    `
      INSERT INTO users(email, password_hash, email_verified_at)
      VALUES($1, $2, now())
      RETURNING id, email, created_at
    `,
    [email, passwordHash]
  );

  const user = inserted.rows[0];
  if (!user) {
    throw new Error("Failed to create Google user account.");
  }

  return {
    id: Number(user.id),
    email: user.email,
    createdAt: user.created_at
  };
}

export function issueAuthToken(user: AuthUser): string {
  loadEnvironment(true);
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required in environment.");
  }

  const configuredExpiry = process.env.JWT_EXPIRES_IN;
  const expiresIn: jwt.SignOptions["expiresIn"] = configuredExpiry
    ? Number.isFinite(Number(configuredExpiry))
      ? Number(configuredExpiry)
      : (configuredExpiry as jwt.SignOptions["expiresIn"])
    : "12h";
  const issuer = process.env.JWT_ISSUER?.trim() || "repograph-auth";
  const audience = process.env.JWT_AUDIENCE?.trim() || "repograph-client";

  return jwt.sign(
    { email: user.email },
    secret,
    {
      algorithm: "HS256",
      expiresIn,
      issuer,
      audience,
      subject: String(user.id),
      jwtid: randomUUID()
    }
  );
}

function isDuplicateEmailError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const pgError = error as { code?: string; constraint?: string };
  return pgError.code === "23505" && pgError.constraint === "users_email_key";
}

export async function getUserById(userId: number): Promise<AuthUser | null> {
  const db = getDbPool();
  const result = await db.query<{ id: string; email: string; created_at: string }>(
    `
      SELECT id, email, created_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [userId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    email: row.email,
    createdAt: row.created_at
  };
}

export async function requireAuth(request: AuthedRequest, response: Response, next: NextFunction): Promise<void> {
  try {
    loadEnvironment(true);
    const secret = process.env.JWT_SECRET;
    const issuer = process.env.JWT_ISSUER?.trim() || "repograph-auth";
    const audience = process.env.JWT_AUDIENCE?.trim() || "repograph-client";
    if (!secret) {
      response.status(500).json({ error: "JWT_SECRET is not configured." });
      return;
    }

    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      logSecurityEvent("auth_guard_denied", {
        ip: getClientIp(request),
        method: request.method,
        path: request.path,
        reason: "missing_bearer_token"
      });
      response.status(401).json({ error: "Authentication required." });
      return;
    }

    const token = header.slice("Bearer ".length).trim();
    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer,
      audience
    }) as jwt.JwtPayload;
    const userId = Number(decoded.sub);

    if (!Number.isFinite(userId) || userId <= 0) {
      response.status(401).json({ error: "Invalid auth token." });
      return;
    }

    const user = await getUserById(userId);
    if (!user) {
      logSecurityEvent("auth_guard_denied", {
        ip: getClientIp(request),
        method: request.method,
        path: request.path,
        reason: "unknown_user"
      });
      response.status(401).json({ error: "User no longer exists." });
      return;
    }

    request.user = user;
    next();
  } catch (error) {
    logSecurityEvent("auth_guard_failed", {
      ip: getClientIp(request),
      method: request.method,
      path: request.path,
      reason: error instanceof Error ? error.message : "invalid_or_expired_token"
    });
    response.status(401).json({ error: "Invalid or expired auth token." });
  }
}

export function getLoginAttemptKey(request: Request, emailRaw: string): string {
  const email = normalizeEmail(emailRaw);
  const rawIp =
    (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    request.socket.remoteAddress ||
    "unknown";

  return `${rawIp.toLowerCase()}::${email}`;
}

export async function requestEmailVerification(emailRaw: string): Promise<void> {
  const email = normalizeEmail(emailRaw);
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return;
  }

  const db = getDbPool();
  const result = await db.query<{ id: string; email: string; email_verified_at: string | null }>(
    `
      SELECT id, email, email_verified_at
      FROM users
      WHERE email = $1
      LIMIT 1
    `,
    [email]
  );

  const user = result.rows[0];
  if (!user || user.email_verified_at) {
    return;
  }

  await createAndDispatchAuthToken({
    userId: Number(user.id),
    email: user.email,
    purpose: "verify_email",
    ttlMs: EMAIL_VERIFICATION_TOKEN_TTL_HOURS * 60 * 60 * 1000
  });
}

async function createAndDispatchAuthToken(options: {
  userId: number;
  email: string;
  purpose: "verify_email" | "password_reset";
  ttlMs: number;
}): Promise<void> {
  const db = getDbPool();
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + options.ttlMs).toISOString();

  await db.query(
    `
      DELETE FROM auth_tokens
      WHERE user_id = $1
        AND purpose = $2
        AND consumed_at IS NULL
    `,
    [options.userId, options.purpose]
  );

  await db.query(
    `
      INSERT INTO auth_tokens(user_id, purpose, token_hash, expires_at)
      VALUES($1, $2, $3, $4)
    `,
    [options.userId, options.purpose, tokenHash, expiresAt]
  );

  await dispatchAuthEmail(options.email, options.purpose, rawToken);
}

async function verifyGoogleIdToken(idToken: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) {
    throw new Error("Invalid Google credential token.");
  }

  const allowedClientIds = getAllowedGoogleClientIds();

  if (!googleClient) {
    googleClient = new OAuth2Client();
  }

  let ticket;
  if (allowedClientIds.length > 0) {
    try {
      // Verify against configured audiences first for the strongest guarantee.
      ticket = await googleClient.verifyIdToken({
        idToken,
        audience: allowedClientIds
      });
    } catch (error) {
      if (isGoogleAudienceStrict()) {
        throw new Error("Google token audience is not allowed for this backend.");
      }

      // Compatibility fallback for production misconfiguration:
      // still verify signature/claims, then perform permissive audience handling below.
      logSecurityEvent("google_auth_audience_verify_failed_fallback", {
        allowedClientIds,
        reason: error instanceof Error ? error.message : "unknown_verify_error"
      });
      ticket = await googleClient.verifyIdToken({ idToken });
    }
  } else {
    // No configured audience: verify cryptographic claims only.
    ticket = await googleClient.verifyIdToken({ idToken });
  }

  const payload = ticket.getPayload();
  const email = payload?.email?.trim().toLowerCase();
  const emailVerified = payload?.email_verified === true;
  if (!email || !emailVerified) {
    throw new Error("Google account email is missing or unverified.");
  }

  const aud = typeof payload?.aud === "string" ? payload.aud : undefined;
  const azp = typeof payload?.azp === "string" ? payload.azp : undefined;
  const audienceMatches =
    allowedClientIds.length === 0 ||
    (typeof aud === "string" && allowedClientIds.includes(aud)) ||
    (typeof azp === "string" && allowedClientIds.includes(azp));

  if (!audienceMatches) {
    if (isGoogleAudienceStrict()) {
      throw new Error("Google token audience is not allowed for this backend.");
    }

    logSecurityEvent("google_auth_audience_mismatch_permitted", {
      aud,
      azp,
      allowedClientIds
    });
  }

  return email;
}

async function dispatchAuthEmail(email: string, purpose: "verify_email" | "password_reset", token: string): Promise<void> {
  loadEnvironment(true);
  const pathName = purpose === "verify_email" ? "/verify-email" : "/reset-password";
  const tokenFingerprint = hashToken(token).slice(0, 12);

  // In production integrate a provider (SES, SendGrid, etc.).
  // Never log raw tokens; fingerprint helps correlation without exposing credentials.
  console.log(`[auth-email] purpose=${purpose} to=${email} path=${pathName} tokenFingerprint=${tokenFingerprint}`);
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

async function assertLoginNotRateLimited(attemptKey: string): Promise<void> {
  const db = getDbPool();
  const result = await db.query<AttemptRow>(
    `
      SELECT failed_count, window_started_at, locked_until
      FROM auth_login_attempts
      WHERE attempt_key = $1
      LIMIT 1
    `,
    [attemptKey]
  );

  const row = result.rows[0];
  if (!row || !row.locked_until) {
    return;
  }

  if (new Date(row.locked_until).getTime() > Date.now()) {
    throw new Error("Too many login attempts. Please try again later.");
  }
}

async function registerFailedLoginAttempt(attemptKey: string): Promise<void> {
  const db = getDbPool();
  const now = Date.now();
  const result = await db.query<AttemptRow>(
    `
      SELECT failed_count, window_started_at, locked_until
      FROM auth_login_attempts
      WHERE attempt_key = $1
      LIMIT 1
    `,
    [attemptKey]
  );

  const row = result.rows[0];
  if (!row) {
    await db.query(
      `
        INSERT INTO auth_login_attempts(attempt_key, failed_count, window_started_at, locked_until)
        VALUES($1, 1, now(), NULL)
      `,
      [attemptKey]
    );
    return;
  }

  const windowAgeMs = now - new Date(row.window_started_at).getTime();
  const isOutsideWindow = windowAgeMs > LOGIN_WINDOW_MINUTES * 60 * 1000;
  const failedCount = isOutsideWindow ? 1 : row.failed_count + 1;
  const lockUntil = failedCount >= LOGIN_MAX_ATTEMPTS
    ? new Date(now + LOGIN_LOCK_MINUTES * 60 * 1000).toISOString()
    : null;

  await db.query(
    `
      UPDATE auth_login_attempts
      SET failed_count = $2,
          window_started_at = CASE WHEN $3 THEN now() ELSE window_started_at END,
          locked_until = $4
      WHERE attempt_key = $1
    `,
    [attemptKey, failedCount, isOutsideWindow, lockUntil]
  );
}

async function clearLoginAttempts(attemptKey: string): Promise<void> {
  const db = getDbPool();
  await db.query(
    `
      DELETE FROM auth_login_attempts
      WHERE attempt_key = $1
    `,
    [attemptKey]
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateCredentials(email: string, password: string, validatePasswordLength = true): void {
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error("Valid email is required.");
  }

  if (!password) {
    throw new Error("Password is required.");
  }

  if (validatePasswordLength && password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
}
