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

import {
  emptyNotes,
  reconcileNotes,
  validateNotes,
  validateResearch,
  type Note,
} from "../src/index.js";

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1",
  target: { type: "node", id: "file:a.ts" },
  type: "flag",
  color: "red",
  body: "remember this",
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

describe("notes schema", () => {
  it("accepts a valid file and rejects duplicates and long bodies", () => {
    expect(validateNotes({ ...emptyNotes(), notes: [note()] }).ok).toBe(true);
    expect(validateNotes({ ...emptyNotes(), notes: [note(), note()] }).errors.join()).toContain(
      "duplicate id",
    );
    expect(validateNotes({ ...emptyNotes(), notes: [note({ body: "x".repeat(4001) })] }).ok).toBe(
      false,
    );
    expect(validateNotes({ schemaVersion: "nope", notes: [] }).ok).toBe(false);
  });
});

describe("reconcileNotes", () => {
  const m = base();
  it("attaches, relocates by snapshot, and orphans without deleting", () => {
    const attached = note();
    const moved = note({
      id: "n2",
      target: { type: "node", id: "file:old.ts" },
      snapshot: { kind: "file", name: "b.ts", path: "b.ts" },
    });
    const lost = note({ id: "n3", target: { type: "node", id: "file:gone.ts" } });
    const edge = note({ id: "n4", target: { type: "edge", id: "file:a.ts=>file:b.ts" } });
    const r = reconcileNotes([attached, moved, lost, edge], m);
    expect(r.attached.map((n) => n.id)).toEqual(["n1", "n4"]);
    expect(r.relocated).toEqual([{ note: moved, to: "file:b.ts" }]);
    expect(r.orphaned.map((n) => n.id)).toEqual(["n3"]);
  });
});

describe("research schema", () => {
  it("requires a valid url and keeps errors explicit", () => {
    const ok = {
      schemaVersion: "buildrax-research/v1",
      generatedAt: "t",
      findings: [
        {
          id: "f1",
          nodeId: "external:express",
          subject: "express",
          finding: "latest is 5.0.0",
          sourceUrl: "https://registry.npmjs.org/express/latest",
          publisher: "npm registry",
          retrievedAt: "t",
          evidenceType: "registry-metadata",
          reliability: "high",
        },
      ],
      errors: [],
    };
    expect(validateResearch(ok).ok).toBe(true);
    ok.findings[0]!.sourceUrl = "not a url";
    expect(validateResearch(ok).ok).toBe(false);
  });
});

import { INFRA_KINDS, IR_SCHEMA_VERSION } from "../src/index.js";

describe("schema versions", () => {
  it("writes v3 but still reads v1 and v2 models", () => {
    expect(IR_SCHEMA_VERSION).toBe("buildrax-ir/v3");
    expect(validateModel({ ...base(), schemaVersion: "buildrax-ir/v1" }).ok).toBe(true);
    expect(validateModel({ ...base(), schemaVersion: "buildrax-ir/v2" }).ok).toBe(true);
    expect(validateModel({ ...base(), schemaVersion: "buildrax-ir/v3" }).ok).toBe(true);
    expect(validateModel({ ...base(), schemaVersion: "buildrax-ir/v4" }).ok).toBe(false);
  });
  it("accepts entity nodes and `relates` edges (v3)", () => {
    const m = base();
    m.nodes.push(
      {
        id: "entity:s.prisma:A",
        kind: "entity",
        name: "A",
        evidence: [{ kind: "verified", file: "s.prisma", startLine: 1 }],
      },
      {
        id: "entity:s.prisma:B",
        kind: "entity",
        name: "B",
        evidence: [{ kind: "verified", file: "s.prisma", startLine: 5 }],
      },
    );
    m.edges.push({
      id: "entity:s.prisma:A->relates->entity:s.prisma:B",
      from: "entity:s.prisma:A",
      to: "entity:s.prisma:B",
      kind: "relates",
      evidence: [{ kind: "verified", file: "s.prisma", startLine: 3 }],
    });
    expect(validateModel(m)).toMatchObject({ ok: true });
  });
  it("accepts infrastructure nodes and `uses` edges", () => {
    const m = base();
    m.schemaVersion = "buildrax-ir/v2";
    m.nodes.push({
      id: "database:postgres",
      kind: "database",
      name: "PostgreSQL",
      parent: "project:r",
      evidence: [{ kind: "config", file: "docker-compose.yml", startLine: 4 }],
      meta: { engine: "postgres", version: "16" },
    });
    m.edges.push({
      id: "file:a.ts->uses->database:postgres",
      from: "file:a.ts",
      to: "database:postgres",
      kind: "uses",
      evidence: [{ kind: "verified", file: "a.ts", startLine: 1 }],
    });
    expect(validateModel(m)).toMatchObject({ ok: true });
    expect(INFRA_KINDS).toContain("cache");
  });
});
