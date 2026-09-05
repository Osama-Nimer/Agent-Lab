# LANE A — Discovery Engine   `[SWE-A]`

**You own:** `api/src/discovery/**` — exclusively. Do not edit any other file.
**You deliver:** `discover(rootDir: string): Promise<Facts>` — pure, deterministic, no LLM.
**Read first:** `Docs/CONTRACTS.md` section 1. Your entire job is producing that `Facts` shape.

> **You are the foundation but you are not a blocker.** SWE-B and SWE-C build against
> `fixtures/graph.sample.json`. If you finish at T+74, nothing upstream was idle. Work
> depth-first: one complete chain on the demo repo beats five half-scanners.

---

## Files you create

```
api/src/discovery/
├── index.ts             A1  discover() orchestrator
├── load.ts              A1  ts-morph Project setup + file walk
├── scan-modules.ts      A2  modules + URL mount prefixes
├── scan-routes.ts       A3  route definitions
├── scan-calls.ts        A4  controller->service->repo call edges
├── scan-models.ts       A5  ORM model definitions
├── util.ts              A1  path normalization, evidence helper
└── cli.ts               A5  standalone runner for your inner loop
```

---

## A1 — Repo loading + file walk   *(12 min)*

`load.ts`:

```ts
import { Project } from "ts-morph";
import path from "node:path";

export function loadProject(rootDir: string) {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths([
    path.posix.join(toPosix(rootDir), "**/*.ts"),
    "!" + path.posix.join(toPosix(rootDir), "**/node_modules/**"),
    "!" + path.posix.join(toPosix(rootDir), "**/dist/**"),
    "!" + path.posix.join(toPosix(rootDir), "**/*.d.ts"),
  ]);
  return project;
}
```

> **Do not** pass `tsConfigFilePath`. Type-checking a foreign repo is slow and fails on missing
> deps. You only need the syntax tree, never the type checker. This is the single biggest
> performance decision in your lane.

`util.ts` — every lane depends on you getting paths right:

```ts
import path from "node:path";

export const toPosix = (p: string) => p.split(path.sep).join("/");

/** Repo-relative, POSIX. This is what goes in Evidence.file. */
export const relPath = (rootDir: string, absFile: string) =>
  toPosix(path.relative(rootDir, absFile));

export const evidence = (rootDir: string, node: { getSourceFile(): { getFilePath(): string }; getStartLineNumber(): number }) => ({
  file: relPath(rootDir, node.getSourceFile().getFilePath()),
  line: node.getStartLineNumber(),
});
```

`index.ts` orchestrates, collects `warnings`, times the run, and **guarantees no dangling edges**:

```ts
export async function discover(rootDir: string): Promise<Facts> {
  const started = Date.now();
  const warnings: string[] = [];
  const project = loadProject(rootDir);

  const modules  = scanModules(project, rootDir, warnings);
  const routes   = scanRoutes(project, rootDir, modules, warnings);
  const calls    = scanCalls(project, rootDir, warnings);
  const models   = scanModels(project, rootDir, warnings);

  const nodes = [projectNode, ...modules.nodes, ...routes.nodes, ...calls.nodes, ...models.nodes];
  const rawEdges = [...modules.edges, ...routes.edges, ...calls.edges, ...models.edges];

  // CONTRACT REQUIREMENT: drop dangling edges, record them as warnings
  const names = new Set(nodes.map(n => n.name));
  const edges = rawEdges.filter(e => {
    const ok = names.has(e.from) && names.has(e.to);
    if (!ok) warnings.push(`Dropped edge ${e.from} -> ${e.to} (unresolved endpoint)`);
    return ok;
  });

  return {
    repo: { name: path.basename(rootDir), url: null, commit: null, rootDir },
    nodes, edges,
    stats: { filesScanned: project.getSourceFiles().length, durationMs: Date.now() - started, warnings },
  };
}
```

**Done when:** `npx tsx src/discovery/cli.ts <repo>` prints a file count in under 5 seconds.

---

## A2 — Modules + mount prefixes   *(10 min)*

