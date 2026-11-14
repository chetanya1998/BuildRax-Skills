import { describe, expect, it } from "vitest";
import { edgeId, nodeId, slug, validateModel, type Model } from "../src/index.js";

const ev = [{ kind: "verified" as const, file: "a.ts", startLine: 1 }];
const base = (): Model => ({
  schemaVersion: "buildrax-ir/v1",
  meta: { repo: "r", scannedAt: "t", generator: { name: "buildrax", version: "0" }, languages: [] },
  nodes: [
    { id: "project:r", kind: "project", name: "r", evidence: [{ kind: "config" }] },
    { id: "file:a.ts", kind: "file", name: "a.ts", parent: "project:r", evidence: ev },
    { id: "file:b.ts", kind: "file", name: "b.ts", parent: "project:r", evidence: ev },
  ],
  edges: [
    {
      id: edgeId("file:a.ts", "imports", "file:b.ts"),
      from: "file:a.ts",
      to: "file:b.ts",
      kind: "imports",
      evidence: ev,
    },
  ],
});

describe("ids", () => {
  it("slugs deterministically", () => {
    expect(slug("Orders API")).toBe("orders-api");
    expect(slug("  --Hello__World!! ")).toBe("hello-world");
  });
  it("builds node and edge ids", () => {
    expect(nodeId("file", "src/a.ts")).toBe("file:src/a.ts");
    expect(edgeId("file:a", "imports", "file:b")).toBe("file:a->imports->file:b");
  });
});

describe("validateModel", () => {
  it("accepts a valid model", () => {
    expect(validateModel(base())).toMatchObject({ ok: true, errors: [] });
  });
  it("rejects a wrong schema version", () => {
    const m = { ...base(), schemaVersion: "v0" };
    expect(validateModel(m).ok).toBe(false);
  });
  it("rejects duplicate node ids", () => {
    const m = base();
    m.nodes.push({ ...m.nodes[1]! });
    expect(validateModel(m).errors.join()).toContain('duplicate id "file:a.ts"');
  });
  it("rejects dangling edges and parents", () => {
    const m = base();
    m.edges.push({ id: "x", from: "file:a.ts", to: "file:nope", kind: "imports", evidence: ev });
    m.nodes.push({ id: "file:c.ts", kind: "file", name: "c", parent: "missing", evidence: ev });
    const errors = validateModel(m).errors.join("\n");
    expect(errors).toContain('to "file:nope" does not exist');
    expect(errors).toContain('parent "missing" does not exist');
  });
  it("requires evidence on nodes and edges", () => {
    const m = base();
    m.nodes[1]!.evidence = [];
    expect(validateModel(m).ok).toBe(false);
  });
  it("detects parent cycles", () => {
    const m = base();
    m.nodes[1]!.parent = "file:b.ts";
    m.nodes[2]!.parent = "file:a.ts";
    expect(validateModel(m).errors.join()).toContain("parent chain contains a cycle");
  });
});
