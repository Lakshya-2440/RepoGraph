import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import cors from "cors";
import express from "express";

import type {
  AiRepoInsight,
  AnalyzeRequest,
  AnalysisResult,
  ChatMessage,
  GraphEdge,
  GraphNode,
  HealthResponse,
  NodeDetailResponse,
  RepoAiInsightsResponse,
  RepoAiCodeOriginResponse,
  RepoChatRequest,
  RepoChatResponse,
  SearchResult,
  SubgraphResponse
} from "../../shared/src/index.js";
import { analyzeRepository } from "./analyzer/analyzeRepository.js";
import { estimateCodeOrigin } from "./chat/repoCodeOrigin.js";
import { generateAiInsights } from "./chat/repoAiInsights.js";
import { answerRepoQuestion } from "./chat/repoChat.js";
import { loadEnvironment } from "./config/env.js";
import { getCurrentAnalysis, isAnalysisRunning, loadStoredAnalysis, runAnalysis } from "./store/analysisStore.js";

loadEnvironment();

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendDist = path.resolve(process.cwd(), "frontend/dist");

await loadStoredAnalysis();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => {
  const payload: HealthResponse = {
    status: "ok",
    hasAnalysis: Boolean(getCurrentAnalysis()),
    analyzing: isAnalysisRunning(),
    defaultSource: process.cwd()
  };

  response.json(payload);
});

app.get("/api/current", (_request, response) => {
  const current = getCurrentAnalysis();

  if (!current) {
    response.status(404).json({ error: "No analysis has been generated yet." });
    return;
  }

  response.json(current);
});

app.post("/api/analyze", async (request, response) => {
  const body = request.body as Partial<AnalyzeRequest>;
  const source = body.source?.trim();

  if (!source) {
    response.status(400).json({ error: "A source path or GitHub URL is required." });
    return;
  }

  try {
    const analysis = await runAnalysis(() => analyzeRepository({ source, ref: body.ref?.trim() }));
    response.json(analysis);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Analysis failed."
    });
  }
});

app.get("/api/search", (request, response) => {
  const analysis = getCurrentAnalysis();
  if (!analysis) {
    response.status(404).json({ error: "No analysis available." });
    return;
  }

  const query = `${request.query.q ?? ""}`.trim().toLowerCase();
  if (!query) {
    response.json([] satisfies SearchResult[]);
    return;
  }

  const results = analysis.graph.nodes
    .map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      path: node.path,
      score: scoreSearchResult(node, query)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 20);

  response.json(results satisfies SearchResult[]);
});

app.get("/api/nodes/:nodeId", (request, response) => {
  const analysis = getCurrentAnalysis();
  if (!analysis) {
    response.status(404).json({ error: "No analysis available." });
    return;
  }

  const nodeId = request.params.nodeId;
  const node = analysis.graph.nodes.find((candidate) => candidate.id === nodeId);

  if (!node) {
    response.status(404).json({ error: "Node not found." });
    return;
  }

  const inbound = analysis.graph.edges.filter((edge) => edge.target === nodeId);
  const outbound = analysis.graph.edges.filter((edge) => edge.source === nodeId);
  const neighborIds = new Set<string>([
    ...inbound.map((edge) => edge.source),
    ...outbound.map((edge) => edge.target)
  ]);
  const neighbors = analysis.graph.nodes.filter((candidate) => neighborIds.has(candidate.id));

  const payload: NodeDetailResponse = {
    node,
    insights: analysis.insights[nodeId] ?? [],
    inbound,
    outbound,
    neighbors
  };

  response.json(payload);
});

app.get("/api/file-content", (request, response) => {
  const analysis = getCurrentAnalysis();
  if (!analysis) {
    response.status(404).json({ error: "No analysis available." });
    return;
  }

  const filePath = `${request.query.path ?? ""}`.trim();
  if (!filePath) {
    response.status(400).json({ error: "path query parameter is required." });
    return;
  }

  const repoRoot = analysis.summary.resolvedPath;
  const resolved = path.resolve(repoRoot, filePath);

  // Prevent directory traversal
  if (!resolved.startsWith(repoRoot)) {
    response.status(403).json({ error: "Path outside repository." });
    return;
  }

  if (!existsSync(resolved)) {
    response.status(404).json({ error: "File not found." });
    return;
  }

  try {
    const raw = readFileSync(resolved, "utf-8");
    const content = raw.length > 50_000 ? raw.slice(0, 50_000) + "\n\n// ... truncated (50k char limit)" : raw;
    const ext = path.extname(filePath).replace(".", "").toLowerCase();
    const languageMap: Record<string, string> = {
      ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
      py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
      css: "css", html: "html", json: "json", md: "markdown", yml: "yaml", yaml: "yaml",
      sh: "bash", sql: "sql", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    };
    const language = languageMap[ext] ?? (ext || "plaintext");
    response.json({ content, language });
  } catch {
    response.status(500).json({ error: "Failed to read file." });
  }
});

