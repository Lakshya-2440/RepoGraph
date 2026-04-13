import type {
  AiRepoInsight,
  AnalysisResult,
  Insight,
  RepoAiInsightsResponse
} from "../../../shared/src/index.js";
import { loadEnvironment } from "../config/env.js";

interface HuggingFaceChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface RawAiInsight {
  kind?: string;
  title?: string;
  message?: string;
  confidence?: number;
  nodeHint?: string;
}

export async function generateAiInsights(options: {
  analysis: AnalysisResult;
}): Promise<RepoAiInsightsResponse> {
  loadEnvironment(true);

  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_TOKEN;
  if (!token) {
    throw new Error("Missing Hugging Face token. Set HF_TOKEN (or HUGGING_FACE_TOKEN) in backend environment.");
  }

  const prompt = buildInsightsPrompt(options.analysis);
  const nodeLookup = createNodeLookup(options.analysis);

  // Try different strategies
  let lastError: Error | null = null;

  // Try Groq if available
  try {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      const content = await queryGroq(groqKey, prompt);
      const parsed = parseAiInsightPayload(content);
      const mapped = parsed
        .slice(0, 10)
        .map((item, index) => mapAiInsight(item, nodeLookup, index))
        .filter((item): item is AiRepoInsight => Boolean(item));

      if (mapped.length > 0) {
        return {
          model: "groq/mixtral-8x7b-32768",
          generatedAt: new Date().toISOString(),
          insights: mapped
        };
      }
    }
  } catch (error) {
    lastError = error instanceof Error ? error : new Error("Groq failed");
  }

  // Try HF Inference
  try {
    const content = await queryHuggingFaceInference(token, prompt);
    const parsed = parseAiInsightPayload(content);
    const mapped = parsed
      .slice(0, 10)
      .map((item, index) => mapAiInsight(item, nodeLookup, index))
      .filter((item): item is AiRepoInsight => Boolean(item));

    if (mapped.length > 0) {
      return {
        model: "huggingface/inference-api",
        generatedAt: new Date().toISOString(),
        insights: mapped
      };
    }
  } catch (error) {
    lastError = error instanceof Error ? error : new Error("HF Inference failed");
  }

  // Fallback: Generate insights from heuristics
  const fallbackInsights = generateFallbackInsights(options.analysis, nodeLookup);
  return {
    model: "fallback/heuristic-analysis",
    generatedAt: new Date().toISOString(),
    insights: fallbackInsights
  };
}

function buildInsightsPrompt(analysis: AnalysisResult): string {
  const topEdges = analysis.graph.edges.length;
  const depNodes = analysis.graph.nodes.filter((node) => node.type === "Dependency").slice(0, 20);
  const fileNodes = analysis.graph.nodes
    .filter((node) => node.type === "File")
    .sort((left, right) => ((right.metrics?.inbound ?? 0) as number) - ((left.metrics?.inbound ?? 0) as number))
    .slice(0, 20)
    .map((node) => ({
      label: node.label,
      path: node.path,
      inbound: node.metrics?.inbound ?? 0,
      outbound: node.metrics?.outbound ?? 0,
      commits: node.metrics?.commits ?? 0,
      size: node.metrics?.size ?? 0
    }));

  const deterministicInsights = flattenInsights(analysis.insights).slice(0, 24);

  return [
    "You are a senior staff engineer performing repository analysis.",
    "Generate high-value, concrete engineering insights from the provided repository data.",
    "",
    "Output strictly as JSON array. No markdown. No prose outside JSON.",
    "Each item must include:",
    "- kind: warning | info | success",
    "- title: short title",
    "- message: practical insight with why it matters",
    "- confidence: integer 1..100",
    "- nodeHint: optional file path or symbol label if relevant",
    "",
    "Prefer insights about architecture, risk hotspots, testing gaps, ownership, dependency risk, and maintainability.",
    "Avoid generic statements.",
    "",
    `Repository: ${analysis.summary.repoName}`,
    `Counts: nodes=${analysis.summary.counts.nodes}, edges=${topEdges}, files=${analysis.summary.counts.files}, dependencies=${analysis.summary.counts.dependencies}`,
    `Entry points: ${analysis.summary.entryPoints.slice(0, 12).join(", ") || "n/a"}`,
    `Top directories: ${analysis.summary.topDirectories.slice(0, 12).map((item) => item.label).join(", ") || "n/a"}`,
    `Top contributors: ${analysis.summary.topContributors.slice(0, 10).map((item) => `${item.name}(${item.commits})`).join(", ") || "n/a"}`,
    "",
    "Dependency nodes:",
    JSON.stringify(depNodes.map((node) => node.label), null, 2),
    "",
    "Hot files:",
    JSON.stringify(fileNodes, null, 2),
    "",
    "Existing deterministic insights:",
    JSON.stringify(deterministicInsights, null, 2)
  ].join("\n");
}