Two jobs: find the modules, and find the URL prefix each one is mounted at.

**Find modules.** Any directory directly under `modules/` or `src/modules/` (fall back to
`src/features/`). Module slug = directory name. Emit one `FactNode { kind: "Module" }` each, plus
`Project -> Module` `CONTAINS` edges.

**Find mount prefixes.** In `server.ts` / `app.ts` / `index.ts`, find every
`app.use("<prefix>", <identifier>)`:

```ts
for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) continue;
  if (expr.getName() !== "use") continue;

  const args = call.getArguments();
  if (args.length < 2) continue;                       // app.use(helmet()) — skip
  if (!Node.isStringLiteral(args[0])) continue;        // must have a path prefix

  const prefix = args[0].getLiteralValue();            // "/api/v1/users"
  const routerId = args[1].getText();                  // "usersModule"
  // resolve routerId -> its import declaration -> module folder
}
```

Resolve the identifier to a module by walking its import:

```ts
const imp = sf.getImportDeclarations()
  .find(d => d.getNamedImports().some(n => n.getName() === routerId));
const spec = imp?.getModuleSpecifierValue();           // "./modules/users/users.module"
const slug = spec?.match(/modules\/([^/]+)\//)?.[1];   // "users"
```

Return `Map<moduleSlug, prefix>` for A3. **If a module has no prefix, default to `""` and push a
warning** — do not drop its routes.

> Multiple modules can mount at the same prefix. Keep the map one-to-one from module to prefix,
> not the reverse.

**Cut line:** `Module -> Module` IMPORTS edges are cut item #3 on the Cut List. Skip until A3-A5
are done.

---

## A3 — Routes scanner   *(15 min — your highest-value task)*

Scan `**/*.routes.ts` (fall back: any file containing `Router()`).

```ts
const HTTP = new Set(["get","post","put","patch","delete","options","all"]);

for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) continue;

  const obj    = expr.getExpression().getText();   // "router"
  const method = expr.getName().toLowerCase();     // "post"
  if (obj !== "router" && obj !== "app") continue;
  if (!HTTP.has(method)) continue;

  const args = call.getArguments();
  if (args.length < 2 || !Node.isStringLiteral(args[0])) continue;

  const localPath = args[0].getLiteralValue();     // "/:id"
  const handler   = args[args.length - 1];         // UserController.create
  const middleware = args.slice(1, -1).map(a => a.getText().split("(")[0]);

  let controllerName: string | null = null;
  let handlerName = "";
  if (Node.isPropertyAccessExpression(handler)) {
    controllerName = handler.getExpression().getText();  // "UserController"
    handlerName    = handler.getName();                  // "create"
  }
  // ...emit
}
```

**Build the full path** — this is what makes the demo legible:

```ts
const fullPath = (prefix + localPath).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
const name = `${method.toUpperCase()} ${fullPath}`;   // "POST /api/v1/users"
```

Emit per route:
- `FactRoute` with `meta: { method, path, handlerName, controllerName, middleware }`
- `Route -> Controller` `HANDLED_BY` edge, `EXTRACTED`, evidence = the `router.x()` call line
- `Module -> Route` `CONTAINS` edge

**Edge cases, in priority order:**
- Inline arrow handler (`router.get("/", (req,res)=>{...})`) → still emit the Route, set
  `controllerName: null`, no HANDLED_BY edge, push a warning. **Never drop the route.**
- `router.use(auth, requireRole([...]))` → not a route. Skip it (no string-literal first arg, so
  the guard above already handles it).
- A router mounted on another router → out of scope, warn.

**Done when:** the demo repo prints a list of `METHOD /full/path -> Controller.handler` that you
can eyeball against its actual API.

---

## A4 — Call edges: Controller -> Service -> Repository   *(15 min)*

The generic algorithm, applied twice. **Do not use the type checker** — use imports as the
resolution table.

For a source file `F`:

