import { describe, expect, it } from "vitest";
import type { Model } from "@buildrax/ir";
import { GraphIndex, findRoutes, listRoutes, routeFlow, routesReaching } from "../src/index.js";

const ev = (file: string, line = 1) => [{ kind: "verified" as const, file, startLine: line }];
const file = (p: string) => ({
  id: `file:${p}`,
  kind: "file" as const,
  name: p,
  path: p,
  parent: "project:r",
  evidence: ev(p),
});
const edge = (from: string, kind: string, to: string) => ({
  id: `${from}->${kind}->${to}`,
  from,
  to,
  kind,
  evidence: ev(from.replace("file:", "")),
});
const model = {
  schemaVersion: "buildrax-ir/v2",
  meta: { repo: "r", scannedAt: "t", tool: "buildrax", version: "0", languages: [] },
  nodes: [
    { id: "project:r", kind: "project", name: "r", evidence: ev("x") },
    file("api/orders.ts"),
    file("lib/db.ts"),
    file("lib/queue.ts"),
    file("lib/unused.ts"),
    {
      id: "route:.:GET /orders/:id",
      kind: "route",
      name: "GET /orders/:id",
      parent: "file:api/orders.ts",
      path: "api/orders.ts",
      evidence: ev("api/orders.ts", 4),
      meta: { method: "GET", path: "/orders/:id", framework: "express", type: "api" },
    },
    {
      id: "route:.:POST /orders",
      kind: "route",
      name: "POST /orders",
      parent: "file:api/orders.ts",
      path: "api/orders.ts",
      evidence: ev("api/orders.ts", 9),
      meta: { method: "POST", path: "/orders", framework: "express", type: "api" },
    },
    {
      id: "database:postgres",
      kind: "database",
      name: "PostgreSQL",
      evidence: ev("db"),
      meta: { infra: true },
    },
    { id: "queue:bullmq", kind: "queue", name: "BullMQ", evidence: ev("q"), meta: { infra: true } },
    { id: "external:pg", kind: "external", name: "pg", evidence: ev("x") },
  ],
  edges: [
    edge("file:api/orders.ts", "imports", "file:lib/db.ts"),
    edge("file:api/orders.ts", "imports", "file:lib/queue.ts"),
    edge("file:lib/db.ts", "uses", "database:postgres"),
    edge("file:lib/db.ts", "depends-on", "external:pg"),
    edge("file:lib/queue.ts", "uses", "queue:bullmq"),
    edge("file:lib/queue.ts", "imports", "file:lib/db.ts"),
  ],
} as unknown as Model;
const index = new GraphIndex(model);

describe("flows", () => {
  it("lists and finds endpoints in any parameter style", () => {
    expect(listRoutes(index).map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /orders",
      "GET /orders/:id",
    ]);
    expect(findRoutes(index, "get /orders/{id}").map((r) => r.id)).toEqual([
      "route:.:GET /orders/:id",
    ]);
    expect(findRoutes(index, "/orders").map((r) => r.method)).toEqual(["POST"]);
  });

  it("walks from the handler file to code, infrastructure and packages, in numbered steps", () => {
    const f = routeFlow(index, "route:.:GET /orders/:id")!;
    expect(f.entry).toBe("file:api/orders.ts");
    expect(f.steps.map((s) => `${s.n}:${s.hop} ${s.from}->${s.to}`)).toEqual([
      "1:1 file:api/orders.ts->file:lib/db.ts",
      "2:1 file:api/orders.ts->file:lib/queue.ts",
      "3:2 file:lib/db.ts->external:pg",
      "4:2 file:lib/db.ts->database:postgres",
      "5:2 file:lib/queue.ts->queue:bullmq",
    ]);
    expect(f.participants).toEqual({
      files: ["file:api/orders.ts", "file:lib/db.ts", "file:lib/queue.ts"],
      infra: ["database:postgres", "queue:bullmq"],
      external: ["external:pg"],
      packages: [],
    });
    expect(f.steps[0]!.evidence?.file).toBe("api/orders.ts");
  });

  it("reports when the depth limit cut the walk short", () => {
    expect(routeFlow(index, "route:.:GET /orders/:id", { depth: 1 })!.truncated).toBe(true);
  });

  it("answers which endpoints reach a database", () => {
    expect(
      routesReaching(index, "database:postgres")
        .map((r) => r.method)
        .sort(),
    ).toEqual(["GET", "POST"]);
    expect(routesReaching(index, "file:lib/unused.ts")).toEqual([]);
  });
});
