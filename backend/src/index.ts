import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import cors from "cors";
import express, { type Request, type Response } from "express";

import type {
  AnalyzeRequest,
  AnalysisResult,
  AuthResponse,
  ChatMessage,
  GraphEdge,
  GraphNode,
  HealthResponse,
  LoginRequest,
  NodeDetailResponse,
  GoogleAuthRequest,
  RegisterResponse,
  RequestEmailVerificationRequest,
  RequestPasswordResetRequest,
  ResetPasswordRequest,
  RepoAiInsightsResponse,
  RepoAiCodeOriginResponse,
  RepoChatRequest,
  RepoChatResponse,
  RegisterRequest,
  SearchResult,
  SubgraphResponse,
  VerifyEmailRequest
} from "../../shared/src/index.js";
import {
  AuthError,
  AuthedRequest,
  getLoginAttemptKey,
  issueAuthToken,
  loginOrRegisterWithGoogle,
  loginUser,
  requestEmailVerification,
  registerUser,
  requestPasswordReset,
  requireAuth,
  resetPasswordByToken,
  verifyEmailByToken
} from "./auth.js";
import { analyzeRepository } from "./analyzer/analyzeRepository.js";
import { estimateCodeOrigin } from "./chat/repoCodeOrigin.js";
import { generateAiInsights } from "./chat/repoAiInsights.js";
import { answerRepoQuestion } from "./chat/repoChat.js";
import { loadEnvironment, validateProductionEnvironment } from "./config/env.js";
import { getDbPool, initializeDatabase } from "./db/index.js";
import { getClientIp, logApiError, logAuthAttempt, logSecurityEvent } from "./logging/security.js";
import { getCurrentAnalysis, hasAnalysisForUser, isAnalysisRunning, loadStoredAnalysis, runAnalysis } from "./store/analysisStore.js";

loadEnvironment();
validateProductionEnvironment();

const app = express();
const port = Number(process.env.PORT ?? 4000);
const frontendDist = path.resolve(process.cwd(), "frontend/dist");
const isProduction = (process.env.NODE_ENV ?? "").toLowerCase() === "production";

const corsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const extraCorsOrigins = (process.env.CORS_ORIGIN_EXTRA ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const allowedCorsOrigins = new Set<string>([...corsOrigins, ...extraCorsOrigins]);
const allowVercelPreviewOrigins = (() => {
  const configured = (process.env.ALLOW_VERCEL_PREVIEW_ORIGINS ?? "").trim().toLowerCase();
  if (!configured) {
    return true;
  }

  return configured === "true";
})();

const appBaseOrigin = (() => {
  const baseUrl = (process.env.APP_BASE_URL ?? "").trim();
  if (!baseUrl) {
    return undefined;
  }

  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
})();

const isLoopbackOrigin = (origin: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
const isVercelPreviewOrigin = (origin: string): boolean => /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
const TRAFFIC_WINDOW_MS = 60_000;
const TRAFFIC_ALERT_THRESHOLD = Number(process.env.TRAFFIC_ALERT_THRESHOLD ?? 300);
const AUTH_FAILURE_ALERT_THRESHOLD = Number(process.env.AUTH_FAILURE_ALERT_THRESHOLD ?? 20);
const API_RATE_LIMIT_WINDOW_MS = 60_000;
const API_RATE_LIMIT_MAX_REQUESTS = Number(process.env.API_RATE_LIMIT_MAX_REQUESTS ?? 240);
const ENUMERATION_ALERT_THRESHOLD = Number(process.env.ENUMERATION_ALERT_THRESHOLD ?? 40);

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

type TrafficWindow = {
  count: number;
  startedAt: number;
  alerted: boolean;
};

type RateLimitState = {
  count: number;
  startedAt: number;
};

type RateLimiterOptions = {
  scope: string;
  windowMs: number;
  maxRequests: number;
  getKey: (request: Request) => string | null;
};

const requestTrafficByIp = new Map<string, TrafficWindow>();
const authFailureByIp = new Map<string, TrafficWindow>();
const apiRequestByIp = new Map<string, TrafficWindow>();
const apiEnumerationByIp = new Map<string, TrafficWindow>();

const loginRateLimiter = createRateLimiter({
  scope: "auth_login",
  windowMs: 15 * MINUTE_MS,
  maxRequests: 30,
  getKey: (request) => {
    const ip = getClientIp(request);
    const email = extractBodyEmail(request);
    return email ? `${ip}::${email}` : ip;
  }
});

const registerRateLimiter = createRateLimiter({
  scope: "auth_register",
  windowMs: HOUR_MS,
  maxRequests: 8,
  getKey: (request) => getClientIp(request)
});

const emailVerificationRateLimiter = createRateLimiter({
  scope: "auth_request_email_verification",
  windowMs: HOUR_MS,
  maxRequests: 12,
  getKey: (request) => {
    const ip = getClientIp(request);
    const email = extractBodyEmail(request);
    return email ? `${ip}::${email}` : ip;
  }
});

const passwordResetRequestLimiter = createRateLimiter({
  scope: "auth_request_password_reset",
  windowMs: HOUR_MS,
  maxRequests: 12,
  getKey: (request) => {
    const ip = getClientIp(request);
    const email = extractBodyEmail(request);
    return email ? `${ip}::${email}` : ip;
  }
});

const passwordResetSubmitLimiter = createRateLimiter({
  scope: "auth_reset_password",
  windowMs: HOUR_MS,
  maxRequests: 20,
  getKey: (request) => getClientIp(request)
});

const googleAuthRateLimiter = createRateLimiter({
  scope: "auth_google",
  windowMs: 15 * MINUTE_MS,
  maxRequests: 30,
  getKey: (request) => getClientIp(request)
});

const analyzeRateLimiter = createRateLimiter({
  scope: "api_analyze",
  windowMs: HOUR_MS,
  maxRequests: 20,
  getKey: getAuthedUserKey
});

const searchRateLimiter = createRateLimiter({
  scope: "api_search",
  windowMs: MINUTE_MS,
  maxRequests: 180,
  getKey: getAuthedUserKey
});

const nodeReadRateLimiter = createRateLimiter({
  scope: "api_nodes",
  windowMs: MINUTE_MS,
  maxRequests: 180,
  getKey: getAuthedUserKey
});

const fileReadRateLimiter = createRateLimiter({
  scope: "api_file_content",
  windowMs: MINUTE_MS,
  maxRequests: 90,
  getKey: getAuthedUserKey
});

const subgraphRateLimiter = createRateLimiter({
  scope: "api_subgraph",
  windowMs: MINUTE_MS,
  maxRequests: 120,
  getKey: getAuthedUserKey
});

const aiChatRateLimiter = createRateLimiter({
  scope: "api_ai_chat",
  windowMs: HOUR_MS,
  maxRequests: 80,
  getKey: getAuthedUserKey
});

const aiInsightsRateLimiter = createRateLimiter({
  scope: "api_ai_insights",
  windowMs: HOUR_MS,
  maxRequests: 30,
  getKey: getAuthedUserKey
});

const aiCodeOriginRateLimiter = createRateLimiter({
  scope: "api_ai_code_origin",
  windowMs: HOUR_MS,
  maxRequests: 30,
  getKey: getAuthedUserKey
});

await loadStoredAnalysis();
await initializeDatabase();

app.set("trust proxy", 1);
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");

  if (isProduction) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  next();
});

app.use((request, response, next) => {
  if (!isProduction) {
    next();
    return;
  }

  const forwardedProto = `${request.headers["x-forwarded-proto"] ?? ""}`.split(",")[0].trim().toLowerCase();
  const isSecure = request.secure || forwardedProto === "https";
  if (isSecure) {
    next();
    return;
  }

  response.status(426).json({ error: "HTTPS is required." });
});

app.use("/api", (request, response, next) => {
  if (request.path === "/ready") {
    next();
    return;
  }

  const key = getClientIp(request);
  const current = incrementWindow(apiRequestByIp, key, API_RATE_LIMIT_WINDOW_MS);
  const dynamicLimit = isLikelyAutomatedClient(request)
    ? Math.max(1, Math.floor(API_RATE_LIMIT_MAX_REQUESTS / 2))
    : API_RATE_LIMIT_MAX_REQUESTS;

  if (current.count > dynamicLimit) {
    const retryAfterSeconds = Math.max(1, Math.ceil(API_RATE_LIMIT_WINDOW_MS / 1000));
    response.setHeader("Retry-After", String(retryAfterSeconds));
    logSecurityEvent("api_rate_limited", {
      ip: key,
      method: request.method,
      path: request.path,
      threshold: dynamicLimit,
      windowMs: API_RATE_LIMIT_WINDOW_MS,
      automatedClient: isLikelyAutomatedClient(request)
    });
    response.status(429).json({ error: "Too many requests. Please try again later." });
    return;
  }

  next();
});

