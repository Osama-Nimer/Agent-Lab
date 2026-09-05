// LLM provider selection. The agent SDK speaks the OpenAI wire format, so any OpenAI-compatible
// endpoint works: free open-weight hosts (Groq, Cerebras, OpenRouter), Meta's Llama API, Gemini's
// free tier, a local Ollama, or OpenAI itself. Everything is env-driven; see .env.example.
//
// Two facts about free tiers drive the design:
//  - model names churn (Sept 2026: Groq/Cerebras dropped Meta Llama chat models; Google retired
//    gemini-2.5-flash for new accounts) -> unless LLM_MODEL pins one, the host's live /models
//    catalog is read once and the first match from a preference list is used;
//  - they rate-limit hard (Groq 8k tokens/min, Gemini per-minute quotas) -> every provider with a
//    key becomes a failover candidate, primary first (see getProviderChain / agent.ts).
import { OpenAIProvider, setTracingDisabled, type Model } from "@openai/agents";
import OpenAI from "openai";

export type ProviderName = "groq" | "cerebras" | "openrouter" | "llama" | "gemini" | "ollama" | "openai" | "custom";

interface Preset {
  baseURL: string | null; // null = the OpenAI default
  /** Models to try, best first. [0] is the fallback when the catalog cannot be read. */
  models: string[];
  keyEnv: string[]; // env vars checked, in order
  /** OpenAI strict function schemas. Only OpenAI honours them reliably; others get plain JSON Schema. */
  strictTools: boolean;
  /** Force a tool call on the first turn (tool_choice: "required"). Off for hosts that reject it. */
  forceFirstTool: boolean;
  /** Responses API vs Chat Completions. Only OpenAI has Responses. */
  useResponses: boolean;
  signup: string;
}

// Order matters: auto-detection walks this list and picks the first provider with a key present,
// so the free options win over OpenAI when both are configured. It is also the failover order.
const PRESETS: Record<ProviderName, Preset> = {
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    models: [
      "openai/gpt-oss-120b",
      "meta-llama/llama-4-maverick-17b-128e-instruct",
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "llama-3.3-70b-versatile",
      "qwen/qwen3.8-27b",
      "qwen/qwen3.6-27b",
      "openai/gpt-oss-20b",
    ],
    keyEnv: ["GROQ_API_KEY"],
    strictTools: false,
    forceFirstTool: true,
    useResponses: false,
    signup: "free key at https://console.groq.com/keys",
  },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    // Google retires older ids for new accounts (2.5-flash -> 404 "use gemini-3.6-flash"), so lead
    // with the current stable flash line and keep older names as fallbacks.
    models: ["gemini-3.6-flash", "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    strictTools: false,
    forceFirstTool: true,
    useResponses: false,
    signup: "free key at https://aistudio.google.com/apikey",
  },
  cerebras: {
    baseURL: "https://api.cerebras.ai/v1",
    models: ["gpt-oss-120b", "llama-3.3-70b", "llama-4-scout-17b-16e-instruct", "qwen-3.8-27b", "gemma-4-31b"],
    keyEnv: ["CEREBRAS_API_KEY"],
    strictTools: false,
    forceFirstTool: true,
    useResponses: false,
    signup: "key at https://cloud.cerebras.ai (new accounts answered 402 for every model in Sept 2026)",
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    models: [
      "openai/gpt-oss-120b:free",
      "meta-llama/llama-4-maverick:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "qwen/qwen3-235b-a22b:free",
    ],
    keyEnv: ["OPENROUTER_API_KEY"],
    strictTools: false,
    forceFirstTool: true,
    useResponses: false,
    signup: "free key at https://openrouter.ai/keys",
  },
  llama: {
    baseURL: "https://api.llama.com/compat/v1/",
    models: ["Llama-4-Maverick-17B-128E-Instruct-FP8", "Llama-4-Scout-17B-16E-Instruct-FP8", "Llama-3.3-70B-Instruct"],
    keyEnv: ["LLAMA_API_KEY"],
    strictTools: false,
    forceFirstTool: true,
    useResponses: false,
    signup: "Meta Llama API preview at https://llama.developer.meta.com",
  },
  ollama: {
    baseURL: "http://localhost:11434/v1",
    models: ["gpt-oss:20b", "llama3.1:8b", "qwen3:8b", "llama3.2:3b"],
    keyEnv: [], // Ollama ignores the key; any non-empty string works
    strictTools: false,
    forceFirstTool: false,
    useResponses: false,
    signup: "install https://ollama.com then `ollama pull llama3.1:8b`",
  },
  openai: {
    baseURL: null,
    models: ["gpt-4.1-mini"],
    keyEnv: ["OPENAI_API_KEY"],
    strictTools: true,
    forceFirstTool: true,
    useResponses: true,
    signup: "paid — https://platform.openai.com/api-keys",
  },
  custom: {
    baseURL: null, // must come from LLM_BASE_URL
    models: [], // must come from LLM_MODEL
    keyEnv: ["LLM_API_KEY"],
    strictTools: false,
    forceFirstTool: true,
    useResponses: false,
    signup: "set LLM_BASE_URL, LLM_MODEL and LLM_API_KEY",
  },
};

