// B3 — agent construction + ask(). Graph-first; where the provider supports it, tool_choice is
// forced on the first turn so the model can never answer from priors without touching the graph.
//
// Resilience against free tiers: a paywalled/vanished model (402/404) is demoted to the next
// catalog candidate on the same host; a rate limit (429), server error (5xx) or unreachable host
// fails over to the next provider that has a key. One question, several chances, one answer.
import { Agent, run } from "@openai/agents";
import type { AskResponse, ToolCallTrace } from "../contract.js";
import * as q from "../graph/query.js";
import { setTimeout as delay } from "node:timers/promises";
import {
  cooldownRemaining,
  demoteModel,
  getActiveChain,
  getModel,
  getProviderChain,
  isCoolingDown,
  markModelCooling,
  markRateLimited,
  reasoningEffortFor,
  resolveModel,
  selectModel,
  type LLMConfig,
} from "../llm.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { makeTools, type ToolContext } from "./tools.js";

export interface AskOptions {
  /** Root of the analyzed repo for the fallback tools. */
  rootDir?: string | null;
  model?: string;
  maxTurns?: number;
}

export async function ask(question: string, opts: AskOptions = {}): Promise<AskResponse> {
  if (!q.hasGraph()) throw new Error("No graph loaded. Run /api/analyze first.");
  const text = question.trim();
  if (!text) throw new Error("Question is empty.");

  if (getActiveChain().length === 0) throw new Error(getProviderChain()[0]!.keyHelp);

  const ctx: ToolContext = { trace: [], seen: new Set(), rootDir: opts.rootDir ?? null };
  const reset = () => {
    ctx.trace.length = 0;
    ctx.seen.clear();
  };

  const failures: string[] = [];
  let finalOutput: unknown;
  let answeredBy: { provider: string; model: string } | undefined;

  /** One pass over the providers. Returns true when someone answered; records failures otherwise. */
  const attemptChain = async (chain: LLMConfig[]): Promise<boolean> => {
    providers: for (let pi = 0; pi < chain.length; pi++) {
      const cfg = await resolveModel(chain[pi]!);
      const tools = makeTools(ctx, cfg.strictTools);

      for (let attempt = 0; attempt < 5; attempt++) {
        const modelName = opts.model ?? selectModel(cfg);
        if (!modelName) break; // every model on this host is retired or cooling — next provider
        const agent = await buildAgent(cfg, modelName, tools);
        try {
          finalOutput = (await run(agent, text, { maxTurns: opts.maxTurns ?? 12 })).finalOutput;
          answeredBy = { provider: cfg.provider, model: modelName };
          return true;
        } catch (e) {
          const described = describeProviderError(e, cfg.provider, modelName, cfg.baseURL);
          if (!opts.model && isModelLevelFailure(e)) {
            const next = demoteModel(modelName, cfg);
            if (next) {
              console.warn(`[llm] ${cfg.provider}/${modelName} unavailable; retrying with ${next}`);
              reset();
              continue;
            }
          }
          if (cfg.forceFirstTool && /tool.?choice/i.test(messageOf(e)) && statusOf(e) === 400) {
            // Some hosts reject tool_choice=required on certain models; drop it and go again.
            console.warn(`[llm] ${cfg.provider}/${modelName} rejected forced tool choice; retrying without it`);
            cfg.forceFirstTool = false;
            reset();
            continue;
          }
          if (!opts.model && isPerModelRateLimit(e)) {
            // Groq-style per-model TPM: this model is spent for a bit, its siblings are not.
            markModelCooling(cfg, modelName, retryAfterMs(e));
            const next = selectModel(cfg);
            if (next) {
              console.warn(`[llm] ${cfg.provider}/${modelName} rate-limited; rotating to ${next}`);
              reset();
              continue;
            }
          }
          failures.push(described);
          if (isRateLimit(e)) markRateLimited(cfg.provider, retryAfterMs(e));
          if (pi < chain.length - 1 && shouldFailover(e)) {
            console.warn(`[llm] ${described} — failing over to ${chain[pi + 1]!.provider}`);
            reset();
            continue providers;
          }
          if (!shouldFailover(e)) throw new Error(described); // config/auth problems: no point retrying
          return false;
        }
      }
    }
    return false;
  };

  let answered = await attemptChain(getActiveChain());

  // Every provider is throttled at once (free tiers, consecutive questions). Rather than surface an
  // error, wait for the soonest one to recover — Groq's per-minute budget resets in seconds — and
  // go once more. Bounded: a single extra pass, at most 30s of waiting.
  if (!answered) {
    // Only rate-limited providers recover with time; a paywalled or misconfigured one never will.
    const soonest = getActiveChain().find((c) => isCoolingDown(c.provider));
    const wait = soonest ? Math.min(cooldownRemaining(soonest.provider), 30_000) : 0;
    if (soonest && wait > 0) {
      console.warn(`[llm] all providers throttled; waiting ${Math.ceil(wait / 1000)}s for ${soonest.provider}`);
      await delay(wait);
      reset();
      answered = await attemptChain(getActiveChain());
    }
  }
  if (!answered || !answeredBy) throw new Error(failures.join(" | ") || "No LLM provider could answer.");

  const raw = typeof finalOutput === "string" ? finalOutput : JSON.stringify(finalOutput ?? "");
  const { answer, cited } = splitCited(raw);

  return {
    answer: answer || "The model returned no answer text.",
    citedNodeIds: resolveCited(answer, cited, ctx.seen),
    toolCalls: ctx.trace,
    llm: answeredBy,
  };
}

