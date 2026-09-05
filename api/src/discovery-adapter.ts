// Seam between Lane B and Lane A. Dynamically imports Lane A's `discover()` when it exists;
// until then serves the shared fixture with a loud warning. Lane A lands by dropping in
// src/discovery/index.ts — nobody edits this file at integration time.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AnalyzeRequest, Facts, Graph } from "./contract.js";
import { buildGraph, validateGraph } from "./graph/build.js";
import { FIXTURES_DIR } from "./env.js";
import { cloneRepo } from "./clone.js";

export interface DiscoveryResult {
  graph: Graph;
  source: "discovery" | "fixture";
  /** Absolute path of the analyzed repo (for read_file / search_code); null for the fixture. */
  rootDir: string | null;
}

type DiscoverFn = (rootDir: string) => Promise<Facts>;

async function loadDiscover(): Promise<DiscoverFn | null> {
  // "Lane A absent" is decided by the filesystem, not by an import error: a Lane A that exists but
  // fails to load (missing dependency, typo) must surface as a 500, never be masked by the fixture.
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "discovery", "index.ts");
  if (!existsSync(entry)) return null;
  // Variable specifier so TypeScript does not try to resolve a module that may not exist yet.
  const spec = "./discovery/index.ts";
  const mod = (await import(spec)) as { discover?: DiscoverFn };
  if (typeof mod.discover !== "function") {
    throw new Error("src/discovery/index.ts exists but does not export discover(rootDir)");
  }
  return mod.discover;
}

export async function runDiscovery(req: AnalyzeRequest): Promise<DiscoveryResult> {
  const discover = await loadDiscover();

  if (!req.repoUrl && !req.localPath) {
    return { graph: await loadFixture(), source: "fixture", rootDir: null };
  }

  const rootDir = req.localPath ? path.resolve(req.localPath) : await cloneRepo(req.repoUrl!);

  if (!discover) {
    const graph = await loadFixture();
    graph.stats.warnings.unshift(
      `Discovery engine (Lane A) not present yet — serving fixtures/graph.sample.json instead of analyzing ${rootDir}`,
    );
    return { graph, source: "fixture", rootDir };
  }

  const facts = await discover(rootDir);
  if (req.repoUrl && !facts.repo.url) facts.repo.url = req.repoUrl;
  const graph = buildGraph(facts);
  const problems = validateGraph(graph);
  if (problems.length) throw new Error(`Graph builder produced an invalid graph: ${problems.slice(0, 3).join("; ")}`);
  return { graph, source: "discovery", rootDir };
}

export async function loadFixture(): Promise<Graph> {
  const raw = await readFile(path.join(FIXTURES_DIR, "graph.sample.json"), "utf8");
  const graph = JSON.parse(raw) as Graph;
  // never share the cached object across requests — callers mutate warnings
  return structuredClone(graph);
}
