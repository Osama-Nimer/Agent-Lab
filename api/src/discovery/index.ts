import path from "node:path";
import type { Facts, FactNode } from "../contract.js";
import { loadProject } from "./load.js";
import { scanModules } from "./scan-modules.js";
import { scanRoutes } from "./scan-routes.js";
import { scanCalls } from "./scan-calls.js";
import { scanModels } from "./scan-models.js";
import { relPath } from "./util.js";

export async function discover(rootDir: string): Promise<Facts> {
  const started = Date.now();
  const warnings: string[] = [];
  const absoluteRoot = path.resolve(rootDir);
  const project = loadProject(absoluteRoot);

  const repoName = path.basename(absoluteRoot);
  const evidenceSource = [...project.getSourceFiles()].sort((a, b) => {
    const aPath = relPath(absoluteRoot, a.getFilePath());
    const bPath = relPath(absoluteRoot, b.getFilePath());
    const rank = (file: string) => /(^|\/)(app|server|index)\.ts$/.test(file) ? 0 : 1;
    return rank(aPath) - rank(bPath) || aPath.localeCompare(bPath);
  })[0];
  const projectNode: FactNode = {
    kind: "Project",
    name: repoName,
    module: null,
    evidence: {
      file: evidenceSource ? relPath(absoluteRoot, evidenceSource.getFilePath()) : ".",
      line: 1,
    },
  };

  const modules = scanModules(project, absoluteRoot, warnings);
  const routes = scanRoutes(
    project,
    absoluteRoot,
    modules.modulesRoot,
    modules.prefixByModule,
    modules.prefixByFile,
    warnings
  );
  const calls = scanCalls(project, absoluteRoot, modules.modulesRoot, warnings);
  const models = scanModels(project, absoluteRoot, warnings);

  const nodes = [projectNode, ...modules.nodes, ...routes.nodes, ...calls.nodes, ...models.nodes];
  const rawEdges = [...modules.edges, ...routes.edges, ...calls.edges, ...models.edges];

  // CONTRACT REQUIREMENT: drop dangling edges, record them as warnings
  const names = new Set(nodes.map((n) => n.name));
  const edges = rawEdges.filter((e) => {
    const ok = names.has(e.from) && names.has(e.to);
    if (!ok) warnings.push(`Dropped edge ${e.from} -> ${e.to} (unresolved endpoint)`);
    return ok;
  });

  return {
    repo: { name: repoName, url: null, commit: null, rootDir: absoluteRoot },
    nodes,
    edges,
    stats: {
      filesScanned: project.getSourceFiles().length,
      durationMs: Date.now() - started,
      warnings,
    },
  };
}
