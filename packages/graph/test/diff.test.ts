import { describe, expect, it } from "vitest";
import type { Model } from "@buildrax/ir";
import { diffModels } from "../src/index.js";

const ev = [{ kind: "verified" as const, file: "a.ts", startLine: 1 }];
const file = (p: string, lines = 10) => ({
  id: `file:${p}`,
  kind: "file" as const,
  name: p,
  path: p,
  parent: "project:r",
  evidence: ev,
  meta: { lines },
});
const imp = (a: string, b: string, line = 1) => ({
  id: `file:${a}->imports->file:${b}`,
  from: `file:${a}`,
  to: `file:${b}`,
  kind: "imports" as const,
  evidence: [{ ...ev[0]!, startLine: line }],
});
const model = (nodes: Model["nodes"], edges: Model["edges"]): Model =>
  ({
    schemaVersion: "buildrax-ir/v2",
    meta: { repo: "r", scannedAt: "t", tool: "buildrax", version: "0", languages: [] },
    nodes: [{ id: "project:r", kind: "project", name: "r", evidence: ev }, ...nodes],
    edges,
  }) as unknown as Model;

describe("diffModels", () => {
  const before = model([file("a.ts"), file("b.ts"), file("old.ts")], [imp("a.ts", "b.ts")]);

  it("reports nothing when only line numbers moved", () => {
    const after = model(
      [file("a.ts", 99), file("b.ts"), file("old.ts")],
      [imp("a.ts", "b.ts", 42)],
    );
    expect(diffModels(before, after).same).toBe(true);
  });

  it("reports added/removed nodes and links, and new cycles", () => {
    const after = model(
      [file("a.ts"), file("b.ts"), file("c.ts")],
      [imp("a.ts", "b.ts"), imp("b.ts", "a.ts")],
    );
    const d = diffModels(before, after);
    expect(d.nodes.added.map((n) => n.id)).toEqual(["file:c.ts"]);
    expect(d.nodes.removed.map((n) => n.id)).toEqual(["file:old.ts"]);
    expect(d.edges.added.map((e) => e.id)).toEqual(["file:b.ts->imports->file:a.ts"]);
    expect(d.cycles.introduced).toHaveLength(1);
    expect(diffModels(after, before).cycles.resolved).toHaveLength(1);
    expect(d.same).toBe(false);
  });

  it("reports changed declared facts, e.g. a database class", () => {
    const db = (cls: string) => ({
      id: "database:postgres",
      kind: "database" as const,
      name: "PostgreSQL",
      parent: "project:r",
      evidence: ev,
      meta: { infra: true, instanceType: cls },
    });
    const d = diffModels(model([db("db.t4g.small")], []), model([db("db.m7g.large")], []));
    expect(d.nodes.changed).toEqual([
      {
        id: "database:postgres",
        kind: "database",
        name: "PostgreSQL",
        changes: ['instanceType: "db.t4g.small" → "db.m7g.large"'],
      },
    ]);
  });
});
