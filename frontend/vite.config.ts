import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(frontendRoot, "..");

export default defineConfig({
  root: frontendRoot,
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(repoRoot, "shared/src")
    }
  },
  server: {
    port: 5173,
    fs: {
      allow: [repoRoot]
    },
    proxy: {
      "/api": "http://localhost:4000"
    }
  },
  build: {
    outDir: path.resolve(frontendRoot, "dist"),
    emptyOutDir: true
  }
});