app.use((request, response, next) => {
  const ip = getClientIp(request);
  const startedAt = Date.now();
  const traffic = incrementWindow(requestTrafficByIp, ip, TRAFFIC_WINDOW_MS);

  if (!traffic.alerted && traffic.count >= TRAFFIC_ALERT_THRESHOLD) {
    traffic.alerted = true;
    logSecurityEvent("traffic_spike", {
      ip,
      count: traffic.count,
      windowMs: TRAFFIC_WINDOW_MS,
      method: request.method,
      path: request.path
    });
  }

  response.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    if (response.statusCode >= 500) {
      logApiError(request, new Error(`Unexpected ${response.statusCode} response`), {
        statusCode: response.statusCode,
        durationMs
      });
    }

    if (response.statusCode === 401 || response.statusCode === 403) {
      const failures = incrementWindow(authFailureByIp, ip, TRAFFIC_WINDOW_MS);
      if (!failures.alerted && failures.count >= AUTH_FAILURE_ALERT_THRESHOLD) {
        failures.alerted = true;
        logSecurityEvent("auth_failures_spike", {
          ip,
          count: failures.count,
          windowMs: TRAFFIC_WINDOW_MS,
          path: request.path,
          statusCode: response.statusCode
        });
      }
    }

    if (response.statusCode === 404 && request.path.startsWith("/api")) {
      const enumeration = incrementWindow(apiEnumerationByIp, ip, TRAFFIC_WINDOW_MS);
      if (!enumeration.alerted && enumeration.count >= ENUMERATION_ALERT_THRESHOLD) {
        enumeration.alerted = true;
        logSecurityEvent("api_enumeration_spike", {
          ip,
          count: enumeration.count,
          windowMs: TRAFFIC_WINDOW_MS,
          method: request.method,
          path: request.path,
          userAgent: `${request.headers["user-agent"] ?? ""}`.slice(0, 160)
        });
      }
    }
  });

  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (
        allowedCorsOrigins.has(origin) ||
        origin === appBaseOrigin ||
        isLoopbackOrigin(origin) ||
        (allowVercelPreviewOrigins && isVercelPreviewOrigin(origin)) ||
        (!isProduction && allowedCorsOrigins.size === 0)
      ) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    credentials: true
  })
);

app.use((request, response, next) => {
  const contentType = `${request.headers["content-type"] ?? ""}`.toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    response.status(415).json({ error: "File uploads are not supported." });
    return;
  }

  next();
});

app.use(express.json({ limit: "2mb" }));

app.get("/api/ready", (_request, response) => {
  response.json({ status: "ok" });
});

app.get("/api/health", requireAuth, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const hasAnyAnalysis = await hasAnalysisForUser(user.id);

  const payload: HealthResponse = {
    status: "ok",
    hasAnalysis: hasAnyAnalysis,
    analyzing: isAnalysisRunning(user.id)
  };

  response.json(payload);
});

app.post("/api/auth/register", registerRateLimiter, async (request, response) => {
  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const email = getValidatedEmail(body.email, response);
  const password = getValidatedPassword(body.password, response);
  if (!email || !password) {
    return;
  }

  try {
    await registerUser(email, password);
    logAuthAttempt("register_success", request, email);
    response.status(201).json({
      message: "Account created. Please verify your email before signing in."
    } satisfies RegisterResponse);
  } catch (error) {
    logAuthAttempt("register_failed", request, email, error);
    respondWithAuthError(response, error, 400, "Registration failed.");
  }
});

