import type { AnalysisResult } from "../../../shared/src/index.js";
import { getDbPool } from "../db/index.js";

const currentAnalysisByUser = new Map<number, AnalysisResult>();
const runningAnalysisByUser = new Map<number, Promise<AnalysisResult>>();

export async function loadStoredAnalysis(): Promise<void> {
  // No-op: analyses are loaded per-user on demand from DB.
}

export async function getCurrentAnalysis(userId: number): Promise<AnalysisResult | null> {
  const cached = currentAnalysisByUser.get(userId);
  if (cached) {
    return cached;
  }

  const db = getDbPool();
  const result = await db.query<{ payload: AnalysisResult }>(
    `
      SELECT payload
      FROM analysis_runs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [userId]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const analysis = row.payload;
  currentAnalysisByUser.set(userId, analysis);
  return analysis;
}

export function isAnalysisRunning(userId: number): boolean {
  return runningAnalysisByUser.has(userId);
}

export async function hasAnalysisForUser(userId: number): Promise<boolean> {
  if (currentAnalysisByUser.has(userId)) {
    return true;
  }

  const db = getDbPool();
  const result = await db.query<{ exists: boolean }>(
    `
      SELECT EXISTS(
        SELECT 1
        FROM analysis_runs
        WHERE user_id = $1
      ) AS exists
    `,
    [userId]
  );

  return result.rows[0]?.exists === true;
}

export async function setCurrentAnalysis(userId: number, analysis: AnalysisResult): Promise<void> {
  currentAnalysisByUser.set(userId, analysis);

  const db = getDbPool();
  await db.query(
    `
      INSERT INTO analysis_runs(user_id, analysis_id, source, payload)
      VALUES($1, $2, $3, $4::jsonb)
    `,
    [userId, analysis.id, analysis.summary.source, JSON.stringify(analysis)]
  );
}

export async function runAnalysis(userId: number, task: () => Promise<AnalysisResult>): Promise<AnalysisResult> {
  const existing = runningAnalysisByUser.get(userId);
  if (existing) {
    return existing;
  }

  const running = task()
      .then(async (analysis) => {
        await setCurrentAnalysis(userId, analysis);
        return analysis;
      })
      .finally(() => {
        runningAnalysisByUser.delete(userId);
      });

  runningAnalysisByUser.set(userId, running);
  return running;
}
