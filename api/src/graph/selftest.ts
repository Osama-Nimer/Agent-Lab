// `npm run test:graph` — verifies build + query against the shared fixture with zero LLM.
// Expected values come from Docs/FIXTURE_SAMPLE.md "Query answers it should produce".
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Facts, Graph } from "../contract.js";
import { buildGraph, validateGraph } from "./build.js";
import { findNodes, indexGraph, neighbors, overview, tracePath } from "./query.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, "../../../fixtures/graph.sample.json");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Graph;
check("fixture validates (no dangling edges / dup ids)", validateGraph(fixture).length === 0, validateGraph(fixture));

// --- build.ts: round-trip fixture -> Facts -> Graph and compare
const facts: Facts = {
  repo: fixture.repo,
  nodes: fixture.nodes.map((n) => ({
    kind: n.type,
    name: n.label,
    module: n.module,
    evidence: { file: n.file ?? "", line: n.line ?? 0 },
    meta: n.meta,
  })),
  edges: [
    ...fixture.edges.map((e) => ({
      from: fixture.nodes.find((n) => n.id === e.source)!.label,
      to: fixture.nodes.find((n) => n.id === e.target)!.label,
      type: e.type,
      confidence: e.confidence,
      evidence: e.evidence ?? { file: "", line: 0 },
    })),
    // deliberately dangling — must be dropped, not emitted
    { from: "UserController", to: "GhostService", type: "CALLS", confidence: "EXTRACTED", evidence: { file: "x.ts", line: 1 } },
  ],
  stats: { filesScanned: 41, durationMs: 1, warnings: [] },
};
const built = buildGraph(facts);
check("buildGraph: same node ids as fixture", JSON.stringify(ids(built.nodes)) === JSON.stringify(ids(fixture.nodes)), ids(built.nodes));
check("buildGraph: same edge ids as fixture", JSON.stringify(ids(built.edges)) === JSON.stringify(ids(fixture.edges)), ids(built.edges));
check("buildGraph: dangling edge dropped + warned", built.stats.warnings.some((w) => w.includes("GhostService")), built.stats.warnings);
check("buildGraph: output validates", validateGraph(built).length === 0, validateGraph(built));

// --- query.ts against the fixture
indexGraph(fixture);
const ov = overview();
check("overview: 12 nodes / 14 edges / 2 modules", ov.nodeCount === 12 && ov.edgeCount === 14 && ov.modules.length === 2, ov);

check("findNodes('user') -> 9 (module + model both labelled 'users')", findNodes("user").length === 9, ids(findNodes("user")));

// Name collision: Module "users" and Model "users" share a name. Without kinds the builder must
// still route CONTAINS to the module and READS_WRITES to the model; with kinds it must be exact.
const collision = buildGraph({
  ...facts,
  edges: [
    { from: "acme-api", to: "users", type: "CONTAINS", confidence: "EXTRACTED", evidence: { file: "server.ts", line: 1 } },
    { from: "insertUser", to: "users", type: "READS_WRITES", confidence: "EXTRACTED", evidence: { file: "r.ts", line: 1 } },
    { from: "auth", to: "users", type: "IMPORTS", confidence: "EXTRACTED", evidence: { file: "a.ts", line: 1 } },
    { from: "AuthService", to: "users", toKind: "Model", type: "READS_WRITES", confidence: "INFERRED", evidence: { file: "a.ts", line: 9 } },
  ],
});
check(
  "collision: kind-aware resolution picks module for CONTAINS/IMPORTS and model for READS_WRITES",
  JSON.stringify(ids(collision.edges)) ===
    JSON.stringify([
      "module:auth->module:users:IMPORTS",
      "project:acme-api->module:users:CONTAINS",
      "repo:insertUser->model:users:READS_WRITES",
      "service:AuthService->model:users:READS_WRITES",
    ]),
  ids(collision.edges),
);

