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
