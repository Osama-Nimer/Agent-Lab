import {
  Project,
  Node,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type FunctionDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from "ts-morph";
import type { FactNode, FactEdge, EdgeType, NodeType } from "../contract.js";
import { evidence } from "./util.js";
import { moduleSlugForFile } from "./scan-modules.js";

export interface ScanCallsResult {
  nodes: FactNode[];
  edges: FactEdge[];
}

interface ImportTarget {
  localName: string;
  importedName: string;
  spec: string;
}

interface ResolvedTarget {
  name: string;
  kind: NodeType;
  confidence: "EXTRACTED" | "INFERRED";
}

interface Owner {
  name: string;
  declaration: VariableDeclaration | FunctionDeclaration | ClassDeclaration;
}

function classifyBySpecifier(spec: string): NodeType | null {
  if (/service/i.test(spec)) return "Service";
  if (/repo|repository/i.test(spec)) return "Repository";
  if (/db|database|schema|tables|model|entity|prisma/i.test(spec)) return "Model";
  return null;
}

function classifyByName(name: string): NodeType | null {
  if (/Service$/i.test(name)) return "Service";
  if (/Repo(?:sitory)?$/i.test(name)) return "Repository";
  return null;
}

function ownerKindForFile(filePath: string): NodeType | null {
  if (/\.controller\.ts$/i.test(filePath)) return "Controller";
  if (/\.service\.ts$/i.test(filePath)) return "Service";
  if (/\.(repo|repository)\.ts$/i.test(filePath)) return "Repository";
  return null;
}

function edgeTypeFor(toKind: NodeType): EdgeType {
  return toKind === "Model" ? "READS_WRITES" : "CALLS";
}

export function scanCalls(
  project: Project,
  rootDir: string,
  modulesRoot: string | null,
  _warnings: string[]
): ScanCallsResult {
  const nodes = new Map<string, FactNode>();
  const edges: FactEdge[] = [];

  for (const sf of project.getSourceFiles()) {
    const filePath = sf.getFilePath();
    const ownerKind = ownerKindForFile(filePath);
    if (!ownerKind) continue;

    const imports = buildImportTable(sf);
    const module = moduleSlugForFile(rootDir, filePath, modulesRoot);

    if (ownerKind === "Controller") {
      for (const owner of declaredControllerOwners(sf)) {
        addNode(nodes, {
          kind: ownerKind,
          name: owner.name,
          module,
          evidence: evidence(rootDir, owner.declaration),
        }, true);
      }
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const target = resolveTarget(call, imports);
      if (!target) continue;

      const owner = findOwner(call, sf);
      if (!owner) continue;

      const callEv = evidence(rootDir, call);
      addNode(nodes, {
        kind: ownerKind,
        name: owner.name,
        module,
        evidence: evidence(rootDir, owner.declaration),
      }, true);
      addNode(nodes, {
        kind: target.kind,
        name: target.name,
        module,
        evidence: callEv,
      });

      edges.push({
        from: owner.name,
        to: target.name,
        type: edgeTypeFor(target.kind),
        confidence: target.confidence,
        evidence: callEv,
      });
    }
  }

  return { nodes: [...nodes.values()], edges: dedupeEdges(edges) };
}

function buildImportTable(sf: SourceFile): Map<string, ImportTarget> {
  const imports = new Map<string, ImportTarget>();
  for (const declaration of sf.getImportDeclarations()) {
    const spec = declaration.getModuleSpecifierValue();
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) {
      const localName = defaultImport.getText();
      imports.set(localName, { localName, importedName: localName, spec });
    }
    for (const named of declaration.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      imports.set(localName, { localName, importedName: named.getName(), spec });
    }
  }
  return imports;
}

