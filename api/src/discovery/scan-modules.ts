import { Project, Node, SyntaxKind, type SourceFile } from "ts-morph";
import fs from "node:fs";
import path from "node:path";
import type { FactNode, FactEdge } from "../contract.js";
import { toPosix, relPath } from "./util.js";

const MODULE_ROOTS = ["modules", "src/modules", "src/features"];

/** Repo-relative folder that contains modules, e.g. "src/modules", or null if none found. */
function findModulesRoot(rootDir: string): string | null {
  for (const rel of MODULE_ROOTS) {
    if (fs.existsSync(path.join(rootDir, rel))) return rel;
  }
  return null;
}

/**
 * Derive the owning module slug for an absolute file path, e.g.
 * ".../src/modules/users/users.routes.ts" -> "users". Returns null if the
 * file is not under a known modules root.
 */
export function moduleSlugForFile(rootDir: string, absFile: string, modulesRoot: string | null): string | null {
  if (!modulesRoot) return null;
  const rel = relPath(rootDir, absFile);
  const prefix = toPosix(modulesRoot) + "/";
  if (!rel.startsWith(prefix)) return null;
  const rest = rel.slice(prefix.length);
  const slug = rest.split("/")[0];
  return slug || null;
}

export interface ScanModulesResult {
  nodes: FactNode[];
  edges: FactEdge[];
  /** module slug -> mount prefix (e.g. "users" -> "/api/v1/users") */
  prefixByModule: Map<string, string>;
  /** absolute router source file -> inherited mount prefix */
  prefixByFile: Map<string, string>;
  modulesRoot: string | null;
}

export function scanModules(project: Project, rootDir: string, warnings: string[]): ScanModulesResult {
  const nodes: FactNode[] = [];
  const edges: FactEdge[] = [];
  const modulesRoot = findModulesRoot(rootDir);

  if (!modulesRoot) {
    warnings.push(`No modules/, src/modules/, or src/features/ directory found under ${rootDir}`);
    return { nodes, edges, prefixByModule: new Map(), prefixByFile: new Map(), modulesRoot: null };
  }

  const absModulesRoot = path.join(rootDir, modulesRoot);
  const slugs = fs
    .readdirSync(absModulesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const slug of slugs) {
    const modulePrefix = `${toPosix(modulesRoot)}/${slug}/`;
    const moduleSource = project
      .getSourceFiles()
      .filter((sf) => relPath(rootDir, sf.getFilePath()).startsWith(modulePrefix))
      .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()))[0];
    const moduleEvidence = {
      file: moduleSource
        ? relPath(rootDir, moduleSource.getFilePath())
        : `${modulePrefix.replace(/\/$/, "")}/index.ts`,
      line: 1,
    };
    nodes.push({
      kind: "Module",
      name: slug,
      module: slug,
      evidence: moduleEvidence,
    });
    edges.push({
      from: path.basename(rootDir),
      fromKind: "Project",
      to: slug,
      toKind: "Module",
      type: "CONTAINS",
      confidence: "EXTRACTED",
      evidence: moduleEvidence,
    });
  }

  const { prefixByModule, prefixByFile } = findMountPrefixes(project, rootDir, modulesRoot, warnings);

  // Any module with no discovered prefix still gets routes — default to "".
  for (const slug of slugs) {
    if (!prefixByModule.has(slug)) {
      warnings.push(`No mount prefix found for module "${slug}"; defaulting to ""`);
      prefixByModule.set(slug, "");
    }
  }

  return { nodes, edges, prefixByModule, prefixByFile, modulesRoot };
}

function findMountPrefixes(
  project: Project,
  rootDir: string,
  modulesRoot: string,
  warnings: string[]
): { prefixByModule: Map<string, string>; prefixByFile: Map<string, string> } {
  const prefixByModule = new Map<string, string>();
  const prefixByFile = new Map<string, string>();

  const entryFiles = project
    .getSourceFiles()
    .filter((sf) => {
      const rel = relPath(rootDir, sf.getFilePath());
      return /(^|\/)(server|app)\.ts$/.test(rel) || /^(src\/)?index\.ts$/.test(rel);
    });

  for (const sf of entryFiles) {
    walkRouterMounts(
      project,
      rootDir,
      modulesRoot,
      sf,
      "",
      prefixByModule,
      prefixByFile,
      warnings,
      new Set()
    );
  }

  return { prefixByModule, prefixByFile };
}

interface ImportedRouter {
  spec: string;
  sourceFile: SourceFile | null;
}

