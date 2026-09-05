# EXECUTION PLAN — 2 Hours, 3 SWEs

**Product:** Repository Engineering Graph
**Constraint:** 2 hours wall-clock, three engineers working in parallel.
**Win condition:** a live demo where an agent answers an architecture question by traversing a
graph it did not invent.

Read `ARCHITECTURE.md` first, then `CONTRACTS.md`, then your own lane file in `Docs/lanes/`.

---

## 0. Decisions Required Before T+10

These are **not** blocking the scaffold, but Lane A cannot be tuned without #1.

| # | Decision | Default if nobody decides | Owner |
|---|---|---|---|
| 1 | **Pin the demo repo** (see criteria below) | — must be answered | Team lead |
| 2 | Backend placement: separate Express (a) vs Next route handlers (b) | **(a) separate Express on :3001** — already assumed throughout these docs | Team lead |
| 3 | `OPENAI_MODEL` | `gpt-4.1-mini` — confirm account access at T+0 | SWE-B |
| 4 | Judging weight: visual polish vs answer quality | Assume **answer quality**; spare minutes go to Lane B | Team lead |

### Demo repo selection criteria

Pick **one** open-source TypeScript backend that has all of:

- a `modules/` or `src/modules/` (or `src/features/`) directory with one folder per domain
- files named `*.routes.ts` / `*.controller.ts` / `*.service.ts`
- a central `server.ts` or `app.ts` that does `app.use("/prefix", someRouter)`
- fewer than ~400 TS files, so a scan finishes in seconds

Also pick a **fallback repo** meeting the same criteria. If the primary parses badly at T+60,
switch rather than debug.

> Copy the chosen repo to a local folder and demo with `localPath`, not `repoUrl`. Cloning live
> on stage over conference wifi is an avoidable risk. Keep `repoUrl` working — it is the pitch —
> but drive the demo from local.

### Standing assumptions (correct these if wrong)

- 2h is wall-clock with all three coding simultaneously: ~65 min build, ~20 min integrate,
  ~15 min rehearse, ~10 min buffer.
- Everyone has the `OPENAI_API_KEY` at T+0.
- Node 24 / npm 11 / git 2.51 present on all three machines (verified on one).
- Target language is TypeScript only. Non-TS files are ignored, not warned about.

---

## 1. Timeline

```
T+0    T+10                                    T+75        T+95      T+110  T+120
 |------|--------------------------------------|-----------|---------|------|
 SETUP  |            PARALLEL BUILD            | INTEGRATE | REHEARSE| BUFF |
 (all)  |     A / B / C never touch same file  |   (all)   |  (all)  |      |
```

| Window | What happens | Who |
|---|---|---|
| **T+0 → T+10** | Scaffold, both `npm install`s running, **freeze `contract.ts`**, hand-write `fixtures/graph.sample.json`, pin demo repo | ALL, same table |
| **T+10 → T+75** | Parallel build. No cross-lane dependencies. | A, B, C |
| **T+75 → T+95** | Wire real discovery into the server, run the smoke test, fix the graph until React Flow renders it | ALL |
| **T+95 → T+110** | Rehearse the demo **twice**, end to end, out loud | ALL |
| **T+110 → T+120** | Buffer. Do not start anything new here. | — |

**T+10 is a hard gate.** Nobody starts lane work until `contract.ts` and the fixture are
committed. Ten minutes of alignment buys sixty-five minutes of zero-conflict parallelism.

---

## 2. Lane Summary

| Lane | Owner | Directory (exclusive) | Deliverable | Detail |
|---|---|---|---|---|
| **A** | SWE-A | `api/src/discovery/` | `discover(rootDir) => Facts` | `lanes/LANE_A_DISCOVERY.md` |
| **B** | SWE-B | `api/src/graph/`, `api/src/agent/`, `api/src/server.ts` | Graph builder + agent + REST API | `lanes/LANE_B_GRAPH_AGENT.md` |
| **C** | SWE-C | `web/` | Next.js UI, React Flow canvas, ask box | `lanes/LANE_C_UI.md` |

### Task IDs

Use these when assigning work to an agent, so two people never run agents on the same task.

| Lane A | Lane B | Lane C |
|---|---|---|
| **A1** Repo loading + file walk | **B1** Facts -> Graph builder | **C1** App shell + repo input form |
| **A2** Modules + mount prefixes | **B2** graphology index + query fns | **C2** React Flow canvas + dagre layout |
| **A3** Routes scanner | **B3** Agent + 6 tools | **C3** Node detail drawer |
| **A4** Controller/Service/Repo call edges | **B4** Express API endpoints | **C4** Ask box + node highlighting |
| **A5** Models scanner + `cli.ts` | **B5** Prompt tuning *(stretch)* | **C5** Legend + warnings banner *(stretch)* |

---

