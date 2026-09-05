# Repository Engineering Graph — Documentation Index

**What we are building:** an AI agent that reads a repository, discovers its engineering
structure deterministically, builds an Engineering Graph, and answers architecture questions by
reasoning over that graph.

**The claim we are proving:** an agent understands a repository better when the codebase is a
structured engineering graph than when it is a pile of files.

---

## Read in this order

| # | Doc | Who | Why |
|---|---|---|---|
| 1 | [ARCHITECTURE.md](ARCHITECTURE.md) | everyone | What we are building and why it is extractable |
| 2 | [CONTRACTS.md](CONTRACTS.md) | everyone | **The frozen interfaces.** This is what lets 3 people work at once |
| 3 | [EXECUTION_PLAN.md](EXECUTION_PLAN.md) | everyone | Timeline, task IDs, ownership matrix, risks, cut list, demo script |
| 4 | [SETUP.md](SETUP.md) | everyone | Scaffold, dependencies, commands, env |
| 5 | [FIXTURE_SAMPLE.md](FIXTURE_SAMPLE.md) | SWE-B, SWE-C | The shared fixture, pasted at T+10 |
| 6 | your lane file | one person | Your tasks, in detail |

## Lane files

| Lane | Owner | File | Owns |
|---|---|---|---|
| **A** | SWE-A | [lanes/LANE_A_DISCOVERY.md](lanes/LANE_A_DISCOVERY.md) | `api/src/discovery/**` |
| **B** | SWE-B | [lanes/LANE_B_GRAPH_AGENT.md](lanes/LANE_B_GRAPH_AGENT.md) | `api/src/graph/**`, `api/src/agent/**`, `api/src/server.ts` |
| **C** | SWE-C | [lanes/LANE_C_UI.md](lanes/LANE_C_UI.md) | `web/**` |

---

## The three rules

1. **Nobody edits another lane's directory.** Ownership is directory-disjoint by design, so
   merges are conflict-free by construction.
2. **`api/src/contract.ts` and `fixtures/graph.sample.json` freeze at T+10.** Changing either
   requires all three people to agree, in the same commit.
3. **The LLM never invents the graph.** Discovery is pure AST. Every edge carries a file and a
   line. That distinction is the entire pitch — protect it in the code, the UI, and the answers.

---

## Before anyone writes code

Four decisions in `EXECUTION_PLAN.md` section 0. Only one is truly blocking:

> **Pin the demo repo.** A discovery engine tuned to one known repository is a demo. One tuned to
> no repository in particular is a coin flip. Pick a primary and a fallback before T+10.

## Open items carried from planning

- Demo repo: **not yet pinned** — blocking Lane A tuning
- Backend placement (separate Express vs Next route handlers): assumed **separate Express on :3001**
- `OPENAI_MODEL`: assumed `gpt-4.1-mini`, confirm account access at T+0
- Judging weight (visual polish vs answer quality): assumed **answer quality**

Correct any of these and the affected sections are flagged in `EXECUTION_PLAN.md` section 0.
