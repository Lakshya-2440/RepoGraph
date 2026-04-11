import { useMemo, useState } from "react";

import type { AnalysisResult, GraphEdge, GraphNode } from "@shared/index";
import { formatCount } from "../lib/format";

interface DependencyTreeProps {
  analysis: AnalysisResult | null;
  onFocusNode: (nodeId: string) => void;
}

interface DepEntry {
  node: GraphNode;
  kind: "production" | "dev";
  dependants: number;
  importedBy: string[];
}

export function DependencyTree({ analysis, onFocusNode }: DependencyTreeProps) {
  const [filter, setFilter] = useState<"all" | "production" | "dev">("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const deps = useMemo(() => {
    if (!analysis) return [];

    const depNodes = analysis.graph.nodes.filter(
      (n) => n.type === "Dependency" || n.type === "Package"
    );

    const edgesByTarget = new Map<string, GraphEdge[]>();
    for (const edge of analysis.graph.edges) {
      if (edge.type === "depends_on" || edge.type === "dev_depends_on") {
        const list = edgesByTarget.get(edge.target) ?? [];
        list.push(edge);
        edgesByTarget.set(edge.target, list);
      }
    }

    const importEdges = new Map<string, string[]>();
    for (const edge of analysis.graph.edges) {
      if (edge.type === "imports") {
        const list = importEdges.get(edge.target) ?? [];
        const sourceNode = analysis.graph.nodes.find((n) => n.id === edge.source);
        if (sourceNode) list.push(sourceNode.label);
        importEdges.set(edge.target, list);
      }
    }

    const entries: DepEntry[] = depNodes.map((node) => {
      const incomingEdges = edgesByTarget.get(node.id) ?? [];
      const hasDevEdge = incomingEdges.some((e) => e.type === "dev_depends_on");
      const hasProdEdge = incomingEdges.some((e) => e.type === "depends_on");
      const kind: "production" | "dev" = hasProdEdge ? "production" : hasDevEdge ? "dev" : "production";

      return {
        node,
        kind,
        dependants: incomingEdges.length,
        importedBy: importEdges.get(node.id) ?? [],
      };
    });

    entries.sort((a, b) => b.dependants - a.dependants || a.node.label.localeCompare(b.node.label));
    return entries;
  }, [analysis?.id]);

  const filtered = useMemo(() => {
    let list = deps;
    if (filter !== "all") list = list.filter((d) => d.kind === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((d) => d.node.label.toLowerCase().includes(q));
    }
    return list;
  }, [deps, filter, search]);

  const selectedDep = selectedId ? deps.find((d) => d.node.id === selectedId) ?? null : null;
  const prodCount = deps.filter((d) => d.kind === "production").length;
  const devCount = deps.filter((d) => d.kind === "dev").length;

  if (!analysis) {
    return (
      <section className="panel dt-panel">
        <div className="panel-title">Dependencies</div>
        <p className="empty-state">Run an analysis to view dependencies.</p>
      </section>
    );
  }

  return (
    <section className="panel dt-panel">
      <div className="dt-header">
        <div>
          <div className="panel-title">Dependencies</div>
          <div className="fe-meta">
            {formatCount(deps.length)} total &middot; {formatCount(prodCount)} prod &middot; {formatCount(devCount)} dev
          </div>
        </div>
      </div>

      <div className="dt-controls">
        <div className="ie-filters">
          {(["all", "production", "dev"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`graph-filter-chip ${filter === f ? "active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "production" ? "Production" : "Dev"}
              <small>{f === "all" ? deps.length : f === "production" ? prodCount : devCount}</small>
            </button>
          ))}
        </div>
        <input
          type="search"
          className="ie-search"
          placeholder="Filter dependencies..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="dt-split">
        <div className="dt-list">
          {filtered.length > 0 ? (
            filtered.map((dep) => (
              <button
                key={dep.node.id}
                type="button"
                className={`dt-row ${selectedId === dep.node.id ? "dt-row-selected" : ""}`}
                onClick={() => {
                  setSelectedId(dep.node.id);
                  onFocusNode(dep.node.id);
                }}
              >
                <span className={`dt-kind-dot ${dep.kind === "dev" ? "dt-kind-dev" : "dt-kind-prod"}`} />
                <span className="dt-row-label">{dep.node.label}</span>
                <span className="dt-row-count">{dep.dependants}</span>
              </button>
            ))
          ) : (
            <p className="empty-state">No dependencies match the filter.</p>
          )}
        </div>

        {selectedDep && (
          <div className="dt-detail">
            <div className="fe-detail-header">
              <span className="node-type">{selectedDep.node.type}</span>
              <strong className="fe-detail-name">{selectedDep.node.label}</strong>
            </div>

            <div className="stats-grid compact">
              <div className="stat-card">
                <strong>{selectedDep.kind}</strong>
                <span>kind</span>
              </div>
              <div className="stat-card">
                <strong>{formatCount(selectedDep.dependants)}</strong>
                <span>dependants</span>
              </div>
              <div className="stat-card">
                <strong>{formatCount(selectedDep.importedBy.length)}</strong>
                <span>imported by</span>
              </div>
              <div className="stat-card">
                <strong>{formatCount(selectedDep.node.metrics?.outbound ?? 0)}</strong>
                <span>outbound</span>
              </div>
            </div>

            {selectedDep.importedBy.length > 0 && (
              <div className="sidebar-section">
                <div className="section-title">Imported By</div>
                <div className="list-stack">
                  {selectedDep.importedBy.slice(0, 12).map((file, i) => (
                    <div key={`${file}-${i}`} className="list-item static">
                      <span>{file}</span>
                    </div>
                  ))}
                  {selectedDep.importedBy.length > 12 && (
                    <p className="empty-state">+{selectedDep.importedBy.length - 12} more</p>
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
