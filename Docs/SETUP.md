# SETUP — Scaffold, Tools, Commands

Everything needed to go from empty repo to running. **Owner of each step is flagged.**

---

## 1. Prerequisites (verified on this machine)

| Tool | Version present | Note |
|---|---|---|
| Node | v24.14.0 | ✅ fine for Next 15 + tsx |
| npm | 11.4.2 | ✅ |
| git | 2.51.0.windows.1 | ✅ needed for clone |

Shell is **PowerShell** on Windows. `&&` chaining does **not** work in Windows PowerShell 5.1 —
use `;` or separate commands. Paths in code must be normalized to POSIX separators before they
go into the graph (`p.split(path.sep).join("/")`).

---

## 2. Directory Scaffold  `[SWE-B] creates at T+0, before the contract freeze]`

```
Agent-Lab/
├── Docs/
├── fixtures/
│   ├── graph.sample.json      [ALL] frozen T+10
│   └── last-graph.json        runtime, gitignored
├── api/                       [SWE-A + SWE-B share one package.json]
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── contract.ts        ★ shared, frozen T+10
│       ├── discovery/         [SWE-A] exclusive
│       ├── graph/             [SWE-B] exclusive
│       ├── agent/             [SWE-B] exclusive
│       └── server.ts          [SWE-B] exclusive
└── web/                       [SWE-C] exclusive
```

Two `npm install`s total (`api/`, `web/`). No workspaces, no monorepo tooling — not worth the
minutes.

---

## 3. Dependencies

### `api/`  — one install, run by **[SWE-B]** at T+0, shared by A and B

```bash
cd api
npm init -y
npm i @openai/agents zod express cors ts-morph fast-glob simple-git graphology graphology-traversal
npm i -D typescript tsx @types/node @types/express @types/cors
```

| Package | Lane | Why |
|---|---|---|
| `ts-morph` | A | TypeScript AST. The whole discovery engine. |
| `fast-glob` | A | Find `**/*.routes.ts` etc. |
| `simple-git` | B | `git clone` without wrangling `child_process`. |
| `graphology` | B | Graph structure + neighbor traversal, so nobody writes BFS. |
| `graphology-traversal` | B | `bfsFromNode` for `get_neighbors` / `trace_path`. |
| `@openai/agents` | B | The agent loop. |
| `zod` | B | Tool arg schemas for the agent. |
| `express`, `cors` | B | The API. |
| `tsx` | A+B | Run TypeScript directly — **no build step**. |

> ✅ **Resolved at T+0:** `@openai/agents` 0.17.0 peer-depends on **`zod ^4`** (installed: 4.5.4).
> The earlier "pin zod v3" warning was wrong — **do not downgrade zod**, it will break the SDK.

`api/package.json` scripts:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "typecheck": "tsc --noEmit",
    "test:graph": "tsx src/graph/selftest.ts",
    "ask": "tsx src/agent/cli.ts",
    "discover": "tsx src/discovery/cli.ts"
  }
}
```

`api/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

### `web/` — run by **[SWE-C]** at T+0

```bash
npx create-next-app@latest web --ts --app --tailwind --eslint --no-src-dir --import-alias "@/*"
cd web
npm i @xyflow/react @dagrejs/dagre
```

> ⚠️ React Flow v12 ships as **`@xyflow/react`**, not `reactflow`. You must import its stylesheet
> once: `import "@xyflow/react/dist/style.css";`

---

## 4. Same-Origin Proxy  `[SWE-C]` — kills CORS entirely

`web/next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://localhost:3001/api/:path*" }];
  },
};
export default nextConfig;
```

SWE-C therefore always calls `fetch("/api/analyze", ...)` — never an absolute URL, never a CORS
preflight. SWE-B still enables `cors()` on the Express app as a belt-and-braces fallback.

---

## 5. Environment  `[SWE-B]` — `api/.env`

The agent SDK speaks the OpenAI wire format, so **any OpenAI-compatible endpoint works**. We
default to a **free open-weight model on Groq** and keep OpenAI as an option. Set one key; the
server auto-detects the provider (free ones win), or force it with `LLM_PROVIDER=`.

