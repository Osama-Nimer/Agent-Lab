"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Graph, GraphNode as GN, GraphEdge as GE } from "@/lib/types";
import { layout } from "@/lib/layout";

/* ── colour by type ─────────────────────────── */
const TYPE_BG: Record<string, string> = {
  Route:       "#059669",   // emerald-600
  Controller:  "#0284c7",   // sky-600
  Service:     "#7c3aed",   // violet-600
  Repository:  "#d97706",   // amber-600
  Model:       "#e11d48",   // rose-600
  Module:      "#52525b",   // zinc-600
  Project:     "#3f3f46",   // zinc-700
};

const TYPE_LABEL_COLOR: Record<string, string> = {
  Route:       "#6ee7b7",
  Controller:  "#7dd3fc",
  Service:     "#c4b5fd",
  Repository:  "#fcd34d",
  Model:       "#fda4af",
  Module:      "#a1a1aa",
  Project:     "#71717a",
};

/* ── custom node ────────────────────────────── */
function ConceptNode({ data }: NodeProps) {
  const d = data as unknown as GN & { highlighted?: boolean };
  const bg = TYPE_BG[d.type] ?? "#3f3f46";
  const labelColor = TYPE_LABEL_COLOR[d.type] ?? "#a1a1aa";

  return (
    <div
      style={{
        background: bg,
        border: d.highlighted ? "2px solid #facc15" : "1px solid rgba(255,255,255,0.12)",
        boxShadow: d.highlighted ? "0 0 12px rgba(250,204,21,0.4)" : "none",
      }}
      className="rounded-lg px-3 py-2 min-w-[160px] max-w-[220px] text-center"
    >
      <Handle type="target" position={Position.Left} className="!bg-zinc-400 !w-2 !h-2" />
      <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: labelColor }}>
        {d.type}
      </div>
      <div className="text-xs text-white font-medium leading-tight mt-0.5 truncate">
        {d.label}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-zinc-400 !w-2 !h-2" />
    </div>
  );
}

const nodeTypes = { concept: ConceptNode };

/* ── props ──────────────────────────────────── */
interface Props {
  graph: Graph;
  citedNodeIds: Set<string>;
  onNodeClick: (node: GN) => void;
}

export default function GraphCanvas({ graph, citedNodeIds, onNodeClick }: Props) {
  /* ── module filter ──────────────────────── */
  const modules = useMemo(() => {
    const mods = [...new Set(graph.nodes.map((n) => n.module).filter(Boolean))] as string[];
    return mods.sort();
  }, [graph]);

  const [selectedModule, setSelectedModule] = useState<string | "__all__">("__all__");

  /* ── filter nodes & edges ──────────────── */
  const filteredNodes = useMemo(() => {
    if (selectedModule === "__all__") return graph.nodes;
    return graph.nodes.filter(
      (n) => n.module === selectedModule || n.module === null || n.type === "Project"
    );
  }, [graph, selectedModule]);

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);

  const filteredEdges = useMemo(
    () => graph.edges.filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target)),
    [graph, filteredNodeIds]
  );

  /* ── layout ─────────────────────────────── */
  const hasCited = citedNodeIds.size > 0;

  const rfNodes: Node[] = useMemo(() => {
    const laid = layout(filteredNodes, filteredEdges);
    return laid.map((n) => ({
      ...n,
      data: { ...n.data, highlighted: citedNodeIds.has(n.id) },
      style: hasCited
        ? citedNodeIds.has(n.id)
          ? { opacity: 1 }
          : { opacity: 0.25 }
        : { opacity: 1 },
    }));
  }, [filteredNodes, filteredEdges, citedNodeIds, hasCited]);

  const rfEdges: Edge[] = useMemo(
    () =>
      filteredEdges.map((e) => {
        const bothCited = citedNodeIds.has(e.source) && citedNodeIds.has(e.target);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.type,
          labelStyle: { fontSize: 9, fill: "#a1a1aa" },
          style: {
            stroke: bothCited && hasCited ? "#facc15" : "#71717a",
            strokeWidth: bothCited && hasCited ? 2.5 : 1.2,
            strokeDasharray: e.confidence === "INFERRED" ? "5 5" : undefined,
            opacity: hasCited ? (bothCited ? 1 : 0.2) : 1,
          },
          animated: bothCited && hasCited,
        };
      }),
    [filteredEdges, citedNodeIds, hasCited]
  );

  /* ── handlers ───────────────────────────── */
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeClick(node.data as unknown as GN);
    },
    [onNodeClick]
  );

  return (
    <div className="relative w-full h-full">
      {/* Module filter + legend */}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-3">
        <select
          value={selectedModule}
          onChange={(e) => setSelectedModule(e.target.value)}
          className="px-2 py-1 rounded bg-zinc-800 border border-zinc-600 text-zinc-200 text-xs"
        >
          <option value="__all__">All modules</option>
          {modules.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {/* Legend */}
      <div className="absolute top-3 right-3 z-10 flex flex-wrap gap-2 items-center bg-zinc-900/80 backdrop-blur rounded-lg px-3 py-2 border border-zinc-700/50">
        {Object.entries(TYPE_BG).map(([type, color]) => (
          <div key={type} className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-sm" style={{ background: color }} />
            <span className="text-[10px] text-zinc-400">{type}</span>
          </div>
        ))}
        <div className="w-px h-4 bg-zinc-600 mx-1" />
        <div className="flex items-center gap-1">
          <div className="w-5 h-0 border-t border-zinc-400" />
          <span className="text-[10px] text-zinc-400">extracted</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-5 h-0 border-t border-dashed border-zinc-400" />
          <span className="text-[10px] text-zinc-400">inferred</span>
        </div>
      </div>

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272a" gap={20} />
        <Controls
          showInteractive={false}
          className="!bg-zinc-800 !border-zinc-700 !shadow-lg [&>button]:!bg-zinc-800 [&>button]:!border-zinc-600 [&>button]:!text-zinc-300 [&>button:hover]:!bg-zinc-700"
        />
        <MiniMap
          nodeColor={(n) => TYPE_BG[(n.data as unknown as GN)?.type] ?? "#3f3f46"}
          maskColor="rgba(0,0,0,0.7)"
          className="!bg-zinc-900 !border-zinc-700"
        />
      </ReactFlow>
    </div>
  );
}
