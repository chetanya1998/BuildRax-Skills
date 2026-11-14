import { describe, expect, it } from "vitest";
import type { EdgeKind, IREdge, IRNode, Model } from "@buildrax/ir";
import {
  GraphIndex,
  buildView,
  fileCycles,
  hubs,
  searchNodes,
  shortestPath,
  tarjanScc,
  traverse,
} from "../src/index.js";

const ev = [{ kind: "verified" as const, file: "x", startLine: 1 }];
const n = (id: string, kind: IRNode["kind"], parent?: string): IRNode => ({
  id,
  kind,
  name: id.split(/[:/]/).pop()!,
  parent,
  path: id.split(":")[1],
  evidence: ev,
});
const e = (from: string, to: string, kind: EdgeKind = "imports"): IREdge => ({
  id: `${from}->${kind}->${to}`,
  from,
  to,
  kind,
  evidence: ev,
});

// pkg a: a1 <-> a2 (internal cycle), a1 -> b1 ; pkg b: b1 -> b2, b1 -> external:lib ; c: c1 -> a1
const model: Model = {
  schemaVersion: "buildrax-ir/v1",
  meta: { repo: "r", scannedAt: "t", generator: { name: "buildrax", version: "0" }, languages: [] },
  nodes: [
    n("project:r", "project"),
    n("module:a", "module", "project:r"),
    n("module:b", "module", "project:r"),
    n("module:c", "module", "project:r"),
    n("file:a/a1.ts", "file", "module:a"),
    n("file:a/a2.ts", "file", "module:a"),
    n("file:b/b1.ts", "file", "module:b"),
    n("file:b/b2.ts", "file", "module:b"),
    n("file:c/c1.ts", "file", "module:c"),
    n("external:lib", "external", "project:r"),
  ],
  edges: [
    e("file:a/a1.ts", "file:a/a2.ts"),
    e("file:a/a2.ts", "file:a/a1.ts"),
    e("file:a/a1.ts", "file:b/b1.ts"),
    e("file:b/b1.ts", "file:b/b2.ts"),
    e("file:b/b1.ts", "external:lib", "depends-on"),
    e("file:c/c1.ts", "file:a/a1.ts"),
  ],
};
const g = new GraphIndex(model);

describe("traversal", () => {
  it("walks downstream and upstream with a depth limit", () => {
    const down1 = traverse(g, "file:a/a1.ts", { direction: "downstream", depth: 1 });
    expect([...down1.keys()].sort()).toEqual(["file:a/a1.ts", "file:a/a2.ts", "file:b/b1.ts"]);
    const downAll = traverse(g, "file:a/a1.ts", { direction: "downstream", depth: Infinity });
    expect(downAll.has("external:lib")).toBe(true);
    expect(downAll.get("file:b/b2.ts")).toBe(2);
    const up = traverse(g, "file:b/b2.ts", { direction: "upstream", depth: Infinity });
    expect(up.has("file:c/c1.ts")).toBe(true);
  });
  it("finds shortest paths and reports unreachable", () => {
    expect(shortestPath(g, "file:c/c1.ts", "file:b/b2.ts")).toEqual([
      "file:c/c1.ts",
      "file:a/a1.ts",
      "file:b/b1.ts",
      "file:b/b2.ts",
    ]);
    expect(shortestPath(g, "file:b/b2.ts", "file:c/c1.ts")).toBeUndefined();
  });
});

describe("structure", () => {
  it("detects strongly connected components", () => {
    expect(
      tarjanScc(
        ["x", "y", "z"],
        new Map([
          ["x", ["y"]],
          ["y", ["x", "z"]],
          ["z", []],
        ]),
      ),
    ).toEqual([["x", "y"]]);
  });
  it("detects file import cycles", () => {
    expect(fileCycles(g)).toEqual([["file:a/a1.ts", "file:a/a2.ts"]]);
  });
  it("ranks hubs and searches", () => {
    expect(hubs(g, "file", 1)[0]?.id).toBe("file:a/a1.ts");
    expect(searchNodes(g, "b1")[0]?.id).toBe("file:b/b1.ts");
    expect(searchNodes(g, "")).toEqual([]);
  });
});

describe("buildView", () => {
  it("shows modules with aggregated edges and flags internal cycles", () => {
    const v = buildView(g, { expanded: new Set() });
    expect(v.nodes.map((x) => x.id)).toEqual(["external:lib", "module:a", "module:b", "module:c"]);
    expect(v.edges.find((x) => x.id === "module:a=>module:b")?.count).toBe(1);
    expect(v.nodes.find((x) => x.id === "module:a")?.inCycle).toBe(true);
    expect(v.nodes.find((x) => x.id === "module:b")?.inCycle).toBe(false);
    expect(v.nodes.find((x) => x.id === "module:a")).toMatchObject({
      expandable: true,
      fileCount: 2,
    });
  });
  it("expands a module to its files and lifts edges for the rest", () => {
    const v = buildView(g, { expanded: new Set(["module:a"]) });
    const ids = v.nodes.map((x) => x.id);
    expect(ids).toContain("file:a/a1.ts");
    expect(ids).not.toContain("module:a");
    expect(v.edges.find((x) => x.id === "file:a/a1.ts=>module:b")?.count).toBe(1);
    expect(v.edges.find((x) => x.id === "module:c=>file:a/a1.ts")).toBeTruthy();
    const cyc = v.edges.filter((x) => x.inCycle).map((x) => x.id);
    expect(cyc.sort()).toEqual(["file:a/a1.ts=>file:a/a2.ts", "file:a/a2.ts=>file:a/a1.ts"]);
  });
  it("hides external kinds on request", () => {
    const v = buildView(g, { expanded: new Set(), hideKinds: new Set(["external"]) });
    expect(v.nodes.some((x) => x.kind === "external")).toBe(false);
    expect(v.edges.some((x) => x.to === "external:lib")).toBe(false);
  });
});