export interface LLMConfig {
  provider: ProviderName;
  /** Static choice: LLM_MODEL, else the preset's first preference. resolveModel() may replace it. */
  model: string;
  baseURL: string | null;
  hasKey: boolean;
  strictTools: boolean;
  forceFirstTool: boolean;
  /** Human-readable fix when hasKey is false. */
  keyHelp: string;
  /** Where the provider choice came from — surfaced in /api/health so mis-config is visible. */
  resolvedFrom: "LLM_PROVIDER" | "detected-key" | "default" | "failover";
  /** How the model was chosen. "unverified" until resolveModel() has run; "fallback" after a demotion. */
  modelSource: "LLM_MODEL" | "catalog" | "preset-unverified" | "preset-not-in-catalog" | "catalog-unreachable" | "fallback";
  /** Model ids the host actually lists, for the health endpoint, error messages and demotion. */
  catalog: string[];
  apiKey: string; // never serialise this
}

let primaryName: ProviderName | null = null;
const configs = new Map<ProviderName, LLMConfig>();
const resolving = new Map<ProviderName, Promise<LLMConfig>>();
const providers = new Map<ProviderName, OpenAIProvider>();
const demoted = new Map<ProviderName, Set<string>>();

/** The primary provider. Synchronous, cheap, no network. Enough for health checks and error messages. */
export function getLLMConfig(): LLMConfig {
  if (primaryName) return configs.get(primaryName)!;
  const env = process.env;

  let resolvedFrom: LLMConfig["resolvedFrom"] = "default";
  let provider = (env.LLM_PROVIDER?.trim().toLowerCase() || "") as ProviderName | "";
  if (provider && !(provider in PRESETS)) {
    throw new Error(`Unknown LLM_PROVIDER "${provider}". One of: ${Object.keys(PRESETS).join(", ")}`);
  }
  if (provider) resolvedFrom = "LLM_PROVIDER";
  else {
    const detected = (Object.keys(PRESETS) as ProviderName[]).find((p) => PRESETS[p].keyEnv.some((k) => env[k]?.trim()));
    if (detected) {
      provider = detected;
      resolvedFrom = "detected-key";
    } else provider = "groq"; // the recommended free default; keyHelp below says how to get a key
  }

  const cfg = configFor(provider, resolvedFrom, /* honourOverrides */ true);
  primaryName = provider;
  // Tracing exports to OpenAI's platform; with a non-OpenAI key it only produces noise.
  setTracingDisabled(!(provider === "openai" && envBool(env.LLM_TRACING) === true));
  return cfg;
}