```bash
# Recommended free default — Groq. Key: https://console.groq.com/keys
GROQ_API_KEY=gsk_...
# Free backup — Gemini free tier. Key: https://aistudio.google.com/apikey
GEMINI_API_KEY=AIza...
# (Cerebras is a preset too, but a fresh account answered 402 "Payment required" for every model
#  in Sept 2026 — test it with one /api/ask before trusting it as the backup.)

# Others (set one instead, or LLM_PROVIDER=<name> to force):
#   OPENROUTER_API_KEY=   openrouter  free routes, Llama where still offered
#   LLAMA_API_KEY=        llama       Meta Llama API preview (Llama 4)
#   GEMINI_API_KEY=       gemini      gemini-2.5-flash (free tier)
#   LLM_PROVIDER=ollama   ollama      fully local, no key
#   OPENAI_API_KEY=       openai      gpt-4.1-mini (paid)
# LLM_MODEL=            pin a model id (skips auto-selection)
# LLM_BASE_URL=         any other OpenAI-compatible endpoint (LLM_PROVIDER=custom)

PORT=3001
CLONE_DIR=./.tmp-repos
```

**The model is picked from the host's live `/models` catalog at startup**, first match from a
per-provider preference list (`api/src/llm.ts`). Free-tier catalogs churn — in Sept 2026 Groq and
Cerebras dropped Meta Llama chat models; the free open-weight option on both is now
**`gpt-oss-120b`** (OpenAI's Apache-2.0 open weights), which is what we default to. If a name
disappears, the server picks the next available one and warns instead of 404-ing on stage.

`GET /api/health` reports `llm.provider`, `llm.model`, `llm.modelSource` and a catalog sample, so
a wrong env is visible in one request. Full list of knobs: `api/.env.example`.

> **Free-tier pacing (measured):** Groq's free tier allows **8,000 tokens/minute per key**. Every
> agent turn resends the conversation (~1.2–1.9k tokens), so one question costs ~3–6k tokens and
> a second question within the same minute gets throttled — the client waits on `retry-after`
> and the answer arrives 30–50s late instead of 4s. **On stage: one question per minute, and
> never fire two at once.** If you need more, put a Gemini key in as backup (`GEMINI_API_KEY`,
> 250k TPM free) and switch with `LLM_PROVIDER=gemini` + restart.

> Non-OpenAI hosts get plain JSON-Schema tools (`strict: false`) and the server validates tool
> arguments itself; OpenAI gets strict schemas. This is automatic per provider.

Add to `.gitignore`: `node_modules/`, `.env`, `.tmp-repos/`, `fixtures/last-graph.json`, `.next/`

> **Have TWO provider keys at T+0** (e.g. Groq + Cerebras, both free, 2 minutes each). Free tiers
> rate-limit; if one stalls mid-demo, switching is one env var and a restart. Only SWE-B strictly
> needs them, but a blocked key at T+80 with one person able to debug is how demos die.

---

## 6. Run Commands

```bash
# terminal 1
cd api ; npm run dev            # → http://localhost:3001

# terminal 2
cd web ; npm run dev            # → http://localhost:3000

# discovery alone, no server (SWE-A's inner loop)
cd api ; npx tsx src/discovery/cli.ts <path-to-target-repo>
```

---

## 7. Smoke Test — run this at T+75 integration

One command boots the API on a spare port, checks every endpoint contract, and shuts it down:

```bash
cd api
npm test              # offline: graph builder/query + provider config + tool definitions
npm run smoke         # offline: every HTTP endpoint, error shapes, CORS, 413, fixture fallback
npm run smoke:live    # + one real /api/ask; asserts correct chain, cited nodes, graph-only trace
```

Manual equivalents, if you want to poke at a running server:

```bash
curl http://localhost:3001/api/health
curl -X POST http://localhost:3001/api/analyze -H "Content-Type: application/json" -d "{\"localPath\":\"C:/path/to/demo-repo\"}"
curl -X POST http://localhost:3001/api/ask -H "Content-Type: application/json" -d "{\"question\":\"How does creating a user work?\"}"
```

On PowerShell, `curl` is aliased to `Invoke-WebRequest` — use `curl.exe` explicitly, or
`Invoke-RestMethod -Method Post -Uri ... -ContentType application/json -Body '...'`.
