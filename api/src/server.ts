// B4 — the REST API. Shapes are Docs/CONTRACTS.md section 4; every error is `{ error: string }`.
import "./env.js";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnalyzeRequest, AnalyzeResponse, AskRequest, AskResponse, ErrorResponse } from "./contract.js";
import { FIXTURES_DIR } from "./env.js";
import { runDiscovery } from "./discovery-adapter.js";
import { getGraph, indexGraph } from "./graph/query.js";
import { ask } from "./agent/agent.js";
import { describeLLM, resolveModel } from "./llm.js";

const app = express();
// Lane C proxies same-origin, so CORS is only a fallback — and only for other local dev servers.
// A wildcard would let any web page you visit drive localPath + read_file against this machine.
app.use(cors({ origin: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/ }));
app.use(express.json({ limit: "1mb" }));

/** Root of the currently loaded repo, for the agent's fallback tools. */
let currentRootDir: string | null = null;
let analyzing: Promise<unknown> | null = null;

// Always 200 { ok: true } — the API is up even when the LLM env is wrong. Lane C's UI gates the
// analyze button on this, and analysis works without any model. Misconfig shows up in `llmError`.
app.get("/api/health", async (_req, res) => {
  let llm: ReturnType<typeof describeLLM> | null = null;
  let llmError: string | null = null;
  try {
    llm = describeLLM(await resolveModel());
  } catch (e) {
    llmError = e instanceof Error ? e.message : String(e);
  }
  res.json({ ok: true, graphLoaded: getGraph() !== null, llm, llmError });
});

app.post("/api/analyze", async (req: Request<unknown, AnalyzeResponse | ErrorResponse, AnalyzeRequest>, res) => {
  const body = req.body ?? {};
  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl.trim() : "";
  const localPath = typeof body.localPath === "string" ? body.localPath.trim() : "";
  if (!repoUrl && !localPath) return res.status(400).json({ error: "Provide repoUrl or localPath" });
  if (repoUrl && localPath) return res.status(400).json({ error: "Provide only one of repoUrl or localPath" });
  if (analyzing) return res.status(409).json({ error: "An analysis is already running" });

  const t0 = Date.now();
  const job = runDiscovery({ repoUrl: repoUrl || undefined, localPath: localPath || undefined });
  analyzing = job;
  try {
    const { graph, rootDir, source } = await job;
    indexGraph(graph);
    currentRootDir = rootDir;
    await writeFile(path.join(FIXTURES_DIR, "last-graph.json"), JSON.stringify(graph, null, 2)).catch(() => {});
    console.log(`[analyze] ${source} ${graph.stats.nodeCount}n/${graph.stats.edgeCount}e in ${Date.now() - t0}ms  <- ${rootDir ?? "fixture"}`);
    res.json({ graph });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[analyze] failed: ${msg}`);
    res.status(msg.startsWith("Unsupported repo URL") ? 400 : 500).json({ error: msg });
  } finally {
    analyzing = null;
  }
});

/** Convenience for Lane C: load the shared fixture without pointing at a repo. */
app.post("/api/analyze/sample", async (_req, res) => {
  const { graph } = await runDiscovery({});
  indexGraph(graph);
  currentRootDir = null;
  res.json({ graph });
});

app.get("/api/graph", (_req, res) => {
  const graph = getGraph();
  if (!graph) return res.status(404).json({ error: "No graph yet. Run /api/analyze first." });
  res.json({ graph });
});

app.post("/api/ask", async (req: Request<unknown, AskResponse | ErrorResponse, AskRequest>, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question) return res.status(400).json({ error: "Provide a non-empty question" });
  if (!getGraph()) return res.status(400).json({ error: "No graph loaded. Run /api/analyze first." });
  const t0 = Date.now();
  try {
    const out = await ask(question, { rootDir: currentRootDir });
    console.log(`[ask] ${Date.now() - t0}ms  tools=${out.toolCalls.map((t) => t.name).join(",")}  cited=${out.citedNodeIds.length}`);
    res.json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ask] failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

// Anything that escaped the handlers above — still `{ error }`, never an HTML stack trace.
app.use((err: unknown, _req: Request, res: Response<ErrorResponse>, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  // body-parser attaches a 4xx `status` (400 malformed JSON, 413 too large, 415 bad charset…);
  // keep it so client mistakes are not logged and shown as server failures.
  const { type, status: s } = err as { type?: string; status?: number };
  const status = typeof s === "number" && s >= 400 && s < 500 ? s : 500;
  console.error(`[server] ${status} ${msg}`);
  res.status(status).json({ error: type === "entity.parse.failed" ? `Malformed JSON body: ${msg}` : msg });
});

const port = Number(process.env.PORT ?? 3001);
app.listen(port, async () => {
  console.log(`Engineering Graph API on http://localhost:${port}`);
  try {
    const llm = await resolveModel();
    console.log(`[llm] ${llm.provider} / ${llm.model}  (provider: ${llm.resolvedFrom}, model: ${llm.modelSource})${llm.baseURL ? `  <- ${llm.baseURL}` : ""}`);
    if (!llm.hasKey) console.warn(`[warn] ${llm.keyHelp}`);
    else if (llm.modelSource === "preset-not-in-catalog") {
      console.warn(`[warn] "${llm.model}" is not in ${llm.provider}'s catalog. Available: ${llm.catalog.slice(0, 12).join(", ")}. Set LLM_MODEL.`);
    } else if (llm.modelSource === "catalog-unreachable") {
      console.warn(`[warn] could not read ${llm.provider}'s /models catalog; using "${llm.model}" unverified`);
    }
  } catch (e) {
    console.error(`[llm] misconfigured: ${e instanceof Error ? e.message : String(e)} — /api/ask will fail`);
  }
});