function flattenInsights(insights: Record<string, Insight[]>): Array<Pick<Insight, "kind" | "title" | "message" | "score" | "nodeId">> {
  const flattened: Array<Pick<Insight, "kind" | "title" | "message" | "score" | "nodeId">> = [];
  for (const [nodeId, items] of Object.entries(insights)) {
    for (const item of items) {
      flattened.push({
        nodeId,
        kind: item.kind,
        title: item.title,
        message: item.message,
        score: item.score
      });
    }
  }

  flattened.sort((left, right) => right.score - left.score);
  return flattened;
}

function createNodeLookup(analysis: AnalysisResult): Map<string, { id: string; label: string; path?: string }> {
  const lookup = new Map<string, { id: string; label: string; path?: string }>();

  for (const node of analysis.graph.nodes) {
    lookup.set(node.id.toLowerCase(), { id: node.id, label: node.label, path: node.path });
    lookup.set(node.label.toLowerCase(), { id: node.id, label: node.label, path: node.path });

    if (node.path) {
      lookup.set(node.path.toLowerCase(), { id: node.id, label: node.label, path: node.path });
      const base = node.path.split("/").at(-1);
      if (base) {
        lookup.set(base.toLowerCase(), { id: node.id, label: node.label, path: node.path });
      }
    }
  }

  return lookup;
}

function parseAiInsightPayload(content: string): RawAiInsight[] {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  const bracketStart = candidate.indexOf("[");
  const bracketEnd = candidate.lastIndexOf("]");
  const jsonArray = bracketStart >= 0 && bracketEnd > bracketStart
    ? candidate.slice(bracketStart, bracketEnd + 1)
    : candidate;

  const parsed = JSON.parse(jsonArray) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("AI insights format was not a JSON array.");
  }

  return parsed as RawAiInsight[];
}

function mapAiInsight(
  input: RawAiInsight,
  nodeLookup: Map<string, { id: string; label: string; path?: string }>,
  index: number
): AiRepoInsight | null {
  const title = `${input.title ?? ""}`.trim();
  const message = `${input.message ?? ""}`.trim();
  if (!title || !message) {
    return null;
  }

  const normalizedKind = `${input.kind ?? "info"}`.toLowerCase();
  const kind: AiRepoInsight["kind"] =
    normalizedKind === "warning" || normalizedKind === "success" || normalizedKind === "info"
      ? normalizedKind
      : "info";

  const confidenceRaw = Number(input.confidence ?? 70);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(1, Math.min(100, Math.round(confidenceRaw))) : 70;

  const hint = `${input.nodeHint ?? ""}`.trim().toLowerCase();
  const matched = hint ? nodeLookup.get(hint) : undefined;

  return {
    id: `ai-${Date.now()}-${index}`,
    kind,
    title,
    message,
    confidence,
    nodeId: matched?.id,
    nodeLabel: matched?.path ?? matched?.label
  };
}

