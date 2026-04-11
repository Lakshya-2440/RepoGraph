import { useState, useMemo, useEffect } from "react";

import type { AnalysisResult, GraphNode } from "@shared/index";
import { formatCount } from "../lib/format";
import { fetchFileContent } from "../lib/api";

interface FileExplorerProps {
  analysis: AnalysisResult | null;
  onFocusNode: (nodeId: string) => void;
}

interface TreeNode {
  node: GraphNode;
  children: TreeNode[];
  depth: number;
}

function buildFileTree(analysis: AnalysisResult): TreeNode[] {
  const nodeMap = new Map<string, GraphNode>();
  const childrenMap = new Map<string, GraphNode[]>();

  for (const node of analysis.graph.nodes) {
    if (node.type !== "Directory" && node.type !== "File") continue;
    nodeMap.set(node.id, node);

    if (node.parentId) {
      const siblings = childrenMap.get(node.parentId) ?? [];
      siblings.push(node);
      childrenMap.set(node.parentId, siblings);
    }
  }

  function buildSubtree(nodeId: string, depth: number): TreeNode | null {
    const node = nodeMap.get(nodeId);
    if (!node) return null;

    const childNodes = childrenMap.get(nodeId) ?? [];
    childNodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "Directory" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    return {
      node,
      depth,
      children: childNodes
        .map((child) => buildSubtree(child.id, depth + 1))
        .filter((child): child is TreeNode => child !== null)
    };
  }

  const rootNodes = analysis.graph.nodes.filter(
    (n) => (n.type === "Directory" || n.type === "File") && !n.parentId
  );

  if (rootNodes.length === 0) {
    const repoNode = analysis.graph.nodes.find((n) => n.type === "Repo");
    if (repoNode) {
      const topLevel = childrenMap.get(repoNode.id) ?? [];
      return topLevel
        .map((child) => buildSubtree(child.id, 0))
        .filter((t): t is TreeNode => t !== null);
    }
  }

  return rootNodes
    .map((n) => buildSubtree(n.id, 0))
    .filter((t): t is TreeNode => t !== null);
}

