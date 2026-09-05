// B2 — in-memory graph index + the query functions the agent tools wrap.
// Everything here is LLM-free and unit-testable (see selftest.ts).
import Graph from "graphology";
import type { Graph as GraphData, GraphEdge, GraphNode, NodeType } from "../contract.js";

export type Direction = "in" | "out" | "both";

interface Indexed {
  data: GraphData;
  g: Graph<GraphNode, GraphEdge>;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
}

let current: Indexed | null = null;

export function indexGraph(data: GraphData): void {
  const g = new Graph<GraphNode, GraphEdge>({ type: "directed", multi: true, allowSelfLoops: false });
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  for (const n of data.nodes) {
    if (nodes.has(n.id)) continue;
    nodes.set(n.id, n);
    g.addNode(n.id, n);
  }
  for (const e of data.edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target) || edges.has(e.id)) continue;
    edges.set(e.id, e);
    g.addDirectedEdgeWithKey(e.id, e.source, e.target, e);
  }
  current = { data, g, nodes, edges };
}

export const hasGraph = (): boolean => current !== null;
export const getGraph = (): GraphData | null => current?.data ?? null;
export const getNode = (id: string): GraphNode | undefined => current?.nodes.get(id);

function need(): Indexed {
  if (!current) throw new Error("No graph loaded. Run /api/analyze first.");
  return current;
}

// ---------------------------------------------------------------------------

export interface Overview {
  repo: string;
  nodeCount: number;
  edgeCount: number;
  countsByType: Record<string, number>;
  modules: string[];
  routes: string[];
  warnings: number;
}

export function overview(): Overview {
  const { data } = need();
  const countsByType: Record<string, number> = {};
  for (const n of data.nodes) countsByType[n.type] = (countsByType[n.type] ?? 0) + 1;
  return {
    repo: data.repo.name,
    nodeCount: data.nodes.length,
    edgeCount: data.edges.length,
    countsByType,
    modules: data.nodes.filter((n) => n.type === "Module").map((n) => n.label),
    routes: data.nodes
      .filter((n) => n.type === "Route")
      .map((n) => n.label)
      .slice(0, 40),
    warnings: data.stats.warnings.length,
  };
}

// ---------------------------------------------------------------------------
// Search. Deterministic and cheap (no embeddings, no extra LLM calls — free tiers meter those),
// but "semantic enough" for architecture questions: the words people use ("create user") rarely
// match the identifiers in code ("register", "POST /api/auth/register"), so we match on words
// split out of camelCase/paths, stem them, expand synonyms both ways, and let domain words imply
// their entity (register ⇒ user). Type words act as filters; verbs boost the matching HTTP method.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "does", "do", "did",
  "where", "what", "which", "who", "how", "when", "why", "show", "me", "tell", "explain", "please",
  "this", "that", "it", "its", "there", "here", "exist", "exists", "located", "location", "defined",
  "work", "works", "working", "happen", "happens", "code", "logic", "flow", "function", "handled", "handles",
  "endpoints", "apis", "api", "v1", "v2", "by", "with", "from", "into", "via", "at", "as", "be", "can", "i", "we", "you",
  "architecture", "structure", "design", "system", "component", "components", "part", "parts", "related", "relationship",
  "depends", "depend", "dependency", "dependencies", "uses", "use", "used", "using", "call", "calls", "called", "involved",
]);

const HTTP_WORDS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);

