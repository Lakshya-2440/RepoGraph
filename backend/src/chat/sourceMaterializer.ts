import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AnalysisResult } from "../../../shared/src/index.js";

const execFileAsync = promisify(execFile);

export async function resolveAnalysisRootPath(analysis: AnalysisResult): Promise<string | null> {
  const current = analysis.summary.resolvedPath;
  try {
    await fs.access(current);
    return current;
  } catch {
    // fall through
  }

  if (analysis.summary.sourceType !== "github") {
    return null;
  }

  const parsed = parseGitHubSource(analysis.summary.source);
  if (!parsed) {
    return null;
  }

  const requestedRef = analysis.summary.ref;
  const rootPath = await cloneGitHubRepository(parsed.url, parsed.owner, parsed.repo, requestedRef);
  return rootPath;
}

function parseGitHubSource(source: string): { owner: string; repo: string; url: string } | null {
  const trimmed = source.trim();
  const match = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (!match) {
    return null;
  }

  const owner = match[1];
  const repo = match[2];
  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}.git`
  };
}

async function cloneGitHubRepository(url: string, owner: string, repo: string, requestedRef?: string): Promise<string> {
  const repoRoot = path.join(os.tmpdir(), "github-knowledge-graph-cache", "repos");
  const repoSlug = `${owner}__${repo}${requestedRef ? `__${requestedRef.replace(/[^\w.-]+/g, "_")}` : ""}`;
  const rootPath = path.join(repoRoot, repoSlug);

  await fs.mkdir(repoRoot, { recursive: true });

  const gitDir = path.join(rootPath, ".git");
  const hasGitDir = await exists(gitDir);

  if (!hasGitDir) {
    const args = ["clone", "--depth", "100"];
    if (requestedRef) {
      args.push("--branch", requestedRef, "--single-branch");
    }
    args.push(url, rootPath);
    await execFileAsync("git", args);
  } else {
    await execFileAsync("git", ["-C", rootPath, "fetch", "--depth", "100", "origin"]);
    if (requestedRef) {
      await execFileAsync("git", ["-C", rootPath, "checkout", requestedRef]);
      await execFileAsync("git", ["-C", rootPath, "pull", "--ff-only", "origin", requestedRef]);
    } else {
      await execFileAsync("git", ["-C", rootPath, "pull", "--ff-only"]);
    }
  }

  return rootPath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
