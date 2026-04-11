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

  const modelCandidates = [
    process.env.HF_CHAT_MODEL?.trim(),
    "Qwen/Qwen2.5-7B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3"
  ].filter((candidate): candidate is string => Boolean(candidate));

  const prompt = buildInsightsPrompt(options.analysis);
  const nodeLookup = createNodeLookup(options.analysis);

  let lastError: Error | null = null;
  for (const model of modelCandidates) {
    try {
      const content = await queryHuggingFaceChat({ token, model, userPrompt: prompt });
      const parsed = parseAiInsightPayload(content);
      const mapped = parsed
        .slice(0, 10)
        .map((item, index) => mapAiInsight(item, nodeLookup, index))
        .filter((item): item is AiRepoInsight => Boolean(item));

      if (mapped.length === 0) {
        throw new Error("AI returned no usable insights.");
      }

      return {
        model,
        generatedAt: new Date().toISOString(),
        insights: mapped
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown AI insight generation error.");
    }
  }

  throw new Error(lastError?.message ?? "Failed to generate AI insights.");
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

async function queryHuggingFaceChat(options: {
  token: string;
  model: string;
  userPrompt: string;
}): Promise<string> {
  const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.token}`
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        {
          role: "system",
          content:
            "You are an expert repository analysis assistant. Produce actionable engineering insights grounded in provided data."
        },
        {
          role: "user",
          content: options.userPrompt
        }
      ],
      temperature: 0.2,
      max_tokens: 1200
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Hugging Face request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as HuggingFaceChatResponse;
  const content = payload.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("Hugging Face returned an empty insight response.");
  }

  return content;
}
