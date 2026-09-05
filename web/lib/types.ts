// Duplicated from CONTRACTS.md §2 — do NOT import from api/

export type NodeType =
  | "Project" | "Module" | "Route" | "Controller"
  | "Service" | "Repository" | "Model";

export type EdgeType =
  | "CONTAINS"
  | "HANDLED_BY"
  | "CALLS"
  | "READS_WRITES"
  | "IMPORTS";

export type Confidence = "EXTRACTED" | "INFERRED";

export interface Evidence {
  file: string;
  line: number;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  module: string | null;
  file: string | null;
  line: number | null;
  meta: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  confidence: Confidence;
  evidence: Evidence | null;
}

export interface GraphStats {
  filesScanned: number;
  durationMs: number;
  warnings: string[];
  nodeCount: number;
  edgeCount: number;
}

export interface Graph {
  schemaVersion: 1;
  repo: {
    name: string;
    url: string | null;
    commit: string | null;
    rootDir: string;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: GraphStats;
}

export interface AskResponse {
  answer: string;
  citedNodeIds: string[];
  toolCalls: { name: string; args: Record<string, unknown> }[];
}