app.get("/api/subgraph", (request, response) => {
  const analysis = getCurrentAnalysis();
  if (!analysis) {
    response.status(404).json({ error: "No analysis available." });
    return;
  }

  const nodeId = `${request.query.nodeId ?? ""}`.trim();
  if (!nodeId) {
    response.status(400).json({ error: "nodeId is required." });
    return;
  }

  const depth = clampInt(Number(request.query.depth ?? 1), 1, 4);
  const limit = clampInt(Number(request.query.limit ?? 80), 10, 200);
  const subgraph = buildSubgraph(analysis, nodeId, depth, limit);

  if (!subgraph) {
    response.status(404).json({ error: "Node not found." });
    return;
  }

  response.json(subgraph satisfies SubgraphResponse);
});

app.post("/api/chat", async (request, response) => {
  const analysis = getCurrentAnalysis();
  if (!analysis) {
    response.status(404).json({ error: "No analysis available. Run analysis first." });
    return;
  }

  const body = (request.body ?? {}) as Partial<RepoChatRequest>;
  const question = body.question?.trim() ?? "";
  const history = sanitizeHistory(body.history);

  if (!question) {
    response.status(400).json({ error: "Question is required." });
    return;
  }

  try {
    const result = await answerRepoQuestion({
      analysis,
      question,
      history
    });

    response.json(result satisfies RepoChatResponse);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Chat request failed."
    });
  }
});

app.post("/api/insights/ai", async (_request, response) => {
  const analysis = getCurrentAnalysis();
  if (!analysis) {
    response.status(404).json({ error: "No analysis available. Run analysis first." });
    return;
  }

  try {
    const payload = await generateAiInsights({ analysis });
    response.json(payload satisfies RepoAiInsightsResponse);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to generate AI insights."
    });
  }
});

app.post("/api/ai/code-origin", async (_request, response) => {
  const analysis = getCurrentAnalysis();
  if (!analysis) {
    response.status(404).json({ error: "No analysis available. Run analysis first." });
    return;
  }

  try {
    const payload = await estimateCodeOrigin({ analysis });
    response.json(payload satisfies RepoAiCodeOriginResponse);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to estimate AI-generated code ratio."
    });
  }
});

if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get("*", (request, response, next) => {
    if (request.path.startsWith("/api")) {
      next();
      return;
    }

    response.sendFile(path.join(frontendDist, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});

function scoreSearchResult(node: GraphNode, query: string): number {
  const label = node.label.toLowerCase();
  const filePath = node.path?.toLowerCase() ?? "";

  if (label === query) {
    return 120;
  }

  if (filePath === query) {
    return 115;
  }

  if (label.startsWith(query)) {
    return 90;
  }

  if (filePath.startsWith(query)) {
    return 80;
  }

  if (label.includes(query)) {
    return 70;
  }

  if (filePath.includes(query)) {
    return 60;
  }

  return 0;
}

function buildSubgraph(
  analysis: AnalysisResult,
  centerId: string,
  depth: number,
  limit: number
): SubgraphResponse | null {
  const centerNode = analysis.graph.nodes.find((node) => node.id === centerId);

  if (!centerNode) {
    return null;
  }

  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of analysis.graph.edges) {
    if (!adjacency.has(edge.source)) {
      adjacency.set(edge.source, []);
    }
    if (!adjacency.has(edge.target)) {
      adjacency.set(edge.target, []);
    }

    adjacency.get(edge.source)?.push(edge);
    adjacency.get(edge.target)?.push(edge);
  }

  const visited = new Set<string>([centerId]);
  let frontier = [centerId];

  for (let level = 0; level < depth; level += 1) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      for (const edge of adjacency.get(nodeId) ?? []) {
        const neighborId = edge.source === nodeId ? edge.target : edge.source;
        if (visited.has(neighborId)) {
          continue;
        }

        visited.add(neighborId);
        nextFrontier.push(neighborId);
        if (visited.size >= limit) {
          break;
        }
      }

      if (visited.size >= limit) {
        break;
      }
    }

    frontier = nextFrontier;

    if (frontier.length === 0 || visited.size >= limit) {
      break;
    }
  }

  return {
    centerId,
    depth,
    nodes: analysis.graph.nodes.filter((node) => visited.has(node.id)),
    edges: analysis.graph.edges.filter((edge) => visited.has(edge.source) && visited.has(edge.target))
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function sanitizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) {
    return [];
  }

  const clean: ChatMessage[] = [];
  for (const candidate of history) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const role = (candidate as { role?: unknown }).role;
    const content = (candidate as { content?: unknown }).content;

    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim().length > 0) {
      clean.push({ role, content: content.trim().slice(0, 4000) });
    }
  }

  return clean.slice(-12);
}