function walkRouterMounts(
  project: Project,
  rootDir: string,
  modulesRoot: string,
  sf: SourceFile,
  inheritedPrefix: string,
  prefixByModule: Map<string, string>,
  prefixByFile: Map<string, string>,
  warnings: string[],
  visited: Set<string>
) {
  const visitKey = `${sf.getFilePath()}|${inheritedPrefix}`;
  if (visited.has(visitKey)) return;
  visited.add(visitKey);
  const currentFilePrefix = prefixByFile.get(sf.getFilePath());
  if (currentFilePrefix === undefined || inheritedPrefix.length > currentFilePrefix.length) {
    prefixByFile.set(sf.getFilePath(), inheritedPrefix);
  }

  const imports = importTable(project, rootDir, sf);

  // Barrel files (`modules/announcements/index.ts` = `export default announcementsRoutes`) carry
  // the prefix through to the routes file they re-export.
  for (const reExported of reExportedRouters(sf, imports)) {
    const slug = moduleSlugForFile(rootDir, reExported.sourceFile!.getFilePath(), modulesRoot);
    if (slug && (prefixByModule.get(slug) === undefined || inheritedPrefix.length < prefixByModule.get(slug)!.length)) {
      prefixByModule.set(slug, inheritedPrefix);
    }
    walkRouterMounts(project, rootDir, modulesRoot, reExported.sourceFile!, inheritedPrefix, prefixByModule, prefixByFile, warnings, visited);
  }

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== "use") continue;

    const args = call.getArguments();
    if (args.length === 0) continue;
    const firstArg = args[0];
    const hasPath = Node.isStringLiteral(firstArg);
    const localPrefix = Node.isStringLiteral(firstArg) ? firstArg.getLiteralValue() : "";
    const mountedPrefix = joinPrefixes(inheritedPrefix, localPrefix);
    const routerArgs = args
      .slice(hasPath ? 1 : 0)
      .filter(Node.isIdentifier)
      .reverse();

    const routerArg = routerArgs.find((arg) => {
      const imported = imports.get(arg.getText());
      return imported ? looksLikeRouter(imported) : false;
    });
    if (!routerArg) continue;

    const routerId = routerArg.getText();
    const imported = imports.get(routerId)!;
    // Prefer the resolved file's location (handles `./activity/activity.routes` imported from an
    // aggregator inside modules/), fall back to matching the specifier text.
    const slug = (imported.sourceFile
      ? moduleSlugForFile(rootDir, imported.sourceFile.getFilePath(), modulesRoot)
      : null) ?? matchModuleSlug(imported.spec, modulesRoot);
    if (slug) {
      // The module's own prefix is its OUTERMOST mount; nested sub-routers (courses -> assets) are
      // more specific and recorded per file below.
      const current = prefixByModule.get(slug);
      if (current === undefined || mountedPrefix.length < current.length) {
        prefixByModule.set(slug, mountedPrefix);
      }
    }

    if (imported.sourceFile) {
      walkRouterMounts(
        project,
        rootDir,
        modulesRoot,
        imported.sourceFile,
        mountedPrefix,
        prefixByModule,
        prefixByFile,
        warnings,
        visited
      );
    } else if (!slug && /route|router/i.test(imported.spec)) {
      warnings.push(`Could not follow router "${routerId}" imported from "${imported.spec}"`);
    }
  }
}

function importTable(project: Project, rootDir: string, sf: SourceFile): Map<string, ImportedRouter> {
  const imports = new Map<string, ImportedRouter>();
  for (const declaration of sf.getImportDeclarations()) {
    const spec = declaration.getModuleSpecifierValue();
    const sourceFile = declaration.getModuleSpecifierSourceFile()
      ?? resolveImportSource(project, rootDir, sf, spec);
    const value = { spec, sourceFile };
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) imports.set(defaultImport.getText(), value);
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport) imports.set(namespaceImport.getText(), value);
    for (const named of declaration.getNamedImports()) {
      imports.set(named.getAliasNode()?.getText() ?? named.getName(), value);
    }
  }
  return imports;
}

function resolveImportSource(
  project: Project,
  rootDir: string,
  importingFile: SourceFile,
  spec: string
): SourceFile | null {
  let base: string | null = null;
  if (spec.startsWith(".")) {
    base = path.resolve(path.dirname(importingFile.getFilePath()), spec);
  } else if (/^[@~]\//.test(spec)) {
    base = path.join(rootDir, "src", spec.slice(2));
  }
  if (!base) return null;

  const candidates = [base, `${base}.ts`, path.join(base, "index.ts")]
    .map((candidate) => path.resolve(candidate).toLowerCase());
  return project.getSourceFiles().find((candidate) =>
    candidates.includes(path.resolve(candidate.getFilePath()).toLowerCase())
  ) ?? null;
}

function looksLikeRouter(imported: ImportedRouter): boolean {
  if (/route|router/i.test(imported.spec)) return true;
  const sf = imported.sourceFile;
  if (!sf) return false;
  const text = sf.getFullText();
  // Creates a router, or is a barrel that re-exports one (`export default announcementsRoutes`).
  return /\bRouter\s*\(/.test(text) || /from\s+["'][^"']*rout(e|er)s?["']/i.test(text);
}

/**
 * `export default X` / `export { X as default }` where X is an imported router: the mount prefix
 * flows straight through this barrel file into the real routes file.
 */
function reExportedRouters(sf: SourceFile, imports: Map<string, ImportedRouter>): ImportedRouter[] {
  const out: ImportedRouter[] = [];
  const consider = (name: string | undefined) => {
    const imported = name ? imports.get(name) : undefined;
    if (imported?.sourceFile && looksLikeRouter(imported)) out.push(imported);
  };
  for (const ea of sf.getExportAssignments()) consider(ea.getExpression().getText());
  for (const ed of sf.getExportDeclarations()) {
    if (ed.getModuleSpecifierValue()) continue; // `export { x } from "./y"` handled by imports? no — treat as opaque
    for (const spec of ed.getNamedExports()) consider(spec.getName());
  }
  return out;
}

function joinPrefixes(parent: string, child: string): string {
  return `${parent}/${child}`.replace(/\/+/g, "/").replace(/\/$/, "") || "";
}

function matchModuleSlug(moduleSpecifier: string, modulesRoot: string): string | null {
  const rootName = modulesRoot.split("/").pop()!; // "modules" or "features"
  const re = new RegExp(`${rootName}/([^/]+)/`);
  return moduleSpecifier.match(re)?.[1] ?? null;
}