/**
 * Primary first, then every other preset that has a key in the environment — the failover order
 * used by ask(). Ollama and custom only ever appear as the explicit primary.
 */
export function getProviderChain(): LLMConfig[] {
  const first = getLLMConfig();
  const rest = (Object.keys(PRESETS) as ProviderName[]).filter(
    (p) => p !== first.provider && p !== "custom" && p !== "ollama" && PRESETS[p].keyEnv.some((k) => process.env[k]?.trim()),
  );
  return [first, ...rest.map((p) => configFor(p, "failover", false))];
}

// ---- circuit breaker ----------------------------------------------------------------------
// A provider that just rate-limited us will do so again for the next minute; asking it first on
// every question costs 15-20s of retries before the failover kicks in. Skip it while it cools.
const COOLDOWN_MS = 60_000;
const cooldownUntil = new Map<ProviderName, number>();

export function markRateLimited(provider: ProviderName, ms = COOLDOWN_MS): void {
  cooldownUntil.set(provider, Date.now() + Math.min(Math.max(ms, 5_000), 5 * 60_000));
}

/** Milliseconds until the provider may be tried again; 0 when it is not cooling down. */
export function cooldownRemaining(provider: ProviderName): number {
  const until = cooldownUntil.get(provider);
  if (until === undefined) return 0;
  const left = until - Date.now();
  if (left <= 0) {
    cooldownUntil.delete(provider);
    return 0;
  }
  return left;
}

export const isCoolingDown = (provider: ProviderName): boolean => cooldownRemaining(provider) > 0;

/** Providers to try, in order: those not cooling down first (chain order), then the cooling ones soonest-to-recover first. */
export function getActiveChain(): LLMConfig[] {
  const chain = getProviderChain().filter((c) => c.hasKey);
  const ready = chain.filter((c) => !isCoolingDown(c.provider));
  const cooling = chain.filter((c) => isCoolingDown(c.provider)).sort((a, b) => cooldownRemaining(a.provider) - cooldownRemaining(b.provider));
  return [...ready, ...cooling];
}

function configFor(provider: ProviderName, resolvedFrom: LLMConfig["resolvedFrom"], honourOverrides: boolean): LLMConfig {
  const existing = configs.get(provider);
  if (existing) return existing;
  const env = process.env;
  const preset = PRESETS[provider];

  // LLM_MODEL / LLM_BASE_URL / LLM_API_KEY describe the PRIMARY provider only; failover providers use presets.
  const apiKey =
    (honourOverrides ? env.LLM_API_KEY?.trim() : "") ||
    preset.keyEnv.map((k) => env[k]?.trim()).find(Boolean) ||
    (provider === "ollama" ? "ollama" : "");
  const pinned = honourOverrides ? env.LLM_MODEL?.trim() || (provider === "openai" ? env.OPENAI_MODEL?.trim() : "") || "" : "";
  const model = pinned || preset.models[0] || "";
  const baseURL = (honourOverrides ? env.LLM_BASE_URL?.trim() : "") || preset.baseURL;

  if (provider === "custom" && (!baseURL || !model)) {
    throw new Error("LLM_PROVIDER=custom requires LLM_BASE_URL and LLM_MODEL");
  }

  const cfg: LLMConfig = {
    provider,
    model,
    baseURL,
    hasKey: Boolean(apiKey),
    strictTools: (honourOverrides ? envBool(env.LLM_STRICT_TOOLS) : undefined) ?? preset.strictTools,
    forceFirstTool: (honourOverrides ? envBool(env.LLM_FORCE_FIRST_TOOL) : undefined) ?? preset.forceFirstTool,
    keyHelp: apiKey
      ? ""
      : `No API key for LLM provider "${provider}". Set ${preset.keyEnv[0] ?? "LLM_API_KEY"} in api/.env (${preset.signup}), or choose another with LLM_PROVIDER=${Object.keys(PRESETS).join("|")}.`,
    resolvedFrom,
    modelSource: pinned ? "LLM_MODEL" : "preset-unverified",
    catalog: [],
    apiKey,
  };
  configs.set(provider, cfg);
  return cfg;
}

