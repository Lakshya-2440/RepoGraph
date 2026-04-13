import { existsSync } from "node:fs";
import path from "node:path";

import { config as dotenvConfig } from "dotenv";

let loaded = false;

export function loadEnvironment(force = false): void {
  if (loaded && !force) {
    return;
  }

  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "backend/.env"),
    path.resolve(cwd, "../.env")
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) {
      continue;
    }

    dotenvConfig({ path: envPath, override: true });
  }

  loaded = true;
}

export function validateProductionEnvironment(): void {
  const isProduction = (process.env.NODE_ENV ?? "").toLowerCase() === "production";
  if (!isProduction) {
    return;
  }

  const required = ["DATABASE_URL", "JWT_SECRET", "CORS_ORIGIN", "APP_BASE_URL"];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }

  const jwtSecret = process.env.JWT_SECRET ?? "";
  if (jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters in production.");
  }

  const baseUrl = process.env.APP_BASE_URL ?? "";
  if (!baseUrl.startsWith("https://")) {
    throw new Error("APP_BASE_URL must use https:// in production.");
  }

  const corsOrigins = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const invalidOrigins = corsOrigins.filter((origin) => !origin.startsWith("https://"));
  if (invalidOrigins.length > 0) {
    throw new Error("CORS_ORIGIN must contain only https:// origins in production.");
  }
}
