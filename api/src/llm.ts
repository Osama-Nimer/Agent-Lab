// LLM provider selection. The agent SDK speaks the OpenAI wire format, so any OpenAI-compatible
// endpoint works: free open-weight hosts (Groq, Cerebras, OpenRouter), Meta's Llama API, Gemini's
// free tier, a local Ollama, or OpenAI itself. Everything is env-driven; see .env.example.
//
// Model names on free hosts churn (Sept 2026: Groq and Cerebras no longer list Meta Llama chat
// models). So unless LLM_MODEL pins one, we read the host's live /models catalog once at startup
// and take the first match from a preference list — a catalog change becomes a warning, not a 404.
import { OpenAIProvider, setDefaultModelProvider, setTracingDisabled } from "@openai/agents";

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
// so the free options win over OpenAI when both are configured.
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
  cerebras: {
    baseURL: "https://api.cerebras.ai/v1",
    models: ["gpt-oss-120b", "llama-3.3-70b", "llama-4-scout-17b-16e-instruct", "qwen-3.8-27b", "gemma-4-31b"],
    keyEnv: ["CEREBRAS_API_KEY"],
    strictTools: false,
    forceFirstTool: true,
    useResponses: false,
    signup: "free key at https://cloud.cerebras.ai",
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
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    models: ["gemini-2.5-flash", "gemini-2.0-flash"],
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    strictTools: false,
    forceFirstTool: true,
    useResponses: false,
    signup: "free key at https://aistudio.google.com/apikey",
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
  resolvedFrom: "LLM_PROVIDER" | "detected-key" | "default";
  /** How the model was chosen. "unverified" until resolveModel() has run; "fallback" after a demotion. */
  modelSource: "LLM_MODEL" | "catalog" | "preset-unverified" | "preset-not-in-catalog" | "catalog-unreachable" | "fallback";
  /** Model ids the host actually lists (first few), for the health endpoint and error messages. */
  catalog: string[];
  apiKey: string; // never serialise this
}

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

let cached: LLMConfig | null = null;
let resolving: Promise<LLMConfig> | null = null;

/** Synchronous, cheap, no network. Enough for health checks and error messages. */
export function getLLMConfig(): LLMConfig {
  if (cached) return cached;
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
  const preset = PRESETS[provider];

  const apiKey =
    env.LLM_API_KEY?.trim() ||
    preset.keyEnv.map((k) => env[k]?.trim()).find(Boolean) ||
    (provider === "ollama" ? "ollama" : "");
  const pinned = env.LLM_MODEL?.trim() || (provider === "openai" ? env.OPENAI_MODEL?.trim() : "") || "";
  const model = pinned || preset.models[0] || "";
  const baseURL = env.LLM_BASE_URL?.trim() || preset.baseURL;

  if (provider === "custom" && (!baseURL || !model)) {
    throw new Error("LLM_PROVIDER=custom requires LLM_BASE_URL and LLM_MODEL");
  }

  const strictTools = envBool(env.LLM_STRICT_TOOLS) ?? preset.strictTools;
  const forceFirstTool = envBool(env.LLM_FORCE_FIRST_TOOL) ?? preset.forceFirstTool;

  const keyHelp = apiKey
    ? ""
    : `No API key for LLM provider "${provider}". Set ${preset.keyEnv[0] ?? "LLM_API_KEY"} in api/.env (${preset.signup}), or choose another with LLM_PROVIDER=${Object.keys(PRESETS).join("|")}.`;

  if (apiKey) {
    setDefaultModelProvider(new OpenAIProvider({ apiKey, baseURL: baseURL ?? undefined, useResponses: preset.useResponses }));
  }
  // Tracing exports to OpenAI's platform; with a non-OpenAI key it only produces noise.
  setTracingDisabled(!(provider === "openai" && envBool(env.LLM_TRACING) === true));

  cached = {
    provider,
    model,
    baseURL,
    hasKey: Boolean(apiKey),
    strictTools,
    forceFirstTool,
    keyHelp,
    resolvedFrom,
    modelSource: pinned ? "LLM_MODEL" : "preset-unverified",
    catalog: [],
    apiKey,
  };
  return cached;
}

/**
 * Confirms the model against the host's live /models catalog (once; cached). Never throws for
 * network reasons — falls back to the preset name and records why in modelSource.
 */
export function resolveModel(): Promise<LLMConfig> {
  if (resolving) return resolving;
  resolving = (async () => {
    const cfg = getLLMConfig();
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
  return resolving;
}

async function fetchCatalog(baseURL: string, apiKey: string): Promise<string[] | null> {
  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string");
    return ids.length ? ids.sort() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const demoted = new Set<string>();

/**
 * After a model-level failure (402 paywalled, 404 gone) switch to the next candidate: remaining
 * preferences that the catalog lists, then any other chat-looking catalog entry. Returns the new
 * model, or null when the user pinned LLM_MODEL or nothing is left.
 */
export function demoteModel(failed: string): string | null {
  const cfg = getLLMConfig();
  if (cfg.modelSource === "LLM_MODEL") return null;
  demoted.add(failed);
  const preset = PRESETS[cfg.provider];
  const catalogIds = cfg.catalog.map((id) => id.replace(/^models\//, ""));
  const listed = (m: string) => catalogIds.length === 0 || catalogIds.includes(m);
  const candidates = [
    ...preset.models.filter(listed),
    ...catalogIds.filter((id) => !preset.models.includes(id) && looksLikeChatModel(id)),
  ];
  const next = candidates.find((m) => !demoted.has(m));
  if (!next) return null;
  cfg.model = next;
  cfg.modelSource = "fallback";
  return next;
}

/** Catalogs mix in speech, embedding and guard models; never fall back onto one of those. */
const looksLikeChatModel = (id: string) => !/whisper|orpheus|tts|speech|embed|rerank|guard|moderation|safeguard|allam/i.test(id);

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
    catalogSample: cfg.catalog.slice(0, 12),
    catalogSize: cfg.catalog.length,
  };
}

/** Test seam. */
export function resetLLMConfig(): void {
  cached = null;
  resolving = null;
  demoted.clear();
}

function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  return !/^(0|false|no|off)$/i.test(v.trim());
}