// Words that mean the same thing for our purposes. Bidirectional. Kept generic; one group per intent.
const SYNONYM_GROUPS: string[][] = [
  ["create", "register", "signup", "add", "insert", "new", "post", "make", "init", "initialize", "generate", "submit"],
  ["delete", "remove", "destroy", "cancel", "revoke", "clear", "purge", "drop"],
  ["update", "edit", "patch", "put", "modify", "change", "set", "rename", "reorder", "toggle"],
  ["get", "list", "fetch", "find", "read", "retrieve", "show", "view", "index", "search", "detail", "details", "query", "lookup", "load"],
  ["login", "signin", "authenticate", "auth", "authentication", "authorize", "authorization", "session", "token", "refresh", "otp", "verify", "password", "oauth", "credential"],
  ["logout", "signout"],
  ["user", "account", "member", "profile", "customer", "student", "mentor", "admin", "person", "people"],
  ["upload", "file", "asset", "attachment", "media", "storage", "bucket", "s3", "image", "document"],
  ["payment", "order", "checkout", "pay", "billing", "invoice", "purchase", "transaction"],
  ["enroll", "enrol", "enrollment", "enrolment", "subscribe", "subscription", "join", "membership"],
  ["stream", "streaming", "video", "manifest", "playlist", "playback", "watch"],
  ["review", "rating", "feedback", "comment"],
  ["notification", "email", "mail", "message", "announcement", "notify", "alert"],
  ["report", "analytics", "stats", "statistics", "metric", "dashboard", "overview"],
  ["role", "permission", "guard", "policy", "acl", "rbac"],
  ["health", "ping", "status", "alive", "ready"],
];

// A code word that implies an entity the user might name instead ("create user" -> register).
const IMPLIES: Record<string, string[]> = {
  register: ["user", "account", "create"],
  signup: ["user", "account", "create"],
  login: ["user", "auth"],
  logout: ["user", "auth"],
  password: ["user", "auth"],
  otp: ["auth", "verify"],
  token: ["auth", "session"],
  enroll: ["course", "user"],
  enrollment: ["course", "user"],
  wishlist: ["course", "user"],
  profile: ["user"],
  me: ["user", "profile"],
};

const TYPE_WORDS: Record<string, NodeType> = {
  route: "Route", endpoint: "Route", url: "Route", path: "Route",
  controller: "Controller", handler: "Controller",
  service: "Service",
  repository: "Repository", repo: "Repository",
  model: "Model", table: "Model", entity: "Model", schema: "Model",
  module: "Module", feature: "Module",
};

const METHOD_FOR_GROUP: Record<string, string[]> = {
  create: ["POST"], delete: ["DELETE"], update: ["PUT", "PATCH"], get: ["GET"],
};

/** Light stemming so users/user, categories/category, classes/class agree. */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies")) return w.slice(0, -3) + "y"; // categories -> category
  if (/(ss|sh|ch|x|z)es$/.test(w)) return w.slice(0, -2); // classes, boxes -> class, box
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1); // courses, users -> course, user
  return w;
}

/** camelCase / PascalCase / kebab / snake / path segments -> lowercase stemmed words. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !/^v\d+$/.test(w) && w !== "api")
    .map(stem);
}

const GROUP_OF = new Map<string, Set<string>>(); // stemmed word -> stemmed group members
for (const group of SYNONYM_GROUPS) {
  const stemmed = new Set(group.map(stem));
  for (const w of stemmed) GROUP_OF.set(w, stemmed);
}
const groupHead = (w: string): string | null => {
  for (const group of SYNONYM_GROUPS) if (group.map(stem).includes(w)) return stem(group[0]!);
  return null;
};

/** Everything a label word can stand for: itself, its synonyms, what it implies. */
function expandLabelWord(w: string): Set<string> {
  const out = new Set<string>([w]);
  for (const s of GROUP_OF.get(w) ?? []) out.add(s);
  for (const i of IMPLIES[w] ?? []) {
    const si = stem(i);
    out.add(si);
    for (const s of GROUP_OF.get(si) ?? []) out.add(s);
  }
  return out;
}

export interface SearchResult {
  nodes: GraphNode[];
  /** true when every meaningful query word matched (directly, by synonym or implication). */
  complete: boolean;
  /** query words actually used, after stop-word removal and type extraction. */
  terms: string[];
  typeFilter: NodeType | null;
}