function resolveTarget(call: CallExpression, imports: Map<string, ImportTarget>): ResolvedTarget | null {
  const callee = call.getExpression();

  if (Node.isIdentifier(callee)) {
    const name = callee.getText();
    const imported = imports.get(name);
    if (imported) {
      const kind = classifyBySpecifier(imported.spec);
      if (kind) return { name: imported.importedName, kind, confidence: "EXTRACTED" };
    }
    const kind = classifyByName(name);
    return kind ? { name, kind, confidence: "INFERRED" } : null;
  }

  if (!Node.isPropertyAccessExpression(callee)) return null;
  const chain = propertyChain(callee);
  if (!chain || chain.parts.length === 0) return null;

  if (chain.root === "this" && chain.parts.length >= 2) {
    const objectName = chain.parts[0];
    const imported = findObjectImport(objectName, imports);
    if (!imported) {
      const kind = classifyByName(objectName);
      return kind ? { name: objectName, kind, confidence: "INFERRED" } : null;
    }
    const kind = classifyBySpecifier(imported.spec);
    return kind
      ? { name: imported.importedName, kind, confidence: "EXTRACTED" }
      : null;
  }

  const imported = imports.get(chain.root);
  if (imported) {
    const kind = classifyBySpecifier(imported.spec);
    if (!kind) return null;

    if (kind === "Model" && /^(db|database)$/i.test(chain.root)
      && chain.parts.length === 1 && /^(insert|select|update|delete)$/i.test(chain.parts[0])) {
      const firstArg = call.getArguments()[0];
      if (firstArg && Node.isIdentifier(firstArg)) {
        return { name: firstArg.getText(), kind, confidence: "EXTRACTED" };
      }
    }
    if (kind === "Model" && /^col$/i.test(chain.root) && chain.parts.length >= 1) {
      return { name: chain.parts[0], kind, confidence: "EXTRACTED" };
    }
    if (kind === "Model" && /^(prisma|db|database)$/i.test(chain.root) && chain.parts.length >= 2) {
      return { name: chain.parts[0], kind, confidence: "EXTRACTED" };
    }
    return { name: imported.importedName, kind, confidence: "EXTRACTED" };
  }

  const inferredKind = classifyByName(chain.root);
  return inferredKind
    ? { name: chain.root, kind: inferredKind, confidence: "INFERRED" }
    : null;
}

function propertyChain(node: Node): { root: string; parts: string[] } | null {
  if (Node.isIdentifier(node)) return { root: node.getText(), parts: [] };
  if (node.getKind() === SyntaxKind.ThisKeyword) return { root: "this", parts: [] };
  if (!Node.isPropertyAccessExpression(node)) return null;
  const parent = propertyChain(node.getExpression());
  if (!parent) return null;
  parent.parts.push(node.getName());
  return parent;
}

function findObjectImport(objectName: string, imports: Map<string, ImportTarget>): ImportTarget | null {
  const direct = imports.get(objectName);
  if (direct) return direct;
  const normalized = objectName.toLowerCase();
  return [...imports.values()].find((entry) =>
    entry.localName.toLowerCase() === normalized
    || entry.importedName.toLowerCase() === normalized
  ) ?? null;
}

function findOwner(call: CallExpression, sf: SourceFile): Owner | null {
  const ancestors = call.getAncestors();
  const classDecl = ancestors.find(Node.isClassDeclaration);
  if (classDecl?.getName()) {
    const className = classDecl.getName()!;
    const exportedInstance = sf.getVariableDeclarations().find((declaration) => {
      if (!declaration.isExported()) return false;
      const initializer = declaration.getInitializer();
      return Boolean(initializer && Node.isNewExpression(initializer)
        && initializer.getExpression().getText() === className);
    });
    return exportedInstance
      ? { name: exportedInstance.getName(), declaration: exportedInstance }
      : { name: className, declaration: classDecl };
  }

  const objectOwner = ancestors
    .filter(Node.isVariableDeclaration)
    .find((declaration) => {
      const initializer = declaration.getInitializer();
      return Boolean(initializer && Node.isObjectLiteralExpression(initializer));
    });
  if (objectOwner) return { name: objectOwner.getName(), declaration: objectOwner };

  const functionOwner = ancestors.find(Node.isFunctionDeclaration);
  if (functionOwner?.getName()) {
    return { name: functionOwner.getName()!, declaration: functionOwner };
  }

  const variableOwner = ancestors.find(Node.isVariableDeclaration);
  return variableOwner
    ? { name: variableOwner.getName(), declaration: variableOwner }
    : null;
}

function declaredControllerOwners(sf: SourceFile): Owner[] {
  const owners: Owner[] = [];
  const claimedClasses = new Set<string>();

  for (const declaration of sf.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!declaration.isExported() || !initializer) continue;
    if (Node.isNewExpression(initializer)) {
      const className = initializer.getExpression().getText();
      const classDecl = sf.getClass(className);
      if (classDecl) claimedClasses.add(className);
      owners.push({ name: declaration.getName(), declaration });
    } else if (Node.isObjectLiteralExpression(initializer)) {
      owners.push({ name: declaration.getName(), declaration });
    }
  }

  for (const classDecl of sf.getClasses()) {
    const className = classDecl.getName();
    if (className && !claimedClasses.has(className)) {
      owners.push({ name: className, declaration: classDecl });
    }
  }
  return owners;
}

function addNode(nodes: Map<string, FactNode>, node: FactNode, prefer = false) {
  if (prefer || !nodes.has(node.name)) nodes.set(node.name, node);
}

function dedupeEdges(edges: FactEdge[]): FactEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}|${edge.to}|${edge.type}|${edge.evidence.file}|${edge.evidence.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
