"use client";

import type { GraphNode } from "@/lib/types";

interface Props {
  node: GraphNode | null;
  onClose: () => void;
}

const TYPE_COLORS: Record<string, string> = {
  Route: "text-emerald-400",
  Controller: "text-sky-400",
  Service: "text-violet-400",
  Repository: "text-amber-400",
  Model: "text-rose-400",
  Module: "text-zinc-400",
  Project: "text-zinc-500",
};

export default function NodeDrawer({ node, onClose }: Props) {
  if (!node) return null;

  const meta = node.meta as Record<string, unknown>;
  const isRoute = node.type === "Route";

  return (
    <div className="fixed top-0 right-0 h-full w-96 bg-zinc-900 border-l border-zinc-700 shadow-2xl z-50 overflow-y-auto">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-zinc-100">{node.label}</h2>
            <span className={`text-sm font-medium ${TYPE_COLORS[node.type] ?? "text-zinc-400"}`}>
              {node.type}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 text-2xl leading-none transition-colors"
          >
            ×
          </button>
        </div>

        {/* Details table */}
        <div className="space-y-3 text-sm">
          {node.module && (
            <Row label="module" value={node.module} />
          )}
          {node.file && (
            <Row label="file" value={node.file} mono />
          )}
          {node.line != null && (
            <Row label="line" value={String(node.line)} mono />
          )}
          {node.file && node.line != null && (
            <div className="pt-1">
              <span className="text-zinc-500 text-xs">location</span>
              <p className="font-mono text-xs text-zinc-300 bg-zinc-800 rounded px-2 py-1 mt-1">
                {node.file}:{node.line}
              </p>
            </div>
          )}
        </div>

        {/* Route meta */}
        {isRoute && meta && (
          <div className="mt-6 border-t border-zinc-700 pt-4">
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Route Details</h3>
            <div className="space-y-3 text-sm">
              {meta.method ? <Row label="method" value={String(meta.method)} /> : null}
              {meta.path ? <Row label="path" value={String(meta.path)} mono /> : null}
              {meta.handlerName ? <Row label="handler" value={String(meta.handlerName)} /> : null}
              {meta.controllerName ? <Row label="controller" value={String(meta.controllerName)} /> : null}
              {Array.isArray(meta.middleware) && meta.middleware.length > 0 && (
                <div>
                  <span className="text-zinc-500">middleware</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {meta.middleware.map((mw: string) => (
                      <span key={mw} className="px-2 py-0.5 bg-zinc-800 rounded text-xs text-zinc-300 font-mono">
                        {mw}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Other meta */}
        {Object.keys(meta).filter(k => !['method','path','handlerName','controllerName','middleware'].includes(k)).length > 0 && (
          <div className="mt-6 border-t border-zinc-700 pt-4">
            <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Metadata</h3>
            <div className="space-y-2 text-sm">
              {Object.entries(meta)
                .filter(([k]) => !['method','path','handlerName','controllerName','middleware'].includes(k))
                .map(([k, v]) => (
                  <Row key={k} label={k} value={JSON.stringify(v)} />
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-zinc-500 shrink-0">{label}</span>
      <span className={`text-zinc-200 text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}