// Same-named endpoints (found by the review): must resolve to the one legal pairing, never a self-loop.
const sameName = buildGraph({
  ...facts,
  nodes: [
    ...facts.nodes,
    { kind: "Service", name: "createUser", module: "users", evidence: { file: "s.ts", line: 1 } },
    { kind: "Repository", name: "createUser", module: "users", evidence: { file: "r.ts", line: 1 } },
  ],
  edges: [
    { from: "createUser", to: "createUser", type: "CALLS", confidence: "EXTRACTED", evidence: { file: "s.ts", line: 5 } },
    { from: "users", to: "users", type: "CONTAINS", confidence: "EXTRACTED", evidence: { file: "m.ts", line: 1 } },
    // explicit kinds forcing a genuine self-loop -> dropped WITH a warning
    { from: "UserController", fromKind: "Controller", to: "UserController", toKind: "Controller", type: "CALLS", confidence: "EXTRACTED", evidence: { file: "c.ts", line: 1 } },
  ],
});
check(
  "same-name endpoints: Service createUser -> Repository createUser, Module users -> Model users",
  JSON.stringify(ids(sameName.edges)) === JSON.stringify(["module:users->model:users:CONTAINS", "service:createUser->repo:createUser:CALLS"]),
  ids(sameName.edges),
);
check("genuine self-loop is dropped with a warning, not silently", sameName.stats.warnings.some((w) => /self-loop/.test(w)), sameName.stats.warnings);

// Ambiguous: Controller -> "users" where both a Service and a Repository named users exist -> drop + warn.
const ambiguous = buildGraph({
  ...facts,
  nodes: [
    ...facts.nodes,
    { kind: "Service", name: "lookup", module: "users", evidence: { file: "s.ts", line: 1 } },
    { kind: "Repository", name: "lookup", module: "users", evidence: { file: "r.ts", line: 1 } },
  ],
  edges: [{ from: "UserController", to: "lookup", type: "CALLS", confidence: "EXTRACTED", evidence: { file: "c.ts", line: 9 } }],
});
check("ambiguous endpoint is dropped with an 'ambiguous' warning rather than guessed", ambiguous.edges.length === 0 && ambiguous.stats.warnings.some((w) => /ambiguous/.test(w)), ambiguous.stats.warnings);
check("findNodes('user', Route) -> 2", findNodes("user", "Route").length === 2);
check("findNodes('create user', Route) -> OR fallback returns both user routes", findNodes("create user", "Route").length === 2, ids(findNodes("create user", "Route")));
check("findNodes('create user') -> all-token match (CreateUserService) ranks alone", JSON.stringify(ids(findNodes("create user"))) === JSON.stringify(["service:CreateUserService"]), ids(findNodes("create user")));
check("findNodes('zzz') -> empty, no throw", findNodes("zzz").length === 0);
check("findNodes('UserController') exact first", findNodes("UserController")[0]?.id === "controller:UserController");

const inN = neighbors("service:CreateUserService", "in");
check("neighbors(CreateUserService, in) -> UserController", JSON.stringify(ids(inN.nodes)) === JSON.stringify(["controller:UserController"]), ids(inN.nodes));
const outN = neighbors("service:CreateUserService", "out");
check("neighbors(CreateUserService, out) -> insertUser", JSON.stringify(ids(outN.nodes)) === JSON.stringify(["repo:insertUser"]), ids(outN.nodes));
const modelIn = neighbors("model:users", "in");
check(
  "neighbors(users model, in) -> 2 repos + AuthService (INFERRED)",
  JSON.stringify(ids(modelIn.nodes)) === JSON.stringify(["repo:findUserById", "repo:insertUser", "service:AuthService"]),
  ids(modelIn.nodes),
);
check("neighbors depth 2 reaches the controller from the model", ids(neighbors("model:users", "in", 2).nodes).includes("service:CreateUserService"));

const p = tracePath("route:POST /api/v1/users", "model:users");
check(
  "tracePath(POST /users -> users model) = Route>Controller>Service>Repo>Model",
  p.found && p.directed && p.nodes.map((n) => n.type).join(">") === "Route>Controller>Service>Repository>Model",
  p.nodes.map((n) => n.id),
);
const rev = tracePath("model:users", "route:POST /api/v1/users");
check("tracePath reverse falls back to undirected", rev.found && !rev.directed && rev.nodes.length === 5);

let threw = "";
try { neighbors("service:CreateUser", "out"); } catch (e) { threw = (e as Error).message; }
check("unknown node id -> helpful suggestion", threw.includes("Did you mean") && threw.includes("service:CreateUserService"), threw);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