function FileTreeItem({
  treeNode,
  expandedIds,
  toggleExpand,
  selectedId,
  onSelect,
  insightCounts
}: {
  treeNode: TreeNode;
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  insightCounts: Record<string, number>;
}) {
  const { node, children } = treeNode;
  const isDir = node.type === "Directory";
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedId === node.id;
  const insightCount = insightCounts[node.id] ?? 0;

  return (
    <div className="fe-tree-item">
      <button
        type="button"
        className={`fe-tree-row ${isSelected ? "fe-tree-selected" : ""}`}
        style={{ paddingLeft: `${16 + treeNode.depth * 18}px` }}
        onClick={() => {
          if (isDir) toggleExpand(node.id);
          onSelect(node.id);
        }}
      >
        <span className="fe-tree-icon">
          {isDir ? (isExpanded ? "\u25BE" : "\u25B8") : "\u25AA"}
        </span>
        <span className="fe-tree-label">{node.label}</span>
        {insightCount > 0 && <span className="fe-tree-badge">{insightCount}</span>}
        {isDir && children.length > 0 && (
          <span className="fe-tree-count">{children.length}</span>
        )}
      </button>
      {isDir && isExpanded && (
        <div className="fe-tree-children">
          {children.map((child) => (
            <FileTreeItem
              key={child.node.id}
              treeNode={child}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              selectedId={selectedId}
              onSelect={onSelect}
              insightCounts={insightCounts}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ analysis, onFocusNode }: FileExplorerProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [fileContent, setFileContent] = useState<{ content: string; language: string } | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [showContent, setShowContent] = useState(false);

  const tree = useMemo(() => (analysis ? buildFileTree(analysis) : []), [analysis?.id]);

  const insightCounts = useMemo(() => {
    if (!analysis) return {};
    const counts: Record<string, number> = {};
    for (const [nodeId, insights] of Object.entries(analysis.insights)) {
      counts[nodeId] = insights.length;
    }
    return counts;
  }, [analysis?.id]);

  const selectedNode = useMemo(() => {
    if (!selectedId || !analysis) return null;
    return analysis.graph.nodes.find((n) => n.id === selectedId) ?? null;
  }, [selectedId, analysis?.id]);

  const selectedInsights = useMemo(() => {
    if (!selectedId || !analysis) return [];
    return analysis.insights[selectedId] ?? [];
  }, [selectedId, analysis?.id]);

  const selectedEdges = useMemo(() => {
    if (!selectedId || !analysis) return { inbound: 0, outbound: 0 };
    let inbound = 0;
    let outbound = 0;
    for (const edge of analysis.graph.edges) {
      if (edge.target === selectedId) inbound++;
      if (edge.source === selectedId) outbound++;
    }
    return { inbound, outbound };
  }, [selectedId, analysis?.id]);

  const filteredTree = useMemo(() => {
    if (!searchQuery.trim()) return tree;
    const q = searchQuery.toLowerCase();

    function filterNode(treeNode: TreeNode): TreeNode | null {
      const matches = treeNode.node.label.toLowerCase().includes(q);
      const filteredChildren = treeNode.children
        .map((child) => filterNode(child))
        .filter((child): child is TreeNode => child !== null);

      if (matches || filteredChildren.length > 0) {
        return { ...treeNode, children: filteredChildren };
      }
      return null;
    }

    return tree
      .map((t) => filterNode(t))
      .filter((t): t is TreeNode => t !== null);
  }, [tree, searchQuery]);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setShowContent(false);
    setFileContent(null);
    onFocusNode(id);
  };

  const handleViewContent = () => {
    if (!selectedNode?.path || selectedNode.type !== "File") return;
    setLoadingContent(true);
    setShowContent(true);
    fetchFileContent(selectedNode.path)
      .then((result) => setFileContent(result))
      .catch(() => setFileContent({ content: "// Failed to load file content", language: "plaintext" }))
      .finally(() => setLoadingContent(false));
  };

  if (!analysis) {
    return (
      <section className="panel fe-panel">
        <div className="panel-title">File Explorer</div>
        <p className="empty-state">Run an analysis to browse the file tree.</p>
      </section>
    );
  }

  const fileCount = analysis.graph.nodes.filter((n) => n.type === "File").length;
  const dirCount = analysis.graph.nodes.filter((n) => n.type === "Directory").length;

  return (
    <section className="panel fe-panel">
      <div className="fe-header">
        <div>
          <div className="panel-title">File Explorer</div>
          <div className="fe-meta">
            {formatCount(fileCount)} files &middot; {formatCount(dirCount)} directories
          </div>
        </div>
        <div className="fe-actions">
          <button
            type="button"
            className="graph-toggle"
            onClick={() => {
              const allDirIds = new Set(
                analysis.graph.nodes.filter((n) => n.type === "Directory").map((n) => n.id)
              );
              setExpandedIds((prev) => (prev.size > 0 ? new Set() : allDirIds));
            }}
          >
            {expandedIds.size > 0 ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </div>

      <div className="fe-search">
        <input
          type="search"
          placeholder="Filter files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="fe-split">
        <div className="fe-tree-pane">
          {filteredTree.length > 0 ? (
            filteredTree.map((treeNode) => (
              <FileTreeItem
                key={treeNode.node.id}
                treeNode={treeNode}
                expandedIds={expandedIds}
                toggleExpand={toggleExpand}
                selectedId={selectedId}
                onSelect={handleSelect}
                insightCounts={insightCounts}
              />
            ))
          ) : (
            <p className="empty-state">No files match the filter.</p>
          )}
        </div>

        {selectedNode && (
          <div className="fe-detail-pane">
            <div className="fe-detail-header">
              <span className="node-type">{selectedNode.type}</span>
              <strong className="fe-detail-name">{selectedNode.label}</strong>
            </div>
            {selectedNode.path && <div className="node-path">{selectedNode.path}</div>}

            <div className="stats-grid compact">
              <div className="stat-card">
                <strong>{formatCount(selectedEdges.inbound)}</strong>
                <span>inbound</span>
              </div>
              <div className="stat-card">
                <strong>{formatCount(selectedEdges.outbound)}</strong>
                <span>outbound</span>
              </div>
              <div className="stat-card">
                <strong>{formatCount(selectedNode.metrics?.commits ?? 0)}</strong>
                <span>commits</span>
              </div>
              <div className="stat-card">
                <strong>{selectedNode.metrics?.size ? formatCount(selectedNode.metrics.size) : "\u2014"}</strong>
                <span>bytes</span>
              </div>
            </div>

            {selectedInsights.length > 0 && (
              <div className="sidebar-section">
                <div className="section-title">Insights</div>
                {selectedInsights.map((insight) => (
                  <div key={insight.id} className={`insight-card ${insight.kind}`}>
                    <strong>{insight.title}</strong>
                    <span>{insight.message}</span>
                  </div>
                ))}
              </div>
            )}

            {selectedNode.type === "File" && selectedNode.path && (
              <div className="sidebar-section">
                {!showContent ? (
                  <button type="button" className="graph-toggle fe-view-btn" onClick={handleViewContent}>
                    View source
                  </button>
                ) : loadingContent ? (
                  <div className="fe-code-loading">Loading file content...</div>
                ) : fileContent ? (
                  <div className="fe-code-block">
                    <div className="fe-code-header">
                      <span className="fe-code-lang">{fileContent.language}</span>
                      <button
                        type="button"
                        className="graph-toggle"
                        onClick={() => setShowContent(false)}
                        style={{ fontSize: "0.7rem", padding: "5px 10px" }}
                      >
                        Close
                      </button>
                    </div>
                    <pre className="fe-code-pre"><code>{fileContent.content}</code></pre>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
