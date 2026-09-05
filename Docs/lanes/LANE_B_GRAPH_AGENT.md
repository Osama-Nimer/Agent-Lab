# LANE B — Graph Builder + Agent + API   `[SWE-B]`

**You own:** `api/src/graph/**`, `api/src/agent/**`, `api/src/server.ts`, `api/package.json`.
**You deliver:** a REST API that turns `Facts` into a `Graph`, and an agent that answers
architecture questions **by traversing that graph**.
**Read first:** `Docs/CONTRACTS.md` sections 2-5. You are the producer of section 2 and section 4.

> **You are never blocked by SWE-A.** Build entirely against `fixtures/graph.sample.json`.
> Swapping in the real `discover()` at T+75 is a one-line import change.
> **You are the demo's centre of gravity** — the agent's answer is what the judges remember.

---

## T+0 responsibilities (before the contract freeze)

You own the scaffold. Do these first, they unblock everyone:

1. Create the directory tree from `SETUP.md` section 2.
2. Run the `api/` install (`SETUP.md` section 3). Tell SWE-A the moment it is done.
3. **Verify the zod compatibility risk in 2 minutes** — define one throwaway tool and run it.
   If it throws a schema error, `npm i zod@^3.23`. Do not discover this at T+80.
4. Write `api/src/contract.ts` by copying `CONTRACTS.md` sections 1-2 verbatim. Announce the freeze.

---

## Files you create

```
api/src/
├── contract.ts          T+0  shared, frozen
├── graph/
│   ├── build.ts         B1   Facts -> Graph
│   └── query.ts         B2   graphology index + query functions
├── agent/
│   ├── tools.ts         B3   the 6 tools
│   ├── prompt.ts        B3   system prompt
│   └── agent.ts         B3   agent construction + ask()
└── server.ts            B4   Express endpoints
```

---

## B1 — Facts -> Graph builder   *(12 min)*

`graph/build.ts` exports `buildGraph(facts: Facts): Graph`.

**Node ID construction — use `CONTRACTS.md` section 3 exactly.** SWE-C hardcodes nothing, but the
agent's `citedNodeIds` must match the UI's node ids character for character.

```ts
const idFor = (kind: NodeType, name: string): string => {
  switch (kind) {
    case "Project":    return `project:${name}`;
    case "Module":     return `module:${name}`;
    case "Route":      return `route:${name}`;        // name is already "POST /api/v1/users"
    case "Controller": return `controller:${name}`;
    case "Service":    return `service:${name}`;
    case "Repository": return `repo:${name}`;
    case "Model":      return `model:${name}`;
  }
};
```

The builder must, in order:

1. Map every `FactNode` to a `GraphNode` (id, type, label, module, file, line, meta).
2. **De-duplicate by id.** A service called from three controllers appears three times in facts.
   Keep the first, merge `meta`.
3. Map `FactEdge.from`/`.to` (names) through a `name -> id` lookup to get `source`/`target`.
4. **Drop any edge whose source or target is not in the node set, and count it in
   `stats.warnings`.** This is a contract guarantee — React Flow throws on a dangling edge and
   kills the demo. Belt and braces even though SWE-A also filters.
5. De-duplicate edges by `${source}->${target}:${type}`.
6. Return `Graph` with `schemaVersion: 1` and populated `stats.nodeCount` / `edgeCount`.

**Done when:** `buildGraph(sampleFacts)` round-trips and `JSON.stringify` matches the fixture's shape.

---

## B2 — graphology index + query functions   *(12 min)*

`graph/query.ts`. Build the index once per analyze, hold it in a module-level variable.

```ts
import Graph from "graphology";
import { bfsFromNode } from "graphology-traversal";

let current: { graph: Graph; data: GraphType } | null = null;

export function indexGraph(g: GraphType) {
  const graph = new Graph({ type: "directed", multi: true });
  for (const n of g.nodes) graph.addNode(n.id, n as any);
  for (const e of g.edges)
    if (graph.hasNode(e.source) && graph.hasNode(e.target))
      graph.addDirectedEdgeWithKey(e.id, e.source, e.target, e as any);
  current = { graph, data: g };
}
export const getCurrent = () => current;
```

Four query functions, each returning plain `GraphNode[]` / `GraphEdge[]` — the tools in B3 are
thin wrappers over these, so test them directly:

| Function | Behaviour |
|---|---|
| `overview()` | counts by type, module list, up to 40 route labels |
| `findNodes(query, type?)` | case-insensitive substring match on `label` and `id`, cap 20 |
| `neighbors(nodeId, direction, depth=1)` | `"out"` = outbound, `"in"` = inbound, `"both"` = union. Returns nodes **and** the connecting edges. |
| `tracePath(from, to)` | BFS shortest path, ordered nodes. **Stretch — cut item #1.** |

> `get_neighbors` with `direction: "in"` is what answers *"What depends on UserService?"*. That is
> a demo question. Test it explicitly.

**Done when:** against the fixture, `neighbors("service:CreateUserService","in")` returns the
controller, and `"out"` returns the repository.

---

## B3 — Agent + tools   *(20 min — your highest-value task)*

### The system prompt (`agent/prompt.ts`) — this is a real deliverable, not boilerplate

