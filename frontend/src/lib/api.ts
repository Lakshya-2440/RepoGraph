import type {
  AnalysisResult,
  AuthResponse,
  AuthUser,
  ChatMessage,
  HealthResponse,
  LoginRequest,
  NodeDetailResponse,
  RequestPasswordResetRequest,
  ResetPasswordRequest,
  RegisterRequest,
  RepoAiCodeOriginResponse,
  RepoAiInsightsResponse,
  RepoChatResponse,
  VerifyEmailRequest,
  GoogleAuthRequest,
  SearchResult
} from "@shared/index";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const AUTH_TOKEN_KEY = "repograph_auth_token";

export function getAuthToken(): string | null {
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  window.localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
}

export async function register(request: RegisterRequest): Promise<AuthResponse> {
  const payload = await requestApi<AuthResponse>("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });

  setAuthToken(payload.token);
  return payload;
}

export async function login(request: LoginRequest): Promise<AuthResponse> {
  const payload = await requestApi<AuthResponse>("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });

  setAuthToken(payload.token);
  return payload;
}

export async function loginWithGoogle(request: GoogleAuthRequest): Promise<AuthResponse> {
  const payload = await requestApi<AuthResponse>("/api/auth/google", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  }, false);

  setAuthToken(payload.token);
  return payload;
}

export async function fetchMe(): Promise<AuthUser> {
  const payload = await requestApi<{ user: AuthUser }>("/api/auth/me");
  return payload.user;
}

export async function verifyEmail(request: VerifyEmailRequest): Promise<{ message: string }> {
  return requestApi<{ message: string }>("/api/auth/verify-email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  }, false);
}

export async function requestPasswordReset(request: RequestPasswordResetRequest): Promise<{ message: string }> {
  return requestApi<{ message: string }>("/api/auth/request-password-reset", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  }, false);
}

export async function resetPassword(request: ResetPasswordRequest): Promise<{ message: string }> {
  return requestApi<{ message: string }>("/api/auth/reset-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  }, false);
}

export async function fetchHealth(): Promise<HealthResponse> {
  return requestApi<HealthResponse>("/api/health", undefined, false);
}

export async function fetchCurrentAnalysis(): Promise<AnalysisResult> {
  return requestApi<AnalysisResult>("/api/current");
}

export async function analyzeSource(source: string, ref?: string): Promise<AnalysisResult> {
  return requestApi<AnalysisResult>("/api/analyze", {
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
  return requestApi<SearchResult[]>(`/api/search?${params.toString()}`);
}

export async function fetchNodeDetails(nodeId: string): Promise<NodeDetailResponse> {
  return requestApi<NodeDetailResponse>(`/api/nodes/${encodeURIComponent(nodeId)}`);
}

export async function fetchFileContent(filePath: string): Promise<{ content: string; language: string }> {
  const params = new URLSearchParams({ path: filePath });
  return requestApi<{ content: string; language: string }>(`/api/file-content?${params.toString()}`);
}

export async function askRepoQuestion(question: string, history?: ChatMessage[]): Promise<RepoChatResponse> {
  return requestApi<RepoChatResponse>("/api/chat", {
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
  return requestApi<RepoAiInsightsResponse>("/api/insights/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  });
}

export async function fetchAiCodeOriginEstimate(): Promise<RepoAiCodeOriginResponse> {
  return requestApi<RepoAiCodeOriginResponse>("/api/ai/code-origin", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    }
  });
}

async function requestApi<T>(pathname: string, init?: RequestInit, includeAuth = true): Promise<T> {
  const headers = new Headers(init?.headers ?? {});
  if (includeAuth) {
    const token = getAuthToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const response = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers
  });

  const responseText = await response.text();
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const parseJson = <U>() => {
    if (!responseText.trim()) {
      throw new Error("Empty response from server.");
    }

    if (!contentType.includes("application/json")) {
      throw new Error("Server returned a non-JSON response.");
    }

    return JSON.parse(responseText) as U;
  };

  if (!response.ok) {
    const fallbackMessage = `${response.status} ${response.statusText}`;

    try {
      const payload = parseJson<{ error?: string }>();
      throw new Error(payload.error ?? fallbackMessage);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }

      throw new Error(fallbackMessage);
    }
  }

  return parseJson<T>();
}
