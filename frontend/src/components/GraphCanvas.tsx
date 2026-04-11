import { useEffect, useRef, useState } from "react";

import ForceGraph2D from "react-force-graph-2d";

import type { AnalysisResult, GraphEdge, GraphNode } from "@shared/index";

type VisualNode = GraphNode & {
  fx?: number;
  fy?: number;
  x?: number;
  y?: number;
  insightCount: number;
};

type VisualLink = Omit<GraphEdge, "source" | "target"> & {
  source: string | VisualNode;
  target: string | VisualNode;
};

interface GraphCanvasProps {
  analysis: AnalysisResult | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
  revealOnAnalyzeNonce: number;
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

const LEGEND_ITEMS = [
  { type: "File", label: "files" },
  { type: "Function", label: "code symbols" },
  { type: "Dependency", label: "dependencies" },
  { type: "Commit", label: "git + GitHub" }
];

export function GraphCanvas({ analysis, selectedNodeId, onSelectNode, onClearSelection, revealOnAnalyzeNonce }: GraphCanvasProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<any>(null);
  const canAutoFocusSelectionRef = useRef(false);
  const previousAnalysisIdRef = useRef<string | null>(null);
  const lastAnimatedAnalyzeNonceRef = useRef(0);
  const revealIntervalRef = useRef<number | null>(null);
  const revealStartedAtRef = useRef<Map<string, number>>(new Map());
  const [dimensions, setDimensions] = useState({ width: 800, height: 640 });
  const [graphData, setGraphData] = useState<{ nodes: VisualNode[]; links: VisualLink[] }>({
    nodes: [],
    links: []
  });
  const [revealedNodeIds, setRevealedNodeIds] = useState<Set<string>>(new Set());
  const [hiddenTypes, setHiddenTypes] = useState<string[]>([]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredLinkId, setHoveredLinkId] = useState<string | null>(null);
  const [pointerPosition, setPointerPosition] = useState({ x: 32, y: 32 });
  const [spotlightMode, setSpotlightMode] = useState(false);
  const [showAllLabels, setShowAllLabels] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);

  const typeCounts = analysis ? collectTypeCounts(analysis.graph.nodes) : [];
  const hoveredNode = hoveredNodeId ? graphData.nodes.find((node) => node.id === hoveredNodeId) ?? null : null;
  const hoveredLink = hoveredLinkId ? graphData.links.find((link) => link.id === hoveredLinkId) ?? null : null;
  const activeContext = buildActiveContext(graphData.links, selectedNodeId, hoveredNodeId);
  const pinnedCount = graphData.nodes.filter(
    (node) => typeof node.fx === "number" || typeof node.fy === "number"
  ).length;
  const visibleNodeCount = graphData.nodes.length;
  const visibleLinkCount = graphData.links.length;

  useEffect(() => {
    if (!frameRef.current) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setDimensions({
        width: Math.max(320, Math.floor(entry.contentRect.width)),
        height: Math.max(420, Math.floor(entry.contentRect.height))
      });
    });

    observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!analysis) {
      setGraphData({ nodes: [], links: [] });
      setRevealedNodeIds(new Set());
      setHiddenTypes([]);
      setHoveredNodeId(null);
      setHoveredLinkId(null);
      previousAnalysisIdRef.current = null;
      if (revealIntervalRef.current !== null) {
        window.clearInterval(revealIntervalRef.current);
        revealIntervalRef.current = null;
      }
      revealStartedAtRef.current.clear();
      return;
    }

    const hidden = new Set(hiddenTypes);
    const visibleNodes = analysis.graph.nodes
      .filter((node) => node.type === "Repo" || !hidden.has(node.type))
      .map((node) => ({
        ...node,
        insightCount: analysis.insights[node.id]?.length ?? 0
      }));
    const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
    const visibleLinks = analysis.graph.edges
      .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
      .map((edge) => ({ ...edge }));

    setGraphData({
      nodes: visibleNodes,
      links: visibleLinks
    });
    setHoveredNodeId(null);
    setHoveredLinkId(null);
  }, [analysis?.id, hiddenTypes.join("|")]);

  useEffect(() => {
    if (revealIntervalRef.current !== null) {
      window.clearInterval(revealIntervalRef.current);
      revealIntervalRef.current = null;
    }

    if (!analysis || graphData.nodes.length === 0) {
      setRevealedNodeIds(new Set());
      revealStartedAtRef.current.clear();
      return;
    }

    const isNewAnalysis = previousAnalysisIdRef.current !== analysis.id;
    previousAnalysisIdRef.current = analysis.id;
    const shouldAnimateForThisAnalysis =
      isNewAnalysis && revealOnAnalyzeNonce > lastAnimatedAnalyzeNonceRef.current;

    if (!shouldAnimateForThisAnalysis) {
      const now = Date.now();
      const revealMap = new Map<string, number>();
      const revealed = new Set<string>();
      for (const node of graphData.nodes) {
        revealMap.set(node.id, now);
        revealed.add(node.id);
      }
      revealStartedAtRef.current = revealMap;
      setRevealedNodeIds(revealed);
      return;
    }

    lastAnimatedAnalyzeNonceRef.current = revealOnAnalyzeNonce;

    const sequence = buildNodeRevealSequence(graphData.nodes, graphData.links);
    if (sequence.length === 0) {
      setRevealedNodeIds(new Set());
      revealStartedAtRef.current.clear();
      return;
    }

    revealStartedAtRef.current.clear();
    setRevealedNodeIds(new Set());

    let cursor = 0;
    const batchSize = 1;

    const revealBatch = () => {
      const now = Date.now();
      setRevealedNodeIds((current) => {
        const next = new Set(current);
        for (let index = 0; index < batchSize && cursor < sequence.length; index += 1) {
          const nodeId = sequence[cursor];
          cursor += 1;
          if (!next.has(nodeId)) {
            next.add(nodeId);
            revealStartedAtRef.current.set(nodeId, now);
          }
        }
        return next;
      });

      if (cursor >= sequence.length && revealIntervalRef.current !== null) {
        window.clearInterval(revealIntervalRef.current);
        revealIntervalRef.current = null;
      }
    };

    revealBatch();
    revealIntervalRef.current = window.setInterval(revealBatch, 24);

    return () => {
      if (revealIntervalRef.current !== null) {
        window.clearInterval(revealIntervalRef.current);
        revealIntervalRef.current = null;
      }
    };
  }, [analysis?.id, graphData.nodes, graphData.links, revealOnAnalyzeNonce]);

  useEffect(() => {
    if (!selectedNodeId) {
      return;
    }

    if (!graphData.nodes.some((node) => node.id === selectedNodeId)) {
      onClearSelection();
    }
  }, [selectedNodeId, graphData.nodes.length]);

  useEffect(() => {
    if (!graphRef.current || graphData.nodes.length === 0) {
      return;
    }

    canAutoFocusSelectionRef.current = false;
    graphRef.current.d3ReheatSimulation?.();
    const timer = window.setTimeout(() => {
      graphRef.current?.zoomToFit(900, 76);
      canAutoFocusSelectionRef.current = true;
    }, 220);

    return () => {
      window.clearTimeout(timer);
      canAutoFocusSelectionRef.current = false;
    };
  }, [graphData.nodes.length, graphData.links.length]);

  useEffect(() => {
    if (!graphRef.current || !selectedNodeId || !canAutoFocusSelectionRef.current) {
      return;
    }

    const selectedNode = graphData.nodes.find((node) => node.id === selectedNodeId);
    if (!selectedNode || typeof selectedNode.x !== "number" || typeof selectedNode.y !== "number") {
      return;
    }

    graphRef.current.centerAt(selectedNode.x, selectedNode.y, 700);
    graphRef.current.zoom(2.2, 700);
  }, [selectedNodeId, graphData.nodes]);

  useEffect(() => {
    if (!graphRef.current) {
      return;
    }

    if (isFrozen) {
      graphRef.current.pauseAnimation?.();
      return;
    }

    graphRef.current.resumeAnimation?.();
    graphRef.current.d3ReheatSimulation?.();
  }, [isFrozen]);

  useEffect(() => {
    if (!frameRef.current) {
      return;
    }

    frameRef.current.style.cursor = hoveredNodeId || hoveredLinkId ? "pointer" : "grab";
  }, [hoveredNodeId, hoveredLinkId]);

  const focusLabel = hoveredNode
    ? `${hoveredNode.type} · ${hoveredNode.label}`
    : hoveredLink
      ? `${hoveredLink.type} edge`
      : selectedNodeId
        ? `Focused node neighborhood`
        : "Hover nodes to inspect the graph";

  const tooltip = buildTooltipContent(hoveredNode, hoveredLink);
  const tooltipStyle = tooltip
    ? {
        left: `${clamp(pointerPosition.x + 18, 12, dimensions.width - 280)}px`,
        top: `${clamp(pointerPosition.y + 18, 12, dimensions.height - 176)}px`
      }
    : undefined;

  return (
    <section className="panel graph-panel">
      <div className="graph-panel-header">
        <div>
          <div className="panel-title">Interactive Graph</div>
          <div className="graph-subtitle">Hover to inspect, drag to pin, click the backdrop to clear focus.</div>
        </div>

        <div className="graph-kpi-strip">
          <div className="graph-kpi">
            <strong>{visibleNodeCount}</strong>
            <span>visible nodes</span>
          </div>
          <div className="graph-kpi">
            <strong>{visibleLinkCount}</strong>
            <span>visible links</span>
          </div>
          <div className="graph-kpi">
            <strong>{pinnedCount}</strong>
            <span>pinned</span>
          </div>
        </div>
      </div>

      <div className="legend-row graph-legend">
        {LEGEND_ITEMS.map((item) => (
          <span key={item.type} className="legend-item">
            <i style={{ backgroundColor: NODE_COLORS[item.type] }} />
            {item.label}
          </span>
        ))}
      </div>

      <div className="graph-toolbar">
        <button
          type="button"
          className={`graph-toggle ${spotlightMode ? "active" : ""}`}
          onClick={() => setSpotlightMode((current) => !current)}
        >
          Spotlight
        </button>
        <button
          type="button"
          className={`graph-toggle ${showAllLabels ? "active" : ""}`}
          onClick={() => setShowAllLabels((current) => !current)}
        >
          Dense labels
        </button>
        <button
          type="button"
          className={`graph-toggle ${isFrozen ? "active" : ""}`}
          onClick={() => setIsFrozen((current) => !current)}
        >
          {isFrozen ? "Frozen" : "Live motion"}
        </button>
        <button
          type="button"
          className="graph-toggle"
          onClick={() => {
            graphRef.current?.zoomToFit(900, 76);
            graphRef.current?.d3ReheatSimulation?.();
          }}
        >
          Reset view
        </button>
      </div>

      <div
        ref={frameRef}
        className="graph-frame"
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setPointerPosition({
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top
          });
        }}
      >
        <div className="graph-hud graph-hud-top">
          <div className="graph-status-block">
            <div className="graph-status-label">Focus</div>
            <strong>{focusLabel}</strong>
          </div>
          <div className="graph-status-block graph-status-mini">
            <div className="graph-status-label">Modes</div>
            <span>{spotlightMode ? "Spotlight on" : "Full graph"}</span>
            <span>{showAllLabels ? "Dense labels" : "Smart labels"}</span>
          </div>
        </div>

        <div className="graph-filter-bar">
          {typeCounts.map((item) => {
            const hidden = hiddenTypes.includes(item.type);
            return (
              <button
                key={item.type}
                type="button"
                className={`graph-filter-chip ${hidden ? "muted" : "active"}`}
                onClick={() =>
                  setHiddenTypes((current) =>
                    current.includes(item.type)
                      ? current.filter((value) => value !== item.type)
                      : [...current, item.type]
                  )
                }
                aria-pressed={!hidden}
              >
                <span>{item.type}</span>
                <small>{item.count}</small>
              </button>
            );
          })}
        </div>

        {tooltip ? (
          <div className="graph-tooltip" style={tooltipStyle}>
            <div className="graph-tooltip-type">{tooltip.eyebrow}</div>
            <strong>{tooltip.title}</strong>
            {tooltip.subtitle ? <span>{tooltip.subtitle}</span> : null}
            <div className="graph-tooltip-metrics">
              {tooltip.metrics.map((metric) => (
                <div key={metric.label} className="graph-tooltip-metric">
                  <small>{metric.label}</small>
                  <strong>{metric.value}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="graph-viewfinder">
          <span />
          <span />
          <span />
          <span />
        </div>

        {analysis ? (
          <ForceGraph2D
            ref={graphRef}
            width={dimensions.width}
            height={dimensions.height}
            graphData={graphData}
            backgroundColor="rgba(0,0,0,0)"
            autoPauseRedraw={false}
            cooldownTicks={isFrozen ? 0 : 180}
            d3AlphaDecay={0.028}
            d3VelocityDecay={0.28}
            linkDirectionalParticles={(link: VisualLink) =>
              isLinkRevealed(link, revealedNodeIds) &&
              (hoveredLinkId === link.id || activeContext.activeLinkIds.has(link.id))
                ? 2
                : 0
            }
            linkDirectionalParticleSpeed={(link: VisualLink) =>
              isLinkRevealed(link, revealedNodeIds) &&
              (hoveredLinkId === link.id || activeContext.activeLinkIds.has(link.id))
                ? 0.008
                : 0
            }
            linkColor={(link: VisualLink) =>
              getLinkColor(
                link,
                hoveredLinkId,
                activeContext.activeLinkIds,
                activeContext.hasFocus,
                spotlightMode,
                revealedNodeIds
              )
            }
            linkWidth={(link: VisualLink) =>
              getLinkWidth(
                link,
                hoveredLinkId,
                activeContext.activeLinkIds,
                activeContext.hasFocus,
                spotlightMode,
                revealedNodeIds
              )
            }
            linkCanvasObjectMode={() => "after"}
            linkCanvasObject={(linkObject, canvasContext) => {
              const link = linkObject as VisualLink;
              if (isLinkRevealed(link, revealedNodeIds) && hoveredLinkId === link.id) {
                drawHoveredLinkLabel(link, canvasContext);
              }
            }}
            nodeCanvasObject={(nodeObject, canvasContext, globalScale) => {
              const node = nodeObject as VisualNode;
              if (!revealedNodeIds.has(node.id)) {
                return;
              }

              drawNode(nodeObject as VisualNode, canvasContext, globalScale, {
                selectedNodeId,
                hoveredNodeId,
                activeNodeIds: activeContext.activeNodeIds,
                hasFocus: activeContext.hasFocus,
                spotlightMode,
                showAllLabels,
                revealScale: getRevealScale(node.id, revealStartedAtRef.current)
              });
            }}
            nodePointerAreaPaint={(nodeObject, color, canvasContext) => {
              const node = nodeObject as VisualNode;
              if (!revealedNodeIds.has(node.id)) {
                return;
              }
              canvasContext.fillStyle = color;
              canvasContext.beginPath();
              canvasContext.arc(node.x ?? 0, node.y ?? 0, getNodeRadius(node) + 9, 0, 2 * Math.PI, false);
              canvasContext.fill();
            }}
            onNodeClick={(node) => onSelectNode((node as VisualNode).id)}
            onBackgroundClick={() => {
              onClearSelection();
              setHoveredNodeId(null);
              setHoveredLinkId(null);
            }}
            onNodeHover={(node) => {
              setHoveredNodeId(node ? (node as VisualNode).id : null);
              if (node) {
                setHoveredLinkId(null);
              }
            }}
            onLinkHover={(link) => {
              setHoveredLinkId(link ? (link as VisualLink).id : null);
              if (link) {
                setHoveredNodeId(null);
              }
            }}
            onNodeDragEnd={(node) => {
              const visualNode = node as VisualNode;
              visualNode.fx = visualNode.x ?? undefined;
              visualNode.fy = visualNode.y ?? undefined;
              setGraphData((current) => ({
                nodes: [...current.nodes],
                links: current.links
              }));
            }}
          />
        ) : (
          <div className="empty-stage">
            The graph will appear here after the first analysis finishes. Use the controls above to switch visual modes
            once it loads.
          </div>
        )}
      </div>
    </section>
  );
}

function drawNode(
  node: VisualNode,
  context: CanvasRenderingContext2D,
  globalScale: number,
  options: {
    selectedNodeId: string | null;
    hoveredNodeId: string | null;
    activeNodeIds: Set<string>;
    hasFocus: boolean;
    spotlightMode: boolean;
    showAllLabels: boolean;
    revealScale: number;
  }
): void {
  const radius = Math.max(1.8, getNodeRadius(node) * options.revealScale);
  const isSelected = node.id === options.selectedNodeId;
  const isHovered = node.id === options.hoveredNodeId;
  const isActive = options.activeNodeIds.has(node.id);
  const isDimmed = options.spotlightMode && options.hasFocus && !isActive;
  const alpha = isDimmed ? 0.18 : 1;
  const color = NODE_COLORS[node.type] ?? "#475569";
  const pulse = 0.75 + 0.25 * Math.sin(Date.now() / 360 + node.label.length);
  const x = node.x ?? 0;
  const y = node.y ?? 0;

  const haloRadius = radius + (isSelected ? 14 : isHovered ? 10 : 5 + pulse * 1.4);
  const halo = context.createRadialGradient(x, y, radius * 0.4, x, y, haloRadius);
  halo.addColorStop(0, hexToRgba(color, isSelected ? 0.36 * alpha : isHovered ? 0.22 * alpha : 0.08 * alpha));
  halo.addColorStop(1, hexToRgba(color, 0));
  context.beginPath();
  context.arc(x, y, haloRadius, 0, 2 * Math.PI, false);
  context.fillStyle = halo;
  context.fill();

  context.beginPath();
  context.arc(x, y, isSelected ? radius + 3 : radius, 0, 2 * Math.PI, false);
  context.fillStyle = hexToRgba(color, isDimmed ? 0.26 : 0.94);
  context.shadowColor = isSelected
    ? "rgba(255,107,44,0.46)"
    : isHovered
      ? "rgba(255,255,255,0.3)"
      : "rgba(15,23,42,0.16)";
  context.shadowBlur = isSelected ? 22 : isHovered ? 12 : 8;
  context.fill();
  context.shadowBlur = 0;

  if (isSelected || isHovered) {
    context.beginPath();
    context.arc(x, y, radius + (isSelected ? 7 : 5), 0, 2 * Math.PI, false);
    context.strokeStyle = isSelected ? "rgba(255,244,230,0.95)" : "rgba(255,255,255,0.78)";
    context.lineWidth = isSelected ? 2.4 : 1.4;
    context.stroke();
  }

  if (node.insightCount > 0 && !isDimmed) {
    context.beginPath();
    context.arc(x + radius * 0.7, y - radius * 0.7, 3.3, 0, 2 * Math.PI, false);
    context.fillStyle = "#fff4d4";
    context.fill();
    context.beginPath();
    context.arc(x + radius * 0.7, y - radius * 0.7, 1.8, 0, 2 * Math.PI, false);
    context.fillStyle = "#ff6b2c";
    context.fill();
  }

  const shouldLabel =
    options.revealScale > 0.88 &&
    options.showAllLabels ||
    isSelected ||
    isHovered ||
    node.type === "Repo" ||
    (!isDimmed && options.hasFocus && isActive) ||
    globalScale > 1.55;

  if (!shouldLabel) {
    return;
  }

  const label = truncateLabel(node.label, node.type === "Dependency" ? 16 : 20);
  const fontSize = isSelected ? 13 : Math.max(10, 12 / globalScale);
  context.font = `500 ${fontSize}px "IBM Plex Mono", monospace`;
  const textWidth = context.measureText(label).width;
  const badgeHeight = fontSize + 8;
  const badgeY = y + radius + 11;
  drawRoundedRect(
    context,
    x - textWidth / 2 - 8,
    badgeY - badgeHeight / 2,
    textWidth + 16,
    badgeHeight,
    999,
    isDimmed ? "rgba(255,255,255,0.24)" : "rgba(255,250,242,0.92)"
  );
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = isDimmed ? "rgba(16,33,49,0.38)" : "#102131";
  context.fillText(label, x, badgeY + 1);
}

function drawHoveredLinkLabel(link: VisualLink, context: CanvasRenderingContext2D): void {
  const source: VisualNode | null = typeof link.source === "string" ? null : link.source;
  const target: VisualNode | null = typeof link.target === "string" ? null : link.target;

  if (!source || !target) {
    return;
  }

  const centerX = ((source.x ?? 0) + (target.x ?? 0)) / 2;
  const centerY = ((source.y ?? 0) + (target.y ?? 0)) / 2;
  const label = link.type;

  context.font = `500 11px "IBM Plex Mono", monospace`;
  const width = context.measureText(label).width + 14;
  drawRoundedRect(context, centerX - width / 2, centerY - 11, width, 22, 999, "rgba(16,33,49,0.82)");
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "rgba(255,255,255,0.92)";
  context.fillText(label, centerX, centerY + 1);
}

function collectTypeCounts(nodes: GraphNode[]): Array<{ type: string; count: number }> {
  const counts = new Map<string, number>();

  for (const node of nodes) {
    if (node.type === "Repo") {
      continue;
    }

    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => ({ type, count }));
}

function buildActiveContext(links: VisualLink[], selectedNodeId: string | null, hoveredNodeId: string | null) {
  const focusIds = [selectedNodeId, hoveredNodeId].filter((value): value is string => Boolean(value));
  const activeNodeIds = new Set<string>();
  const activeLinkIds = new Set<string>();

  if (focusIds.length === 0) {
    return {
      activeNodeIds,
      activeLinkIds,
      hasFocus: false
    };
  }

  for (const focusId of focusIds) {
    activeNodeIds.add(focusId);
    for (const link of links) {
      const sourceId = getLinkNodeId(link.source);
      const targetId = getLinkNodeId(link.target);
      if (sourceId === focusId || targetId === focusId) {
        activeLinkIds.add(link.id);
        activeNodeIds.add(sourceId);
        activeNodeIds.add(targetId);
      }
    }
  }

  return {
    activeNodeIds,
    activeLinkIds,
    hasFocus: true
  };
}

function buildTooltipContent(hoveredNode: VisualNode | null, hoveredLink: VisualLink | null) {
  if (hoveredNode) {
    return {
      eyebrow: hoveredNode.type,
      title: hoveredNode.label,
      subtitle: hoveredNode.path ?? "",
      metrics: [
        { label: "Inbound", value: `${hoveredNode.metrics?.inbound ?? 0}` },
        { label: "Outbound", value: `${hoveredNode.metrics?.outbound ?? 0}` },
        { label: "Insights", value: `${hoveredNode.insightCount}` }
      ]
    };
  }

  if (hoveredLink) {
    return {
      eyebrow: "Edge",
      title: hoveredLink.type,
      subtitle: `${truncateLabel(getLinkNodeId(hoveredLink.source), 24)} -> ${truncateLabel(getLinkNodeId(hoveredLink.target), 24)}`,
      metrics: [
        { label: "Source", value: shortenNodeId(getLinkNodeId(hoveredLink.source)) },
        { label: "Target", value: shortenNodeId(getLinkNodeId(hoveredLink.target)) }
      ]
    };
  }

  return null;
}

function getNodeRadius(node: VisualNode): number {
  const base = node.type === "Repo" ? 11 : node.type === "Directory" ? 8 : node.type === "File" ? 7 : 5.6;
  const inbound = node.metrics?.inbound ?? 0;
  return Math.min(18, base + Math.min(6, inbound / 2.2));
}

function getLinkNodeId(value: string | VisualNode): string {
  return typeof value === "string" ? value : value.id;
}

function getLinkColor(
  link: VisualLink,
  hoveredLinkId: string | null,
  activeLinkIds: Set<string>,
  hasFocus: boolean,
  spotlightMode: boolean,
  revealedNodeIds: Set<string>
): string {
  if (!isLinkRevealed(link, revealedNodeIds)) {
    return "rgba(0,0,0,0)";
  }

  if (link.id === hoveredLinkId) {
    return "rgba(255,244,230,0.92)";
  }

  if (activeLinkIds.has(link.id)) {
    return "rgba(255,107,44,0.72)";
  }

  if (spotlightMode && hasFocus) {
    return "rgba(16,33,49,0.06)";
  }

  return "rgba(30,41,59,0.18)";
}

function getLinkWidth(
  link: VisualLink,
  hoveredLinkId: string | null,
  activeLinkIds: Set<string>,
  hasFocus: boolean,
  spotlightMode: boolean,
  revealedNodeIds: Set<string>
): number {
  if (!isLinkRevealed(link, revealedNodeIds)) {
    return 0;
  }

  if (link.id === hoveredLinkId) {
    return 2.8;
  }

  if (activeLinkIds.has(link.id)) {
    return 2.1;
  }

  if (spotlightMode && hasFocus) {
    return 0.5;
  }

  return 1;
}

function hexToRgba(hex: string, alpha: number): string {
  const cleanHex = hex.replace("#", "");
  const normalized =
    cleanHex.length === 3
      ? cleanHex
          .split("")
          .map((value) => `${value}${value}`)
          .join("")
      : cleanHex;
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
  context.fillStyle = fillStyle;
  context.fill();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateLabel(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function shortenNodeId(nodeId: string): string {
  const parts = nodeId.split(":");
  return parts.at(-1) ?? nodeId;
}

function isLinkRevealed(link: VisualLink, revealedNodeIds: Set<string>): boolean {
  const sourceId = getLinkNodeId(link.source);
  const targetId = getLinkNodeId(link.target);
  return revealedNodeIds.has(sourceId) && revealedNodeIds.has(targetId);
}

function getRevealScale(nodeId: string, revealStartedAt: Map<string, number>): number {
  const startedAt = revealStartedAt.get(nodeId);
  if (!startedAt) {
    return 1;
  }

  const elapsed = Date.now() - startedAt;
  const t = clamp(elapsed / 260, 0, 1);
  return 0.2 + 0.8 * easeOutBack(t);
}

function easeOutBack(value: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(value - 1, 3) + c1 * Math.pow(value - 1, 2);
}

function buildNodeRevealSequence(nodes: VisualNode[], links: VisualLink[]): string[] {
  if (nodes.length === 0) {
    return [];
  }

  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }

  for (const link of links) {
    const sourceId = getLinkNodeId(link.source);
    const targetId = getLinkNodeId(link.target);
    adjacency.get(sourceId)?.add(targetId);
    adjacency.get(targetId)?.add(sourceId);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rootNode =
    nodes.find((node) => node.type === "Repo") ??
    [...nodes].sort((left, right) => {
      const leftDegree = adjacency.get(left.id)?.size ?? 0;
      const rightDegree = adjacency.get(right.id)?.size ?? 0;
      if (leftDegree !== rightDegree) {
        return rightDegree - leftDegree;
      }

      return (right.metrics?.inbound ?? 0) - (left.metrics?.inbound ?? 0);
    })[0];

  if (!rootNode) {
    return nodes.map((node) => node.id);
  }

  const depthMap = new Map<string, number>();
  const queue: string[] = [rootNode.id];
  depthMap.set(rootNode.id, 0);

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (!currentId) {
      continue;
    }

    const nextDepth = (depthMap.get(currentId) ?? 0) + 1;
    const neighbors = adjacency.get(currentId);
    if (!neighbors) {
      continue;
    }

    for (const neighborId of neighbors) {
      if (depthMap.has(neighborId)) {
        continue;
      }

      depthMap.set(neighborId, nextDepth);
      queue.push(neighborId);
    }
  }

  const disconnected = nodes
    .filter((node) => !depthMap.has(node.id))
    .sort((left, right) => (adjacency.get(right.id)?.size ?? 0) - (adjacency.get(left.id)?.size ?? 0));

  const ordered = [...nodes].sort((left, right) => {
    const leftDepth = depthMap.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightDepth = depthMap.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftDepth !== rightDepth) {
      return leftDepth - rightDepth;
    }

    const leftDegree = adjacency.get(left.id)?.size ?? 0;
    const rightDegree = adjacency.get(right.id)?.size ?? 0;
    if (leftDegree !== rightDegree) {
      return rightDegree - leftDegree;
    }

    return left.label.localeCompare(right.label);
  });

  const seen = new Set<string>();
  const sequence: string[] = [];

  for (const node of [rootNode, ...ordered, ...disconnected]) {
    if (seen.has(node.id)) {
      continue;
    }

    seen.add(node.id);
    sequence.push(node.id);
  }

  return sequence;
}
