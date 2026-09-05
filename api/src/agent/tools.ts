// B3 — the 6 tools. Thin wrappers over graph/query.ts plus two file-system fallbacks.
// The trace is recorded here, in the closure, so it is independent of SDK result internals.
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { GraphNode, NodeType, ToolCallTrace } from "../contract.js";
import * as q from "../graph/query.js";

const NODE_TYPES = ["Project", "Module", "Route", "Controller", "Service", "Repository", "Model"] as const;

export interface ToolContext {
  trace: ToolCallTrace[];
  /** Every node id any graph tool returned — the candidate set for citedNodeIds. */
  seen: Set<string>;
  /** Root of the analyzed repo for the fallback tools; null when only a fixture is loaded. */
  rootDir: string | null;
}

const compact = (n: GraphNode) => ({
  id: n.id,
  type: n.type,
  label: n.label,
  module: n.module,
  file: n.file,
  line: n.line,
});
const edgeView = (e: { source: string; target: string; type: string; confidence: string }) => ({
  source: e.source,
  target: e.target,
  type: e.type,
  confidence: e.confidence,
});

/**
 * @param strict  true = OpenAI strict function schemas (zod passed through).
 *                false = plain JSON Schema for OpenAI-compatible hosts (Groq, Ollama, …) that do
 *                not honour strict mode; arguments are validated here with the same zod schema.
 */