async function buildAgent(cfg: LLMConfig, modelName: string, tools: ReturnType<typeof makeTools>) {
  const effort = reasoningEffortFor(modelName);
  return new Agent({
    name: "Engineering Graph Analyst",
    instructions: SYSTEM_PROMPT,
    model: await getModel(cfg, modelName),
    tools,
    modelSettings: {
      // Free tiers meter tokens per minute and every turn resends the conversation, so fewer
      // turns is the whole latency game: let the model issue several tool calls in one turn.
      parallelToolCalls: true,
      // "required" applies to the first turn only; the SDK resets tool choice after a tool call.
      ...(cfg.forceFirstTool ? { toolChoice: "required" as const } : {}),
      // Cheap questions, expensive thinking: keep reasoning models brief (see reasoningEffortFor).
      ...(effort ? { reasoning: { effort } } : {}),
    },
  });
}

const statusOf = (e: unknown) => (e as { status?: number }).status;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isRateLimit = (e: unknown) => statusOf(e) === 429 || /rate limit|quota/i.test(messageOf(e));
/** Groq words its TPM/RPM limits "Rate limit reached for model `x`" — scoped to the model, not the key. */
const isPerModelRateLimit = (e: unknown) => isRateLimit(e) && /for model\s*`/i.test(messageOf(e));

/**
 * How long the provider asked us to wait. Groq: `retry-after` header / "try again in 12.3s";
 * Gemini: `"retryDelay":"20s"` in the body. Default 15s; clamped 5s..60s by markRateLimited.
 */
function retryAfterMs(e: unknown): number {
  const headers = (e as { headers?: Headers | Record<string, string> }).headers;
  const header = headers instanceof Headers ? headers.get("retry-after") : headers?.["retry-after"];
  const fromHeader = header ? Number(header) : NaN;
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader * 1000;
  const msg = messageOf(e);
  const m = msg.match(/try again in ([\d.]+)\s*(ms|s|m)\b/i) ?? msg.match(/retryDelay"?\s*:\s*"?([\d.]+)(s)/i);
  if (m) {
    const n = Number(m[1]);
    return m[2]!.toLowerCase() === "ms" ? n : m[2]!.toLowerCase() === "m" ? n * 60_000 : n * 1000;
  }
  return 15_000;
}

/** 402 (paywalled on this plan) and 404 (gone) are about the model, not the request. */
function isModelLevelFailure(e: unknown): boolean {
  const status = statusOf(e);
  return status === 402 || status === 404 || /model_not_found|payment required|does not exist or you do not have access|no longer available/i.test(messageOf(e));
}

/** Rate limits, host errors and dead endpoints are about the provider; another one may answer. */
function shouldFailover(e: unknown): boolean {
  const status = statusOf(e);
  const msg = messageOf(e);
  return (
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    /rate limit|quota|connection error|ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT/i.test(msg) ||
    isModelLevelFailure(e) // every model on this host was demoted away
  );
}

/** Turn SDK/HTTP failures into one line a UI can show and a person can act on. */
function describeProviderError(e: unknown, provider: string, model: string, baseURL: string | null): string {
  const msg = messageOf(e);
  const status = statusOf(e);
  const prefix = `[${provider}/${model}] `;
  if (status === 401 || /invalid api key|incorrect api key|unauthorized/i.test(msg)) return `${prefix}API key rejected (401). Check the key in api/.env.`;
  if (status === 402 || /payment required/i.test(msg)) return `${prefix}This model needs a paid plan on ${provider} (402). Set LLM_MODEL to a free one — GET /api/health lists the catalog.`;
  if (status === 404 || /model.*(not found|does not exist)|no such model|model_not_found|no longer available/i.test(msg)) {
    return `${prefix}Model not found (404). Set LLM_MODEL to one this provider serves — GET /api/health lists the host's catalog.`;
  }
  if (status === 429 || /rate limit|quota|credits/i.test(msg)) return `${prefix}Rate-limited or out of quota (429): ${firstLine(msg)}`;
  if (/connection error|ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT/i.test(msg)) {
    return `${prefix}Cannot reach the provider endpoint ${baseURL ?? "(OpenAI)"}${provider === "ollama" ? " — is Ollama running? (`ollama serve`)" : ""}. ${firstLine(msg)}`;
  }
  if (/max turns/i.test(msg)) return `${prefix}The agent exceeded its turn limit without finishing.`;
  return `${prefix}${firstLine(msg)}`;
}
const firstLine = (s: string) => s.split("\n")[0]!.slice(0, 300);

