import { Project, Node, SyntaxKind, type SourceFile, type Node as MorphNode, type PropertyAccessExpression } from "ts-morph";
import type { FactNode, FactRoute, FactEdge } from "../contract.js";
import { toPosix, evidence } from "./util.js";
import { moduleSlugForFile } from "./scan-modules.js";

const HTTP = new Set(["get", "post", "put", "patch", "delete", "options", "all"]);

export interface ScanRoutesResult {
  nodes: FactNode[];
  edges: FactEdge[];
}

export function scanRoutes(
  project: Project,
  rootDir: string,
  modulesRoot: string | null,
  prefixByModule: Map<string, string>,
  prefixByFile: Map<string, string>,
  warnings: string[]
): ScanRoutesResult {
  const nodes: FactNode[] = [];
  const edges: FactEdge[] = [];

  const routeFiles = project
    .getSourceFiles()
    .filter((sf) => /\.routes\.ts$/.test(sf.getFilePath()) || sf.getFullText().includes("Router()"));

  for (const sf of routeFiles) {
    const module = moduleSlugForFile(rootDir, sf.getFilePath(), modulesRoot);
    const prefix = module
      ? prefixByModule.get(module) ?? ""
      : prefixByFile.get(sf.getFilePath()) ?? "";
    const routerNames = findRouterIdentifiers(sf);

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;

      const obj = expr.getExpression().getText();
      const method = expr.getName().toLowerCase();
      if (!routerNames.has(obj)) continue;
      if (!HTTP.has(method)) continue;

      const args = call.getArguments();
      if (args.length < 2 || !Node.isStringLiteral(args[0])) continue;

      const localPath = args[0].getLiteralValue();
      const handler = findHandler(args[args.length - 1]);
      const middleware = args.slice(1, -1).map((a) => a.getText().split("(")[0]);

      let controllerName: string | null = null;
      let handlerName = "";
      if (handler) {
        controllerName = resolveControllerName(sf, handler.getExpression().getText());
        handlerName = handler.getName();
      } else {
        warnings.push(
          `Inline handler for ${method.toUpperCase()} ${localPath} in ${toPosix(sf.getFilePath())} — no controller edge emitted`
        );
      }

      const fullPath = (prefix + localPath).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
      const name = `${method.toUpperCase()} ${fullPath}`;
      const ev = evidence(rootDir, call);

      const route: FactRoute = {
        kind: "Route",
        name,
        module,
        evidence: ev,
        meta: {
          method: method.toUpperCase() as FactRoute["meta"]["method"],
          path: fullPath,
          handlerName,
          controllerName: controllerName ?? "",
          middleware,
        },
      };
      nodes.push(route);

      if (module) {
        edges.push({ from: module, to: name, type: "CONTAINS", confidence: "EXTRACTED", evidence: ev });
      }

      if (controllerName) {
        edges.push({
          from: name,
          to: controllerName,
          type: "HANDLED_BY",
          confidence: "EXTRACTED",
          evidence: ev,
        });
      }
    }
  }

  return { nodes, edges };
}

function findRouterIdentifiers(sf: SourceFile): Set<string> {
  const names = new Set(["router", "app"]);
  for (const declaration of sf.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const callee = initializer.getExpression();
    const isRouter = Node.isIdentifier(callee)
      ? callee.getText() === "Router" || callee.getText() === "express"
      : Node.isPropertyAccessExpression(callee) && callee.getName() === "Router";
    if (isRouter) names.add(declaration.getName());
  }
  return names;
}

function findHandler(node: MorphNode): PropertyAccessExpression | null {
  if (Node.isPropertyAccessExpression(node)) return node;
  if (!Node.isCallExpression(node)) return null;
  for (const arg of [...node.getArguments()].reverse()) {
    const nested = findHandler(arg);
    if (nested) return nested;
  }
  return null;
}

function resolveControllerName(sf: SourceFile, objectName: string): string {
  const local = sf.getVariableDeclaration(objectName);
  const initializer = local?.getInitializer();
  if (initializer && Node.isNewExpression(initializer)) {
    return initializer.getExpression().getText();
  }
  return objectName;
}
