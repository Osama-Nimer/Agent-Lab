// `npm run test:agent` — provider resolution + tool definitions in both wire formats, no network.
import { RunContext } from "@openai/agents";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Graph } from "../contract.js";
import { indexGraph } from "../graph/query.js";
import { demoteModel, getActiveChain, getLLMConfig, markModelCooling, markRateLimited, resetLLMConfig, resolveModel, selectModel } from "../llm.js";
import { makeTools, type ToolContext } from "./tools.js";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- llm.ts
const LLM_VARS = [
  "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL", "LLM_STRICT_TOOLS", "LLM_FORCE_FIRST_TOOL", "LLM_TRACING",
  "GROQ_API_KEY", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "LLAMA_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
  "OPENAI_API_KEY", "OPENAI_MODEL",
];
const saved = Object.fromEntries(LLM_VARS.map((k) => [k, process.env[k]]));
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  for (const k of LLM_VARS) delete process.env[k];
  Object.assign(process.env, vars);
  resetLLMConfig();
  try {
    return fn();
  } finally {
    for (const k of LLM_VARS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
    resetLLMConfig();
  }
}
const cfg = (vars: Record<string, string>) => withEnv(vars, () => getLLMConfig());
const throws = (vars: Record<string, string>) => { try { cfg(vars); return ""; } catch (e) { return (e as Error).message; } };

let c = cfg({});
check("no keys -> groq default, hasKey=false, helpful keyHelp", c.provider === "groq" && !c.hasKey && /GROQ_API_KEY/.test(c.keyHelp) && c.resolvedFrom === "default", c);
c = cfg({ GROQ_API_KEY: "gsk_test" });
check("GROQ_API_KEY -> groq detected, gpt-oss-120b preset, non-strict, chat completions base", c.provider === "groq" && c.hasKey && c.model === "openai/gpt-oss-120b" && c.modelSource === "preset-unverified" && !c.strictTools && c.baseURL === "https://api.groq.com/openai/v1" && c.resolvedFrom === "detected-key", c);
c = cfg({ GROQ_API_KEY: "gsk_test", LLM_MODEL: "qwen/qwen3.8-27b" });
check("LLM_MODEL pins the model and skips catalog resolution", c.model === "qwen/qwen3.8-27b" && c.modelSource === "LLM_MODEL", c);
c = cfg({ OPENAI_API_KEY: "sk-test", OPENAI_MODEL: "gpt-4.1" });
check("OPENAI_API_KEY only -> openai, strict tools, OPENAI_MODEL honoured", c.provider === "openai" && c.strictTools && c.model === "gpt-4.1" && c.baseURL === null, c);
c = cfg({ OPENAI_API_KEY: "sk-test", GROQ_API_KEY: "gsk" });
check("both keys -> free provider wins", c.provider === "groq", c);
c = cfg({ LLM_PROVIDER: "ollama" });
check("ollama -> no key needed, first-tool forcing off", c.provider === "ollama" && c.hasKey && !c.forceFirstTool && c.baseURL === "http://localhost:11434/v1", c);
// resolveModel() with an unreachable host must fall back, never throw (nothing listens on port 9).
// resolveModel() reads config synchronously before its first await, so the env is captured correctly.
const resolved = await withEnv({ LLM_PROVIDER: "ollama", LLM_BASE_URL: "http://127.0.0.1:9/v1" }, () => resolveModel());
check("resolveModel: unreachable catalog -> preset kept, modelSource=catalog-unreachable", resolved.model === "gpt-oss:20b" && resolved.modelSource === "catalog-unreachable", { model: resolved.model, src: resolved.modelSource });

