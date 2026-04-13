import { promises as fs } from "node:fs";
import path from "node:path";

import type { AnalysisResult, ChatMessage, RepoChatResponse, RepoChatSource } from "../../../shared/src/index.js";
import { loadEnvironment } from "../config/env.js";

interface RagChunk {
  id: string;
  path: string;
  text: string;
  preview: string;
  tokenCounts: Map<string, number>;
}

interface RagIndex {
  analysisId: string;
  chunks: RagChunk[];
}

interface HuggingFaceChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "by", "is", "are", "be", "with", "at",
  "from", "this", "that", "it", "as", "if", "can", "you", "we", "our", "about", "what", "which", "who", "when",
  "where", "why", "how", "does", "do", "did", "any", "all", "into", "than", "then", "their", "there", "them"
]);

let ragCache: RagIndex | null = null;

export async function answerRepoQuestion(options: {
  analysis: AnalysisResult;
  question: string;
  history?: ChatMessage[];
}): Promise<RepoChatResponse> {
  loadEnvironment(true);

  const question = options.question.trim();
  if (!question) {
    throw new Error("Question is required.");
  }

  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_TOKEN;
  if (!token) {
    throw new Error("Missing Hugging Face token. Set HF_TOKEN (or HUGGING_FACE_TOKEN) in backend environment.");
  }

  const index = await getOrBuildRagIndex(options.analysis);
  const ranked = rankChunks(index.chunks, question).slice(0, 8);

  const contextBlocks = ranked
    .map((item, indexPosition) => {
      const excerpt = item.chunk.text.length > 1400 ? `${item.chunk.text.slice(0, 1400)}\n...` : item.chunk.text;
      return `Source ${indexPosition + 1} | ${item.chunk.path}\n${excerpt}`;
    })
    .join("\n\n---\n\n");

  const summary = buildSummaryContext(options.analysis);
  const history = (options.history ?? []).slice(-6);
  const userPrompt = [
    "You are a repository expert assistant.",
    "Answer using the provided repository context.",
    "If context is insufficient, state exactly what is missing.",
    "Cite file paths from the source labels when possible.",
    "Keep the response concise and structured.",
    "Use this exact format:",
    "Summary",
    "- 1 to 2 bullets",
    "Key points",
    "- 3 to 5 bullets",
    "Actionable next steps",
    "- 1 to 3 bullets",
    "Do not include long paragraphs.",
    "",
    "Repository summary:",
    summary,
    "",
    "Conversation history:",
    formatHistory(history),
    "",
    "Question:",
    question,
    "",
    "Retrieved context:",
    contextBlocks || "No matching source chunks were retrieved."
  ].join("\n");

  const modelCandidates = [
    process.env.HF_CHAT_MODEL?.trim(),
    "mistralai/Mistral-7B-Instruct-v0.1",
    "meta-llama/Llama-2-7b-chat-hf",
    "HuggingFaceH4/zephyr-7b-beta"
  ].filter((candidate): candidate is string => Boolean(candidate));

  let lastError: Error | null = null;
  for (const model of modelCandidates) {
    try {
      const answer = normalizeStructuredAnswer(await queryHuggingFaceChat({ token, model, userPrompt }));
      const sources: RepoChatSource[] = ranked.map((item) => ({
        path: item.chunk.path,
        score: Number(item.score.toFixed(2)),
        snippet: item.chunk.preview
      }));

      return {
        answer,
        model,
        sources
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Unknown Hugging Face error.");
    }
  }

  throw new Error(lastError?.message ?? "Failed to generate an answer with Hugging Face. Please check your HF_TOKEN and verify it has access to inference models.");
}

async function getOrBuildRagIndex(analysis: AnalysisResult): Promise<RagIndex> {
  if (ragCache && ragCache.analysisId === analysis.id) {
    return ragCache;
  }

  const root = analysis.summary.resolvedPath;
  const fileNodes = analysis.graph.nodes
    .filter((node) => node.type === "File" && typeof node.path === "string")
    .map((node) => node.path as string)
    .sort((left, right) => left.localeCompare(right));

  const chunks: RagChunk[] = [];

  for (const relativePath of fileNodes) {
    const absolutePath = path.resolve(root, relativePath);
    if (!absolutePath.startsWith(root)) {
      continue;
    }

    let content = "";
    try {
      content = await fs.readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    if (!content || content.includes("\u0000")) {
      continue;
    }

    const capped = content.length > 60_000 ? content.slice(0, 60_000) : content;
    const fileChunks = splitIntoChunks(relativePath, capped, 1200, 180);
    chunks.push(...fileChunks);

    if (chunks.length >= 5000) {
      break;
    }
  }

  ragCache = {
    analysisId: analysis.id,
    chunks
  };

  return ragCache;
}

function splitIntoChunks(filePath: string, text: string, maxChars: number, overlap: number): RagChunk[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const chunks: RagChunk[] = [];

  let cursor = 0;
  let chunkIndex = 0;

  while (cursor < lines.length) {
    let size = 0;
    const start = cursor;

    while (cursor < lines.length && size + lines[cursor].length + 1 <= maxChars) {
      size += lines[cursor].length + 1;
      cursor += 1;
    }

    if (cursor === start) {
      cursor += 1;
    }

    const chunkText = lines.slice(start, cursor).join("\n").trim();
    if (chunkText.length > 0) {
      const preview = chunkText.length > 220 ? `${chunkText.slice(0, 220)}...` : chunkText;
      chunks.push({
        id: `${filePath}#${chunkIndex}`,
        path: filePath,
        text: chunkText,
        preview,
        tokenCounts: toTokenCounts(chunkText)
      });
      chunkIndex += 1;
    }

    if (cursor >= lines.length) {
      break;
    }

    const rewindChars = Math.max(0, overlap);
    let rewound = 0;
    while (cursor > start && rewound < rewindChars) {
      cursor -= 1;
      rewound += lines[cursor].length + 1;
    }

    if (cursor <= start) {
      cursor = start + 1;
    }
  }

  return chunks;
}

function toTokenCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  const tokens = tokenize(value);

  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return counts;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function rankChunks(chunks: RagChunk[], question: string): Array<{ chunk: RagChunk; score: number }> {
  const terms = tokenize(question);
  const raw = question.toLowerCase();

  if (terms.length === 0) {
    return chunks.slice(0, 8).map((chunk, index) => ({ chunk, score: 1 / (index + 1) }));
  }

  const scored = chunks
    .map((chunk) => {
      let score = 0;

      for (const term of terms) {
        const frequency = chunk.tokenCounts.get(term) ?? 0;
        score += Math.min(8, frequency) * 2.2;

        if (chunk.path.toLowerCase().includes(term)) {
          score += 2.8;
        }
      }

      if (chunk.path.toLowerCase().includes(raw)) {
        score += 10;
      }

      if (raw.includes("readme") && chunk.path.toLowerCase().includes("readme")) {
        score += 8;
      }

      if (chunk.path.endsWith("package.json")) {
        score += 0.8;
      }

      return { chunk, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored;
}

function buildSummaryContext(analysis: AnalysisResult): string {
  const topDirs = analysis.summary.topDirectories.slice(0, 8).map((directory) => directory.label).join(", ");
  const topContributors = analysis.summary.topContributors.slice(0, 8).map((item) => item.name).join(", ");

  return [
    `Repo: ${analysis.summary.repoName}`,
    `Source: ${analysis.summary.source}`,
    `Nodes: ${analysis.summary.counts.nodes}, Edges: ${analysis.summary.counts.edges}`,
    `Files: ${analysis.summary.counts.files}, Directories: ${analysis.summary.counts.directories}`,
    `Top directories: ${topDirs || "n/a"}`,
    `Top contributors: ${topContributors || "n/a"}`
  ].join("\n");
}

function formatHistory(history: ChatMessage[]): string {
  if (history.length === 0) {
    return "(none)";
  }

  return history
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
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
              temperature: 0.15,
              max_new_tokens: 900
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
                content:
                  "You are an expert codebase assistant. Stay factual, concise, and grounded in repository context. Always output a structured response with short bullet lists under clear section headings."
              },
              {
                role: "user",
                content: options.userPrompt
              }
            ],
            temperature: 0.15,
            max_tokens: 900
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

function normalizeStructuredAnswer(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const hasSections = /summary/i.test(trimmed) && /key points/i.test(trimmed);
  const hasBullets = /^\s*[-*]\s+/m.test(trimmed);

  if (hasSections && hasBullets) {
    return trimmed.replace(/\n{3,}/g, "\n\n");
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const bullets = lines
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, 8);

  const summaryBullets = bullets.slice(0, 2);
  const keyBullets = bullets.slice(2, 7);

  const summarySection = summaryBullets.length > 0
    ? summaryBullets.map((item) => `- ${item}`).join("\n")
    : "- No concise summary could be derived from model output.";

  const keySection = keyBullets.length > 0
    ? keyBullets.map((item) => `- ${item}`).join("\n")
    : "- No additional key points were provided.";

  return [
    "Summary",
    summarySection,
    "",
    "Key points",
    keySection,
    "",
    "Actionable next steps",
    "- Validate the suggested points against the referenced files.",
    "- Ask a follow-up question for deeper technical detail if needed."
  ].join("\n");
}
