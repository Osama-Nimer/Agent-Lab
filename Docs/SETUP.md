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

> ⚠️ **Known risk, check at T+0 (2 min):** `@openai/agents` has historically required **zod v3**
> for tool schemas; zod v4 changed internals. If defining a tool throws a schema error, run
> `npm i zod@^3.23` and move on. Do not debug this at T+80.

`api/package.json` scripts:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
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

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini      # confirm the team has access; swap if not
PORT=3001
CLONE_DIR=./.tmp-repos
```

Add to `.gitignore`: `node_modules/`, `.env`, `.tmp-repos/`, `fixtures/last-graph.json`, `.next/`

> **The API key must be in all three SWEs' hands at T+0.** Only SWE-B strictly needs it, but a
> blocked key at T+80 with one person able to debug is how demos die.

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

```bash
curl http://localhost:3001/api/health
curl -X POST http://localhost:3001/api/analyze -H "Content-Type: application/json" -d "{\"localPath\":\"C:/path/to/demo-repo\"}"
curl -X POST http://localhost:3001/api/ask -H "Content-Type: application/json" -d "{\"question\":\"How does creating a user work?\"}"
```

On PowerShell, `curl` is aliased to `Invoke-WebRequest` — use `curl.exe` explicitly, or
`Invoke-RestMethod -Method Post -Uri ... -ContentType application/json -Body '...'`.