/**
 * Confirms the model against the host's live /models catalog (once per provider; cached). Never
 * throws for network reasons — falls back to the preset name and records why in modelSource.
 */
export function resolveModel(cfg: LLMConfig = getLLMConfig()): Promise<LLMConfig> {
  const pending = resolving.get(cfg.provider);
  if (pending) return pending;
  const p = (async () => {
    if (!cfg.hasKey || cfg.modelSource === "LLM_MODEL" || cfg.provider === "custom") return cfg;

    const preset = PRESETS[cfg.provider];
    const catalog = await fetchCatalog(cfg.baseURL ?? "https://api.openai.com/v1", cfg.apiKey);
    if (catalog === null) {
      cfg.modelSource = "catalog-unreachable";
      return cfg;
    }
    cfg.catalog = catalog;
    const ids = new Set(catalog.flatMap((id) => [id, id.replace(/^models\//, "")])); // Gemini prefixes "models/"
    const pick = preset.models.find((m) => ids.has(m));
    if (pick) {
      cfg.model = pick;
      cfg.modelSource = "catalog";
    } else if (cfg.provider === "openai" || cfg.provider === "llama") {
      cfg.modelSource = "preset-unverified"; // these catalogs are huge/partial; trust the preset
    } else {
      cfg.modelSource = "preset-not-in-catalog";
    }
    return cfg;
  })();
  resolving.set(cfg.provider, p);
  return p;
}

/** A Model instance bound to this provider's endpoint and key, for `new Agent({ model })`. */
export async function getModel(cfg: LLMConfig, modelName = cfg.model): Promise<Model> {
  let provider = providers.get(cfg.provider);
  if (!provider) {
    // With a failover available, a 429 should switch provider immediately instead of sitting in
    // the client's retry/backoff loop (that loop is what pushed answers past the UI proxy timeout).
    const maxRetries = getProviderChain().filter((c) => c.hasKey).length > 1 ? 0 : 2;
    const openAIClient = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? undefined, maxRetries, timeout: 60_000 });
    provider = new OpenAIProvider({ openAIClient, useResponses: PRESETS[cfg.provider].useResponses });
    providers.set(cfg.provider, provider);
  }
  return provider.getModel(modelName);
}

async function fetchCatalog(baseURL: string, apiKey: string): Promise<string[] | null> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    return ids.length ? ids.sort() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Every model this provider could serve, best first: listed preferences, then other chat-looking catalog entries. */
function candidateModels(cfg: LLMConfig): string[] {
  const preset = PRESETS[cfg.provider];
  const catalogIds = cfg.catalog.map((id) => id.replace(/^models\//, ""));
  const listed = (m: string) => catalogIds.length === 0 || catalogIds.includes(m);
  return [...preset.models.filter(listed), ...catalogIds.filter((id) => !preset.models.includes(id) && looksLikeChatModel(id))];
}

// Per-model rate-limit cooldowns. Groq meters tokens per minute PER MODEL, so when gpt-oss-120b is
// spent, gpt-oss-20b or qwen still have a fresh budget on the same key — rotate before failing over.
const modelCooling = new Map<ProviderName, Map<string, number>>();

export function markModelCooling(cfg: LLMConfig, model: string, ms: number): void {
  const m = modelCooling.get(cfg.provider) ?? new Map<string, number>();
  m.set(model, Date.now() + Math.min(Math.max(ms, 5_000), 5 * 60_000));
  modelCooling.set(cfg.provider, m);
}

function modelReady(cfg: LLMConfig, model: string): boolean {
  const until = modelCooling.get(cfg.provider)?.get(model);
  if (until === undefined) return true;
  if (Date.now() >= until) {
    modelCooling.get(cfg.provider)!.delete(model);
    return true;
  }
  return false;
}

/**
 * The model to use for the next request: LLM_MODEL if pinned, else the best candidate that is
 * neither permanently unavailable (402/404) nor cooling down (429). Null when nothing is usable.
 */
export function selectModel(cfg: LLMConfig): string | null {
  if (cfg.modelSource === "LLM_MODEL") return cfg.model;
  const gone = demoted.get(cfg.provider) ?? new Set<string>();
  const pick = candidateModels(cfg).find((m) => !gone.has(m) && modelReady(cfg, m));
  if (pick && pick !== cfg.model) {
    cfg.model = pick;
    if (cfg.modelSource !== "catalog" || pick !== candidateModels(cfg)[0]) cfg.modelSource = "fallback";
  }
  return pick ?? null;
}

/**
 * After a model-level failure (402 paywalled, 404 gone) retire the model for good and switch to the
 * next candidate. Returns the new model, or null when the user pinned LLM_MODEL or nothing is left.
 */
export function demoteModel(failed: string, cfg: LLMConfig = getLLMConfig()): string | null {
  if (cfg.modelSource === "LLM_MODEL") return null;
  const gone = demoted.get(cfg.provider) ?? new Set<string>();
  gone.add(failed);
  demoted.set(cfg.provider, gone);
  const next = candidateModels(cfg).find((m) => !gone.has(m));
  if (!next) return null;
  cfg.model = next;
  cfg.modelSource = "fallback";
  return next;
}

/** Catalogs mix in speech, image, video, embedding, guard and research previews; never fall back onto one of those. */
const looksLikeChatModel = (id: string) =>
  !/whisper|orpheus|tts|speech|embed|rerank|guard|moderation|safeguard|allam|preview|antigravity|image|imagen|veo|lyria|audio|live|transcribe|robotics|computer-use|deep-research|aqa|banana|omni/i.test(id);

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * Graph traversal is easy; long deliberation only adds latency. Reasoning models (gpt-oss, o-series)
 * accept `reasoning_effort`; most other hosts reject the parameter, so only send it where it fits.
 * LLM_REASONING_EFFORT overrides (set "none" to never send it).
 */
export function reasoningEffortFor(model: string): ReasoningEffort | null {
  const v = process.env.LLM_REASONING_EFFORT?.trim().toLowerCase();
  if (v === "none" || v === "off") return null;
  if (v === "minimal" || v === "low" || v === "medium" || v === "high") return v;
  return /gpt-oss|(^|\/)o[1-9]|reasoning|thinking/i.test(model) ? "low" : null;
}

/** Safe-to-serialise view for /api/health and logs. */
export function describeLLM(cfg: LLMConfig) {
  return {
    provider: cfg.provider,
    model: cfg.model,
    modelSource: cfg.modelSource,
    reasoningEffort: reasoningEffortFor(cfg.model),
    baseURL: cfg.baseURL,
    hasKey: cfg.hasKey,
    resolvedFrom: cfg.resolvedFrom,
    coolingDown: isCoolingDown(cfg.provider),
    modelsCooling: [...(modelCooling.get(cfg.provider)?.entries() ?? [])].filter(([, until]) => until > Date.now()).map(([m, until]) => `${m} (${Math.ceil((until - Date.now()) / 1000)}s)`),
    failover: getProviderChain().slice(1).map((c) => `${c.provider}/${c.model}${isCoolingDown(c.provider) ? " (cooling down)" : ""}`),
    catalogSample: cfg.catalog.slice(0, 12),
    catalogSize: cfg.catalog.length,
  };
}

/** Test seam. */
export function resetLLMConfig(): void {
  primaryName = null;
  configs.clear();
  resolving.clear();
  providers.clear();
  demoted.clear();
  cooldownUntil.clear();
  modelCooling.clear();
}

function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  return !/^(0|false|no|off)$/i.test(v.trim());
}
