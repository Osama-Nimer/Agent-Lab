# Fixture — `fixtures/graph.sample.json`

Paste this into `fixtures/graph.sample.json` at **T+10**, right after freezing `contract.ts`.
It is read-only afterwards. SWE-B and SWE-C both build against it, which is what makes the
parallel window possible.

It covers the complete chain `Project -> Module -> Route -> Controller -> Service -> Repository ->
Model`, one `Module -> Module` IMPORTS edge, and **one deliberately `INFERRED` edge**
(`AuthService -> users`) so SWE-C can verify dashed-edge rendering before real data exists.

```json
{
  "schemaVersion": 1,
  "repo": { "name": "acme-api", "url": null, "commit": null, "rootDir": "C:/demo/acme-api" },
  "nodes": [
    { "id": "project:acme-api", "type": "Project", "label": "acme-api", "module": null, "file": null, "line": null, "meta": {} },

    { "id": "module:users", "type": "Module", "label": "users", "module": "users", "file": "modules/users/users.module.ts", "line": 1, "meta": { "prefix": "/api/v1/users" } },
    { "id": "module:auth", "type": "Module", "label": "auth", "module": "auth", "file": "modules/auth/auth.module.ts", "line": 1, "meta": { "prefix": "/api/v1/auth" } },

    { "id": "route:POST /api/v1/users", "type": "Route", "label": "POST /api/v1/users", "module": "users", "file": "modules/users/users.routes.ts", "line": 12,
      "meta": { "method": "POST", "path": "/api/v1/users", "handlerName": "create", "controllerName": "UserController", "middleware": [] } },
    { "id": "route:GET /api/v1/users/:id", "type": "Route", "label": "GET /api/v1/users/:id", "module": "users", "file": "modules/users/users.routes.ts", "line": 13,
      "meta": { "method": "GET", "path": "/api/v1/users/:id", "handlerName": "getById", "controllerName": "UserController", "middleware": ["authMiddleware"] } },

    { "id": "controller:UserController", "type": "Controller", "label": "UserController", "module": "users", "file": "modules/users/users.controller.ts", "line": 9, "meta": {} },

    { "id": "service:CreateUserService", "type": "Service", "label": "CreateUserService", "module": "users", "file": "modules/users/services/users.service.ts", "line": 21, "meta": {} },
    { "id": "service:GetUserService", "type": "Service", "label": "GetUserService", "module": "users", "file": "modules/users/services/users.service.ts", "line": 48, "meta": {} },
    { "id": "service:AuthService", "type": "Service", "label": "AuthService", "module": "auth", "file": "modules/auth/services/auth.service.ts", "line": 17, "meta": {} },

    { "id": "repo:insertUser", "type": "Repository", "label": "insertUser", "module": "users", "file": "modules/users/repo/users.repo.ts", "line": 8, "meta": {} },
    { "id": "repo:findUserById", "type": "Repository", "label": "findUserById", "module": "users", "file": "modules/users/repo/users.repo.ts", "line": 24, "meta": {} },

    { "id": "model:users", "type": "Model", "label": "users", "module": null, "file": "db/users/users.tables.ts", "line": 6, "meta": { "orm": "drizzle" } }
  ],
  "edges": [
    { "id": "project:acme-api->module:users:CONTAINS", "source": "project:acme-api", "target": "module:users", "type": "CONTAINS", "confidence": "EXTRACTED", "evidence": { "file": "server.ts", "line": 22 } },
    { "id": "project:acme-api->module:auth:CONTAINS", "source": "project:acme-api", "target": "module:auth", "type": "CONTAINS", "confidence": "EXTRACTED", "evidence": { "file": "server.ts", "line": 23 } },

    { "id": "module:users->route:POST /api/v1/users:CONTAINS", "source": "module:users", "target": "route:POST /api/v1/users", "type": "CONTAINS", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/users.routes.ts", "line": 12 } },
    { "id": "module:users->route:GET /api/v1/users/:id:CONTAINS", "source": "module:users", "target": "route:GET /api/v1/users/:id", "type": "CONTAINS", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/users.routes.ts", "line": 13 } },

    { "id": "route:POST /api/v1/users->controller:UserController:HANDLED_BY", "source": "route:POST /api/v1/users", "target": "controller:UserController", "type": "HANDLED_BY", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/users.routes.ts", "line": 12 } },
    { "id": "route:GET /api/v1/users/:id->controller:UserController:HANDLED_BY", "source": "route:GET /api/v1/users/:id", "target": "controller:UserController", "type": "HANDLED_BY", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/users.routes.ts", "line": 13 } },

    { "id": "controller:UserController->service:CreateUserService:CALLS", "source": "controller:UserController", "target": "service:CreateUserService", "type": "CALLS", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/users.controller.ts", "line": 15 } },
    { "id": "controller:UserController->service:GetUserService:CALLS", "source": "controller:UserController", "target": "service:GetUserService", "type": "CALLS", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/users.controller.ts", "line": 28 } },

    { "id": "service:CreateUserService->repo:insertUser:CALLS", "source": "service:CreateUserService", "target": "repo:insertUser", "type": "CALLS", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/services/users.service.ts", "line": 30 } },
    { "id": "service:GetUserService->repo:findUserById:CALLS", "source": "service:GetUserService", "target": "repo:findUserById", "type": "CALLS", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/services/users.service.ts", "line": 55 } },

    { "id": "repo:insertUser->model:users:READS_WRITES", "source": "repo:insertUser", "target": "model:users", "type": "READS_WRITES", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/repo/users.repo.ts", "line": 11 } },
    { "id": "repo:findUserById->model:users:READS_WRITES", "source": "repo:findUserById", "target": "model:users", "type": "READS_WRITES", "confidence": "EXTRACTED", "evidence": { "file": "modules/users/repo/users.repo.ts", "line": 27 } },

    { "id": "module:auth->module:users:IMPORTS", "source": "module:auth", "target": "module:users", "type": "IMPORTS", "confidence": "EXTRACTED", "evidence": { "file": "modules/auth/services/auth.service.ts", "line": 4 } },

    { "id": "service:AuthService->model:users:READS_WRITES", "source": "service:AuthService", "target": "model:users", "type": "READS_WRITES", "confidence": "INFERRED", "evidence": null }
  ],
  "stats": {
    "filesScanned": 41,
    "durationMs": 1840,
    "warnings": [
      "modules/uploads/uploads.routes.ts:22 inline arrow handler, no controller resolved",
      "Dropped edge NotificationService -> sendEmail (unresolved endpoint)"
    ],
    "nodeCount": 12,
    "edgeCount": 14
  }
}
```

---

## What this fixture is for

| Consumer | Uses it to |
|---|---|
| **SWE-B** | serve `/api/graph` from T+15, and test all four query functions before Lane A lands |
| **SWE-C** | build the entire UI — layout, colours, dashed edges, drawer, highlighting |
| **ALL, T+75** | integration check: SWE-A's real output must satisfy the same TypeScript types |

## Query answers it should produce

Use these to verify Lane B's `query.ts` without any agent involved:

| Call | Expected |
|---|---|
| `findNodes("user")` | 8 nodes (routes, controller, services, repos, model) |
| `neighbors("service:CreateUserService", "in")` | `controller:UserController` |
| `neighbors("service:CreateUserService", "out")` | `repo:insertUser` |
| `neighbors("model:users", "in")` | both repos **and** `service:AuthService` (the INFERRED one) |
| `tracePath("route:POST /api/v1/users", "model:users")` | Route → Controller → Service → Repo → Model |

That last row is exactly the answer to *"How does creating a user work?"*
