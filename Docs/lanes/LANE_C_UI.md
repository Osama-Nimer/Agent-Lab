# LANE C — UI   `[SWE-C]`

**You own:** `web/**` — exclusively. You never touch `api/`.
**You deliver:** a Next.js page that renders the engineering graph, shows node details, and lets
the user ask a question that visibly lights up the answer path.
**Read first:** `Docs/CONTRACTS.md` sections 2-4. You consume `Graph` and call three endpoints.

> **You are never blocked.** `fixtures/graph.sample.json` exists from T+10. Copy it into
> `web/fixtures/graph.sample.json` and build against it. Switch to live `fetch` at T+40 when
> SWE-B's server is up — the shape is identical by contract.
>
> **Your job is the demo's legibility.** A graph nobody can read loses even if the agent is
> perfect. Prioritize readability over features.

---

## Files you create

```
web/
├── next.config.ts             C1  the API proxy — do this first
├── app/
│   ├── page.tsx               C1  main page, all state lives here
│   └── globals.css            C2  theme tokens
├── components/
│   ├── RepoInput.tsx          C1
│   ├── GraphCanvas.tsx        C2  React Flow + dagre
│   ├── NodeDrawer.tsx         C3
│   └── AskBox.tsx             C4
└── lib/
    ├── types.ts               C1  paste Graph types from contract
    ├── api.ts                 C1  three fetch wrappers
    └── layout.ts              C2  dagre layout function
```

---

## C1 — Shell, proxy, repo input   *(12 min)*

**Do `next.config.ts` first** (`SETUP.md` section 4). It makes CORS a non-issue for the rest of
your lane. Verify with `fetch("/api/health")` before writing anything else.

`lib/types.ts` — paste `GraphNode`, `GraphEdge`, `Graph`, `NodeType`, `EdgeType`, `Confidence`,
`Evidence` from `CONTRACTS.md` section 2. **Do not import from `api/`** — a cross-package import
will break your build and is not worth solving today. Duplication is correct here.

`lib/api.ts`:

```ts
export async function analyze(input: { repoUrl?: string; localPath?: string }) {
  const r = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Analyze failed");
  return j.graph as Graph;
}
```

Same pattern for `getGraph()` and `ask(question)`. **Always read `j.error`** — SWE-B guarantees
that shape on every failure, so surface it verbatim instead of "Something went wrong".

`RepoInput.tsx`: one text field, one Analyze button, plus a **"Load sample" button** that loads
your bundled fixture. That button is your safety net if the backend dies mid-demo — build it in
the first 12 minutes, not at T+100.

**Loading state matters.** Analyze takes up to 20s. Show a spinner with the repo name, or judges
will think it hung.

---

## C2 — React Flow canvas + dagre layout   *(20 min — your highest-value task)*

```ts
import { ReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import "@xyflow/react/dist/style.css";   // REQUIRED — without it you get an invisible canvas
```

### Layout (`lib/layout.ts`)

React Flow does not lay out for you. Nodes without positions all stack at the origin.

```ts
import dagre from "@dagrejs/dagre";

const W = 200, H = 56;

export function layout(nodes: GraphNode[], edges: GraphEdge[]) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", ranksep: 110, nodesep: 28 });

  nodes.forEach(n => g.setNode(n.id, { width: W, height: H }));
  edges.forEach(e => g.setEdge(e.source, e.target));
  dagre.layout(g);

  return nodes.map(n => {
    const p = g.node(n.id);
    return {
      id: n.id,
      position: { x: p.x - W / 2, y: p.y - H / 2 },
      data: { ...n },
      type: "concept",
    };
  });
}
```

> `rankdir: "LR"` (left-to-right) reads as a pipeline: Route → Controller → Service → Model.
> That mirrors the story you are telling. `"TB"` is the fallback if the graph is very wide.

### Colour by node type — this is what makes the graph legible at a glance

| Type | Role in the story |
|---|---|
| `Route` | entry point — most saturated colour |
| `Controller` | request handling |
| `Service` | business logic |
| `Repository` | data access |
| `Model` | persistence — distinct colour, it is the chain's end |
| `Module` | grouping — muted |
| `Project` | root — muted |

Pick one hue family and vary saturation along the chain, so the pipeline reads as a gradient.
Put the **type name as a small label above the node name** — judges do not know your node types yet.

### Edge styling — carries the credibility claim

- `confidence: "EXTRACTED"` → solid line
- `confidence: "INFERRED"` → **dashed** (`style: { strokeDasharray: "5 5" }`)

The fixture contains one deliberately INFERRED edge so you can verify this before real data
arrives. Add a one-line legend: *"dashed = inferred, not proven from the AST."* Saying that out
loud during the demo is a credibility win, so make it visible.

### Density control

If the graph exceeds ~40 nodes it becomes unreadable. Add a module filter (a `<select>` of
`graph.nodes` module values, default to the module with the most routes) and a "Show all" toggle.
**Cheap to build, saves the demo.**

---

## C3 — Node detail drawer   *(10 min)*

On `onNodeClick`, open a right-hand panel showing:

```
UserController                    [Controller]
module      users
file        modules/users/users.controller.ts
line        14
```

Plus, for a Route node, the `meta`: method, full path, handler name, middleware list.

Render `file:line` as monospace — it is the proof that the graph came from real source, not from
an LLM's imagination. Point at it during the demo.

---

## C4 — Ask box + highlighting   *(15 min — the money shot)*

Text input, submit, then render three things:

1. **The answer** — plain prose, readable size.
2. **The tool trace** — a small list: `find_nodes({query:"user"})`, `get_neighbors(...)`.
   Style it as muted monospace. This is the evidence that the agent used the graph.
3. **Highlighting** — for every id in `citedNodeIds`, emphasize that node on the canvas.

```ts
const cited = new Set(res.citedNodeIds);
setNodes(ns => ns.map(n => ({
  ...n,
  data: { ...n.data, highlighted: cited.has(n.id) },
  style: cited.has(n.id) ? { opacity: 1 } : { opacity: 0.25 },
})));
```

Dimming the uncited nodes reads better on a projector than brightening the cited ones. Also
highlight edges whose **both** endpoints are cited — that draws the actual path.

> Node ids come straight from `CONTRACTS.md` section 3. If highlighting silently does nothing,
> the first thing to check is an id mismatch — `console.log` one `citedNodeIds` entry against one
> `node.id` and compare character by character.

Add a "clear" action that restores full opacity, so you can ask the second question cleanly.

**Pre-fill the input with the first demo question.** On stage you click, you do not type.

---

## C5 — Legend + warnings banner   *(stretch — cut item #2)*

A legend for node colours and the solid/dashed distinction, plus a dismissible banner showing
`graph.stats.warnings.length` — *"12 relationships could not be resolved"*. Showing the misses
makes the successes credible.

---

## Your Definition of Done

- [ ] `next.config.ts` proxy works; no absolute URLs anywhere in your code
- [ ] Fixture renders with dagre layout, left-to-right, no console errors
- [ ] Node colours distinguish all seven types; type label visible
- [ ] INFERRED edges render dashed
- [ ] Clicking a node opens the drawer with file and line
- [ ] Ask box returns an answer and renders the tool trace
- [ ] Cited nodes highlight; uncited nodes dim; clear works
- [ ] "Load sample" button works with the backend switched off
- [ ] Readable on a projector — check font sizes at 1.5m from the screen
