import type {
  AnalysisResult,
  ChatMessage,
  HealthResponse,
  NodeDetailResponse,
  RepoAiCodeOriginResponse,
  RepoAiInsightsResponse,
  RepoChatResponse,
  SearchResult
} from "@shared/index";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

export async function fetchCurrentAnalysis(): Promise<AnalysisResult> {
  return request<AnalysisResult>("/api/current");
}

export async function analyzeSource(source: string, ref?: string): Promise<AnalysisResult> {
  return request<AnalysisResult>("/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      source,
      ref
    })
  });
}

export async function searchNodes(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  return request<SearchResult[]>(`/api/search?${params.toString()}`);
}

export async function fetchNodeDetails(nodeId: string): Promise<NodeDetailResponse> {
  return request<NodeDetailResponse>(`/api/nodes/${encodeURIComponent(nodeId)}`);
}

export async function fetchFileContent(filePath: string): Promise<{ content: string; language: string }> {
  const params = new URLSearchParams({ path: filePath });
  return request<{ content: string; language: string }>(`/api/file-content?${params.toString()}`);
}

export async function askRepoQuestion(question: string, history?: ChatMessage[]): Promise<RepoChatResponse> {
  return request<RepoChatResponse>("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      question,
      history
    })
  });
}

export async function fetchAiInsights(): Promise<RepoAiInsightsResponse> {
  return request<RepoAiInsightsResponse>("/api/insights/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  });
}

export async function fetchAiCodeOriginEstimate(): Promise<RepoAiCodeOriginResponse> {
  return request<RepoAiCodeOriginResponse>("/api/ai/code-origin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  });
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${pathname}`, init);

  if (!response.ok) {
    const fallbackMessage = `${response.status} ${response.statusText}`;

    try {
      const payload = (await response.json()) as { error?: string };
      throw new Error(payload.error ?? fallbackMessage);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }

      throw new Error(fallbackMessage);
    }
  }

  return (await response.json()) as T;
}
