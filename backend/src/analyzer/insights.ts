import path from "node:path";

import type { GraphEdge, GraphNode, Insight } from "../../../shared/src/index.js";

interface OwnershipSummary {
  name: string;
  email?: string;
  commits: number;
  share: number;
}

interface ActivitySummary {
  commits: number;
  lastTouchedAt?: string;
}

export interface InsightContext {
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryPointIds: Set<string>;
  fileTestMatches: Map<string, string[]>;
  fileOwnership: Map<string, OwnershipSummary>;
  fileActivity: Map<string, ActivitySummary>;
}

const RELEVANT_INBOUND = new Set(["imports", "calls", "references", "depends_on"]);
const LARGE_FILE_COUNT = 5;
const HOT_THRESHOLD = 4;
const HUB_THRESHOLD = 4;
const BOTTLENECK_THRESHOLD = 7;
const STALE_DAYS = 180;

export function generateInsights(context: InsightContext): Record<string, Insight[]> {
  const inbound = buildEdgeMap(context.edges, "target");
  const outbound = buildEdgeMap(context.edges, "source");
  const insights: Record<string, Insight[]> = {};

  const fileNodes = context.nodes.filter((node) => node.type === "File");
  const largestFileIds = new Set(
    [...fileNodes]
      .sort((left, right) => ((right.metrics?.size as number | undefined) ?? 0) - ((left.metrics?.size as number | undefined) ?? 0))
      .slice(0, LARGE_FILE_COUNT)
      .map((node) => node.id)
  );

  const push = (nodeId: string, insight: Omit<Insight, "id" | "nodeId">): void => {
    if (!insights[nodeId]) {
      insights[nodeId] = [];
    }

    insights[nodeId].push({
      id: `${nodeId}:${insight.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      nodeId,
      ...insight
    });
  };

  for (const node of context.nodes) {
    const nodeInbound = inbound.get(node.id) ?? [];
    const relevantInbound = nodeInbound.filter((edge) => RELEVANT_INBOUND.has(edge.type));

    if (context.entryPointIds.has(node.id)) {
      push(node.id, {
        kind: "success",
        title: "Entry point",
        message: "This node looks like an execution or package entry point.",
        score: 98
      });
    }

    if (isInsightTarget(node) && relevantInbound.length === 0 && !isOrphanExempt(node)) {
      push(node.id, {
        kind: "info",
        title: "Orphan",
        message: "Nothing in the extracted graph appears to import or call this yet.",
        score: 74
      });
    }

    if (isHubCandidate(node) && relevantInbound.length >= HUB_THRESHOLD) {
      push(node.id, {
        kind: "warning",
        title: "Hub",
        message: `This node has ${relevantInbound.length} inbound links and sits on a busy path.`,
        score: 82
      });
    }

    if ((node.type === "File" || node.type === "Directory") && relevantInbound.length >= BOTTLENECK_THRESHOLD) {
      push(node.id, {
        kind: "warning",
        title: "Bottleneck",
        message: "A large portion of the graph depends on this area. Change it carefully.",
        score: 90
      });
    }

    if (node.type === "File" && largestFileIds.has(node.id)) {
      const size = formatBytes((node.metrics?.size as number | undefined) ?? 0);
      push(node.id, {
        kind: "info",
        title: "Large file",
        message: `This is one of the largest files in the current analysis at ${size}.`,
        score: 61
      });
    }

    if (node.type === "File" && isCodeFile(node.path) && !isTestFile(node.path)) {
      const matchingTests = context.fileTestMatches.get(node.id) ?? [];

      if (matchingTests.length === 0) {
        push(node.id, {
          kind: "warning",
          title: "No tests",
          message: "No matching test file was found for this code file.",
          score: 88
        });
      }
    }

    if (node.type === "File") {
      const activity = context.fileActivity.get(node.id);

      if (activity && activity.commits >= HOT_THRESHOLD) {
        push(node.id, {
          kind: "warning",
          title: "Hot file",
          message: `This file was touched in ${activity.commits} recent commits.`,
          score: 79
        });
      }

      if (activity?.lastTouchedAt) {
        const daysOld = ageInDays(activity.lastTouchedAt);

        if (daysOld >= STALE_DAYS) {
          push(node.id, {
            kind: "info",
            title: "Stale",
            message: `No recent git activity was detected here for about ${daysOld} days.`,
            score: 54
          });
        }
      }

      const owner = context.fileOwnership.get(node.id);

      if (owner && owner.commits >= 3 && owner.share >= 0.6) {
        push(node.id, {
          kind: "success",
          title: "Ownership",
          message: `${owner.name} appears to own this area with ${owner.commits} recent commits.`,
          score: 72
        });
      }
    }
  }

  for (const nodeId of Object.keys(insights)) {
    insights[nodeId].sort((left, right) => right.score - left.score);
  }

  return insights;
}

function buildEdgeMap(edges: GraphEdge[], direction: "source" | "target"): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>();

  for (const edge of edges) {
    const key = direction === "source" ? edge.source : edge.target;

    if (!map.has(key)) {
      map.set(key, []);
    }

    map.get(key)?.push(edge);
  }

  return map;
}

function isInsightTarget(node: GraphNode): boolean {
  return node.type === "File" || node.type === "Function" || node.type === "Class" || node.type === "Method";
}

function isHubCandidate(node: GraphNode): boolean {
  return node.type === "File" || node.type === "Function" || node.type === "Class" || node.type === "Method";
}

function isOrphanExempt(node: GraphNode): boolean {
  if (!node.path) {
    return node.type === "Repo";
  }

  if (node.type === "File") {
    if (isTestFile(node.path)) {
      return true;
    }

    const baseName = path.posix.basename(node.path).toLowerCase();
    return baseName.startsWith("readme") || baseName === "package.json" || baseName.endsWith(".md");
  }

  return node.label.toLowerCase().startsWith("anonymous");
}

function isCodeFile(filePath?: string): boolean {
  if (!filePath) {
    return false;
  }

  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/i.test(filePath);
}

function isTestFile(filePath?: string): boolean {
  if (!filePath) {
    return false;
  }

  return /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[^.]+$/i.test(filePath);
}

function ageInDays(dateString: string): number {
  const then = new Date(dateString).getTime();

  if (Number.isNaN(then)) {
    return 0;
  }

  return Math.max(0, Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24)));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