export function searchNodes(query: string, type?: NodeType, limit = 20): SearchResult {
  const { data } = need();
  const q = query.toLowerCase().trim();
  let typeFilter: NodeType | null = type ?? null;

  // Pass 1: meaningful words. Pass 2: a type word among several terms is a filter, not a term
  // ("user controller" -> Controller), but a lone "controller" is still a search.
  const rawTerms = q.split(/[^a-z0-9/:_-]+/i).filter(Boolean).map((r) => r.toLowerCase()).filter((r) => !STOP_WORDS.has(r) && !STOP_WORDS.has(stem(r)));
  const terms: string[] = [];
  for (const raw of rawTerms) {
    const asType = TYPE_WORDS[raw] ?? TYPE_WORDS[stem(raw)];
    if (asType && !type && rawTerms.length > 1) {
      typeFilter = typeFilter ?? asType;
      continue;
    }
    terms.push(stem(raw));
  }
  if (!terms.length) return { nodes: [], complete: false, terms, typeFilter };

  const termSyn = terms.map((t) => new Set<string>([t, ...(GROUP_OF.get(t) ?? [])]));
  const wantedMethods = new Set(terms.flatMap((t) => METHOD_FOR_GROUP[groupHead(t) ?? ""] ?? []));
  const typeWords = new Set(Object.keys(TYPE_WORDS).map(stem));

  const scored: { n: GraphNode; score: number; matched: number }[] = [];
  for (const n of data.nodes) {
    if (typeFilter && n.type !== typeFilter) continue;
    const label = n.label.toLowerCase();
    const paramWords = new Set(words((n.label.match(/:[A-Za-z_]+/g) ?? []).join(" ")));
    const labelWords = words(n.label);
    const moduleWords = new Set(n.module ? words(n.module) : []);
    const expanded = labelWords.map(expandLabelWord);
    const implied = labelWords.map((lw) => new Set((IMPLIES[lw] ?? []).map(stem)));
    const used = new Set<number>();

    let score = 0;
    let matched = 0;
    terms.forEach((t, i) => {
      let best = 0;
      let bestK = -1;
      for (let k = 0; k < labelWords.length; k++) {
        const lw = labelWords[k]!;
        let s = 0;
        if (lw === t) s = 3; // the word itself
        else if (implied[k]!.has(t)) s = 3; // curated: register => user
        else if (HTTP_WORDS.has(lw)) s = termSyn[i]!.has(lw) ? 1 : 0; // "post" for "create": weak — the method boost carries it
        else if (expanded[k]!.has(t) || [...termSyn[i]!].some((syn) => lw === syn || expanded[k]!.has(syn))) s = 2; // synonym
        else if (t.length >= 3 && (lw.includes(t) || (lw.length >= 3 && t.includes(lw)))) s = 1; // substring
        if (s > best) {
          best = s;
          bestK = k;
        }
      }
      if (best === 0 && label.includes(t)) best = 1; // e.g. a raw path fragment
      if (best > 0) {
        matched++;
        if (bestK >= 0) used.add(bestK);
      }
      score += best;
    });
    if (!matched) continue;

    // Precision: meaningful words in the label that the query did not ask for dilute relevance
    // ("/admin/users/:id/devices/revoke" is a worse answer to "create user" than "/auth/register").
    // Params, HTTP methods, type suffixes (…Service) and stop words are free.
    let unmatched = 0;
    labelWords.forEach((lw, k) => {
      if (used.has(k) || paramWords.has(lw) || HTTP_WORDS.has(lw) || typeWords.has(lw) || STOP_WORDS.has(lw) || lw.length < 2) return;
      unmatched++;
    });
    score -= unmatched * 0.5;

    // The owning module is context, not identity: a small nudge, never a match on its own.
    if (terms.some((t) => moduleWords.has(t))) score += 0.5;

    if (label === q) score += 100;
    else if (label.startsWith(terms[0]!)) score += 1;
    if (n.type === "Route" && wantedMethods.has(String((n.meta as { method?: string }).method))) score += 2;
    // Entry points first when tied: Route > Controller > Service > Repository > Model > Module.
    const typeRank: Record<string, number> = { Route: 0.5, Controller: 0.4, Service: 0.3, Repository: 0.2, Model: 0.1, Module: 0, Project: 0 };
    score += typeRank[n.type] ?? 0;
    scored.push({ n, score, matched });
  }

  const complete = scored.some((s) => s.matched === terms.length);
  const pool = complete ? scored.filter((s) => s.matched === terms.length) : scored;
  const nodes = pool
    // more terms matched > higher score > shorter (more general) label > alphabetical
    .sort((a, b) => b.matched - a.matched || b.score - a.score || a.n.label.length - b.n.label.length || a.n.label.localeCompare(b.n.label))
    .slice(0, limit)
    .map((s) => s.n);
  return { nodes, complete, terms, typeFilter };
}

