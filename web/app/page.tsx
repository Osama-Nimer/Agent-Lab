"use client";

import { useState, useCallback } from "react";
import type { Graph, GraphNode, AskResponse } from "@/lib/types";
import { analyze, ask } from "@/lib/api";
import RepoInput from "@/components/RepoInput";
import GraphCanvas from "@/components/GraphCanvas";
import NodeDrawer from "@/components/NodeDrawer";
import AskBox from "@/components/AskBox";
import sampleGraph from "@/fixtures/graph.sample.json";

export default function Home() {
  /* ── state ──────────────────────────────── */
  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(false);
  const [repoName, setRepoName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [citedNodeIds, setCitedNodeIds] = useState<Set<string>>(new Set());

  /* ── analyze ────────────────────────────── */
  const handleAnalyze = useCallback(async (input: { repoUrl?: string; localPath?: string }) => {
    setLoading(true);
    setError(null);
    setRepoName(input.repoUrl ?? input.localPath ?? "repo");
    try {
      const g = await analyze(input);
      setGraph(g);
      setCitedNodeIds(new Set());
      setSelectedNode(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analyze failed");
    } finally {
      setLoading(false);
    }
  }, []);

  /* ── load sample ────────────────────────── */
  const handleLoadSample = useCallback(() => {
    setGraph(sampleGraph as unknown as Graph);
    setRepoName("acme-api (sample)");
    setError(null);
    setCitedNodeIds(new Set());
    setSelectedNode(null);
  }, []);

  /* ── ask ────────────────────────────────── */
  const handleAsk = useCallback(
    async (question: string): Promise<AskResponse> => {
      const res = await ask(question);
      setCitedNodeIds(new Set(res.citedNodeIds ?? []));
      return res;
    },
    []
  );

  /* ── clear highlighting ─────────────────── */
  const handleClearHighlight = useCallback(() => {
    setCitedNodeIds(new Set());
  }, []);

  /* ── node click ─────────────────────────── */
  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  /* ── render ─────────────────────────────── */
  return (
    <div className="h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="shrink-0 border-b border-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between max-w-screen-2xl mx-auto">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Repository Engineering Graph
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Deterministic AST discovery · graph-first agent reasoning
            </p>
          </div>
          {graph && (
            <div className="text-right text-xs text-zinc-500">
              <div>
                <span className="text-zinc-300 font-medium">{graph.repo.name}</span>
              </div>
              <div>
                {graph.stats.nodeCount} nodes · {graph.stats.edgeCount} edges ·{" "}
                {graph.stats.filesScanned} files scanned
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      {!graph ? (
        /* ── Landing: repo input ─────────────── */
        <main className="flex-1 flex flex-col items-center justify-center px-6 gap-6">
          <div className="text-center mb-4">
            <h2 className="text-3xl font-bold mb-2">Analyze a Repository</h2>
            <p className="text-zinc-500 text-sm max-w-md">
              Enter a GitHub URL or local path. The discovery engine will extract the
              engineering graph from the AST.
            </p>
          </div>
          <RepoInput
            onAnalyze={handleAnalyze}
            onLoadSample={handleLoadSample}
            loading={loading}
            repoName={repoName}
          />
          {error && (
            <div className="mt-2 px-4 py-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm max-w-2xl">
              {error}
            </div>
          )}
        </main>
      ) : (
        /* ── Graph view ──────────────────────── */
        <main className="flex-1 flex flex-col min-h-0">
          {/* Warnings banner */}
          {graph.stats.warnings.length > 0 && (
            <div className="shrink-0 px-6 py-2 bg-amber-900/20 border-b border-amber-700/30 text-amber-300 text-xs">
              ⚠ {graph.stats.warnings.length} warning{graph.stats.warnings.length > 1 ? "s" : ""}:{" "}
              {graph.stats.warnings.slice(0, 3).join(" · ")}
              {graph.stats.warnings.length > 3 && ` · +${graph.stats.warnings.length - 3} more`}
            </div>
          )}

          {/* Canvas */}
          <div className="flex-1 min-h-0">
            <GraphCanvas
              graph={graph}
              citedNodeIds={citedNodeIds}
              onNodeClick={handleNodeClick}
            />
          </div>

          {/* Ask box */}
          <div className="shrink-0 border-t border-zinc-800 px-6 py-4 bg-zinc-900/50">
            <div className="max-w-4xl mx-auto">
              <AskBox
                onAsk={handleAsk}
                onClear={handleClearHighlight}
                disabled={!graph}
              />
            </div>
          </div>
        </main>
      )}

      {/* Node drawer */}
      <NodeDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />
    </div>
  );
}
