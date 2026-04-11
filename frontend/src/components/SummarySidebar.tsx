import { useMemo } from "react";

import type { AnalysisResult } from "@shared/index";

import { formatCount } from "../lib/format";

interface SummarySidebarProps {
  analysis: AnalysisResult | null;
  onFocusNode: (nodeId: string) => void;
}

function computeHealthScore(analysis: AnalysisResult): { score: number; grade: string; color: string } {
  let score = 70; // base score

  const { counts } = analysis.summary;
  const totalInsights = Object.values(analysis.insights).reduce((sum, arr) => sum + arr.length, 0);
  const warnings = Object.values(analysis.insights)
    .flat()
    .filter((i) => i.kind === "warning").length;

  // Positive signals
  if (counts.commits > 10) score += 5;
  if (counts.commits > 50) score += 5;
  if (analysis.summary.topContributors.length > 1) score += 5;
  if (counts.functions > 0) score += 3;
  if (counts.dependencies > 0 && counts.dependencies < 100) score += 4;
  if (analysis.summary.narratives.length > 0) score += 3;

  // Negative signals
  if (warnings > 5) score -= 8;
  if (warnings > 15) score -= 7;
  if (counts.dependencies > 100) score -= 5;
  if (analysis.summary.alerts.length > 3) score -= 5;
  if (counts.files === 0) score -= 15;

  score = Math.max(0, Math.min(100, score));

  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
  const color = score >= 80 ? "#0f766e" : score >= 60 ? "#f59e0b" : "#ef4444";

  return { score, grade, color };
}

export function SummarySidebar({ analysis, onFocusNode }: SummarySidebarProps) {
  if (!analysis) {
    return (
      <aside className="panel sidebar">
        <div className="panel-title">Repo Summary</div>
        <p className="empty-state">Run an analysis to populate the dashboard, narratives, and alerts.</p>
      </aside>
    );
  }

  const { summary } = analysis;
  const health = useMemo(() => computeHealthScore(analysis), [analysis.id]);

  return (
    <aside className="panel sidebar">
      <div className="panel-title">Repo Summary</div>
      <div className="summary-name">{summary.repoName}</div>
      <div className="summary-meta">
        <span>{summary.sourceType === "github" ? "GitHub source" : "Local source"}</span>
        {summary.ref ? <span>Ref: {summary.ref}</span> : null}
      </div>

      <div className="health-score-widget">
        <div className="health-ring" style={{ "--health-color": health.color, "--health-pct": `${health.score}%` } as React.CSSProperties}>
          <span className="health-grade">{health.grade}</span>
        </div>
        <div className="health-info">
          <strong>{health.score}/100</strong>
          <span>Health Score</span>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <strong>{formatCount(summary.counts.nodes)}</strong>
          <span>nodes</span>
        </div>
        <div className="stat-card">
          <strong>{formatCount(summary.counts.edges)}</strong>
          <span>edges</span>
        </div>
        <div className="stat-card">
          <strong>{formatCount(summary.counts.files)}</strong>
          <span>files</span>
        </div>
        <div className="stat-card">
          <strong>{formatCount(summary.counts.dependencies)}</strong>
          <span>dependencies</span>
        </div>
      </div>

      {summary.github ? (
        <div className="sidebar-section">
          <div className="section-title">GitHub</div>
          <div className="badge-row">
            <span className="status-pill">{formatCount(summary.github.stars)} stars</span>
            <span className="status-pill">{formatCount(summary.github.openIssues)} open issues</span>
            <span className="status-pill">{summary.github.defaultBranch}</span>
          </div>
        </div>
      ) : null}

      <div className="sidebar-section">
        <div className="section-title">Alerts</div>
        {summary.alerts.length > 0 ? (
          summary.alerts.map((alert) => (
            <div key={alert} className="alert-card">
              {alert}
            </div>
          ))
        ) : (
          <p className="empty-state">No high-signal alerts were generated for this run.</p>
        )}
      </div>

      <div className="sidebar-section">
        <div className="section-title">Narratives</div>
        <div className="narrative-list">
          {summary.narratives.map((narrative) => (
            <button
              type="button"
              key={narrative.id}
              className="narrative-card"
              onClick={() => narrative.nodeIds[0] && onFocusNode(narrative.nodeIds[0])}
            >
              <strong>{narrative.title}</strong>
              <span>{narrative.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-section">
        <div className="section-title">Top Directories</div>
        <div className="list-stack">
          {summary.topDirectories.length > 0 ? (
            summary.topDirectories.map((directory) => (
              <button
                type="button"
                key={directory.id}
                className="list-item"
                onClick={() => onFocusNode(directory.id)}
              >
                <span>{directory.label}</span>
                <small>{formatCount(directory.children)} children</small>
              </button>
            ))
          ) : (
            <p className="empty-state">No directory hierarchy was extracted.</p>
          )}
        </div>
      </div>

      <div className="sidebar-section">
        <div className="section-title">Top Contributors</div>
        <div className="list-stack">
          {summary.topContributors.length > 0 ? (
            summary.topContributors.map((contributor) => (
              <div key={`${contributor.email ?? contributor.name}:${contributor.commits}`} className="list-item static">
                <span>{contributor.name}</span>
                <small>{formatCount(contributor.commits)} commits</small>
              </div>
            ))
          ) : (
            <p className="empty-state">No git contributor history was found for this source.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
