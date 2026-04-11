import { useMemo, useState } from "react";

import type { AnalysisResult, GraphNode } from "@shared/index";
import { formatCount } from "../lib/format";

interface ContributorViewProps {
  analysis: AnalysisResult | null;
  onFocusNode: (nodeId: string) => void;
}

interface ContributorEntry {
  name: string;
  email?: string;
  commits: number;
  nodeId?: string;
  filesChanged: string[];
  percentage: number;
}

export function ContributorView({ analysis, onFocusNode }: ContributorViewProps) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const contributors = useMemo(() => {
    if (!analysis) return [];

    const maxCommits = Math.max(
      1,
      ...analysis.summary.topContributors.map((c) => c.commits)
    );

    // Map contributor names to User node IDs
    const userNodes = new Map<string, string>();
    for (const node of analysis.graph.nodes) {
      if (node.type === "User") {
        userNodes.set(node.label.toLowerCase(), node.id);
      }
    }

    // Build per-contributor file lists from edges
    const contributorFiles = new Map<string, Set<string>>();
    for (const edge of analysis.graph.edges) {
      if (edge.type === "authored_by" || edge.type === "blamed_to") {
        const targetNode = analysis.graph.nodes.find((n) => n.id === edge.target);
        const sourceNode = analysis.graph.nodes.find((n) => n.id === edge.source);
        if (targetNode?.type === "User" && sourceNode) {
          const set = contributorFiles.get(targetNode.label) ?? new Set();
          if (sourceNode.type === "File" || sourceNode.type === "Commit") {
            set.add(sourceNode.label);
          }
          contributorFiles.set(targetNode.label, set);
        }
      }
    }

    const entries: ContributorEntry[] = analysis.summary.topContributors.map((c) => ({
      name: c.name,
      email: c.email,
      commits: c.commits,
      nodeId: userNodes.get(c.name.toLowerCase()),
      filesChanged: [...(contributorFiles.get(c.name) ?? [])],
      percentage: Math.round((c.commits / maxCommits) * 100),
    }));

    return entries;
  }, [analysis?.id]);

  const filtered = useMemo(() => {
    if (!search.trim()) return contributors;
    const q = search.toLowerCase();
    return contributors.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q)
    );
  }, [contributors, search]);

  const selectedContributor = selectedName
    ? contributors.find((c) => c.name === selectedName) ?? null
    : null;

  const totalCommits = contributors.reduce((sum, c) => sum + c.commits, 0);

  if (!analysis) {
    return (
      <section className="panel cv-panel">
        <div className="panel-title">Contributors</div>
        <p className="empty-state">Run an analysis to view contributors.</p>
      </section>
    );
  }

  if (contributors.length === 0) {
    return (
      <section className="panel cv-panel">
        <div className="panel-title">Contributors</div>
        <p className="empty-state">No git contributor data was found for this repository.</p>
      </section>
    );
  }

  return (
    <section className="panel cv-panel">
      <div className="cv-header">
        <div>
          <div className="panel-title">Contributors</div>
          <div className="fe-meta">
            {formatCount(contributors.length)} contributors &middot; {formatCount(totalCommits)} commits
          </div>
        </div>
      </div>

      <div className="cv-search">
        <input
          type="search"
          className="ie-search"
          placeholder="Filter contributors..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="cv-split">
        <div className="cv-list">
          {filtered.map((contributor, index) => (
            <button
              key={`${contributor.name}-${index}`}
              type="button"
              className={`cv-row ${selectedName === contributor.name ? "cv-row-selected" : ""}`}
              onClick={() => {
                setSelectedName(contributor.name);
                if (contributor.nodeId) onFocusNode(contributor.nodeId);
              }}
            >
              <div className="cv-row-info">
                <span className="cv-avatar">{contributor.name.charAt(0).toUpperCase()}</span>
                <div className="cv-row-text">
                  <span className="cv-row-name">{contributor.name}</span>
                  <span className="cv-row-email">{contributor.email ?? ""}</span>
                </div>
              </div>
              <div className="cv-row-stats">
                <span className="cv-row-commits">{formatCount(contributor.commits)}</span>
                <div className="cv-bar-track">
                  <div
                    className="cv-bar-fill"
                    style={{ width: `${contributor.percentage}%` }}
                  />
                </div>
              </div>
            </button>
          ))}
        </div>

        {selectedContributor && (
          <div className="cv-detail">
            <div className="cv-detail-header">
              <div className="cv-detail-avatar">{selectedContributor.name.charAt(0).toUpperCase()}</div>
              <div>
                <strong className="fe-detail-name">{selectedContributor.name}</strong>
                {selectedContributor.email && (
                  <div className="cv-detail-email">{selectedContributor.email}</div>
                )}
              </div>
            </div>

            <div className="stats-grid compact">
              <div className="stat-card">
                <strong>{formatCount(selectedContributor.commits)}</strong>
                <span>commits</span>
              </div>
              <div className="stat-card">
                <strong>{selectedContributor.percentage}%</strong>
                <span>of total</span>
              </div>
              <div className="stat-card">
                <strong>{formatCount(selectedContributor.filesChanged.length)}</strong>
                <span>files touched</span>
              </div>
              <div className="stat-card">
                <strong>#{filtered.indexOf(selectedContributor) + 1}</strong>
                <span>rank</span>
              </div>
            </div>

            {selectedContributor.filesChanged.length > 0 && (
              <div className="sidebar-section">
                <div className="section-title">Files Touched</div>
                <div className="list-stack">
                  {selectedContributor.filesChanged.slice(0, 15).map((file, i) => (
                    <div key={`${file}-${i}`} className="list-item static">
                      <span>{file}</span>
                    </div>
                  ))}
                  {selectedContributor.filesChanged.length > 15 && (
                    <p className="empty-state">+{selectedContributor.filesChanged.length - 15} more</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
