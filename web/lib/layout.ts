import dagre from "@dagrejs/dagre";
import type { GraphNode, GraphEdge } from "./types";

const W = 200;
const H = 56;

export function layout(
  nodes: GraphNode[],
  edges: GraphEdge[]
): { id: string; position: { x: number; y: number }; data: GraphNode; type: string }[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", ranksep: 110, nodesep: 28 });

  nodes.forEach((n) => g.setNode(n.id, { width: W, height: H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  return nodes.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      position: { x: p.x - W / 2, y: p.y - H / 2 },
      data: { ...n },
      type: "concept",
    };
  });
}