app.post("/api/auth/login", loginRateLimiter, async (request, response) => {
  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const email = getValidatedEmail(body.email, response);
  const password = getValidatedPassword(body.password, response);
  if (!email || !password) {
    return;
  }

  try {
    const user = await loginUser(email, password, getLoginAttemptKey(request, email));
    const token = issueAuthToken(user);
    logAuthAttempt("login_success", request, email);
    response.json({ token, user });
  } catch (error) {
    logAuthAttempt("login_failed", request, `${body.email ?? ""}`, error);
    respondWithAuthError(response, error, 401, "Login failed.");
  }
});

app.post("/api/auth/request-email-verification", emailVerificationRateLimiter, async (request, response) => {
  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const email = getValidatedEmail(body.email, response);
  if (!email) {
    return;
  }

  try {
    await requestEmailVerification(email);
    logAuthAttempt("verify_email_requested", request, email);
  } finally {
    response.json({ message: "If the account exists, a verification email has been sent." });
  }
});

app.post("/api/auth/google", googleAuthRateLimiter, async (request, response) => {
  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const idToken = getValidatedGoogleIdToken(body.idToken, response);
  if (!idToken) {
    return;
  }

  try {
    const user = await loginOrRegisterWithGoogle(idToken);
    const token = issueAuthToken(user);
    logAuthAttempt("google_auth_success", request, user.email);
    response.json({ token, user } satisfies AuthResponse);
  } catch (error) {
    logAuthAttempt("google_auth_failed", request, undefined, error);
    response.status(401).json({
      error: error instanceof Error
        ? `Google authentication failed: ${error.message}`
        : "Google authentication failed."
    });
  }
});

app.post("/api/auth/verify-email", async (request, response) => {
  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const token = getValidatedOpaqueToken(body.token, "Verification token", response);
  if (!token) {
    return;
  }

  try {
    await verifyEmailByToken(token);
    logAuthAttempt("verify_email_success", request);
    response.json({ message: "Email verified successfully." });
  } catch (error) {
    logAuthAttempt("verify_email_failed", request, undefined, error);
    response.status(400).json({ error: error instanceof Error ? error.message : "Email verification failed." });
  }
});

app.post("/api/auth/request-password-reset", passwordResetRequestLimiter, async (request, response) => {
  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const email = getValidatedEmail(body.email, response);
  if (!email) {
    return;
  }

  try {
    await requestPasswordReset(email);
    logAuthAttempt("password_reset_requested", request, email);
  } finally {
    response.json({ message: "If the account exists, a password reset link has been sent." });
  }
});

app.post("/api/auth/reset-password", passwordResetSubmitLimiter, async (request, response) => {
  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const token = getValidatedOpaqueToken(body.token, "Reset token", response);
  const newPassword = getValidatedPassword(body.newPassword, response);
  if (!token || !newPassword) {
    return;
  }

  try {
    await resetPasswordByToken(token, newPassword);
    logAuthAttempt("password_reset_success", request);
    response.json({ message: "Password reset successful." });
  } catch (error) {
    logAuthAttempt("password_reset_failed", request, undefined, error);
    response.status(400).json({ error: error instanceof Error ? error.message : "Password reset failed." });
  }
});

app.get("/api/auth/me", requireAuth, async (request, response) => {
  const authed = request as AuthedRequest;
  if (!authed.user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  response.json({ user: authed.user });
});

app.get("/api/current", requireAuth, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const current = await getCurrentAnalysis(user.id);

  if (!current) {
    response.status(404).json({ error: "No analysis has been generated yet." });
    return;
  }

  response.json(current);
});

app.post("/api/analyze", requireAuth, analyzeRateLimiter, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const source = getValidatedSource(body.source, response);
  const ref = getValidatedRef(body.ref, response);
  if (!source || ref === null) {
    return;
  }

  try {
    const analysis = await runAnalysis(user.id, () => analyzeRepository({ source, ref }));
    response.json(analysis);
  } catch (error) {
    logApiError(request, error, { route: "/api/analyze" });
    response.status(500).json({
      error: error instanceof Error ? error.message : "Analysis failed."
    });
  }
});

