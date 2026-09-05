// `npm run smoke`        — boots the API on a spare port and checks every endpoint contract (no LLM).
// `npm run smoke:live`   — additionally asks a real question and asserts the answer used graph tools.
// Exit code 1 on any failure. Meant for the T+75 integration checkpoint and pre-demo sanity.
import "./env.js";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { API_ROOT, REPO_ROOT } from "./env.js";
import type { AskResponse, Graph } from "./contract.js";

const live = process.argv.includes("--live");
const port = 3900 + Math.floor(Math.random() * 90);
const B = `http://localhost:${port}`;
const J = { "Content-Type": "application/json" };

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (!ok) failures++;
};
const post = (path: string, body: unknown) => fetch(B + path, { method: "POST", headers: J, body: typeof body === "string" ? body : JSON.stringify(body) });
const json = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null });

// ---- boot ---------------------------------------------------------------------------------
const logs: string[] = [];
const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: API_ROOT,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => logs.push(String(d)));
child.stderr.on("data", (d) => logs.push(String(d)));
const stop = () => { try { child.kill(); } catch { /* already gone */ } };
process.on("exit", stop);

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await delay(300);
  up = await fetch(`${B}/api/health`).then((r) => r.ok).catch(() => false);
}
check(`server up on :${port}`, up, logs.join(""));
if (!up) { stop(); process.exit(1); }

try {
  // ---- contract checks (offline) -------------------------------------------------------------
  const h = await json(await fetch(`${B}/api/health`));
  check("health 200 ok:true with llm block", h.status === 200 && h.body?.ok === true && "llm" in (h.body ?? {}), h);

  let r = await json(await fetch(`${B}/api/graph`));
  check("graph before analyze -> 404 {error}", r.status === 404 && typeof r.body?.error === "string", r);

  r = await json(await post("/api/analyze", {}));
  check("analyze {} -> 400 {error}", r.status === 400 && typeof r.body?.error === "string", r);
  r = await json(await post("/api/analyze", { repoUrl: "ftp://nope" }));
  check("analyze bad url -> 400", r.status === 400, r);
  r = await json(await post("/api/analyze", { repoUrl: "x", localPath: "y" }));
  check("analyze both fields -> 400", r.status === 400, r);
  r = await json(await post("/api/analyze", "{bad"));
  check("malformed JSON -> 400 {error}", r.status === 400 && /Malformed JSON/.test(String(r.body?.error)), r);
  r = await json(await post("/api/analyze", { localPath: "x".repeat(1_200_000) }));
  check("1.2MB body -> 413", r.status === 413, r);

  r = await json(await post("/api/analyze/sample", {}));
  const g = (r.body as { graph?: Graph } | null)?.graph;
  check("analyze/sample -> 200 with graph", r.status === 200 && !!g && g.schemaVersion === 1, r.status);
  if (g) {
    const ids = new Set(g.nodes.map((n) => n.id));
    check("graph: no dangling edges", g.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
    check("graph: no duplicate node ids", ids.size === g.nodes.length);
    check("graph: stats counts match", g.stats.nodeCount === g.nodes.length && g.stats.edgeCount === g.edges.length);
    check("graph: every edge has confidence", g.edges.every((e) => e.confidence === "EXTRACTED" || e.confidence === "INFERRED"));
  }

  r = await json(await post("/api/analyze", { localPath: REPO_ROOT }));
  const g2 = (r.body as { graph?: Graph } | null)?.graph;
  check("analyze localPath -> 200 (real discovery, or fixture + explicit warning)", r.status === 200 && !!g2 && (g2.stats.warnings.some((w) => /Lane A/.test(w)) || g2.nodes.length > 0), r.status);

  r = await json(await fetch(`${B}/api/graph`));
  check("graph after analyze -> 200", r.status === 200 && !!(r.body as { graph?: Graph })?.graph, r.status);

  const pre = await fetch(`${B}/api/analyze`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  check("CORS: foreign origin not allowed", pre.headers.get("access-control-allow-origin") === null, pre.headers.get("access-control-allow-origin"));
  const pre2 = await fetch(`${B}/api/analyze`, { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" } });
  check("CORS: localhost dev server allowed", pre2.headers.get("access-control-allow-origin") === "http://localhost:3000", pre2.headers.get("access-control-allow-origin"));

  r = await json(await post("/api/ask", { question: "   " }));
  check("ask empty -> 400", r.status === 400, r);

  // ---- live (needs a provider key) ----------------------------------------------------------
  if (live) {
    const t0 = Date.now();
    r = await json(await post("/api/ask", { question: "How does creating a user work?" }));
    const a = r.body as unknown as AskResponse | null;
    const ms = Date.now() - t0;
    check(`ask live -> 200 in ${ms}ms`, r.status === 200 && !!a, r);
    if (r.status === 200 && a) {
      console.log(`      answer: ${a.answer.slice(0, 220)}${a.answer.length > 220 ? "…" : ""}`);
      console.log(`      tools:  ${a.toolCalls.map((t) => t.name).join(", ")}`);
      const graphTools = new Set(["get_graph_overview", "find_nodes", "get_neighbors", "trace_path"]);
      check("ask: answer names the controller and the service", /UserController/.test(a.answer) && /CreateUserService/.test(a.answer), a.answer);
      check("ask: cites route and model", a.citedNodeIds.includes("route:POST /api/v1/users") && a.citedNodeIds.includes("model:users"), a.citedNodeIds);
      check("ask: used graph tools only (no file fallback)", a.toolCalls.length > 0 && a.toolCalls.every((t) => graphTools.has(t.name)), a.toolCalls.map((t) => t.name));
      check("ask: answered in <= 5 turns", a.toolCalls.length <= 5, a.toolCalls.length);
    } else {
      console.log(`      ${logs.filter((l) => /\[ask\]|\[llm\]/.test(l)).join("").trim()}`);
    }
  } else {
    console.log("(skip)  live ask — run `npm run smoke:live` with a provider key in api/.env");
  }
} finally {
  stop();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
