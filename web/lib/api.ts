import type { Graph, AskResponse } from "./types";

export async function analyze(input: { repoUrl?: string; localPath?: string }): Promise<Graph> {
  const r = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Analyze failed");
  return j.graph as Graph;
}

export async function getGraph(): Promise<Graph> {
  const r = await fetch("/api/graph");
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Failed to fetch graph");
  return j.graph as Graph;
}

export async function ask(question: string): Promise<AskResponse> {
  const r = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Ask failed");
  return j as AskResponse;
}