```
You are a software architecture analyst. You answer questions about a codebase using an
Engineering Graph that was built deterministically from the source AST.

RULES:
1. Always start with get_graph_overview or find_nodes. Never guess.
2. Prefer graph tools. Only use read_file or search_code if the graph genuinely lacks the
   answer, and say so explicitly in your answer when you do.
3. Answer in 2-4 sentences. Name the concrete chain, e.g.
   "POST /api/v1/users is handled by UserController.create, which calls CreateUserService,
   which writes to the users model."
4. Every node you mention must appear in your cited node ids, using the exact id from the graph.
5. If an edge is marked INFERRED, say it is inferred rather than stating it as fact.
6. Never invent nodes, routes, or relationships that the tools did not return.
```

Rule 2 is the thesis. Rule 5 is the credibility. Rule 6 is the safety.

### Tool definitions (`agent/tools.ts`)

```ts
import { tool } from "@openai/agents";
import { z } from "zod";

export const findNodes = tool({
  name: "find_nodes",
  description: "Search the engineering graph for nodes by name. Use this first to locate a route, controller, service or model.",
  parameters: z.object({
    query: z.string().describe("substring to search for, e.g. 'user'"),
    type: z.enum(["Project","Module","Route","Controller","Service","Repository","Model"]).nullable(),
  }),
  execute: async ({ query, type }) => JSON.stringify(q.findNodes(query, type ?? undefined)),
});
```

> ⚠️ **Two gotchas that will cost you 20 minutes if you hit them cold:**
> 1. Use `.nullable()`, **not** `.optional()`, for optional tool params. OpenAI strict function
>    schemas require every property to be present; optional-only fields get rejected.
> 2. Tool `execute` should return a **string** (JSON.stringify your payload). Returning raw
>    objects works in some SDK versions and not others — stringifying always works.
>
> Verify the exact `@openai/agents` import surface (`Agent`, `run`, `tool`) against the installed
> package's README at T+0. Do not trust this doc over the package.

### Capturing the tool trace — do this the robust way

Do **not** dig through the run result's internal item types to reconstruct tool calls. Record them
yourself in the closure. This is version-proof and takes one line per tool:

```ts
export function makeTools(trace: {name:string; args:unknown}[]) {
  const record = (name: string, args: unknown) => { trace.push({ name, args }); };
  // inside each execute: record("find_nodes", { query, type });
  ...
}
```

`ask()` then returns `{ answer, citedNodeIds, toolCalls: trace }` with zero SDK archaeology.

### Getting `citedNodeIds` reliably

Belt and braces — do both:

1. Ask the model for them (add a final instruction to emit them), **and**
2. **Post-process:** scan the answer text for any node id or node label present in the current
   graph and union them in.

Method 2 alone is sufficient and cannot fail. Implement it first.

```ts
const cited = current.data.nodes
  .filter(n => answer.includes(n.label) || answer.includes(n.id))
  .map(n => n.id);
```

**Done when:** `ask("How does creating a user work?")` against the fixture returns a correct chain
sentence, non-empty `citedNodeIds`, and a `toolCalls` array showing graph tools only.

---

## B4 — Express API   *(12 min)*

`server.ts`. Four endpoints, exactly as specified in `CONTRACTS.md` section 4.

```ts
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());              // fallback; SWE-C proxies same-origin anyway
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/analyze", async (req, res) => {
  try {
    const { repoUrl, localPath } = req.body ?? {};
    if (!repoUrl && !localPath) return res.status(400).json({ error: "Provide repoUrl or localPath" });
    const root = localPath ?? await cloneRepo(repoUrl);
    const facts = await discover(root);
    const graph = buildGraph(facts);
    indexGraph(graph);
    await fs.writeFile("../fixtures/last-graph.json", JSON.stringify(graph, null, 2));
    res.json({ graph });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});
```

**Every error path returns `{ error: string }`.** SWE-C renders `error` directly — if you return
an HTML stack trace, their UI shows garbage.

**Cloning** (`simple-git`), shallow and to a temp dir:

```ts
await simpleGit().clone(repoUrl, dest, ["--depth", "1"]);
```

Wrap it in a timeout. If clone takes over 30s, fail with a clear message rather than hanging the UI.

**Until T+75**, back `/api/analyze` and `/api/graph` with the fixture so SWE-C has a live server
from minute 15:

```ts
// TEMPORARY until Lane A lands — delete at T+75
const graph = JSON.parse(await fs.readFile("../fixtures/graph.sample.json", "utf8"));
```

---

## B5 — Prompt tuning   *(stretch, only if ahead)*

Run both demo questions five times. If the agent ever reads a file when the graph had the answer,
tighten rule 2. If answers ramble, tighten the sentence limit. Nothing else.

---

## Your Definition of Done

- [ ] `contract.ts` frozen and committed at T+10
- [ ] `buildGraph` emits zero dangling edges and zero duplicate ids
- [ ] `indexGraph` + all four query functions work against the fixture
- [ ] Six tools defined; tools 1-3 verified working
- [ ] Both demo questions answered correctly, using **graph tools only**
- [ ] `citedNodeIds` non-empty and matching real node ids
- [ ] `toolCalls` populated
- [ ] All four endpoints return the contract shapes, errors included
- [ ] Real `discover()` wired in at T+75, fixture fallback deleted
