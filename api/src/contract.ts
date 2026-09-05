// api/src/contract.ts
// FROZEN at T+10 — see Docs/CONTRACTS.md. Changes require all three SWEs to agree.

export type NodeType =
  | "Project" | "Module" | "Route" | "Controller"
  | "Service" | "Repository" | "Model";

export type EdgeType =
  | "CONTAINS"      // Project->Module, Module->Route/Controller/Service
  | "HANDLED_BY"    // Route->Controller
  | "CALLS"         // Controller->Service, Service->Repository
  | "READS_WRITES"  // Repository->Model (or Service->Model if no repo layer)
  | "IMPORTS";      // Module->Module

/** How much we trust an edge. Never render INFERRED as established fact. */
export type Confidence = "EXTRACTED" | "INFERRED";

export interface Evidence {
  file: string;   // repo-relative, POSIX separators: "modules/users/users.routes.ts"
  line: number;   // 1-based
}

export interface FactNode {
  kind: NodeType;
  name: string;             // "UserController", "CreateUserService", "POST /api/v1/users"
  module: string | null;    // owning module slug, e.g. "users"
  evidence: Evidence;
  meta?: Record<string, unknown>;
}

export interface FactRoute extends FactNode {
  kind: "Route";
  meta: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "ALL";
    path: string;            // FULL path incl. mount prefix: "/api/v1/users/:id"
    handlerName: string;     // "create"
    controllerName: string;  // "UserController"
    middleware: string[];    // ["authMiddleware", "requireRole"]
  };
}

export interface FactEdge {
  from: string;              // FactNode.name of source
  to: string;                // FactNode.name of target
  type: EdgeType;
  confidence: Confidence;
  evidence: Evidence;
}

export interface Facts {
  repo: {
    name: string;
    url: string | null;      // null when analyzed from a local path
    commit: string | null;
    rootDir: string;         // absolute path on disk
  };
  nodes: FactNode[];         // routes included, discriminated by `kind`
  edges: FactEdge[];
  stats: {
    filesScanned: number;
    durationMs: number;
    warnings: string[];      // human-readable misses — SHOW THESE, honesty sells
  };
}

// --- Section 2: Graph — API output [SWE-B] produces -> [SWE-C] consumes ---
// Included here because contract.ts is the single shared file; Lane A only
// needs section 1 (Facts), but the type must stay one frozen document.

export interface GraphNode {
  id: string;                // stable, see CONTRACTS.md section 3
  type: NodeType;
  label: string;             // display text
  module: string | null;
  file: string | null;       // repo-relative
  line: number | null;
  meta: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;                // `${source}->${target}:${type}`
  source: string;            // GraphNode.id
  target: string;            // GraphNode.id
  type: EdgeType;
  confidence: Confidence;
  evidence: Evidence | null;
}

export interface Graph {
  schemaVersion: 1;
  repo: Facts["repo"];
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Facts["stats"] & { nodeCount: number; edgeCount: number };
}