app.get("/api/search", requireAuth, searchRateLimiter, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const analysis = await getCurrentAnalysis(user.id);
  if (!analysis) {
    response.status(404).json({ error: "No analysis available." });
    return;
  }

  const query = getValidatedSearchQuery(request.query.q, response);
  if (query === null) {
    return;
  }
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

app.get("/api/nodes/:nodeId", requireAuth, nodeReadRateLimiter, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const analysis = await getCurrentAnalysis(user.id);
  if (!analysis) {
    response.status(404).json({ error: "No analysis available." });
    return;
  }

  const nodeId = getValidatedNodeId(request.params.nodeId, response);
  if (!nodeId) {
    return;
  }
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

app.get("/api/file-content", requireAuth, fileReadRateLimiter, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const analysis = await getCurrentAnalysis(user.id);
  if (!analysis) {
    response.status(404).json({ error: "No analysis available." });
    return;
  }

  const filePath = getValidatedFilePathQuery(request.query.path, response);
  if (!filePath) {
    return;
  }

  const fileNode = analysis.graph.nodes.find((node) => node.type === "File" && node.path === filePath);
  if (!fileNode?.path) {
    response.status(404).json({ error: "File not found in current analysis." });
    return;
  }

  const repoRoot = path.resolve(analysis.summary.resolvedPath);
  const resolved = path.resolve(repoRoot, fileNode.path);
  const relativeToRepo = path.relative(repoRoot, resolved);

  // Prevent directory traversal
  if (relativeToRepo.startsWith("..") || path.isAbsolute(relativeToRepo)) {
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
    const ext = path.extname(fileNode.path).replace(".", "").toLowerCase();
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

app.get("/api/subgraph", requireAuth, subgraphRateLimiter, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const analysis = await getCurrentAnalysis(user.id);
  if (!analysis) {
    response.status(404).json({ error: "No analysis available." });
    return;
  }

  const nodeId = getValidatedNodeId(request.query.nodeId, response);
  if (!nodeId) {
    return;
  }

  const depth = getValidatedNumberQuery(request.query.depth, 1, 1, 4, response, "depth");
  const limit = getValidatedNumberQuery(request.query.limit, 80, 10, 200, response, "limit");
  if (depth === null || limit === null) {
    return;
  }
  const subgraph = buildSubgraph(analysis, nodeId, depth, limit);

  if (!subgraph) {
    response.status(404).json({ error: "Node not found." });
    return;
  }

  response.json(subgraph satisfies SubgraphResponse);
});

app.post("/api/chat", requireAuth, aiChatRateLimiter, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const analysis = await getCurrentAnalysis(user.id);
  if (!analysis) {
    response.status(404).json({ error: "No analysis available. Run analysis first." });
    return;
  }

  const body = parseObjectBody(request.body, response);
  if (!body) {
    return;
  }

  const question = getValidatedQuestion(body.question, response);
  if (!question) {
    return;
  }

  const history = sanitizeHistory(body.history);

  try {
    const result = await answerRepoQuestion({
      analysis,
      question,
      history
    });

    await getDbPool().query(
      `
        INSERT INTO ai_events(user_id, event_type, payload)
        VALUES($1, $2, $3::jsonb)
      `,
      [user.id, "chat", JSON.stringify({ question, model: result.model, sourceCount: result.sources.length })]
    );

    response.json(result satisfies RepoChatResponse);
  } catch (error) {
    logApiError(request, error, { route: "/api/chat" });
    response.status(500).json({
      error: error instanceof Error ? error.message : "Chat request failed."
    });
  }
});

app.post("/api/insights/ai", requireAuth, aiInsightsRateLimiter, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const analysis = await getCurrentAnalysis(user.id);
  if (!analysis) {
    response.status(404).json({ error: "No analysis available. Run analysis first." });
    return;
  }

  try {
    const payload = await generateAiInsights({ analysis });

    await getDbPool().query(
      `
        INSERT INTO ai_events(user_id, event_type, payload)
        VALUES($1, $2, $3::jsonb)
      `,
      [user.id, "insights", JSON.stringify({ model: payload.model, insightCount: payload.insights.length })]
    );

    response.json(payload satisfies RepoAiInsightsResponse);
  } catch (error) {
    logApiError(request, error, { route: "/api/insights/ai" });
    response.status(500).json({
      error: error instanceof Error ? error.message : "Failed to generate AI insights."
    });
  }
});

app.post("/api/ai/code-origin", requireAuth, aiCodeOriginRateLimiter, async (request, response) => {
  const authed = request as AuthedRequest;
  const user = authed.user;
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  const analysis = await getCurrentAnalysis(user.id);
  if (!analysis) {
    response.status(404).json({ error: "No analysis available. Run analysis first." });
    return;
  }

  try {
    const payload = await estimateCodeOrigin({ analysis });

    await getDbPool().query(
      `
        INSERT INTO ai_events(user_id, event_type, payload)
        VALUES($1, $2, $3::jsonb)
      `,
      [
        user.id,
        "code-origin",
        JSON.stringify({
          model: payload.model,
          estimatedAiGeneratedPercent: payload.estimatedAiGeneratedPercent,
          confidence: payload.confidence
        })
      ]
    );

    response.json(payload satisfies RepoAiCodeOriginResponse);
  } catch (error) {
    logApiError(request, error, { route: "/api/ai/code-origin" });
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
      clean.push({ role, content: sanitizePlainText(content, 4000) });
    }
  }

  return clean.slice(-12);
}

function respondWithAuthError(
  response: Response,
  error: unknown,
  fallbackStatus: number,
  fallbackMessage: string
): void {
  if (error instanceof AuthError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }

  response.status(fallbackStatus).json({ error: error instanceof Error ? error.message : fallbackMessage });
}

function parseObjectBody(body: unknown, response: Response): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    response.status(400).json({ error: "Request body must be a JSON object." });
    return null;
  }

  return body as Record<string, unknown>;
}

