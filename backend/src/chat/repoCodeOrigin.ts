import { promises as fs } from "node:fs";
import path from "node:path";

import type { AnalysisResult, RepoAiCodeOriginResponse } from "../../../shared/src/index.js";
import { loadEnvironment } from "../config/env.js";
import { resolveAnalysisRootPath } from "./sourceMaterializer.js";

interface HuggingFaceChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface RawCodeOrigin {
  estimatedAiGeneratedPercent?: number;
  confidence?: number;
  summary?: string;
  signals?: string[];
}

export async function estimateCodeOrigin(options: { analysis: AnalysisResult }): Promise<RepoAiCodeOriginResponse> {
  loadEnvironment(true);

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!openRouterKey) {
    throw new Error("Missing AI provider key. Set OPENROUTER_API_KEY.");
  }

  const prompt = await buildPrompt(options.analysis);

  try {
    const content = await queryOpenRouterChat(openRouterKey, prompt);
    const parsed = parseResponse(content);
    return {
      model: process.env.OPENROUTER_MODEL?.trim() || "minimax/minimax-m2.5:free",
      generatedAt: new Date().toISOString(),
      estimatedAiGeneratedPercent: clampPercent(parsed.estimatedAiGeneratedPercent ?? 0),
      confidence: clampPercent(parsed.confidence ?? 60),
      summary: `${parsed.summary ?? "No summary provided."}`.trim(),
      signals: (parsed.signals ?? []).map((signal) => `${signal}`.trim()).filter(Boolean).slice(0, 6)
    };
  } catch (error) {
    // Fall through to heuristic fallback.
  }

  // Fallback: Generate estimate heuristically
  const fallbackResult = generateFallbackCodeOriginEstimate(options.analysis);
  return {
    model: "fallback/heuristic-estimator",
    generatedAt: new Date().toISOString(),
    estimatedAiGeneratedPercent: fallbackResult.estimatedAiGeneratedPercent,
    confidence: fallbackResult.confidence,
    summary: fallbackResult.summary,
    signals: fallbackResult.signals
  };
}

async function queryOpenRouterChat(apiKey: string, userPrompt: string): Promise<string> {
  const model = process.env.OPENROUTER_MODEL?.trim() || "minimax/minimax-m2.5:free";
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are an expert code reviewer estimating whether code is AI-assisted. Output strictly as JSON object. No markdown."
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      temperature: 0.15,
      max_tokens: 900
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenRouter returned empty response");
  }
  return content;
}

async function buildPrompt(analysis: AnalysisResult): Promise<string> {
  const root = await resolveAnalysisRootPath(analysis);
  if (!root) {
    throw new Error("Unable to access repository files for AI code-origin estimation.");
  }
  const filePaths = analysis.graph.nodes
    .filter((node) => node.type === "File" && typeof node.path === "string")
    .map((node) => node.path as string)
    .slice(0, 20);

  const snippets: Array<{ path: string; snippet: string }> = [];
  for (const relativePath of filePaths) {
    if (snippets.length >= 8) {
      break;
    }

    const absolute = path.resolve(root, relativePath);
    if (!absolute.startsWith(root)) {
      continue;
    }

    try {
      const raw = await fs.readFile(absolute, "utf-8");
      if (!raw || raw.includes("\u0000")) {
        continue;
      }

      const snippet = raw.replace(/\r\n/g, "\n").slice(0, 1000);
      snippets.push({ path: relativePath, snippet });
    } catch {
      continue;
    }
  }

  return [
    "Estimate what percentage of this repository likely contains AI-generated code.",
    "This is probabilistic. Be conservative and avoid overclaiming.",
    "",
    "Return STRICT JSON object only, with keys:",
    "estimatedAiGeneratedPercent: number (0..100)",
    "confidence: number (0..100)",
    "summary: short sentence",
    "signals: string[] (3 to 6 concise bullet points)",
    "",
    `Repo: ${analysis.summary.repoName}`,
    `Files: ${analysis.summary.counts.files}, Commits: ${analysis.summary.counts.commits}, Contributors: ${analysis.summary.topContributors.length}`,
    `Top contributors: ${analysis.summary.topContributors.slice(0, 8).map((item) => `${item.name}(${item.commits})`).join(", ") || "n/a"}`,
    "",
    "Sample snippets:",
    ...snippets.map((item, index) => `Source ${index + 1}: ${item.path}\n${item.snippet}`)
  ].join("\n\n");
}

function parseResponse(content: string): RawCodeOrigin {
  const trimmed = content.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const objectText = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;

  const parsed = JSON.parse(objectText) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid AI code-origin response format.");
  }

  return parsed as RawCodeOrigin;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
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
          content: "You are a careful software forensics assistant. Produce conservative probability estimates only."
        },
        {
          role: "user",
          content: userPrompt
        }
      ],
      temperature: 0.1,
      max_tokens: 700
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
            max_length: 800,
            temperature: 0.1
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

function generateFallbackCodeOriginEstimate(analysis: AnalysisResult): {
  estimatedAiGeneratedPercent: number;
  confidence: number;
  summary: string;
  signals: string[];
} {
  const totalNodes = analysis.graph.nodes.length;
  const commentary = analysis.graph.nodes.filter((n) => ((n.data as { comment_ratio?: number } | undefined)?.comment_ratio ?? 0) > 0.3);
  const unusualPatterns = analysis.graph.nodes.filter((n) => Boolean((n.data as { unusual_naming?: boolean } | undefined)?.unusual_naming));

  // Conservative estimate
  const aiEstimate = Math.min(
    30,
    Math.round((commentary.length / Math.max(1, totalNodes)) * 50 + (unusualPatterns.length / Math.max(1, totalNodes)) * 20)
  );

  const signals: string[] = [];
  if (commentary.length > 0) {
    signals.push(`Found ${commentary.length} nodes with high comment ratios`);
  }
  if (unusualPatterns.length > 0) {
    signals.push(`Detected ${unusualPatterns.length} nodes with unusual naming patterns`);
  }
  signals.push("Analysis based on structural heuristics");
  signals.push("Confidence level is conservative estimate");

  return {
    estimatedAiGeneratedPercent: aiEstimate,
    confidence: 45,
    summary: `Based on structural analysis, an estimated ${aiEstimate}% of the code may have been AI-assisted. This is a conservative estimate derived from naming patterns and code structure, not actual content analysis.`,
    signals: signals.slice(0, 4)
  };
}

async function queryHuggingFaceChat(options: {
  token: string;
  model: string;
  userPrompt: string;
}): Promise<string> {
  // This is deprecated but kept for backward compatibility
  return queryHuggingFaceInference(options.token, options.userPrompt);
}