/** Pull the trailing `CITED: a | b` line out of the answer. Tolerates its absence. */
function splitCited(raw: string): { answer: string; cited: string[] } {
  const m = raw.match(/\n?\s*CITED:\s*(.+)\s*$/i);
  if (!m) return { answer: raw.trim(), cited: [] };
  return {
    answer: raw.slice(0, m.index).trim(),
    cited: m[1]!.split(/[|,]/).map((s) => s.trim().replace(/^[`"']|[`"']$/g, "")).filter(Boolean),
  };
}

/**
 * Belt and braces. Union of:
 *  1. ids the model listed on its CITED line (kept only if they exist in the graph)
 *  2. nodes the tools actually returned whose label or id appears in the prose (word-bounded),
 *     so a short label like "users" cannot match by accident from a node the agent never saw.
 * Ordered to follow the request flow so the UI's highlight reads as a path.
 */
function resolveCited(answer: string, fromModel: string[], seen: Set<string>): string[] {
  const out = new Set<string>();
  for (const id of fromModel) if (q.getNode(id)) out.add(id);

  const lower = answer.toLowerCase();
  for (const id of seen) {
    const n = q.getNode(id);
    if (!n) continue;
    if (lower.includes(id.toLowerCase())) {
      out.add(id);
      continue;
    }
    if (n.label.length < 3) continue;
    // Word-bounded, and not preceded by "/" or ":" — so `users` inside "/api/v1/users" or a node
    // id does not count as a prose mention of the users module/model.
    if (new RegExp(`(^|[^A-Za-z0-9_/:])${escapeRe(n.label)}(?![A-Za-z0-9_])`, "i").test(answer)) out.add(id);
  }

  const order: Record<string, number> = { Project: 0, Module: 1, Route: 2, Controller: 3, Service: 4, Repository: 5, Model: 6 };
  return [...out].sort((a, b) => (order[q.getNode(a)!.type] ?? 9) - (order[q.getNode(b)!.type] ?? 9));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export type { ToolCallTrace };
