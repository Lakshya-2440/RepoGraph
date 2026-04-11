import type { NodeDetailResponse } from "@shared/index";

import { formatCount, formatDate, formatRelativeDate, truncate } from "../lib/format";

interface NodePanelProps {
  details: NodeDetailResponse | null;
  loading: boolean;
  onFocusNode: (nodeId: string) => void;
}

export function NodePanel({ details, loading, onFocusNode }: NodePanelProps) {
  if (loading) {
    return (
      <aside className="panel node-panel">
        <div className="panel-title">Node Inspector</div>
        <div className="empty-state">Loading node details...</div>
      </aside>
    );
  }

  if (!details) {
    return (
      <aside className="panel node-panel">
        <div className="panel-title">Node Inspector</div>
        <div className="empty-state">Select a node in the graph to inspect its attributes, edges, and insights.</div>
      </aside>
    );
  }

  const { node } = details;

  return (
    <aside className="panel node-panel">
      <div className="panel-title">Node Inspector</div>
      <div className="node-heading">
        <div>
          <div className="node-type">{node.type}</div>
          <h2>{node.label}</h2>
        </div>
        <div className="status-pill">{node.metrics?.inbound ?? 0} in</div>
      </div>

      <div className="node-path">{node.path ?? "No filesystem path"}</div>

      <div className="stats-grid compact">
        <div className="stat-card">
          <strong>{formatCount(node.metrics?.outbound ?? 0)}</strong>
          <span>outbound</span>
        </div>
        <div className="stat-card">
          <strong>{formatCount(node.metrics?.commits ?? 0)}</strong>
          <span>commits</span>
        </div>
        <div className="stat-card">
          <strong>{formatDate(node.metrics?.lastTouchedAt)}</strong>
          <span>last touched</span>
        </div>
        <div className="stat-card">
          <strong>{formatRelativeDate(node.metrics?.lastTouchedAt)}</strong>
          <span>activity</span>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="section-title">Insights</div>
        {details.insights.length > 0 ? (
          details.insights.map((insight) => (
            <div key={insight.id} className={`insight-card ${insight.kind}`}>
              <strong>{insight.title}</strong>
              <span>{insight.message}</span>
            </div>
          ))
        ) : (
          <p className="empty-state">No extra insights were attached to this node.</p>
        )}
      </div>

      <div className="sidebar-section">
        <div className="section-title">Connections</div>
        <div className="list-stack">
          {details.neighbors.length > 0 ? (
            details.neighbors.slice(0, 10).map((neighbor) => (
              <button
                type="button"
                key={neighbor.id}
                className="list-item"
                onClick={() => onFocusNode(neighbor.id)}
              >
                <span>{neighbor.label}</span>
                <small>{neighbor.type}</small>
              </button>
            ))
          ) : (
            <p className="empty-state">This node has no adjacent nodes in the current graph.</p>
          )}
        </div>
      </div>

      <div className="sidebar-section">
        <div className="section-title">Inbound edges</div>
        <div className="list-stack">
          {details.inbound.length > 0 ? (
            details.inbound.slice(0, 8).map((edge) => (
              <div key={edge.id} className="list-item static">
                <span>{edge.type}</span>
                <small>{truncate(edge.source, 36)}</small>
              </div>
            ))
          ) : (
            <p className="empty-state">No inbound edges.</p>
          )}
        </div>
      </div>

      <div className="sidebar-section">
        <div className="section-title">Outbound edges</div>
        <div className="list-stack">
          {details.outbound.length > 0 ? (
            details.outbound.slice(0, 8).map((edge) => (
              <div key={edge.id} className="list-item static">
                <span>{edge.type}</span>
                <small>{truncate(edge.target, 36)}</small>
              </div>
            ))
          ) : (
            <p className="empty-state">No outbound edges.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
