import { useMemo, useState } from "react";

import type { AnalysisResult } from "@shared/index";
import { formatCount } from "../lib/format";
import { fetchAiCodeOriginEstimate } from "../lib/api";

interface StatsViewProps {
  analysis: AnalysisResult | null;
}

interface BarItem {
  label: string;
  value: number;
  color: string;
}

const NODE_COLORS: Record<string, string> = {
  Repo: "#ff6b2c",
  Directory: "#0f766e",
  File: "#174a72",
  Function: "#d45500",
  Method: "#f59e0b",
  Class: "#8b5cf6",
  Variable: "#8b5e34",
  Import: "#f97316",
  Type: "#14b8a6",
  Package: "#2563eb",
  Dependency: "#ef4444",
  Commit: "#64748b",
  User: "#22c55e",
  Issue: "#dc2626",
  PullRequest: "#16a34a",
  Comment: "#7c2d12"
};

const EDGE_COLORS: Record<string, string> = {
  contains: "#0f766e",
  parent_of: "#14b8a6",
  imports: "#f97316",
  calls: "#d45500",
  inherits: "#8b5cf6",
  references: "#f59e0b",
  defines: "#174a72",
  depends_on: "#ef4444",
  dev_depends_on: "#dc2626",
  authored_by: "#22c55e",
  changed_in: "#64748b",
  blamed_to: "#6b7280",
  opened_by: "#16a34a",
  assignee: "#2563eb",
  fixes: "#ff6b2c",
  reviewed_by: "#0f766e",
  comment_on: "#7c2d12",
  related_to: "#8b5e34",
  implements: "#14b8a6",
  similar_to: "#f59e0b"
};

