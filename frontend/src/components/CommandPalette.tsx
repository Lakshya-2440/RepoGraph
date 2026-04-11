import { useCallback, useEffect, useRef, useState } from "react";

import type { AnalysisResult, GraphNode } from "@shared/index";

interface CommandPaletteProps {
  analysis: AnalysisResult | null;
  onFocusNode: (nodeId: string) => void;
  onSwitchView: (view: string) => void;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  label: string;
  kind: "node" | "action" | "view";
  meta?: string;
  icon: string;
}

const VIEW_ACTIONS: PaletteItem[] = [
  { id: "view:graph", label: "Switch to Graph", kind: "view", meta: "View", icon: "\u25C9" },
  { id: "view:explorer", label: "Switch to Explorer", kind: "view", meta: "View", icon: "\u2263" },
  { id: "view:stats", label: "Switch to Analytics", kind: "view", meta: "View", icon: "\u2261" },
  { id: "view:insights", label: "Switch to Insights", kind: "view", meta: "View", icon: "\u26A0" },
  { id: "view:dependencies", label: "Switch to Dependencies", kind: "view", meta: "View", icon: "\u29BF" },
  { id: "view:contributors", label: "Switch to Contributors", kind: "view", meta: "View", icon: "\u2630" },
];

const STATIC_ACTIONS: PaletteItem[] = [
  { id: "action:export", label: "Export analysis as JSON", kind: "action", meta: "Action", icon: "\u21E9" },
];

function scoreMatch(label: string, path: string | undefined, query: string): number {
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  const p = (path ?? "").toLowerCase();
  if (l === q) return 100;
  if (l.startsWith(q)) return 80;
  if (p.endsWith(`/${q}`)) return 75;
  if (l.includes(q)) return 60;
  if (p.includes(q)) return 40;
  return 0;
}

export function CommandPalette({ analysis, onFocusNode, onSwitchView, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items: PaletteItem[] = (() => {
    const q = query.trim().toLowerCase();
    const results: PaletteItem[] = [];

    // Always show static actions / views if they match
    for (const action of [...VIEW_ACTIONS, ...STATIC_ACTIONS]) {
      if (!q || action.label.toLowerCase().includes(q)) {
        results.push(action);
      }
    }

    // Search nodes
    if (analysis && q.length > 0) {
      const scored = analysis.graph.nodes
        .map((node) => ({ node, score: scoreMatch(node.label, node.path, q) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 24);

      for (const { node } of scored) {
        results.push({
          id: `node:${node.id}`,
          label: node.label,
          kind: "node",
          meta: `${node.type}${node.path ? ` \u00B7 ${node.path}` : ""}`,
          icon: nodeIcon(node),
        });
      }
    } else if (analysis && q.length === 0) {
      // Show recently important nodes when no query
      const important = analysis.graph.nodes
        .filter((n) => n.type === "File" || n.type === "Function" || n.type === "Class")
        .sort((a, b) => (b.metrics?.inbound ?? 0) - (a.metrics?.inbound ?? 0))
        .slice(0, 8);

      for (const node of important) {
        results.push({
          id: `node:${node.id}`,
          label: node.label,
          kind: "node",
          meta: `${node.type}${node.path ? ` \u00B7 ${node.path}` : ""}`,
          icon: nodeIcon(node),
        });
      }
    }

    return results;
  })();

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      if (item.kind === "view") {
        onSwitchView(item.id.replace("view:", ""));
      } else if (item.kind === "node") {
        onFocusNode(item.id.replace("node:", ""));
      } else if (item.id === "action:export" && analysis) {
        const blob = new Blob([JSON.stringify(analysis, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${analysis.summary.repoName}-analysis.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
      onClose();
    },
    [analysis, onFocusNode, onSwitchView, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
      scrollToIndex(selectedIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      scrollToIndex(selectedIndex - 1);
    } else if (e.key === "Enter" && items[selectedIndex]) {
      handleSelect(items[selectedIndex]);
    }
  };

  const scrollToIndex = (index: number) => {
    const list = listRef.current;
    if (!list) return;
    const child = list.children[index] as HTMLElement | undefined;
    child?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="cp-backdrop" onClick={onClose}>
      <div className="cp-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="cp-input-row">
          <span className="cp-icon">/</span>
          <input
            ref={inputRef}
            className="cp-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search nodes, switch views, run actions..."
          />
          <kbd className="cp-kbd">esc</kbd>
        </div>

        <div className="cp-list" ref={listRef}>
          {items.length > 0 ? (
            items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`cp-item ${index === selectedIndex ? "cp-item-active" : ""}`}
                onClick={() => handleSelect(item)}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="cp-item-icon">{item.icon}</span>
                <div className="cp-item-body">
                  <span className="cp-item-label">{item.label}</span>
                  {item.meta && <span className="cp-item-meta">{item.meta}</span>}
                </div>
                <span className={`cp-item-kind cp-kind-${item.kind}`}>{item.kind}</span>
              </button>
            ))
          ) : (
            <div className="cp-empty">No results for &ldquo;{query}&rdquo;</div>
          )}
        </div>

        <div className="cp-footer">
          <span><kbd>\u2191</kbd><kbd>\u2193</kbd> navigate</span>
          <span><kbd>\u23CE</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function nodeIcon(node: GraphNode): string {
  switch (node.type) {
    case "File": return "\u25A1";
    case "Directory": return "\u25A3";
    case "Function": return "\u0192";
    case "Class": return "\u25C7";
    case "Method": return "\u25CB";
    case "Variable": return "x";
    case "Import": return "\u2192";
    case "Type": return "T";
    case "Package": return "\u25A8";
    case "Dependency": return "\u29BF";
    case "Commit": return "\u25CF";
    case "User": return "\u263A";
    default: return "\u25AA";
  }
}