1. Build the import table: `Map<importedName, moduleSpecifier>` from all named imports.
2. Walk every `CallExpression` in `F`, take the callee's base identifier.
3. If that identifier is in the import table, you have a resolved call edge.
4. Classify the target by the module specifier it came from:
   - matches `/service/i` → `Service`
   - matches `/repo|repository/i` → `Repository`
   - matches `/db|schema|tables|model|entity/i` → `Model`

```ts
const importTable = new Map<string, string>();
for (const d of sf.getImportDeclarations())
  for (const n of d.getNamedImports())
    importTable.set(n.getName(), d.getModuleSpecifierValue());

for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
  const callee = call.getExpression();
  const base = Node.isIdentifier(callee) ? callee.getText() : null;
  if (!base) continue;
  const spec = importTable.get(base);
  if (!spec) continue;
  const kind = classify(spec);     // Service | Repository | Model | null
  if (!kind) continue;
  // emit node (if new) + CALLS edge from the enclosing declaration
}
```

**Attributing the edge to the right source.** Walk up from the call to its enclosing named
declaration to decide what the `from` should be:

- inside `export const UserController = { create: ... }` → `from = "UserController"`
- inside `export const CreateUserService = async () => {}` → `from = "CreateUserService"`

```ts
const owner = call.getAncestors().find(a =>
  Node.isPropertyAssignment(a) || Node.isVariableDeclaration(a));
```

Take the **outermost** variable declaration for the object-literal-controller case, the
**innermost** for standalone functions. Simplest correct rule: if the file is a `*.controller.ts`,
`from` = the exported controller object's name; otherwise `from` = the innermost enclosing
`VariableDeclaration` name.

**Confidence tagging — do not skip this, it is in the pitch:**
- Resolved via an actual import → `EXTRACTED`
- Matched by name convention only (e.g. `UserService` referenced but not imported) → `INFERRED`

**Done when:** for one route, you can print
`POST /api/v1/users -> UserController -> CreateUserService -> insertUser -> users`.

---

## A5 — Models scanner + CLI   *(8 min)*

**Models.** Scan `db/**/*.tables.ts`, `**/*.schema.ts`, `**/*.entity.ts`, `**/models/**`. Emit a
`Model` node per exported table/entity declaration:

```ts
for (const v of sf.getVariableDeclarations()) {
  if (!v.isExported()) continue;
  const init = v.getInitializer()?.getText() ?? "";
  if (/pgTable|mysqlTable|sqliteTable|new Schema|@Entity/.test(init))
    // emit Model node named v.getName()
}
```

Repository -> Model `READS_WRITES` edges fall out of A4's classifier — a repo file importing
`users` from the schema and calling `db.insert(users)` resolves through the same import table.
If `db.insert(x)` is a *property* call rather than a bare identifier call, catch it specially:
look for `db.insert|select|update|delete` and take the first argument's identifier as the model.

**CLI** — your inner loop, and the fastest thing you own:

```ts
// api/src/discovery/cli.ts
import { discover } from "./index.js";
const root = process.argv[2];
if (!root) { console.error("usage: tsx src/discovery/cli.ts <repo-path>"); process.exit(1); }
const facts = await discover(root);
console.log(JSON.stringify(facts, null, 2));
console.error(`\n${facts.nodes.length} nodes, ${facts.edges.length} edges, ${facts.stats.warnings.length} warnings`);
```

Run it constantly: `npx tsx src/discovery/cli.ts ../demo-repo | head -100`

---

## Your Definition of Done

- [ ] `discover()` returns a `Facts` object that type-checks against `contract.ts`
- [ ] Zero dangling edges (every `from`/`to` matches a node `name`)
- [ ] At least one full chain: Route -> Controller -> Service -> Repository/Model
- [ ] Every node has real `evidence` with a correct file and line
- [ ] Every edge has a `confidence` value
- [ ] Runs in under 10 seconds on the demo repo
- [ ] `stats.warnings` honestly lists what you could not resolve

## Hand-off at T+75

Give SWE-B one line: `import { discover } from "./discovery/index.js"`. That is the whole
integration. If your output validates against `contract.ts`, wiring takes under two minutes.