function HorizontalBar({ items, maxValue }: { items: BarItem[]; maxValue: number }) {
  return (
    <div className="sv-bar-list">
      {items.map((item) => (
        <div key={item.label} className="sv-bar-row">
          <div className="sv-bar-label">
            <span className="sv-bar-dot" style={{ backgroundColor: item.color }} />
            <span>{item.label}</span>
          </div>
          <div className="sv-bar-track">
            <div
              className="sv-bar-fill"
              style={{
                width: `${Math.max(2, (item.value / maxValue) * 100)}%`,
                backgroundColor: item.color
              }}
            />
          </div>
          <span className="sv-bar-value">{formatCount(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function StatsView({ analysis }: StatsViewProps) {
  const [aiOriginLoading, setAiOriginLoading] = useState(false);
  const [aiOriginError, setAiOriginError] = useState<string | null>(null);
  const [aiOriginResult, setAiOriginResult] = useState<{
    estimatedAiGeneratedPercent: number;
    confidence: number;
    summary: string;
    signals: string[];
    model: string;
  } | null>(null);

  const nodeDistribution = useMemo(() => {
    if (!analysis) return [];
    const counts = new Map<string, number>();
    for (const node of analysis.graph.nodes) {
      counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({
        label: type,
        value: count,
        color: NODE_COLORS[type] ?? "#6b7280"
      }));
  }, [analysis?.id]);

  const edgeDistribution = useMemo(() => {
    if (!analysis) return [];
    const counts = new Map<string, number>();
    for (const edge of analysis.graph.edges) {
      counts.set(edge.type, (counts.get(edge.type) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({
        label: type,
        value: count,
        color: EDGE_COLORS[type] ?? "#6b7280"
      }));
  }, [analysis?.id]);

  const fileExtensions = useMemo(() => {
    if (!analysis) return [];
    const counts = new Map<string, number>();
    for (const node of analysis.graph.nodes) {
      if (node.type !== "File") continue;
      const ext = node.label.includes(".") ? node.label.split(".").pop() ?? "other" : "no ext";
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([ext, count], i) => ({
        label: `.${ext}`,
        value: count,
        color: `hsl(${(i * 30 + 20) % 360}, 55%, 55%)`
      }));
  }, [analysis?.id]);

  const topFilesByInbound = useMemo(() => {
    if (!analysis) return [];
    return analysis.graph.nodes
      .filter((n) => n.type === "File" && (n.metrics?.inbound ?? 0) > 0)
      .sort((a, b) => (b.metrics?.inbound ?? 0) - (a.metrics?.inbound ?? 0))
      .slice(0, 10)
      .map((n) => ({
        label: n.label,
        value: n.metrics?.inbound ?? 0,
        color: "#174a72"
      }));
  }, [analysis?.id]);

  const topFilesByCommits = useMemo(() => {
    if (!analysis) return [];
    return analysis.graph.nodes
      .filter((n) => n.type === "File" && (n.metrics?.commits ?? 0) > 0)
      .sort((a, b) => (b.metrics?.commits ?? 0) - (a.metrics?.commits ?? 0))
      .slice(0, 10)
      .map((n) => ({
        label: n.label,
        value: n.metrics?.commits ?? 0,
        color: "#64748b"
      }));
  }, [analysis?.id]);

  const insightBreakdown = useMemo(() => {
    if (!analysis) return { info: 0, warning: 0, success: 0, total: 0 };
    let info = 0;
    let warning = 0;
    let success = 0;
    for (const insights of Object.values(analysis.insights)) {
      for (const insight of insights) {
        if (insight.kind === "info") info++;
        else if (insight.kind === "warning") warning++;
        else success++;
      }
    }
    return { info, warning, success, total: info + warning + success };
  }, [analysis?.id]);

  if (!analysis) {
    return (
      <section className="panel sv-panel">
        <div className="panel-title">Analytics</div>
        <p className="empty-state">Run an analysis to view repository statistics.</p>
      </section>
    );
  }

  const { summary } = analysis;

  const runAiCodeOriginEstimate = async () => {
    setAiOriginError(null);
    setAiOriginLoading(true);

    try {
      const result = await fetchAiCodeOriginEstimate();
      setAiOriginResult(result);
    } catch (caughtError) {
      setAiOriginError(caughtError instanceof Error ? caughtError.message : "Failed to estimate AI-generated code ratio.");
    } finally {
      setAiOriginLoading(false);
    }
  };

  return (
    <section className="panel sv-panel">
      <div className="panel-title">Analytics Dashboard</div>

      <div className="sv-overview">
        <div className="sv-overview-card sv-card-accent">
          <strong>{formatCount(summary.counts.nodes)}</strong>
          <span>Total Nodes</span>
        </div>
        <div className="sv-overview-card">
          <strong>{formatCount(summary.counts.edges)}</strong>
          <span>Total Edges</span>
        </div>
        <div className="sv-overview-card">
          <strong>{formatCount(summary.counts.files)}</strong>
          <span>Files</span>
        </div>
        <div className="sv-overview-card">
          <strong>{formatCount(summary.counts.functions)}</strong>
          <span>Functions</span>
        </div>
        <div className="sv-overview-card">
          <strong>{formatCount(summary.counts.dependencies)}</strong>
          <span>Dependencies</span>
        </div>
        <div className="sv-overview-card">
          <strong>{formatCount(summary.counts.commits)}</strong>
          <span>Commits</span>
        </div>
        <div className="sv-overview-card">
          <strong>{formatCount(insightBreakdown.total)}</strong>
          <span>Insights</span>
        </div>
        <div className="sv-overview-card">
          <strong>{formatCount(summary.counts.directories)}</strong>
          <span>Directories</span>
        </div>
      </div>

      <div className="sv-grid">
        <div className="sv-card">
          <div className="section-title">Node Distribution</div>
          <HorizontalBar
            items={nodeDistribution}
            maxValue={nodeDistribution[0]?.value ?? 1}
          />
        </div>

        <div className="sv-card">
          <div className="section-title">Edge Distribution</div>
          <HorizontalBar
            items={edgeDistribution.slice(0, 10)}
            maxValue={edgeDistribution[0]?.value ?? 1}
          />
        </div>

        <div className="sv-card">
          <div className="section-title">File Extensions</div>
          <HorizontalBar
            items={fileExtensions}
            maxValue={fileExtensions[0]?.value ?? 1}
          />
        </div>

        <div className="sv-card">
          <div className="section-title">Insight Breakdown</div>
          <div className="sv-insight-summary">
            <div className="sv-insight-item sv-insight-warning">
              <strong>{formatCount(insightBreakdown.warning)}</strong>
              <span>warnings</span>
            </div>
            <div className="sv-insight-item sv-insight-info">
              <strong>{formatCount(insightBreakdown.info)}</strong>
              <span>info</span>
            </div>
            <div className="sv-insight-item sv-insight-success">
              <strong>{formatCount(insightBreakdown.success)}</strong>
              <span>success</span>
            </div>
          </div>
        </div>

        <div className="sv-card">
          <div className="section-title">Most Connected Files</div>
          <HorizontalBar
            items={topFilesByInbound}
            maxValue={topFilesByInbound[0]?.value ?? 1}
          />
        </div>

        <div className="sv-card">
          <div className="section-title">Most Active Files (by commits)</div>
          <HorizontalBar
            items={topFilesByCommits}
            maxValue={topFilesByCommits[0]?.value ?? 1}
          />
        </div>

        <div className="sv-card">
          <div className="section-title">Commit Ownership (who did how many)</div>
          <div className="list-stack">
            {summary.topContributors.length > 0 ? (
              summary.topContributors.slice(0, 12).map((contributor, index) => (
                <div key={`${contributor.name}-${index}`} className="list-item static">
                  <span>
                    {contributor.name}
                    {contributor.email ? ` (${contributor.email})` : ""}
                  </span>
                  <small>{formatCount(contributor.commits)} commits</small>
                </div>
              ))
            ) : (
              <p className="empty-state">No contributor commit data available.</p>
            )}
          </div>
        </div>

        <div className="sv-card">
          <div className="section-title">AI-generated Code Estimate</div>
          <button type="button" className="graph-toggle" onClick={() => void runAiCodeOriginEstimate()} disabled={aiOriginLoading}>
            {aiOriginLoading ? "Analyzing..." : "Estimate with AI"}
          </button>

          {aiOriginError ? <p className="empty-state" style={{ color: "var(--danger)" }}>{aiOriginError}</p> : null}

          {aiOriginResult ? (
            <div className="sv-ai-origin">
              <div className="stats-grid compact">
                <div className="stat-card">
                  <strong>{aiOriginResult.estimatedAiGeneratedPercent}%</strong>
                  <span>estimated AI-generated</span>
                </div>
                <div className="stat-card">
                  <strong>{aiOriginResult.confidence}%</strong>
                  <span>confidence</span>
                </div>
              </div>

              <p className="empty-state" style={{ marginTop: "8px" }}>{aiOriginResult.summary}</p>

              <div className="list-stack">
                {aiOriginResult.signals.map((signal, index) => (
                  <div key={`${signal}-${index}`} className="list-item static">
                    <span>{signal}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