function sanitizePlainText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
}

function getValidatedEmail(input: unknown, response: Response): string | null {
  if (typeof input !== "string") {
    response.status(400).json({ error: "Email is required." });
    return null;
  }

  const email = sanitizePlainText(input.toLowerCase(), 320);
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    response.status(400).json({ error: "Valid email is required." });
    return null;
  }

  return email;
}

function getValidatedPassword(input: unknown, response: Response): string | null {
  if (typeof input !== "string") {
    response.status(400).json({ error: "Password is required." });
    return null;
  }

  const password = input.trim();
  if (password.length < 8 || password.length > 128) {
    response.status(400).json({ error: "Password must be between 8 and 128 characters." });
    return null;
  }

  return password;
}

function getValidatedOpaqueToken(input: unknown, label: string, response: Response): string | null {
  if (typeof input !== "string") {
    response.status(400).json({ error: `${label} is required.` });
    return null;
  }

  const token = sanitizePlainText(input, 512);
  if (!/^[A-Za-z0-9._~+/=-]{20,512}$/.test(token)) {
    response.status(400).json({ error: `${label} is invalid.` });
    return null;
  }

  return token;
}

function getValidatedGoogleIdToken(input: unknown, response: Response): string | null {
  return getValidatedOpaqueToken(input, "Google ID token", response);
}

function getValidatedSource(input: unknown, response: Response): string | null {
  if (typeof input !== "string") {
    response.status(400).json({ error: "A source path or GitHub URL is required." });
    return null;
  }

  const source = sanitizePlainText(input, 2048);
  if (!source) {
    response.status(400).json({ error: "A source path or GitHub URL is required." });
    return null;
  }

  return source;
}

function getValidatedRef(input: unknown, response: Response): string | undefined | null {
  if (typeof input === "undefined" || input === null || input === "") {
    return undefined;
  }

  if (typeof input !== "string") {
    response.status(400).json({ error: "ref must be a string." });
    return null;
  }

  const ref = sanitizePlainText(input, 256);
  if (!/^[A-Za-z0-9._\/-]+$/.test(ref)) {
    response.status(400).json({ error: "ref contains invalid characters." });
    return null;
  }

  return ref;
}

function getValidatedSearchQuery(input: unknown, response: Response): string | null {
  if (typeof input === "undefined" || input === null) {
    return "";
  }

  if (typeof input !== "string") {
    response.status(400).json({ error: "q must be a string." });
    return null;
  }

  return sanitizePlainText(input.toLowerCase(), 200);
}

function getValidatedNodeId(input: unknown, response: Response): string | null {
  if (typeof input !== "string") {
    response.status(400).json({ error: "nodeId is required." });
    return null;
  }

  const nodeId = sanitizePlainText(input, 300);
  if (!/^[A-Za-z0-9:_./-]{1,300}$/.test(nodeId)) {
    response.status(400).json({ error: "nodeId is invalid." });
    return null;
  }

  return nodeId;
}

