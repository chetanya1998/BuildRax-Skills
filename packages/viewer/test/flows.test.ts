import { describe, expect, it } from "vitest";
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
