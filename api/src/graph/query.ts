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

/**
 * Case-insensitive token search over id, label and module. Nodes matching every token rank first;
 * if none do, fall back to nodes matching any token (more tokens matched = higher), so a model
 * asking for "create user" still gets the user routes instead of an empty list and a wasted turn.
 */
export function findNodes(query: string, type?: NodeType, limit = 20): GraphNode[] {
  const { data } = need();
  const q = query.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const scored: { n: GraphNode; score: number; all: boolean }[] = [];
  for (const n of data.nodes) {
    if (type && n.type !== type) continue;
    const label = n.label.toLowerCase();
    const hay = `${n.id} ${label} ${n.module ?? ""}`.toLowerCase();
    const hits = tokens.filter((t) => hay.includes(t)).length;
    if (!hits) continue;
    let score = hits * 10;
    if (label === q) score += 100;
    else if (label.startsWith(tokens[0]!)) score += 50;
    else if (label.includes(tokens[0]!)) score += 25;
    scored.push({ n, score, all: hits === tokens.length });
  }
  const pool = scored.some((s) => s.all) ? scored.filter((s) => s.all) : scored;
  return pool
    .sort((a, b) => b.score - a.score || a.n.label.localeCompare(b.n.label))
    .slice(0, limit)
    .map((s) => s.n);
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
