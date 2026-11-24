import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Model } from "@buildrax/ir";
import {
  aliasCandidates,
  joinPath,
  nextRoutePath,
  parseFile,
  parseJsonc,
  scan,
} from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/flows-app",
);
let model: Model;
beforeAll(async () => {
  model = await scan(FIXTURE, { now: "2026-11-24T00:00:00.000Z" });
});
const routes = () => model.nodes.filter((n) => n.kind === "route");
const names = (scope: string) =>
  routes()
    .filter((r) => r.id.startsWith(`route:${scope}:`))
    .map((r) => r.name)
    .sort();

describe("endpoint detection", () => {
  it("Next.js app and pages routers, with route groups and dynamic segments", () => {
    expect(names("web")).toEqual([
      "ANY /api/legacy",
      "DELETE /api/orders/:id",
      "GET /api/orders",
      "PAGE /orders/:id",
      "POST /api/orders",
    ]);
    expect(nextRoutePath(["(shop)", "blog", "[...slug]"])).toBe("/blog/*slug");
    expect(nextRoutePath(["docs", "[[...rest]]", "@modal"])).toBe("/docs/*rest?");
  });

  it("Express routers mounted from another file, chained methods, computed paths kept as unresolved", () => {
    expect(names("api")).toEqual([
      "DELETE /api/orders/:id/items",
      "GET /api/orders",
      "GET /api/orders/:id",
      "GET /health",
      "POST /api/orders/:id/items",
    ]);
    const computed = routes().find((r) => r.name === "GET (computed path)")!;
    expect(computed.evidence[0]).toMatchObject({
      kind: "unresolved",
      file: "api/src/routes/orders.ts",
      startLine: 6,
    });
    // Map#get, app.get("env") (a setting read) are not routes
    expect(
      routes().some(
        (r) => r.evidence[0]?.file === "api/src/server.ts" && r.evidence[0]?.startLine !== 8,
      ),
    ).toBe(false);
  });

  it("Hono sub-apps, Fastify plugins with a register prefix, NestJS controllers", () => {
    expect(names("edge")).toEqual(["GET /users/:id", "POST /billing/invoices"]);
    expect(routes().find((r) => r.name === "POST /billing/invoices")?.meta).toMatchObject({
      framework: "fastify",
    });
    expect(names("nest")).toEqual(["GET /users/:id", "POST /users"]);
    expect(routes().find((r) => r.id === "route:nest:GET /users/:id")?.meta).toMatchObject({
      handler: "UsersController.find",
    });
  });

  it("FastAPI router prefixes and include_router prefixes across modules; Flask blueprints", () => {
    expect(names("py")).toEqual([
      "GET /",
      "GET /api/v1/items/{item_id}",
      "POST /api/v1/items/bulk",
      "POST /users",
      "PUT /api/v1/items/bulk",
    ]);
    expect(names(".")).toEqual(["GET /admin/stats", "GET /ping", "POST /admin/stats"]);
  });

  it("every route hangs off the file that defines it, with file:line evidence", () => {
    for (const r of routes()) {
      expect(r.parent).toBe(`file:${r.path}`);
      expect(r.evidence[0]?.file).toBe(r.path);
    }
  });
});

describe("tsconfig paths", () => {
  it("resolves @/ aliases to files instead of reporting them unresolved", () => {
    const e = model.edges.find(
      (x) => x.id === "file:web/src/app/api/orders/route.ts->imports->file:web/src/lib/db.ts",
    );
    expect(e?.evidence[0]?.detail).toMatch(/tsconfig paths/);
    expect(model.nodes.some((n) => n.kind === "unresolved" && n.name.startsWith("@/"))).toBe(false);
  });

  it("reads JSON with comments and trailing commas, without touching // inside strings", () => {
    expect(parseJsonc('{ "a": "http://x", // c\n /* b */ "b": [1,2,], }')).toEqual({
      a: "http://x",
      b: [1, 2],
    });
  });

  it("nearest config wins; longest pattern first; baseUrl fallback", () => {
    const cfgs = [
      {
        dir: "apps/web",
        base: "apps/web",
        paths: [
          { pattern: "@/*", targets: ["src/*"] },
          { pattern: "@/ui/*", targets: ["ui/*"] },
        ],
      },
      { dir: "", base: "", baseUrl: "", paths: [] },
    ];
    expect(aliasCandidates(cfgs, "apps/web/src/a.ts", "@/ui/button")).toEqual([
      "apps/web/ui/button",
      "apps/web/src/ui/button",
    ]);
    expect(aliasCandidates(cfgs, "lib/x.ts", "utils/date")).toEqual(["utils/date"]);
  });
});

describe("parse facts", () => {
  it("records local import names for following mounts", async () => {
    const { imports } = await parseFile(
      'import d, { a as b } from "./x";\nimport * as ns from "./y";\nconst r = require("./z");\n',
      "typescript",
    );
    expect(imports.map((i) => i.locals)).toEqual([["d", "b"], ["ns"], ["r"]]);
    const py = await parseFile(
      "from .users import router as users_router\nimport app.routers as r\n",
      "python",
    );
    expect(py.imports.map((i) => i.locals)).toEqual([["users_router"], ["r"]]);
  });

  it("joins paths like a router does", () => {
    expect(joinPath("/api/", "/items", "")).toBe("/api/items");
    expect(joinPath("", "")).toBe("/");
  });
});