async function queryGroq(apiKey: string, userPrompt: string): Promise<string> {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "mixtral-8x7b-32768",
      messages: [
        {
          role: "system",
          content: "You are an expert repository analysis assistant. Produce actionable engineering insights grounded in provided data."
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      temperature: 0.2,
      max_tokens: 1200
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("Groq returned empty response");
  }

  return content;
}

async function queryHuggingFaceInference(token: string, userPrompt: string): Promise<string> {
  // Use HF's free models that work with the Inference API
  const freeModels = [
    "bigscience/bloom",
    "EleutherAI/gpt-neox-20b",
    "tiiuae/falcon-7b-instruct",
    "gpt2"
  ];

  let lastError: Error | null = null;

  for (const model of freeModels) {
    try {
      const response = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          inputs: userPrompt,
          parameters: {
            max_length: 1300,
            temperature: 0.2
          }
        })
      });

      if (!response.ok) {
        const body = await response.text();
        lastError = new Error(`Model ${model} failed (${response.status})`);
        continue;
      }

      const data = await response.json() as Array<{ generated_text?: string }>;
      const content = data?.[0]?.generated_text?.trim();

      if (content) {
        return content;
      }

      lastError = new Error(`Model ${model} returned empty`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(`Model ${model} error`);
      continue;
    }
  }

  throw lastError ?? new Error("No HF model succeeded");
}

function generateFallbackInsights(analysis: AnalysisResult, nodeLookup: Map<string, { id: string; label: string; path?: string }>): AiRepoInsight[] {
  const insights: AiRepoInsight[] = [];

  // High-level insights
  const totalFiles = analysis.graph.nodes.filter((n) => n.type === "File").length;
  const totalFunctions = analysis.graph.nodes.filter((n) => n.type === "Function").length;
  const dependencies = analysis.graph.nodes.filter((n) => n.type === "Dependency").length;

  insights.push({
    id: `ai-${Date.now()}-0`,
    kind: "info",
    title: "Repository Structure Overview",
    message: `This repository contains ${totalFiles} files, ${totalFunctions} functions, and ${dependencies} dependency relationships.`,
    confidence: 85,
    nodeId: undefined,
    nodeLabel: undefined
  });

  // Find highly connected nodes
  const highInboundNodes = analysis.graph.nodes
    .filter((n) => (n.metrics?.inbound ?? 0) > 5)
    .slice(0, 3);

  if (highInboundNodes.length > 0) {
    const fileNames = highInboundNodes
      .filter((n) => n.type === "File")
      .map((n) => (n.type === "File" ? (n as any).path : n.label))
      .join(", ");

    if (fileNames) {
      insights.push({
        id: `ai-${Date.now()}-1`,
        kind: "warning",
        title: "Highly Interdependent Modules",
        message: `Files like ${fileNames} show high coupling. Consider refactoring for better modularity.`,
        confidence: 75,
        nodeId: highInboundNodes[0]?.id,
        nodeLabel: highInboundNodes[0]?.label
      });
    }
  }

  // Check for potential issues
  const isolatedNodes = analysis.graph.nodes.filter((n) => (n.metrics?.inbound ?? 0) === 0 && (n.metrics?.outbound ?? 0) === 0).length;

  if (isolatedNodes > 0) {
    insights.push({
      id: `ai-${Date.now()}-2`,
      kind: "info",
      title: "Unused Code Detected",
      message: `Found ${isolatedNodes} isolated components that may be unused or new to the codebase.`,
      confidence: 70,
      nodeId: undefined,
      nodeLabel: undefined
    });
  }

  return insights.slice(0, 10);
}

async function queryHuggingFaceChat(options: {
  token: string;
  model: string;
  userPrompt: string;
}): Promise<string> {
  // This is deprecated but kept for backward compatibility
  return queryHuggingFaceInference(options.token, options.userPrompt);
}
