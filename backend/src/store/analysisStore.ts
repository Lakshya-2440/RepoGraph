import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AnalysisResult } from "../../../shared/src/index.js";

const DATA_FILE = path.join(os.tmpdir(), "github-knowledge-graph-cache", "current-analysis.json");

let currentAnalysis: AnalysisResult | null = null;
let runningAnalysis: Promise<AnalysisResult> | null = null;

export async function loadStoredAnalysis(): Promise<void> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    currentAnalysis = JSON.parse(raw) as AnalysisResult;
  } catch {
    currentAnalysis = null;
  }
}

export function getCurrentAnalysis(): AnalysisResult | null {
  return currentAnalysis;
}

export function isAnalysisRunning(): boolean {
  return Boolean(runningAnalysis);
}

export async function setCurrentAnalysis(analysis: AnalysisResult): Promise<void> {
  currentAnalysis = analysis;
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(analysis, null, 2), "utf8");
}

export async function runAnalysis(task: () => Promise<AnalysisResult>): Promise<AnalysisResult> {
  if (!runningAnalysis) {
    runningAnalysis = task()
      .then(async (analysis) => {
        await setCurrentAnalysis(analysis);
        return analysis;
      })
      .finally(() => {
        runningAnalysis = null;
      });
  }

  return runningAnalysis;
}
