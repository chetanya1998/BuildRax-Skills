import { describe, expect, it } from "vitest";
import { readFnIndex } from "../app/functions-ui.js";
import { readRationale, whyFor } from "../app/why-ui.js";
import { GraphIndex, routeFlow } from "@buildrax/graph";
import type { Model } from "@buildrax/ir";
import { PER_ROW, layoutFlow, methodColor } from "../app/flows-ui.js";
import { decodeState, encodeState, DEFAULT_STATE } from "../app/state-url.js";

const ev = [{ kind: "verified" as const, file: "a.ts", startLine: 1 }];
const file = (p: string) => ({
  id: `file:${p}`,
  kind: "file",
  name: p.split("/").pop(),
  path: p,
  parent: "project:r",
  evidence: ev,
});
const e = (from: string, kind: string, to: string) => ({
  id: `${from}->${kind}->${to}`,
  from,
  to,
  kind,
  evidence: ev,
});
const libs = ["a", "b", "c", "d"].map((x) => `lib/${x}.ts`);
const model = {
  schemaVersion: "buildrax-ir/v2",
  meta: { repo: "r", scannedAt: "t", tool: "buildrax", version: "0", languages: [] },
  nodes: [
    { id: "project:r", kind: "project", name: "r", evidence: ev },
    file("api/orders.ts"),
    ...libs.map(file),
    {
      id: "route:.:GET /orders",
      kind: "route",
      name: "GET /orders",
      parent: "file:api/orders.ts",
      path: "api/orders.ts",
      evidence: ev,
      meta: { method: "GET", path: "/orders", framework: "express", type: "api" },
    },
    { id: "database:postgres", kind: "database", name: "PostgreSQL", evidence: ev },
    { id: "external:pg", kind: "external", name: "pg", evidence: ev },
  ],
  edges: [
    ...libs.map((l) => e("file:api/orders.ts", "imports", `file:${l}`)),
    e("file:lib/a.ts", "uses", "database:postgres"),
    e("file:lib/a.ts", "depends-on", "external:pg"),
  ],
} as unknown as Model;