function getValidatedFilePathQuery(input: unknown, response: Response): string | null {
  if (typeof input !== "string") {
    response.status(400).json({ error: "path query parameter is required." });
    return null;
  }

  const filePath = sanitizePlainText(input, 1024);
  if (!filePath) {
    response.status(400).json({ error: "path query parameter is required." });
    return null;
  }

  if (filePath.includes("\\") || filePath.includes("..") || filePath.startsWith("/")) {
    response.status(400).json({ error: "path is invalid." });
    return null;
  }

  if (!/^[A-Za-z0-9._\/-]+$/.test(filePath)) {
    response.status(400).json({ error: "path contains invalid characters." });
    return null;
  }

  return filePath;
}

function getValidatedQuestion(input: unknown, response: Response): string | null {
  if (typeof input !== "string") {
    response.status(400).json({ error: "Question is required." });
    return null;
  }

  const question = sanitizePlainText(input, 2000);
  if (!question) {
    response.status(400).json({ error: "Question is required." });
    return null;
  }

  return question;
}

function getValidatedNumberQuery(
  input: unknown,
  fallback: number,
  min: number,
  max: number,
  response: Response,
  fieldName: string
): number | null {
  if (typeof input === "undefined" || input === null || input === "") {
    return fallback;
  }

  if (Array.isArray(input)) {
    response.status(400).json({ error: `${fieldName} must be a number.` });
    return null;
  }

  const value = Number(input);
  if (!Number.isFinite(value)) {
    response.status(400).json({ error: `${fieldName} must be a number.` });
    return null;
  }

  const normalized = Math.trunc(value);
  if (normalized < min || normalized > max) {
    response.status(400).json({ error: `${fieldName} must be between ${min} and ${max}.` });
    return null;
  }

  return normalized;
}

function getAuthedUserKey(request: Request): string | null {
  const user = (request as AuthedRequest).user;
  if (!user) {
    return null;
  }

  return `user:${user.id}`;
}

function extractBodyEmail(request: Request): string | undefined {
  const body = request.body as { email?: unknown } | undefined;
  if (!body || typeof body.email !== "string") {
    return undefined;
  }

  const normalized = body.email.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function createRateLimiter(options: RateLimiterOptions): express.RequestHandler {
  const stateByKey = new Map<string, RateLimitState>();

  return (request, response, next) => {
    const key = options.getKey(request);
    if (!key) {
      next();
      return;
    }

    // Tighten request ceilings for scripted clients likely to scrape data.
    const dynamicMax = isLikelyAutomatedClient(request)
      ? Math.max(1, Math.floor(options.maxRequests / 2))
      : options.maxRequests;

    const now = Date.now();
    const current = stateByKey.get(key);
    if (!current || now - current.startedAt >= options.windowMs) {
      stateByKey.set(key, { count: 1, startedAt: now });
      next();
      return;
    }

    if (current.count >= dynamicMax) {
      const retryAfterSeconds = Math.max(1, Math.ceil((options.windowMs - (now - current.startedAt)) / 1000));
      response.setHeader("Retry-After", String(retryAfterSeconds));

      logSecurityEvent("rate_limited", {
        scope: options.scope,
        ip: getClientIp(request),
        path: request.path,
        method: request.method,
        userKey: key.startsWith("user:") ? key : undefined,
        threshold: dynamicMax,
        windowMs: options.windowMs,
        automatedClient: isLikelyAutomatedClient(request)
      });

      response.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }

    current.count += 1;
    next();
  };
}

function isLikelyAutomatedClient(request: Request): boolean {
  const userAgent = `${request.headers["user-agent"] ?? ""}`.toLowerCase();
  if (!userAgent) {
    return true;
  }

  return /curl|wget|python|scrapy|aiohttp|httpclient|okhttp|bot|crawler|spider/i.test(userAgent);
}

function incrementWindow(store: Map<string, TrafficWindow>, key: string, windowMs: number): TrafficWindow {
  const now = Date.now();
  const current = store.get(key);
  if (!current || now - current.startedAt > windowMs) {
    const resetWindow: TrafficWindow = { count: 1, startedAt: now, alerted: false };
    store.set(key, resetWindow);
    return resetWindow;
  }

  current.count += 1;
  return current;
}
