// B1 — Facts -> Graph. Pure. Guarantees to Lane C: no dangling edges, no duplicate ids.
import {
  edgeId,
  nodeId,
  type EdgeType,
  type FactEdge,
  type FactNode,
  type Facts,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeType,
} from "../contract.js";

/**
 * Legal (sourceKind -> targetKinds) per edge type, from the contract's own definitions. FactEdge
 * references nodes by *name*, and names collide across kinds in real repos (Module "users" vs
 * Model "users"). When a fact omits fromKind/toKind we resolve both ends JOINTLY against this
 * table: exactly one legal pairing wins; zero or several means we drop the edge and warn rather
 * than guess — a guessed self-loop or a mis-wired edge is worse for the demo than an honest miss.
 */
const LEGAL: Record<EdgeType, Partial<Record<NodeType, NodeType[]>>> = {
  CONTAINS: { Project: ["Module"], Module: ["Route", "Controller", "Service", "Repository", "Model"] },
  HANDLED_BY: { Route: ["Controller"] },
  CALLS: { Controller: ["Service", "Repository"], Service: ["Repository", "Service"], Repository: ["Repository"] },
  READS_WRITES: { Repository: ["Model"], Service: ["Model"], Controller: ["Model"] },
  IMPORTS: { Module: ["Module"] },
};

export function buildGraph(facts: Facts): Graph {
  const warnings = [...facts.stats.warnings];

  // 1-2. Map facts to nodes, de-duplicate by id (first wins, meta merged). Index ids by name.
  const nodesById = new Map<string, GraphNode>();
  const idsByName = new Map<string, string[]>();
  const addNode = (f: FactNode) => {
    const id = nodeId(f.kind, f.name);
    const existing = nodesById.get(id);
    if (existing) {
      existing.meta = { ...(f.meta ?? {}), ...existing.meta };
      return;
    }
    nodesById.set(id, toGraphNode(f, id));
    const list = idsByName.get(f.name) ?? [];
    list.push(id);
    idsByName.set(f.name, list);
  };
  for (const f of facts.nodes) addNode(f);

  // A discovery run might not emit a Project node; the graph always has one.
  if (!nodesById.has(nodeId("Project", facts.repo.name))) {
    addNode({ kind: "Project", name: facts.repo.name, module: null, evidence: { file: "", line: 0 } });
  }

  // 3-5. Resolve names -> ids jointly, drop dangling/ambiguous/self-loops, de-duplicate edges.
  const candidates = (name: string, kind?: NodeType): string[] =>
    kind ? [nodeId(kind, name)].filter((id) => nodesById.has(id)) : (idsByName.get(name) ?? []);
  const kindOf = (id: string) => nodesById.get(id)!.type;

  const resolveEdge = (e: FactEdge): { source: string; target: string } | { error: string } => {
    const froms = candidates(e.from, e.fromKind);
    const tos = candidates(e.to, e.toKind);
    if (!froms.length) return { error: `unresolved "${e.from}"` };
    if (!tos.length) return { error: `unresolved "${e.to}"` };

    const legal: [string, string][] = [];
    for (const s of froms) {
      for (const t of tos) {
        if (s !== t && (LEGAL[e.type]?.[kindOf(s)] ?? []).includes(kindOf(t))) legal.push([s, t]);
      }
    }
    if (legal.length === 1) return { source: legal[0]![0], target: legal[0]![1] };
    if (legal.length > 1) return { error: `ambiguous — could be ${legal.map(([s, t]) => `${s} -> ${t}`).join(" or ")}; set fromKind/toKind` };

    // No table-legal pairing. Be lenient when there is nothing to disambiguate — Lane A may emit a
    // relationship shape the table does not list — but never accept a self-loop.
    if (froms.length === 1 && tos.length === 1) {
      if (froms[0] === tos[0]) return { error: `self-loop on ${froms[0]}` };
      return { source: froms[0]!, target: tos[0]! };
    }
    return { error: `no legal ${e.type} pairing among ${[...new Set([...froms, ...tos])].join(", ")}; set fromKind/toKind` };
  };

  const edgesById = new Map<string, GraphEdge>();
  let dropped = 0;
  for (const e of facts.edges) {
    const r = resolveEdge(e);
    if ("error" in r) {
      dropped++;
      warnings.push(`Dropped edge ${e.from} -> ${e.to} (${e.type}): ${r.error}`);
      continue;
    }
    const id = edgeId(r.source, r.target, e.type);
    if (edgesById.has(id)) continue;
    edgesById.set(id, {
      id,
      source: r.source,
      target: r.target,
      type: e.type,
      confidence: e.confidence,
      evidence: e.evidence ?? null,
    });
  }
  if (dropped) warnings.push(`${dropped} edge(s) dropped by graph builder`);

  const nodes = [...nodesById.values()];
  const edges = [...edgesById.values()];
  return {
    schemaVersion: 1,
    repo: facts.repo,
    nodes,
    edges,
    stats: {
      filesScanned: facts.stats.filesScanned,
      durationMs: facts.stats.durationMs,
      warnings,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
  };
}

function toGraphNode(f: FactNode, id: string): GraphNode {
  return {
    id,
    type: f.kind,
    label: f.name,
    module: f.module,
    file: f.evidence?.file || null,
    line: f.evidence?.line || null,
    meta: { ...(f.meta ?? {}) },
  };
}

/** Defensive check for graphs that did not come through buildGraph (e.g. the fixture). */
export function validateGraph(g: Graph): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  for (const e of g.edges) {
    if (!ids.has(e.source)) problems.push(`edge ${e.id}: missing source ${e.source}`);
    if (!ids.has(e.target)) problems.push(`edge ${e.id}: missing target ${e.target}`);
  }
  return problems;
}