// demoteModel(): walk preferences, then other chat-looking catalog entries, never speech/guard models.
withEnv({ GROQ_API_KEY: "gsk" }, () => {
  const g = getLLMConfig();
  g.catalog = ["whisper-large-v3", "openai/gpt-oss-120b", "qwen/qwen3.8-27b", "meta-llama/llama-prompt-guard-2-86m", "groq/compound"];
  g.modelSource = "catalog";
  const first = demoteModel("openai/gpt-oss-120b");
  const second = demoteModel(first!);
  const third = demoteModel(second!);
  check("demoteModel: 120b -> qwen3.8 (next listed preference) -> compound (other chat model) -> null", first === "qwen/qwen3.8-27b" && second === "groq/compound" && third === null, [first, second, third]);
  const after = getLLMConfig(); // fresh reference: TS narrowed `g.modelSource` to the literal assigned above
  check("demoteModel: marks modelSource=fallback", after.modelSource === "fallback" && after.model === "groq/compound", after.modelSource);
});
withEnv({ GROQ_API_KEY: "gsk", LLM_MODEL: "pinned-model" }, () => {
  check("demoteModel: pinned LLM_MODEL is never demoted", demoteModel("pinned-model") === null && getLLMConfig().model === "pinned-model");
  check("selectModel: pinned LLM_MODEL always wins", selectModel(getLLMConfig()) === "pinned-model");
});
// Per-model rate limits (Groq TPM is per model): rotate to a sibling, come back when the window resets.
withEnv({ GROQ_API_KEY: "gsk" }, () => {
  const g = getLLMConfig();
  g.catalog = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"];
  g.modelSource = "catalog";
  check("selectModel: best candidate first", selectModel(g) === "openai/gpt-oss-120b");
  markModelCooling(g, "openai/gpt-oss-120b", 60_000);
  check("selectModel: cooling model skipped -> next listed preference", selectModel(g) === "qwen/qwen3.8-27b", g.model);
  markModelCooling(g, "qwen/qwen3.8-27b", 60_000);
  check("selectModel: two cooling -> third", selectModel(g) === "openai/gpt-oss-20b");
  markModelCooling(g, "openai/gpt-oss-20b", 60_000);
  check("selectModel: all cooling -> null (provider failover)", selectModel(g) === null);
});