/** Back-compat wrapper over searchNodes. */
export function findNodes(query: string, type?: NodeType, limit = 20): GraphNode[] {
  return searchNodes(query, type, limit).nodes;
}

export interface Neighborhood {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const MAX_DEPTH = 6; // Route -> Controller -> Service -> Repository -> Model is 4 hops

/** BFS to `depth` hops (1..MAX_DEPTH) following edge direction. Returns the visited nodes and the edges walked. */
export function neighbors(nodeId: string, direction: Direction = "both", depth = 1): Neighborhood {
  const { g, nodes, edges } = need();
  const center = nodes.get(nodeId);
  if (!center) throw new Error(unknownNode(nodeId));
  const hops = Math.min(MAX_DEPTH, Math.max(1, Math.floor(depth) || 1));

  const seenNodes = new Set<string>([nodeId]);
  const seenEdges = new Set<string>();
  let frontier = [nodeId];
  for (let hop = 0; hop < hops && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      const walk = (edgeKey: string, other: string) => {
        seenEdges.add(edgeKey);
        if (!seenNodes.has(other)) {
          seenNodes.add(other);
          next.push(other);
        }
      };
      if (direction !== "in") g.forEachOutEdge(id, (k, _a, _s, t) => walk(k, t));
      if (direction !== "out") g.forEachInEdge(id, (k, _a, s) => walk(k, s));
    }
    frontier = next;
  }
  seenNodes.delete(nodeId);
  return {
    center,
    nodes: [...seenNodes].map((id) => nodes.get(id)!),
    edges: [...seenEdges].map((k) => edges.get(k)!),
  };
}

export interface Path {
  found: boolean;
  directed: boolean; // false when only an undirected path exists
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Shortest directed path; falls back to undirected so "how are X and Y related" still answers. */
export function tracePath(fromId: string, toId: string): Path {
  const { g, nodes } = need();
  if (!nodes.has(fromId)) throw new Error(unknownNode(fromId));
  if (!nodes.has(toId)) throw new Error(unknownNode(toId));

  const directed = bfsPath(g, fromId, toId, true);
  if (directed) return { found: true, directed: true, ...directed };
  const undirected = bfsPath(g, fromId, toId, false);
  if (undirected) return { found: true, directed: false, ...undirected };
  return { found: false, directed: true, nodes: [], edges: [] };
}

function bfsPath(
  g: Graph<GraphNode, GraphEdge>,
  from: string,
  to: string,
  directedOnly: boolean,
): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
  const prev = new Map<string, { node: string; edge: string }>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === to) break;
    const visit = (k: string, other: string) => {
      if (seen.has(other)) return;
      seen.add(other);
      prev.set(other, { node: id, edge: k });
      queue.push(other);
    };
    g.forEachOutEdge(id, (k, _a, _s, t) => visit(k, t));
    if (!directedOnly) g.forEachInEdge(id, (k, _a, s) => visit(k, s));
  }
  if (!seen.has(to)) return null;
  const nodeIds: string[] = [to];
  const edgeKeys: string[] = [];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur)!;
    edgeKeys.unshift(p.edge);
    nodeIds.unshift(p.node);
    cur = p.node;
  }
  return {
    nodes: nodeIds.map((id) => g.getNodeAttributes(id)),
    edges: edgeKeys.map((k) => g.getEdgeAttributes(k)),
  };
}

function unknownNode(id: string): string {
  const tail = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const hint = findNodes(tail, undefined, 5).map((n) => n.id);
  return `Unknown node id "${id}".${hint.length ? ` Did you mean: ${hint.join(", ")}` : " Use find_nodes first."}`;
}
