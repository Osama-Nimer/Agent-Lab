# Repository Engineering Graph — Architecture

> **Thesis:** An AI agent understands a repository better when the codebase is
> converted into a structured engineering graph. We prove it by building the graph
> **deterministically** and letting the agent reason **over the graph**, not over raw files.

---

## 1. Core Design Principle (non-negotiable)

```
Repository → Deterministic Discovery → Facts → Graph → Agent Reasoning
```

**The LLM never invents the graph.** The Discovery Engine is pure AST/static analysis
(ts-morph). It emits verifiable facts with `file:line` evidence. The agent is a *consumer*
of the graph, not a producer.

If a reviewer asks "how do you know the agent isn't hallucinating the architecture?", the
answer is: every node and edge carries a source-file citation, and the graph is byte-identical
across runs with the same commit.

---

## 2. System Diagram

```
                    ┌──────────────────┐
                    │  GitHub repo URL │
                    │  or local path   │
                    └────────┬─────────┘
                             │
                             v
         ╔═══════════════════════════════════════╗
         ║  api/  (Node + tsx, single process)   ║
         ║                                       ║
         ║  ┌─────────────────────────────────┐  ║
         ║  │ [SWE-A] Discovery Engine        │  ║
         ║  │  clone → ts-morph scan          │  ║
         ║  │  routes / controllers /         │  ║
         ║  │  services / repos / models      │  ║
         ║  └──────────────┬──────────────────┘  ║
         ║                 │ Facts (JSON)        ║
         ║                 v                     ║
         ║  ┌─────────────────────────────────┐  ║
         ║  │ [SWE-B] Graph Builder           │  ║
         ║  │  Facts → nodes + edges          │  ║
         ║  │  graphology in-memory index     │  ║
         ║  └──────────────┬──────────────────┘  ║
         ║                 │ graph.json          ║
         ║        ┌────────┴────────┐            ║
         ║        v                 v            ║
         ║  ┌───────────┐   ┌────────────────┐   ║
         ║  │ REST API  │   │ [SWE-B] Agent  │   ║
         ║  │ /analyze  │   │ @openai/agents │   ║
         ║  │ /graph    │   │ graph tools +  │   ║
         ║  │ /ask      │<──│ file fallback  │   ║
         ║  └─────┬─────┘   └────────────────┘   ║
         ╚════════╪══════════════════════════════╝
                  │ HTTP (proxied same-origin)
                  v
         ┌────────────────────────────────┐
         │ web/  [SWE-C] Next.js          │
         │  React Flow canvas + dagre     │
         │  node detail panel             │
         │  ask box → highlights nodes    │
         └────────────────────────────────┘
```

---

## 3. Components

### 3.1 Discovery Engine — `api/src/discovery/` — **[SWE-A]**

Pure function: `discover(rootDir: string) => Facts`. No network, no LLM, no side effects
beyond reading files. Deterministic: same commit ⇒ same output.

Targets the **layered Express + TypeScript convention** (see §5). Five scanners:

| Scanner | Reads | Produces |
|---|---|---|
| `scan-modules.ts` | `server.ts`, `modules/*/` | Module nodes + URL prefix per module |
| `scan-routes.ts` | `modules/*/*.routes.ts` | Route nodes (`METHOD /full/path`) + middleware |
| `scan-controllers.ts` | `modules/*/*.controller.ts` | Controller nodes, handler→service edges |
| `scan-services.ts` | `modules/*/services/*`, `repo/*` | Service + Repository nodes, call edges |
| `scan-models.ts` | `db/**/*.tables.ts` | Model nodes (Drizzle tables) |

### 3.2 Graph Builder — `api/src/graph/` — **[SWE-B]**

Normalizes `Facts` into the frozen `Graph` shape (`CONTRACTS.md §2`), assigns stable node IDs,
de-duplicates, drops dangling edges, and loads into `graphology` for traversal.

### 3.3 Agent — `api/src/agent/` — **[SWE-B]**

`@openai/agents` loop. **Graph tools first, file tools as fallback.** The system prompt forbids
answering from file contents when a graph tool could answer, and requires citing node IDs.

### 3.4 UI — `web/` — **[SWE-C]**

Next.js App Router + React Flow (`@xyflow/react`) + dagre layout. Three surfaces: repo input,
graph canvas with a node detail drawer, and an ask box that highlights the nodes the agent cited.

---

## 4. Data Flow

1. `POST /api/analyze { repoUrl | localPath }`
2. Server clones to a temp dir (or uses `localPath` verbatim — **demo insurance**)
3. Discovery Engine scans → `Facts`
4. Graph Builder → `Graph`, cached in memory **and** written to `fixtures/last-graph.json`
5. UI fetches graph, lays it out with dagre, renders
6. `POST /api/ask { question }` → agent traverses the in-memory graph → answer + `citedNodeIds`
7. UI highlights those nodes on the canvas

---

## 5. Target Convention Family — Why It Is Extractable

We target the **layered Express + TypeScript** convention family — the `*.routes.ts` /
`*.controller.ts` / `*.service.ts` / ORM-model layout used by a large share of Node backends
(and structurally mirrored by NestJS). One convention, deeply supported, beats five shallowly.

> **DECISION REQUIRED — the demo repo is not yet pinned.** See `EXECUTION_PLAN.md §0`.
> Lane A must be tuned against one concrete open-source repo, chosen before T+10.

Every hop is a static, unambiguous read:

| Hop | Evidence in source | Extraction |
|---|---|---|
| Prefix → Module | `app.use("/api/v1/users", usersModule)` in `server.ts` | CallExpression args |
| Module → Routes | `users.module.ts` re-exports `./users.routes` | ExportDeclaration |
| Route → Controller | `router.post("/", UserController.create)` | CallExpression + PropertyAccess |
| Controller → Service | handler body calls `CreateUserService(...)`, imported from `./services/*` | Identifier ∩ import list |
| Service → Repository | service calls `insertUser`, imported from `../repo/*` | Identifier ∩ import list |
| Repository → Model | `db.insert(users)`, `users` imported from the ORM schema | Identifier ∩ import list |

**Confidence tagging.** Every edge is `EXTRACTED` (both endpoints resolved from AST) or
`INFERRED` (name-convention match only). The UI renders `INFERRED` edges dashed. Never present
an `INFERRED` edge as established fact — in the graph, in the UI, or in an agent answer.

---

## 6. Explicitly Out of Scope

Multi-agent systems · graph databases (Neo4j) · vector DBs / RAG · auth · multi-language support ·
incremental re-indexing · production infra · dozens of tools · a dashboard.

---

## 7. Repository Layout & File Ownership

Ownership boundaries are **directory-level and disjoint** so three people never touch the same
file. The only shared file is frozen before parallel work begins.

```
Agent-Lab/
├── Docs/                          plan + contracts
├── fixtures/
│   ├── graph.sample.json          [ALL] frozen at T+10, read-only after
│   └── last-graph.json            runtime output, gitignored
├── api/
│   ├── package.json               [SWE-B] owns; A appends deps at T+10 only
│   ├── tsconfig.json              [SWE-B]
│   └── src/
│       ├── contract.ts            ★ SHARED — frozen at T+10, no edits after
│       ├── discovery/             [SWE-A] exclusive
│       ├── graph/                 [SWE-B] exclusive
│       ├── agent/                 [SWE-B] exclusive
│       └── server.ts              [SWE-B] exclusive
└── web/                           [SWE-C] exclusive
```

`api/src/contract.ts` is the seam. Once frozen, SWE-B and SWE-C build against
`fixtures/graph.sample.json` and are **never blocked** waiting on SWE-A.