// Failover chain: primary first, then every other keyed preset; rate-limited ones move to the back.
withEnv({ LLM_PROVIDER: "gemini", GEMINI_API_KEY: "g", GROQ_API_KEY: "gsk", CEREBRAS_API_KEY: "c" }, () => {
  const names = () => getActiveChain().map((c) => c.provider);
  check("chain: gemini primary, groq + cerebras failover", JSON.stringify(names()) === JSON.stringify(["gemini", "groq", "cerebras"]), names());
  markRateLimited("gemini");
  check("chain: rate-limited primary moves to the back for 60s", JSON.stringify(names()) === JSON.stringify(["groq", "cerebras", "gemini"]), names());
  markRateLimited("groq", 10_000);
  markRateLimited("cerebras", 40_000);
  check("chain: all cooling -> soonest to recover first", JSON.stringify(names()) === JSON.stringify(["groq", "cerebras", "gemini"]), names());
  check("chain: failover configs keep preset models, not the primary's LLM_MODEL", getActiveChain().find((c) => c.provider === "groq")!.model === "openai/gpt-oss-120b");
});
c = cfg({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk", LLM_STRICT_TOOLS: "false", LLM_MODEL: "gpt-4o-mini", LLM_FORCE_FIRST_TOOL: "0" });
check("explicit overrides beat preset", !c.strictTools && c.model === "gpt-4o-mini" && !c.forceFirstTool && c.resolvedFrom === "LLM_PROVIDER", c);
c = cfg({ GEMINI_API_KEY: "g" });
check("gemini preset", c.provider === "gemini" && c.model === "gemini-3.6-flash", c);
check("unknown provider throws", /Unknown LLM_PROVIDER/.test(throws({ LLM_PROVIDER: "bogus" })));
check("custom without base url throws", /LLM_BASE_URL/.test(throws({ LLM_PROVIDER: "custom", LLM_API_KEY: "k" })));
c = cfg({ LLM_PROVIDER: "custom", LLM_API_KEY: "k", LLM_BASE_URL: "http://x/v1", LLM_MODEL: "m" });
check("custom fully specified", c.hasKey && c.baseURL === "http://x/v1" && c.model === "m", c);

// ---------------------------------------------------------------- tools.ts
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(path.resolve(here, "../../../fixtures/graph.sample.json"), "utf8")) as Graph;
indexGraph(fixture);

type AnyTool = { name: string; strict?: boolean; parameters: { required?: string[]; properties?: Record<string, unknown> }; invoke: (rc: RunContext, input: string) => Promise<unknown> };
const byName = (tools: unknown[], name: string) => (tools as AnyTool[]).find((t) => t.name === name)!;

const apiRoot = path.resolve(here, "../.."); // a real directory to exercise the file tools against
for (const strict of [true, false]) {
  const ctx: ToolContext = { trace: [], seen: new Set(), rootDir: apiRoot };
  const tools = makeTools(ctx, strict);
  const mode = strict ? "strict" : "non-strict";
  check(`${mode}: 6 tools with a repo on disk`, tools.length === 6, tools.length);
  check(`${mode}: 4 graph-only tools without a repo (no useless file tools)`, makeTools({ trace: [], seen: new Set(), rootDir: null }, strict).length === 4);
  const fn = byName(tools, "find_nodes");
  const nb = byName(tools, "get_neighbors");
  check(`${mode}: strict flag = ${strict}`, fn.strict === strict, fn.strict);
  if (strict) {
    check("strict: all params required (OpenAI strict mode)", (nb.parameters.required ?? []).length === 3, nb.parameters.required);
  } else {
    check("non-strict: nullable params not required", JSON.stringify(nb.parameters.required) === JSON.stringify(["nodeId", "direction"]), nb.parameters.required);
    check("non-strict: no $schema key leaks into the tool definition", !("$schema" in nb.parameters), Object.keys(nb.parameters));
  }

  const rc = new RunContext();
  const r1 = JSON.parse(String(await fn.invoke(rc, JSON.stringify({ query: "user", type: null }))));
  check(`${mode}: find_nodes('user') -> 9 via invoke, complete, flagged as no exact match`, r1.count === 9 && r1.exactMatch === false && r1.complete === true && /ARE the answer/.test(r1.note), r1);
  const r1b = JSON.parse(String(await fn.invoke(rc, JSON.stringify({ query: "UserController", type: null }))));
  check(`${mode}: find_nodes('UserController') -> exactMatch, no note`, r1b.exactMatch === true && r1b.note === undefined, r1b);
  const r2 = JSON.parse(String(await nb.invoke(rc, JSON.stringify({ nodeId: "service:CreateUserService", direction: "in", depth: null }))));
  check(`${mode}: get_neighbors in -> UserController`, r2.nodes?.length === 1 && r2.nodes[0].id === "controller:UserController", r2);
  if (!strict) {
    const r3 = JSON.parse(String(await nb.invoke(rc, JSON.stringify({ nodeId: "model:users", direction: "in", depth: "2" }))));
    check("non-strict: depth omitted/quoted is tolerated ('2' -> 2 hops)", r3.nodes?.some((n: { id: string }) => n.id === "service:CreateUserService"), r3);
    const r4 = JSON.parse(String(await nb.invoke(rc, JSON.stringify({ nodeId: "model:users" }))));
    check("non-strict: missing required arg -> {error}, not a throw", typeof r4.error === "string" && /direction/.test(r4.error), r4);
    const r5 = JSON.parse(String(await nb.invoke(rc, JSON.stringify({ nodeId: "service:CreateUser", direction: "out" }))));
    check("non-strict: unknown id -> did-you-mean hint", /Did you mean/.test(r5.error ?? ""), r5);
  }
  check(`${mode}: trace recorded + seen populated`, ctx.trace.length >= 2 && ctx.seen.has("controller:UserController"), { trace: ctx.trace.length, seen: [...ctx.seen] });
  const rf = byName(tools, "read_file");
  const r6 = JSON.parse(String(await rf.invoke(rc, JSON.stringify({ path: "../secret.txt" }))));
  check(`${mode}: read_file refuses paths that escape the repo root`, /escapes repository root/.test(r6.error ?? ""), r6);
  const r7 = JSON.parse(String(await rf.invoke(rc, JSON.stringify({ path: "package.json" }))));
  check(`${mode}: read_file reads a file inside the root`, /engineering-graph-api/.test(r7.content ?? ""), Object.keys(r7));
  const sc = byName(tools, "search_code");
  const r8 = JSON.parse(String(await sc.invoke(rc, JSON.stringify({ pattern: "export function buildGraph" }))));
  check(`${mode}: search_code finds a known line`, r8.count >= 1 && r8.hits.some((h: { file: string }) => /build\.ts$/.test(h.file)), r8);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
