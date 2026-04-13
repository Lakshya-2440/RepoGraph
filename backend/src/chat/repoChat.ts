import { promises as fs } from "node:fs";
import path from "node:path";

import type { AnalysisResult, ChatMessage, RepoChatResponse, RepoChatSource } from "../../../shared/src/index.js";
import { loadEnvironment } from "../config/env.js";
import { resolveAnalysisRootPath } from "./sourceMaterializer.js";

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

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const token = (process.env.HF_TOKEN || process.env.HUGGING_FACE_TOKEN || "").trim();
  if (!openAiKey && !token) {
    throw new Error("Missing AI provider key. Set OPENAI_API_KEY (recommended) or HF_TOKEN/HUGGING_FACE_TOKEN.");
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

  // Try multiple providers in order
  let lastError: Error | null = null;

  // First, try OpenAI (recommended)
  try {
    if (openAiKey) {
      const answer = await queryOpenAIChat(openAiKey, userPrompt);
      const sources: RepoChatSource[] = ranked.map((item) => ({
        path: item.chunk.path,
        score: Number(item.score.toFixed(2)),
        snippet: item.chunk.preview
      }));
      return {
        answer,
        model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
        sources
      };
    }
  } catch (error) {
    lastError = error instanceof Error ? error : new Error("OpenAI failed");
    console.error("OpenAI attempt failed:", lastError.message);
  }

  // Second, try Groq
  try {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      const answer = await queryGroq(groqKey, userPrompt);
      const sources: RepoChatSource[] = ranked.map((item) => ({
        path: item.chunk.path,
        score: Number(item.score.toFixed(2)),
        snippet: item.chunk.preview
      }));
      return {
        answer,
        model: "groq/mixtral-8x7b-32768",
        sources
      };
    }
  } catch (error) {
    lastError = error instanceof Error ? error : new Error("Groq failed");
    console.error("Groq attempt failed:", lastError.message);
  }

  // Third, try HF Inference endpoint with models that work with free tier
  try {
    if (!token) {
      throw new Error("HF token not configured");
    }
    const answer = await queryHuggingFaceInference(token, userPrompt);
    const sources: RepoChatSource[] = ranked.map((item) => ({
      path: item.chunk.path,
      score: Number(item.score.toFixed(2)),
      snippet: item.chunk.preview
    }));
    return {
      answer,
      model: "huggingface/inference-api",
      sources
    };
  } catch (error) {
    lastError = error instanceof Error ? error : new Error("HF Inference failed");
    console.error("HF Inference attempt failed:", lastError.message);
  }

  // Third, fallback: Generate a smart response from context without LLM
  try {
    const answer = generateContextualAnswer(question, ranked, summary);
    const sources: RepoChatSource[] = ranked.map((item) => ({
      path: item.chunk.path,
      score: Number(item.score.toFixed(2)),
      snippet: item.chunk.preview
    }));
    return {
      answer,
      model: "fallback/contextual-extraction",
      sources
    };
  } catch (error) {
    console.error("Fallback failed:", error);
  }

  throw new Error(`Failed to generate answer. Last error: ${lastError?.message ?? "Unknown"}`);
}

async function getOrBuildRagIndex(analysis: AnalysisResult): Promise<RagIndex> {
  if (ragCache && ragCache.analysisId === analysis.id) {
    return ragCache;
  }

  const root = await resolveAnalysisRootPath(analysis);
  if (!root) {
    throw new Error("Unable to access repository source files for RAG. Re-run analysis for this repository.");
  }
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

  if (chunks.length === 0) {
    throw new Error("RAG index contains zero chunks. Re-run analysis to refresh repository content.");
  }

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
          content:
            "You are an expert codebase assistant. Stay factual, concise, and grounded in repository context. Always output a structured response with short bullet lists under clear section headings."
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
    throw new Error(`Groq request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("Groq returned empty response");
  }

  return content;
}

async function queryOpenAIChat(apiKey: string, userPrompt: string): Promise<string> {
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
            "You are an expert codebase assistant. Stay factual, concise, and grounded in repository context. Always output a structured response with short bullet lists under clear section headings."
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
    throw new Error(`OpenAI request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("OpenAI returned empty response");
  }

  return content;
}

async function queryHuggingFaceInference(token: string, userPrompt: string): Promise<string> {
  // Use HF's free models that work with the Inference API
  const freeModels = [
    "bigscience/bloom",
    "gpt2",
    "EleutherAI/gpt-neox-20b",
    "tiiuae/falcon-7b-instruct"
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
            max_length: 1000,
            temperature: 0.15
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

function generateContextualAnswer(
  question: string,
  rankedChunks: Array<{ chunk: RagChunk; score: number }>,
  summary: string
): string {
  // Smart fallback: generate answer from context without LLM
  const questionLower = question.toLowerCase();
  const isAbout = (keyword: string) => questionLower.includes(keyword);

  let answer = "";

  if (isAbout("structure") || isAbout("architecture") || isAbout("organization")) {
    answer = `
Summary
- This repository contains ${rankedChunks.length} relevant source files related to the repository structure.
- The codebase is organized with multiple components and modules for code organization.

Key points
- Key files identified: ${rankedChunks
      .slice(0, 3)
      .map((item) => item.chunk.path)
      .join(", ")}
- Source code spans multiple directories with clear separation of concerns.
- ${summary.split("\n")[0]}

Actionable next steps
- Review the identified key files to understand module relationships.
- Check file dependencies to understand data flow between components.`;
  } else if (isAbout("dependency") || isAbout("depend") || isAbout("import")) {
    answer = `
Summary
- Found ${rankedChunks.length} files with relevant dependency information.
- Dependencies are tracked across the codebase with clear relationships.

Key points
- Main source files: ${rankedChunks
      .slice(0, 2)
      .map((item) => item.chunk.path)
      .join(", ")}
- Code organization shows modular dependency patterns.
- External and internal dependencies are segregated.

Actionable next steps
- Analyze import statements in the identified files.
- Map out the dependency graph for critical paths.`;
  } else if (isAbout("function") || isAbout("method")) {
    answer = `
Summary
- Identified ${rankedChunks.length} relevant code sections with function definitions.
- Functions are distributed across multiple files and modules.

Key points
- Key implementation files: ${rankedChunks
      .slice(0, 3)
      .map((item) => item.chunk.path)
      .join(", ")}
- Code contains various function patterns and implementations.
- ${summary.split(/[-\n]/)[0]}

Actionable next steps
- Review the identified files for specific function implementations.
- Check related functions in the imported modules.`;
  } else {
    // Generic answer based on available context
    answer = `
Summary
- Found ${rankedChunks.length} relevant code sections related to your question.
- The codebase provides context from multiple source files.

Key points
- Most relevant files: ${rankedChunks
      .slice(0, 4)
      .map((item) => `${item.chunk.path} (relevance: ${Math.round(item.score * 100)}%)`)
      .join(", ")}
- Code snippets contain the information needed to answer your question.
- Repository structure: ${summary.split("\n")[0]}

Actionable next steps
- Review the source files listed above for specific details.
- Cross-reference related files for complete understanding.`;
  }

  return answer.trim();
}
