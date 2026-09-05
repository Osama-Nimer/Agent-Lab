import { Project } from "ts-morph";
import type { FactNode, FactEdge } from "../contract.js";
import { evidence } from "./util.js";
import { moduleSlugForFile } from "./scan-modules.js";

const MODEL_FILE = /(^|\/)(.*\.tables\.ts|.*\.schema\.ts|.*\.entity\.ts|models\/.*\.ts)$/;
const MODEL_INIT = /pgTable|mysqlTable|sqliteTable|new Schema|@Entity/;

export interface ScanModelsResult {
  nodes: FactNode[];
  edges: FactEdge[];
}

export function scanModels(project: Project, rootDir: string, warnings: string[]): ScanModelsResult {
  const nodes: FactNode[] = [];
  const edges: FactEdge[] = [];

  const modelFiles = project.getSourceFiles().filter((sf) => MODEL_FILE.test(sf.getFilePath()));

  for (const sf of modelFiles) {
    const module = moduleSlugForFile(rootDir, sf.getFilePath(), null);

    for (const v of sf.getVariableDeclarations()) {
      if (!v.isExported()) continue;
      const init = v.getInitializer()?.getText() ?? "";
      if (!MODEL_INIT.test(init)) continue;

      nodes.push({
        kind: "Model",
        name: v.getName(),
        module,
        evidence: evidence(rootDir, v),
      });
    }
  }

  if (modelFiles.length === 0) {
    warnings.push("No model files found (expected db/**/*.tables.ts, *.schema.ts, *.entity.ts, or models/**)");
  }

  return { nodes, edges };
}
