import { promises as fs } from "node:fs";
import path from "node:path";

import type { AnalysisResult, RepoAiCodeOriginResponse } from "../../../shared/src/index.js";
import { loadEnvironment } from "../config/env.js";

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

  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_TOKEN;
  if (!token) {
    throw new Error("Missing Hugging Face token. Set HF_TOKEN (or HUGGING_FACE_TOKEN) in backend environment.");
  }

  const modelCandidates = [
    process.env.HF_CHAT_MODEL?.trim(),
    "mistralai/Mistral-7B-Instruct-v0.1",
    "meta-llama/Llama-2-7b-chat-hf",
    "HuggingFaceH4/zephyr-7b-beta"
  ].filter((candidate): candidate is string => Boolean(candidate));

  const prompt = await buildPrompt(options.analysis);

  let lastError: Error | null = null;
  for (const model of modelCandidates) {
    try {
      const content = await queryHuggingFaceChat({ token, model, userPrompt: prompt });
      const parsed = parseResponse(content);
      return {
        model,
        generatedAt: new Date().toISOString(),
        estimatedAiGeneratedPercent: clampPercent(parsed.estimatedAiGeneratedPercent ?? 0),
        confidence: clampPercent(parsed.confidence ?? 60),
        summary: `${parsed.summary ?? "No summary provided."}`.trim(),
        signals: (parsed.signals ?? []).map((signal) => `${signal}`.trim()).filter(Boolean).slice(0, 6)
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown code-origin estimation error.");
    }
  }

  throw new Error(lastError?.message ?? "Failed to estimate AI-generated code ratio.");
}

async function buildPrompt(analysis: AnalysisResult): Promise<string> {
  const root = analysis.summary.resolvedPath;
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

async function queryHuggingFaceChat(options: {
  token: string;
  model: string;
  userPrompt: string;
}): Promise<string> {
  // Try using the Hugging Face Inference API directly for more reliable access
  const endpoints = [
    `https://api-inference.huggingface.co/models/${options.model}`,
    "https://router.huggingface.co/v1/chat/completions"
  ];

  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      if (endpoint.includes("api-inference")) {
        // Use the direct inference API format
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.token}`
          },
          body: JSON.stringify({
            inputs: options.userPrompt,
            parameters: {
              temperature: 0.1,
              max_new_tokens: 700
            }
          })
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`HF API failed (${response.status}): ${body.slice(0, 200)}`);
        }

        const payload = await response.json() as Array<{ generated_text?: string }>;
        const content = payload?.[0]?.generated_text?.trim();

        if (!content) {
          throw new Error("HF API returned empty response");
        }

        return content;
      } else {
        // Fall back to router endpoint format
        const response = await fetch(endpoint, {
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
                content: "You are a careful software forensics assistant. Produce conservative probability estimates only."
              },
              {
                role: "user",
                content: options.userPrompt
              }
            ],
            temperature: 0.1,
            max_tokens: 700
          })
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Router failed (${response.status}): ${body.slice(0, 200)}`);
        }

        const payload = (await response.json()) as HuggingFaceChatResponse;
        const content = payload.choices?.[0]?.message?.content?.trim();

        if (!content) {
          throw new Error("Router returned empty response");
        }

        return content;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown error");
      continue;
    }
  }

  throw lastError ?? new Error("All HF endpoints failed");
}
