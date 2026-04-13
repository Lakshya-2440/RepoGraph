export const NODE_TYPES = [
  "Repo",
  "Directory",
  "File",
  "Function",
  "Class",
  "Method",
  "Variable",
  "Import",
  "Type",
  "Package",
  "Dependency",
  "Commit",
  "User",
  "Issue",
  "PullRequest",
  "Comment"
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  "contains",
  "parent_of",
  "imports",
  "calls",
  "inherits",
  "references",
  "defines",
  "depends_on",
  "dev_depends_on",
  "authored_by",
  "changed_in",
  "blamed_to",
  "opened_by",
  "assignee",
  "fixes",
  "reviewed_by",
  "comment_on",
  "related_to",
  "implements",
  "similar_to"
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];
export type SourceType = "local" | "github";
export type InsightKind = "info" | "warning" | "success";

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  path?: string;
  parentId?: string;
  metrics?: {
    inbound: number;
    outbound: number;
    size?: number;
    commits?: number;
    lastTouchedAt?: string;
  };
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  data?: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Insight {
  id: string;
  nodeId: string;
  kind: InsightKind;
  title: string;
  message: string;
  score: number;
}

export interface RepoNarrative {
  id: string;
  title: string;
  description: string;
  nodeIds: string[];
}

export interface RepoSummary {
  source: string;
  sourceType: SourceType;
  resolvedPath: string;
  repoName: string;
  ref?: string;
  headSha?: string;
  generatedAt: string;
  counts: {
    nodes: number;
    edges: number;
    files: number;
    directories: number;
    functions: number;
    dependencies: number;
    commits: number;
    issues: number;
    pullRequests: number;
  };
  alerts: string[];
  topDirectories: Array<{
    id: string;
    label: string;
    children: number;
  }>;
  topContributors: Array<{
    name: string;
    email?: string;
    commits: number;
  }>;
  entryPoints: string[];
  narratives: RepoNarrative[];
  github?: {
    owner: string;
    repo: string;
    stars: number;
    forks: number;
    openIssues: number;
    defaultBranch: string;
    url: string;
  };
}

export interface AnalysisResult {
  id: string;
  summary: RepoSummary;
  graph: GraphData;
  insights: Record<string, Insight[]>;
}

export interface AnalyzeRequest {
  source: string;
  ref?: string;
}

export interface SearchResult {
  id: string;
  label: string;
  type: NodeType;
  path?: string;
  score: number;
}

export interface NodeDetailResponse {
  node: GraphNode;
  insights: Insight[];
  inbound: GraphEdge[];
  outbound: GraphEdge[];
  neighbors: GraphNode[];
}

export interface SubgraphResponse extends GraphData {
  centerId: string;
  depth: number;
}

export interface HealthResponse {
  status: "ok";
  hasAnalysis: boolean;
  analyzing: boolean;
  defaultSource?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  reasoning_details?: unknown;
}

export interface RepoChatRequest {
  question: string;
  history?: ChatMessage[];
}

export interface RepoChatSource {
  path: string;
  score: number;
  snippet: string;
}

export interface RepoChatResponse {
  answer: string;
  model: string;
  sources: RepoChatSource[];
}

export interface AiRepoInsight {
  id: string;
  kind: InsightKind;
  title: string;
  message: string;
  confidence: number;
  nodeId?: string;
  nodeLabel?: string;
}

export interface RepoAiInsightsResponse {
  model: string;
  generatedAt: string;
  insights: AiRepoInsight[];
}

export interface RepoAiCodeOriginResponse {
  model: string;
  generatedAt: string;
  estimatedAiGeneratedPercent: number;
  confidence: number;
  summary: string;
  signals: string[];
}

export interface AuthUser {
  id: number;
  email: string;
  createdAt: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface RegisterResponse {
  message: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface VerifyEmailRequest {
  token: string;
}

export interface RequestEmailVerificationRequest {
  email: string;
}

export interface RequestPasswordResetRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

export interface GoogleAuthRequest {
  idToken: string;
}