## 3. File Ownership Matrix — the anti-collision rule

**Nobody edits a file owned by another lane. No exceptions during the build window.**

| Path | Owner | Notes |
|---|---|---|
| `api/src/contract.ts` | **SHARED** | Frozen T+10. Change = all three agree. |
| `api/src/discovery/**` | SWE-A | |
| `api/src/graph/**` | SWE-B | |
| `api/src/agent/**` | SWE-B | |
| `api/src/server.ts` | SWE-B | |
| `api/package.json` | SWE-B | A requests deps at T+0; B installs once. |
| `web/**` | SWE-C | |
| `fixtures/graph.sample.json` | **SHARED** | Read-only after T+10. |
| `Docs/**` | anyone | Not on the critical path. |

Git: one branch per lane (`lane-a`, `lane-b`, `lane-c`), merged to `main` at T+75. Because
ownership is directory-disjoint, merges should be conflict-free by construction.

---

## 4. Integration Checkpoints

| Time | Check | Pass condition |
|---|---|---|
| **T+10** | Contract freeze | `contract.ts` + fixture committed; all three have pulled |
| **T+40** | Vertical slice | B serves the **fixture** at `GET /api/graph`; C renders it. A prints real routes to console. |
| **T+60** | Go / no-go on demo repo | A's route count > 0 and looks right. If not, **switch to the fallback repo now.** |
| **T+75** | Real wiring | `POST /api/analyze` with `localPath` returns a real graph; C renders it |
| **T+90** | Full loop | Ask a question, get an answer, see nodes highlight |

At T+40 and T+60 everyone stops for 2 minutes and states blockers out loud. That is the entire
process overhead.

---

## 5. Demo Script (rehearse this exact sequence twice)

1. **Frame it, 20 seconds.** "Agents get handed thousands of files and re-derive the architecture
   every single time. We turn the repo into an engineering graph once, and let the agent reason
   over that instead."
2. Paste the repo path. Click Analyze. Graph appears.
3. **Point at the layers.** "This is not an import graph. These are engineering concepts — routes,
   controllers, services, models — and every edge came from the AST, with a file and a line."
4. Click a node. Show the detail drawer: file, line, module.
5. **Ask question 1:** *"How does creating a user work?"* — answer names the chain; the path
   lights up on the canvas.
6. **Ask question 2:** *"What depends on UserService?"* — reverse traversal lights up.
7. **Close on the trace.** Show the tool-call list. "Three graph lookups. It never read a file.
   That is the whole point."

If a question fails live, ask the other one. Do not debug on stage.

---

## 6. Risk Register

| Risk | Likelihood | Mitigation | Owner |
|---|---|---|---|
| Demo repo does not match the convention | **High** | Pin repo at T+0, go/no-go at T+60, fallback repo ready | Lead |
| `@openai/agents` + zod v4 schema incompatibility | Medium | Test one tool definition at T+0; pin `zod@^3.23` if it throws | SWE-B |
| React Flow crashes on a dangling edge | Medium | B validates and drops dangling edges before responding (contract section 2) | SWE-B |
| Graph too dense to read on screen | Medium | Filter to one module by default; "show all" is a toggle | SWE-C |
| Live clone fails on venue wifi | Medium | Demo from `localPath`; pre-clone before presenting | Lead |
| Agent answers from files instead of the graph | Medium | System prompt forbids it; `toolCalls` trace makes cheating visible | SWE-B |
| Scope creep | **High** | The Cut List below is pre-agreed, not negotiated at T+90 | ALL |

---

## 7. Cut List — decided now, not at T+90

Cut in this order the moment you are behind:

1. `trace_path` tool (B4/stretch) — `get_neighbors` covers the demo
2. Legend + warnings banner (C5)
3. `Module -> Module` IMPORTS edges (A2 partial) — the vertical chain is the story
4. `repoUrl` cloning — demo from `localPath` only
5. Middleware capture on routes (A3 partial)
6. The second demo question — one great answer beats two shaky ones

**Never cut:** the vertical chain Route -> Controller -> Service -> Model, the `toolCalls` trace,
or node highlighting from `citedNodeIds`. Those three *are* the pitch.

---

## 8. Definition of Done

- [ ] `POST /api/analyze { localPath }` returns a valid `Graph` in under 20s
- [ ] Graph contains at least one complete chain: Route -> Controller -> Service -> Model
- [ ] Every edge carries `confidence` and, where `EXTRACTED`, real `evidence` file+line
- [ ] UI renders the graph with dagre layout, no console errors
- [ ] Clicking a node shows file, line, type, module
- [ ] *"How does creating a user work?"* returns a correct chain answer
- [ ] *"What depends on X?"* returns correct dependents
- [ ] Cited nodes visibly highlight on the canvas
- [ ] The tool-call trace is visible in the UI
- [ ] Demo rehearsed end to end, twice
