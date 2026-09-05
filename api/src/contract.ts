// ★ SHARED CONTRACT — frozen. Source of truth: Docs/CONTRACTS.md sections 1-2.
// Changing anything here requires all three lanes to agree, in the same commit
// as the matching change to fixtures/graph.sample.json.

export type NodeType =
  | "Project"
  | "Module"
  | "Route"
  | "Controller"
  | "Service"
  | "Repository"
  | "Model";

export type EdgeType =
  | "CONTAINS" // Project->Module, Module->Route/Controller/Service
  | "HANDLED_BY" // Route->Controller
  | "CALLS" // Controller->Service, Service->Repository
  | "READS_WRITES" // Repository->Model (or Service->Model if no repo layer)
  | "IMPORTS"; // Module->Module

/** How much we trust an edge. Never render INFERRED as established fact. */
export type Confidence = "EXTRACTED" | "INFERRED";

export interface Evidence {
  file: string; // repo-relative, POSIX separators: "modules/users/users.routes.ts"
  line: number; // 1-based
}

// ---------------------------------------------------------------------------
// 1. Facts — Discovery output   [SWE-A] produces -> [SWE-B] consumes
// ---------------------------------------------------------------------------

export interface FactNode {
  kind: NodeType;
  name: string; // "UserController", "CreateUserService", "POST /api/v1/users"
  module: string | null; // owning module slug, e.g. "users"
  evidence: Evidence;
  meta?: Record<string, unknown>;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "ALL";

export interface FactRoute extends FactNode {
  kind: "Route";
  meta: {
    method: HttpMethod;
    path: string; // FULL path incl. mount prefix: "/api/v1/users/:id"
    handlerName: string; // "create"
    controllerName: string | null; // "UserController" — null for inline handlers
    middleware: string[]; // ["authMiddleware", "requireRole"]
  };
}

export interface FactEdge {
  from: string; // FactNode.name of source
  to: string; // FactNode.name of target
  /**
   * Strongly recommended. Names collide across kinds (Module "users" vs Model "users");
   * with these set, resolution is exact. Without them the builder disambiguates by edge type
   * and drops (with a warning) anything still ambiguous.
   */
  fromKind?: NodeType;
  toKind?: NodeType;
  type: EdgeType;
  confidence: Confidence;
  evidence: Evidence;
}

export interface RepoInfo {
  name: string;
  url: string | null; // null when analyzed from a local path
  commit: string | null;
  rootDir: string; // absolute path on disk
}

export interface DiscoveryStats {
  filesScanned: number;
  durationMs: number;
  warnings: string[]; // human-readable misses — SHOW THESE, honesty sells
}

export interface Facts {
  repo: RepoInfo;
  nodes: FactNode[]; // routes included, discriminated by `kind`
  edges: FactEdge[];
  stats: DiscoveryStats;
}

// ---------------------------------------------------------------------------
// 2. Graph — API output   [SWE-B] produces -> [SWE-C] consumes
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string; // stable, see Docs/CONTRACTS.md section 3
  type: NodeType;
  label: string; // display text
  module: string | null;
  file: string | null; // repo-relative
  line: number | null;
  meta: Record<string, unknown>;
}

export interface GraphEdge {
  id: string; // `${source}->${target}:${type}`
  source: string; // GraphNode.id
  target: string; // GraphNode.id
  type: EdgeType;
  confidence: Confidence;
  evidence: Evidence | null;
}

export interface Graph {
  schemaVersion: 1;
  repo: RepoInfo;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: DiscoveryStats & { nodeCount: number; edgeCount: number };
}

// ---------------------------------------------------------------------------
// 4. HTTP API shapes   [SWE-B] implements -> [SWE-C] calls
// ---------------------------------------------------------------------------

export interface AnalyzeRequest {
  repoUrl?: string;
  localPath?: string;
}

export interface AnalyzeResponse {
  graph: Graph;
}

export interface AskRequest {
  question: string;
}

export interface ToolCallTrace {
  name: string;
  args: unknown;
}

export interface AskResponse {
  answer: string;
  citedNodeIds: string[];
  toolCalls: ToolCallTrace[];
  /** Additive (optional): which provider/model actually answered — useful on stage after a failover. */
  llm?: { provider: string; model: string };
}

export interface ErrorResponse {
  error: string;
}

// ---------------------------------------------------------------------------
// 3. Node ID convention — the one place ids are built. Never improvise.
// ---------------------------------------------------------------------------

const ID_PREFIX: Record<NodeType, string> = {
  Project: "project",
  Module: "module",
  Route: "route",
  Controller: "controller",
  Service: "service",
  Repository: "repo",
  Model: "model",
};

/** `route:POST /api/v1/users`, `controller:UserController`, ... value verbatim. */
export const nodeId = (kind: NodeType, name: string): string => `${ID_PREFIX[kind]}:${name}`;

export const edgeId = (source: string, target: string, type: EdgeType): string =>
  `${source}->${target}:${type}`;
