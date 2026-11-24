import { describe, expect, it } from "vitest";
import { GraphIndex, buildView } from "@buildrax/graph";
import type { Model } from "@buildrax/ir";
import { MAX_SECTIONS, mergeMarks, selectionView, traceStepView } from "../app/canvas-code.js";

const ev = (file: string, line: number, kind: "verified" | "config" = "verified") => ({
  kind,
  file,
  startLine: line,
});
const node = (id: string, kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  name,
  evidence: [ev("x", 1)],
  ...extra,
});
const edge = (from: string, kind: string, to: string, evidence: ReturnType<typeof ev>[]) => ({
  id: `${from}->${kind}->${to}`,
  from,
  to,
  kind,
  evidence,
});
const model = {
  schemaVersion: "buildrax-ir/v2",
  meta: { repo: "r", scannedAt: "t", tool: "buildrax", version: "0", languages: [] },
  nodes: [
    node("project:r", "project", "r"),
    node("module:src", "module", "src", { parent: "project:r", path: "src" }),
    node("file:src/a.ts", "file", "a.ts", {
      parent: "module:src",
      path: "src/a.ts",
      meta: { lines: 12 },
    }),
    node("file:src/db.ts", "file", "db.ts", {
      parent: "module:src",
      path: "src/db.ts",
      meta: { lines: 4 },
    }),
    node("route:.:GET /x", "route", "GET /x", {
      parent: "file:src/a.ts",
      path: "src/a.ts",
      evidence: [ev("src/a.ts", 9)],
    }),
    node("external:pg", "external", "pg", { parent: "project:r" }),
    node("database:postgres", "database", "PostgreSQL", {
      parent: "project:r",
      evidence: [ev("docker-compose.yml", 18, "config"), ev("src/db.ts", 1)],
      meta: { infra: true },
    }),
  ],
  edges: [
    edge("file:src/a.ts", "imports", "file:src/db.ts", [ev("src/a.ts", 2)]),
    edge("file:src/db.ts", "depends-on", "external:pg", [ev("src/db.ts", 1)]),
    edge("file:src/db.ts", "uses", "database:postgres", [ev("src/db.ts", 1)]),
  ],
} as unknown as Model;
const index = new GraphIndex(model);
const view = buildView(index, { expanded: new Set(["module:src"]), hideKinds: new Set() });

describe("what the code window shows on the canvas", () => {
  it("a file: the whole file with its links and endpoints marked, then who uses it", () => {
    const v = selectionView(index, view, { type: "node", id: "file:src/db.ts" })!;
    expect(v.sections[0]).toEqual({
      kind: "file",
      file: "src/db.ts",
      marks: [[1, "imports pg · uses PostgreSQL"]],
      focus: 1,
    });
    expect(v.sections[1]).toMatchObject({
      kind: "excerpt",
      file: "src/a.ts",
      line: 2,
      label: "Used by",
      mark: "imports db.ts",
    });
    const a = selectionView(index, view, { type: "node", id: "file:src/a.ts" })!;
    expect(a.sections[0]).toMatchObject({
      marks: [
        [2, "imports db.ts"],
        [9, "GET /x"],
      ],
    });
  });

  it("an arrow: the lines that create it", () => {
    const e = view.edges.find((x) => x.from === "file:src/a.ts" && x.to === "file:src/db.ts")!;
    const v = selectionView(index, view, { type: "edge", id: e.id })!;
    expect(v.title).toBe("a.ts → db.ts");
    expect(v.sections).toEqual([{ kind: "excerpt", file: "src/a.ts", line: 2, mark: "→ db.ts" }]);
  });

  it("infrastructure: code that uses it and config that declares it (config excerpts flagged)", () => {
    const v = selectionView(index, view, { type: "node", id: "database:postgres" })!;
    expect(v.sections).toEqual([
      {
        kind: "excerpt",
        file: "docker-compose.yml",
        line: 18,
        mark: "declared here",
        label: "declared in",
        config: true,
      },
      { kind: "excerpt", file: "src/db.ts", line: 1, mark: "uses PostgreSQL" },
    ]);
  });

  it("a package or folder: its files to open", () => {
    const v = selectionView(index, view, { type: "node", id: "module:src" })!;
    expect(v.sections).toEqual([
      {
        kind: "files",
        label: "src",
        files: [
          { path: "src/a.ts", lines: 12 },
          { path: "src/db.ts", lines: 4 },
        ],
      },
    ]);
  });

  it("a trace step: the lines behind each link of that hop", () => {
    const v = traceStepView(index, {
      n: 1,
      direction: "downstream",
      links: [
        {
          edgeId: "x",
          from: "file:src/a.ts",
          to: "file:src/db.ts",
          evidence: ev("src/a.ts", 2),
          count: 1,
        },
      ],
    });
    expect(v.title).toBe("Trace step 1 · uses");
    expect(v.sections).toEqual([
      { kind: "excerpt", file: "src/a.ts", line: 2, mark: "a.ts → db.ts" },
    ]);
  });

  it("caps long lists and merges labels on one line", () => {
    expect(MAX_SECTIONS).toBeGreaterThan(5);
    expect(
      mergeMarks([
        [3, "a"],
        [1, "b"],
        [3, "c"],
        [3, "a"],
      ]),
    ).toEqual([
      [1, "b"],
      [3, "a · c"],
    ]);
  });
});
