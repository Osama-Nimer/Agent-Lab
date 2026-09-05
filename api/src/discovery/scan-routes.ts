import { Project, Node, SyntaxKind, type SourceFile, type Node as MorphNode } from "ts-morph";
import type { FactNode, FactRoute, FactEdge } from "../contract.js";
import { toPosix, evidence } from "./util.js";
import { moduleSlugForFile } from "./scan-modules.js";

const HTTP = new Set(["get", "post", "put", "patch", "delete", "options", "all"]);

export interface ScanRoutesResult {
  nodes: FactNode[];
  edges: FactEdge[];
}

interface HandlerRef {
  /** Controller node name (object/class name, or the exported handler function for function-style controllers). */
  controllerName: string | null;
  handlerName: string;
}

interface RouteImport {
  importedName: string;
  spec: string;
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
    .filter((sf) => /\.routes?\.ts$/.test(sf.getFilePath()) || /\bRouter\s*\(/.test(sf.getFullText()));

  for (const sf of routeFiles) {
    const module = moduleSlugForFile(rootDir, sf.getFilePath(), modulesRoot);
    // The prefix recorded while walking app.use()/router.use() mounts into THIS file is the most
    // specific (it includes nested sub-router mounts); the module-level prefix is the fallback.
    const prefix = prefixByFile.get(sf.getFilePath()) ?? (module ? prefixByModule.get(module) : undefined) ?? "";
    const routerNames = findRouterIdentifiers(sf);
    const imports = importTable(sf);

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
      const handler = findHandler(args[args.length - 1], sf, imports);
      const middleware = args.slice(1, -1).map((a) => a.getText().split("(")[0]!.trim());

      if (!handler) {
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
          handlerName: handler?.handlerName ?? "",
          controllerName: handler?.controllerName ?? null,
          middleware,
        },
      };
      nodes.push(route);

      if (module) {
        edges.push({ from: module, fromKind: "Module", to: name, toKind: "Route", type: "CONTAINS", confidence: "EXTRACTED", evidence: ev });
      }

      if (handler?.controllerName) {
        edges.push({
          from: name,
          fromKind: "Route",
          to: handler.controllerName,
          toKind: "Controller",
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

function importTable(sf: SourceFile): Map<string, RouteImport> {
  const imports = new Map<string, RouteImport>();
  for (const declaration of sf.getImportDeclarations()) {
    const spec = declaration.getModuleSpecifierValue();
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) imports.set(defaultImport.getText(), { importedName: defaultImport.getText(), spec });
    for (const named of declaration.getNamedImports()) {
      imports.set(named.getAliasNode()?.getText() ?? named.getName(), { importedName: named.getName(), spec });
    }
  }
  return imports;
}

/**
 * The handler is the last argument, possibly wrapped: `asyncHandler(ctrl.create)`,
 * `asyncHandler(listAssets)`, `wrap(validate(schema), ctrl.create)`. Unwrap calls right-to-left and
 * accept either `Controller.method` or a bare identifier imported from a *controller* / *handler*
 * file (function-style controllers).
 */
function findHandler(node: MorphNode, sf: SourceFile, imports: Map<string, RouteImport>): HandlerRef | null {
  if (Node.isPropertyAccessExpression(node)) {
    return { controllerName: resolveControllerName(sf, node.getExpression().getText()), handlerName: node.getName() };
  }
  if (Node.isIdentifier(node)) {
    const name = node.getText();
    const imported = imports.get(name);
    if (imported && /controller|handler/i.test(imported.spec)) {
      return { controllerName: imported.importedName, handlerName: imported.importedName };
    }
    if (sf.getFunction(name) || sf.getVariableDeclaration(name)) {
      return { controllerName: null, handlerName: name }; // declared in the routes file itself
    }
    return null;
  }
  if (Node.isCallExpression(node)) {
    for (const arg of [...node.getArguments()].reverse()) {
      const nested = findHandler(arg, sf, imports);
      if (nested) return nested;
    }
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
