// B3 — agent construction + ask(). Graph-first; where the provider supports it, tool_choice is
// forced on the first turn so the model can never answer from priors without touching the graph.
import { Agent, run } from "@openai/agents";
import type { AskResponse, ToolCallTrace } from "../contract.js";
import * as q from "../graph/query.js";
import { demoteModel, reasoningEffortFor, resolveModel } from "../llm.js";
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
  const llm = await resolveModel();
  if (!llm.hasKey) throw new Error(llm.keyHelp);

  const ctx: ToolContext = { trace: [], seen: new Set(), rootDir: opts.rootDir ?? null };
  const tools = makeTools(ctx, llm.strictTools);

  // Free-tier catalogs list models the free plan cannot call (402) or that vanish (404). Those are
  // model-level failures, so fall through to the next candidate instead of failing the question.
  let result;
  for (let attempt = 0; ; attempt++) {
    const model = opts.model ?? llm.model;
    const effort = reasoningEffortFor(model);
    const agent = new Agent({
      name: "Engineering Graph Analyst",
      instructions: SYSTEM_PROMPT,
      model,
      tools,
      modelSettings: {
        // Free tiers meter tokens per minute and every turn resends the conversation, so fewer
        // turns is the whole latency game: let the model issue several tool calls in one turn.
        parallelToolCalls: true,
        // "required" applies to the first turn only; the SDK resets tool choice after a tool call.
        ...(llm.forceFirstTool ? { toolChoice: "required" as const } : {}),
        // Cheap questions, expensive thinking: keep reasoning models brief (see reasoningEffortFor).
        ...(effort ? { reasoning: { effort } } : {}),
      },
    });
    try {
      result = await run(agent, text, { maxTurns: opts.maxTurns ?? 12 });
      break;
    } catch (e) {
      if (!opts.model && attempt < 3 && isModelLevelFailure(e)) {
        const next = demoteModel(model);
        if (next) {
          console.warn(`[llm] ${llm.provider}/${model} unavailable (${firstLine(String((e as Error).message ?? e))}); retrying with ${next}`);
          ctx.trace.length = 0;
          ctx.seen.clear();
          continue;
        }
      }
      throw new Error(describeProviderError(e, llm.provider, model, llm.baseURL));
    }
  }
  const raw = typeof result.finalOutput === "string" ? result.finalOutput : JSON.stringify(result.finalOutput ?? "");
  const { answer, cited } = splitCited(raw);

  return {
    answer: answer || "The model returned no answer text.",
    citedNodeIds: resolveCited(answer, cited, ctx.seen),
    toolCalls: ctx.trace,
  };
}

/** 402 (paywalled on this plan) and 404 (gone) are about the model, not the request. */
function isModelLevelFailure(e: unknown): boolean {
  const status = (e as { status?: number }).status;
  const msg = e instanceof Error ? e.message : String(e);
  return status === 402 || status === 404 || /model_not_found|payment required|does not exist or you do not have access/i.test(msg);
}

/** Turn SDK/HTTP failures into one line a UI can show and a person can act on. */
function describeProviderError(e: unknown, provider: string, model: string, baseURL: string | null): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number }).status;
  const prefix = `[${provider}/${model}] `;
  if (status === 401 || /invalid api key|incorrect api key|unauthorized/i.test(msg)) return `${prefix}API key rejected (401). Check the key in api/.env.`;
  if (status === 402 || /payment required/i.test(msg)) return `${prefix}This model needs a paid plan on ${provider} (402). Set LLM_MODEL to a free one — GET /api/health lists the catalog.`;
  if (status === 404 || /model.*(not found|does not exist)|no such model|model_not_found/i.test(msg)) {
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