export function makeTools(ctx: ToolContext, strict: boolean): Tool[] {
  const record = (name: string, args: unknown) => ctx.trace.push({ name, args });
  const see = (nodes: GraphNode[]) => nodes.forEach((n) => ctx.seen.add(n.id));
  const fail = (e: unknown) => JSON.stringify({ error: e instanceof Error ? e.message : String(e) });

  const getGraphOverview = defineTool(strict, {
    name: "get_graph_overview",
    description:
      "Summary of the loaded engineering graph: node counts by type, module names, and route labels. Call this first when you do not know where to start.",
    schema: z.object({}),
    execute: async () => {
      record("get_graph_overview", {});
      try {
        return JSON.stringify(q.overview());
      } catch (e) {
        return fail(e);
      }
    },
  });

  const findNodes = defineTool(strict, {
    name: "find_nodes",
    description:
      "Search graph nodes by name. Every word in `query` must appear in the node's id, label or module. Returns up to 20 matches with their exact ids. Use this to locate a route, controller, service, repository or model before traversing.",
    schema: z.object({
      query: z.string().describe("words to search for, e.g. 'user' or 'POST users'"),
      type: z.enum(NODE_TYPES).nullable().describe("restrict to one node type, or null for any"),
    }),
    execute: async ({ query, type }) => {
      record("find_nodes", { query, type });
      try {
        const nodes = q.findNodes(query, (type ?? undefined) as NodeType | undefined);
        see(nodes);
        const exact = nodes.some((n) => n.label.toLowerCase() === query.trim().toLowerCase());
        // Smaller models re-search with spelling variants when the exact name is absent. Say it once.
        const note = nodes.length === 0
          ? "No node matches. Try a shorter query (one word) or get_graph_overview to see what exists."
          : exact
            ? undefined
            : `No node is labelled exactly "${query}"; these are the closest matches and are the answer to your search — use their ids, do not search again with variants.`;
        return JSON.stringify({ count: nodes.length, exactMatch: exact, note, nodes: nodes.map(compact) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const getNeighbors = defineTool(strict, {
    name: "get_neighbors",
    description:
      "Traverse from a node along its edges. direction 'out' follows the request flow downstream (Route -> Controller -> Service -> Repository -> Model); with depth 6 from a Route this returns the WHOLE chain in one call. direction 'in' finds what depends on the node (who calls it / who handles it). 'both' does both.",
    schema: z.object({
      nodeId: z.string().describe("exact node id from find_nodes, e.g. 'service:CreateUserService'"),
      direction: z.enum(["in", "out", "both"]),
      // number|string because smaller models sometimes send "2"; normalised below.
      depth: z.union([z.number(), z.string()]).nullable().describe("hops to follow, 1-6; null means 1; use 6 for a full request chain"),
    }),
    execute: async ({ nodeId, direction, depth }) => {
      record("get_neighbors", { nodeId, direction, depth });
      try {
        const d = Number(depth ?? 1);
        const r = q.neighbors(nodeId, direction, Number.isFinite(d) ? d : 1);
        see([r.center, ...r.nodes]);
        return JSON.stringify({ center: compact(r.center), nodes: r.nodes.map(compact), edges: r.edges.map(edgeView) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const tracePath = defineTool(strict, {
    name: "trace_path",
    description:
      "Shortest path between two nodes following edge direction (falls back to ignoring direction if none exists). Use it to explain how an endpoint reaches a model, or how two components are related.",
    schema: z.object({
      fromNodeId: z.string(),
      toNodeId: z.string(),
    }),
    execute: async ({ fromNodeId, toNodeId }) => {
      record("trace_path", { fromNodeId, toNodeId });
      try {
        const r = q.tracePath(fromNodeId, toNodeId);
        see(r.nodes);
        return JSON.stringify({ found: r.found, directed: r.directed, path: r.nodes.map(compact), edges: r.edges.map(edgeView) });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const readFileTool = defineTool(strict, {
    name: "read_file",
    description:
      "FALLBACK ONLY. Read a source file from the analyzed repository (repo-relative path, as shown in a node's `file`). Truncated to 400 lines. Use only when the graph cannot answer, and say so.",
    schema: z.object({ path: z.string() }),
    execute: async ({ path: rel }) => {
      record("read_file", { path: rel });
      if (!ctx.rootDir) return fail("No repository files available (graph loaded from a fixture).");
      try {
        const abs = safeJoin(ctx.rootDir, rel);
        const lines = (await readFile(abs, "utf8")).split(/\r?\n/);
        return JSON.stringify({ path: rel, truncated: lines.length > 400, content: lines.slice(0, 400).join("\n") });
      } catch (e) {
        return fail(e);
      }
    },
  });

  const searchCode = defineTool(strict, {
    name: "search_code",
    description:
      "FALLBACK ONLY. Case-insensitive substring search across the repository's .ts files. Returns up to 30 {file, line, text} hits. Use only when the graph cannot answer, and say so.",
    schema: z.object({ pattern: z.string() }),
    execute: async ({ pattern }) => {
      record("search_code", { pattern });
      if (!ctx.rootDir) return fail("No repository files available (graph loaded from a fixture).");
      try {
        const files = await fg(["**/*.ts"], {
          cwd: ctx.rootDir,
          ignore: ["**/node_modules/**", "**/dist/**", "**/*.d.ts"],
          absolute: false,
          followSymbolicLinks: false,
        });
        const needle = pattern.toLowerCase();
        const hits: { file: string; line: number; text: string }[] = [];
        for (const f of files) {
          const lines = (await readFile(path.join(ctx.rootDir, f), "utf8")).split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < 30; i++) {
            if (lines[i]!.toLowerCase().includes(needle)) hits.push({ file: f, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
          }
          if (hits.length >= 30) break;
        }
        return JSON.stringify({ count: hits.length, hits });
      } catch (e) {
        return fail(e);
      }
    },
  });

  // No repository on disk (fixture-only graph) -> no file tools at all. Offering tools that can
  // only fail wastes a model turn and muddies the "graph tools only" trace.
  const graphTools = [getGraphOverview, findNodes, getNeighbors, tracePath];
  return ctx.rootDir ? [...graphTools, readFileTool, searchCode] : graphTools;
}

// ---------------------------------------------------------------------------

interface ToolSpec<S extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  schema: S;
  execute: (args: z.infer<S>) => Promise<string>;
}

/**
 * One definition, two wire formats. Strict: hand the zod schema to the SDK (OpenAI validates).
 * Non-strict: emit JSON Schema with nullable fields made optional, then validate here — smaller
 * models omit null fields and quote numbers, so be lenient on input and precise on validation.
 */
function defineTool<S extends z.ZodObject<z.ZodRawShape>>(strict: boolean, spec: ToolSpec<S>): Tool {
  if (strict) {
    return tool({
      name: spec.name,
      description: spec.description,
      // The SDK types accept concrete ZodObjects, not a generic bound — the schema is one at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: spec.schema as any,
      execute: (args: unknown) => spec.execute(args as z.infer<S>),
    });
  }

  // Serialise to a plain object: zod 4's output carries a Standard Schema marker ("~standard") that
  // makes the SDK treat it as a live schema and refuse non-strict mode. Plain JSON has no marker.
  const json = JSON.parse(JSON.stringify(z.toJSONSchema(spec.schema))) as Record<string, unknown> & {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  delete json.$schema;
  const nullableKeys = Object.entries(spec.schema.shape)
    .filter(([, s]) => (s as z.ZodTypeAny).safeParse(null).success)
    .map(([k]) => k);
  json.required = (json.required ?? []).filter((k) => !nullableKeys.includes(k));

  return tool({
    name: spec.name,
    description: spec.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parameters: json as any,
    strict: false,
    execute: async (raw: unknown) => {
      let obj: Record<string, unknown>;
      try {
        obj = (typeof raw === "string" ? JSON.parse(raw || "{}") : raw ?? {}) as Record<string, unknown>;
      } catch {
        return JSON.stringify({ error: `Arguments for ${spec.name} were not valid JSON` });
      }
      for (const k of nullableKeys) if (!(k in obj)) obj[k] = null;
      const parsed = spec.schema.safeParse(obj);
      if (!parsed.success) {
        return JSON.stringify({ error: `Invalid arguments for ${spec.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` });
      }
      return spec.execute(parsed.data as z.infer<S>);
    },
  });
}

/** Keep read_file inside the repo root — the agent must not be able to read arbitrary disk. */
function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const normRoot = path.resolve(root) + path.sep;
  if (!abs.startsWith(normRoot)) throw new Error(`Path escapes repository root: ${rel}`);
  return abs;
}
