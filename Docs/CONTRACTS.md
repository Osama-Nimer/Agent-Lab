# CONTRACTS — Frozen Interfaces

> **Status: FROZEN at T+10.** After the freeze, nobody edits these shapes alone. A change
> requires all three SWEs to agree, and is applied to `api/src/contract.ts` +
> `fixtures/graph.sample.json` in the same commit.
>
> This document is the reason three people can work in parallel. SWE-B and SWE-C build
> entirely against `fixtures/graph.sample.json` and are **never blocked** on SWE-A.

Copy sections 1-2 verbatim into **`api/src/contract.ts`**. It is the only file more than one
lane imports.

---

## 1. Facts — Discovery output   [SWE-A] produces -> [SWE-B] consumes

```ts
// api/src/contract.ts

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
    handlerName: string;            // "create"
    controllerName: string | null;  // "UserController" — null for inline arrow handlers
    middleware: string[];           // ["authMiddleware", "requireRole"]
  };
}

export interface FactEdge {
  from: string;              // FactNode.name of source
  to: string;                // FactNode.name of target
  fromKind?: NodeType;       // STRONGLY RECOMMENDED — see collision note below
  toKind?: NodeType;
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
```

**SWE-A guarantees:** every `FactEdge.from` / `.to` matches some `FactNode.name` exactly
(case-sensitive). Unresolvable references are dropped and recorded in `stats.warnings` — never
emitted as dangling edges.

> **Name collisions (found by Lane B's self-test).** Names are not unique across kinds: a Module
> `users` and a Model `users` are routine in real repos. **Lane A: set `fromKind` / `toKind` on
> every edge** — you always know them at emit time, and it makes resolution exact. If omitted,
> the graph builder resolves both ends *jointly* against the legal (source kind → target kinds)
> pairs for that edge type (`Project` CONTAINS `Module`, `Module` CONTAINS the rest, `HANDLED_BY`
> is Route→Controller, `READS_WRITES` targets a Model, `IMPORTS` is Module→Module, …). Exactly
> one legal pairing wins; zero or several, or a self-loop, is **dropped with a warning that names
> the candidates** — never guessed. Both fields are optional so nothing already written breaks.

---

## 2. Graph — API output   [SWE-B] produces -> [SWE-C] consumes

```ts
export interface GraphNode {
  id: string;                // stable, see section 3
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
```

**SWE-B guarantees to SWE-C:**
- Every `edge.source` / `edge.target` exists in `nodes`. **No dangling edges, ever** — React Flow
  throws on an edge referencing a missing node, and that is a demo-killer.
- `nodes` contains no duplicate `id`.
- The graph is returned already de-duplicated; the UI does no cleaning.

---

## 3. Node ID Convention   [ALL] — exact, no improvising

IDs are the shared vocabulary between agent answers and UI highlighting. If B emits
`route:POST /api/v1/users` and C looks up `Route:POST:/api/v1/users`, highlighting silently
breaks and you lose the demo's best moment.

```
Project     project:<repoName>
Module      module:<moduleSlug>
Route       route:<METHOD> <fullPath>
Controller  controller:<ControllerName>
Service     service:<ServiceName>
Repository  repo:<RepoFunctionName>
Model       model:<ModelName>
```

Rules: lowercase type prefix, `:` separator, value **verbatim** from the source (do not re-case,
trim or slugify). Exactly one space between method and path in a Route id.

```
project:acme-api
module:users
route:POST /api/v1/users
controller:UserController
service:CreateUserService
repo:insertUser
model:users
```

---

## 4. HTTP API   [SWE-B] implements -> [SWE-C] calls

Base: `http://localhost:3001`. The UI calls **`/api/*` same-origin** via the Next.js rewrite
(see `SETUP.md` section 4) — so SWE-C never writes an absolute URL and CORS never appears.

### GET /api/health

`200 -> { "ok": true }`

### POST /api/analyze

```jsonc
// request — exactly one of the two
{ "repoUrl": "https://github.com/owner/name" }
{ "localPath": "C:/path/to/repo" }        // demo insurance: no network, no clone
```

```jsonc
// 200
{ "graph": { /* Graph, section 2 */ } }

// 4xx / 5xx — every error in the app uses this shape
{ "error": "Clone failed: repository not found" }
```

Server-side: clone -> discover -> build -> cache in memory -> also write
`fixtures/last-graph.json`. Target under 20s. If it will exceed that, say so in `stats.warnings`.

### GET /api/graph

Returns the last built graph. `404 { "error": "No graph yet. Run /api/analyze first." }`
Lets SWE-C reload the page without re-analyzing.

### POST /api/ask

```jsonc
{ "question": "How does creating a user work?" }
```

```jsonc
{
  "answer": "POST /api/v1/users is handled by UserController.create, which calls ...",
  "citedNodeIds": ["route:POST /api/v1/users", "controller:UserController"],
  "toolCalls": [ { "name": "find_nodes", "args": { "query": "user" } } ]
}
```

`citedNodeIds` drives canvas highlighting. `toolCalls` is rendered as a small "what the agent
did" trace — **this is what proves the graph is being used**, so do not skip it.

---

## 5. Agent Tools   [SWE-B]

Graph-first. The system prompt must forbid `read_file` when a graph tool can answer.

| # | Tool | Args | Returns | Priority |
|---|---|---|---|---|
| 1 | `get_graph_overview` | none | counts by type, module list, route list | graph |
| 2 | `find_nodes` | `{ query, type? }` | matching GraphNode[] (cap 20) | graph |
| 3 | `get_neighbors` | `{ nodeId, direction, depth? }` | `{ nodes, edges }` | graph |
| 4 | `trace_path` | `{ fromNodeId, toNodeId }` | ordered GraphNode[] | graph *(stretch)* |
| 5 | `read_file` | `{ path }` | file text, truncated to 400 lines | fallback |
| 6 | `search_code` | `{ pattern }` | up to 30 `{file, line, text}` | fallback |

`direction` is `"in" | "out" | "both"`; `depth` is 1–6 (6 from a Route returns the whole
request chain in one call — the agent uses this for "how does X work" questions).

Tools 1-3 are **required**. Tool 4 is the stretch goal. Tools 5-6 are the honesty valve for
"the graph did not capture it" — keep them, but they must be last resort.

---

## 6. The Fixture   `fixtures/graph.sample.json`   [ALL]

Hand-written at T+10, roughly 12 nodes covering the full chain
`Project -> Module -> Route -> Controller -> Service -> Repository -> Model`, plus one
`Module->Module IMPORTS` edge and **one deliberately INFERRED edge** so SWE-C can build and
verify dashed-edge rendering without waiting for SWE-A.

Committed and **read-only after T+10.** It is also the integration test: at T+75, SWE-A's real
output must validate against the same TypeScript types.
