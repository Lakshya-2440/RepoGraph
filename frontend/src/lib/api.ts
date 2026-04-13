import type {
  AnalysisResult,
  AuthResponse,
  AuthUser,
  ChatMessage,
  HealthResponse,
  LoginRequest,
  NodeDetailResponse,
  RegisterResponse,
  RequestEmailVerificationRequest,
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

function sanitizeClientText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeOptionalClientText(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  const normalized = sanitizeClientText(value, maxLength);
  return normalized.length > 0 ? normalized : undefined;
}

export function getAuthToken(): string | null {
  const sessionToken = window.sessionStorage.getItem(AUTH_TOKEN_KEY);
  if (sessionToken) {
    return sessionToken;
  }

  const legacyLocalToken = window.localStorage.getItem(AUTH_TOKEN_KEY);
  if (!legacyLocalToken) {
    return null;
  }

  window.sessionStorage.setItem(AUTH_TOKEN_KEY, legacyLocalToken);
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
  return legacyLocalToken;
}

export function setAuthToken(token: string): void {
  window.sessionStorage.setItem(AUTH_TOKEN_KEY, token);
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
}

export function clearAuthToken(): void {
  window.sessionStorage.removeItem(AUTH_TOKEN_KEY);
  window.localStorage.removeItem(AUTH_TOKEN_KEY);
}

export async function register(request: RegisterRequest): Promise<RegisterResponse> {
  return requestApi<RegisterResponse>("/api/auth/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });
}

export async function requestEmailVerification(request: RequestEmailVerificationRequest): Promise<{ message: string }> {
  return requestApi<{ message: string }>("/api/auth/request-email-verification", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  }, false);
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
  return requestApi<HealthResponse>("/api/health");
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
      source: sanitizeClientText(source, 2048),
      ref: normalizeOptionalClientText(ref, 256)
    })
  });
}

export async function searchNodes(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: sanitizeClientText(query, 200) });
  return requestApi<SearchResult[]>(`/api/search?${params.toString()}`);
}

export async function fetchNodeDetails(nodeId: string): Promise<NodeDetailResponse> {
  return requestApi<NodeDetailResponse>(`/api/nodes/${encodeURIComponent(sanitizeClientText(nodeId, 300))}`);
}

export async function fetchFileContent(filePath: string): Promise<{ content: string; language: string }> {
  const params = new URLSearchParams({ path: sanitizeClientText(filePath, 1024) });
  return requestApi<{ content: string; language: string }>(`/api/file-content?${params.toString()}`);
}

export async function askRepoQuestion(question: string, history?: ChatMessage[]): Promise<RepoChatResponse> {
  return requestApi<RepoChatResponse>("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      question: sanitizeClientText(question, 2000),
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