describe("flow diagram layout", () => {
  const index = new GraphIndex(model);
  const flow = routeFlow(index, "route:.:GET /orders")!;
  const { nodes, rows } = layoutFlow(index, flow);

  it("stacks lanes top to bottom: endpoint, handler, code by hop, infrastructure, packages", () => {
    expect(rows).toBe(5);
    const lanes = [...new Map(nodes.map((n) => [n.row, n.title])).values()];
    expect(lanes).toEqual([
      "Endpoint",
      "Handler file",
      "Code · 1 hop away",
      "Infrastructure",
      "Packages",
    ]);
  });

  it("wraps wide lanes and keeps every participant once", () => {
    const code = nodes.filter((n) => n.title === "Code · 1 hop away");
    expect(code.map((n) => n.slot)).toEqual([0, 1, 2, 3]);
    expect(Math.floor(code.at(-1)!.slot / PER_ROW)).toBe(1); // 4th box on a second line
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it("colours methods consistently", () => {
    expect(methodColor("GET")).not.toBe(methodColor("DELETE"));
    expect(methodColor("WHATEVER")).toMatch(/^hsl\(/);
  });
});

describe("flows in the URL", () => {
  it("round-trips the open view and the selected endpoint", () => {
    const s = decodeState(
      `#${encodeState({ ...DEFAULT_STATE, flows: true, route: "route:.:GET /orders" })}`,
    );
    expect(s).toMatchObject({ flows: true, route: "route:.:GET /orders" });
    expect(decodeState("#%7B%22flows%22%3A%22yes%22%7D").flows).toBe(false);
  });
});

describe("code behind a click in the Flows view", async () => {
  const { codeTargetFor } = await import("../app/flows-code.js");
  const m2 = {
    ...model,
    nodes: model.nodes.map((n) =>
      n.kind === "route"
        ? { ...n, evidence: [{ kind: "verified", file: "api/orders.ts", startLine: 7 }] }
        : n,
    ),
    edges: [
      e("file:api/orders.ts", "imports", "file:lib/a.ts"),
      {
        ...e("file:lib/a.ts", "uses", "database:postgres"),
        evidence: [{ kind: "verified", file: "lib/a.ts", startLine: 3 }],
      },
      {
        ...e("file:lib/a.ts", "depends-on", "external:pg"),
        evidence: [{ kind: "verified", file: "lib/a.ts", startLine: 3 }],
      },
    ],
  } as unknown as Model;
  const index = new GraphIndex(m2);
  const flow = routeFlow(index, "route:.:GET /orders")!;

  it("endpoint → the handler line; step → the linking line", () => {
    expect(codeTargetFor(index, flow, { kind: "node", id: "route:.:GET /orders" })).toMatchObject({
      file: "api/orders.ts",
      line: 7,
      marks: [[7, "GET /orders"]],
      nodeId: "file:api/orders.ts",
    });
    const step = flow.steps.find((s) => s.to === "database:postgres")!;
    expect(codeTargetFor(index, flow, { kind: "step", n: step.n })).toMatchObject({
      file: "lib/a.ts",
      line: 3,
      nodeId: "database:postgres",
    });
  });

  it("file box → whole file with its outgoing links marked, one label per line", () => {
    const t = codeTargetFor(index, flow, { kind: "node", id: "file:lib/a.ts" })!;
    expect(t.marks).toHaveLength(1);
    expect(t.marks[0]![0]).toBe(3);
    expect(t.marks[0]![1]).toMatch(/depends-on pg · \d+\. uses PostgreSQL/);
  });

  it("infrastructure box → where the flow reaches it", () => {
    expect(codeTargetFor(index, flow, { kind: "node", id: "database:postgres" })).toMatchObject({
      title: expect.stringMatching(/^PostgreSQL: reached in step \d+$/),
      file: "lib/a.ts",
      line: 3,
    });
  });
});

describe("function index in the viewer", () => {
  it("indexes functions by file, id and route, and ignores anything else", () => {
    const fn = {
      id: "fn:a.ts#GET",
      name: "GET",
      kind: "function" as const,
      line: 1,
      endLine: 3,
      routes: ["route:x:GET /a"],
      calls: [],
      ops: [],
    };
    const idx = readFnIndex({
      schemaVersion: "buildrax-functions/v1",
      repo: "r",
      scannedAt: "t",
      stats: { files: 1, functions: 1, calls: 0, resolved: 0 },
      files: [{ path: "a.ts", functions: [fn] }],
    })!;
    expect(idx.byFile.get("a.ts")).toEqual([fn]);
    expect(idx.byId.get("fn:a.ts#GET")?.path).toBe("a.ts");
    expect(idx.byRoute.get("route:x:GET /a")?.[0]?.fn.name).toBe("GET");
    expect(readFnIndex({ schemaVersion: "other" })).toBeUndefined();
    expect(readFnIndex(undefined)).toBeUndefined();
  });
});

describe("rationale in the viewer", () => {
  it("reads the index and gathers sources for a node and inside it", () => {
    const model = {
      schemaVersion: "buildrax-ir/v3",
      meta: { repo: "r", scannedAt: "t", generator: { name: "b", version: "0" }, languages: [] },
      nodes: [
        { id: "project:r", kind: "project", name: "r", evidence: [{ kind: "config" }] },
        {
          id: "module:src",
          kind: "module",
          name: "src",
          parent: "project:r",
          path: "src",
          evidence: [{ kind: "config" }],
        },
        {
          id: "file:src/a.ts",
          kind: "file",
          name: "a.ts",
          parent: "module:src",
          path: "src/a.ts",
          evidence: [{ kind: "config" }],
        },
      ],
      edges: [],
    } as unknown as Model;
    const r = readRationale({
      schemaVersion: "buildrax-rationale/v1",
      repo: "r",
      scannedAt: "t",
      stats: { adrs: 1, docs: 0, comments: 1, commits: 0 },
      git: { read: false, commits: 0 },
      sources: [
        {
          id: "adr:docs/adr/1.md",
          kind: "adr",
          title: "Use src",
          excerpt: "x",
          links: [{ node: "module:src", via: "code" }],
        },
        {
          id: "comment:src/a.ts:1",
          kind: "comment",
          title: "src/a.ts",
          excerpt: "y",
          links: [{ node: "file:src/a.ts", via: "location" }],
        },
      ],
      byNode: { "module:src": ["adr:docs/adr/1.md"], "file:src/a.ts": ["comment:src/a.ts:1"] },
    })!;
    const w = whyFor(r, new GraphIndex(model), "module:src");
    expect(w.sources.map((s) => s.id)).toEqual(["adr:docs/adr/1.md"]);
    expect(w.inside).toBe(1);
    expect(readRationale({ schemaVersion: "x" })).toBeUndefined();
  });
});
