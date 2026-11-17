import { describe, expect, it } from "vitest";
import type { GraphView } from "@buildrax/graph";
import type { Model } from "@buildrax/ir";
import { injectModel } from "../src/index.js";
import { computeLineage } from "../app/lineage.js";
import { DEFAULT_STATE, decodeState, encodeState } from "../app/state-url.js";

const ve = (from: string, to: string) => ({
  id: `${from}=>${to}`,
  from,
  to,
  count: 1,
  kinds: ["imports" as const],
  evidence: [],
  inCycle: false,
});
const view: GraphView = {
  nodes: [],
  edges: [ve("a", "b"), ve("b", "c"), ve("c", "d"), ve("x", "b")],
};

describe("lineage", () => {
  it("classifies upstream and downstream, honoring depth", () => {
    const l = computeLineage(view, "b", 1);
    expect(l.roles.get("c")).toBe("downstream");
    expect(l.roles.get("a")).toBe("upstream");
    expect(l.roles.get("x")).toBe("upstream");
    expect(l.roles.has("d")).toBe(false);
    expect(computeLineage(view, "b", 0).roles.get("d")).toBe("downstream");
    expect(l.edges.get("a=>b")).toBe("upstream");
  });
});

describe("state url", () => {
  it("round-trips state and survives garbage", () => {
    const s = {
      ...DEFAULT_STATE,
      expanded: ["module:a"],
      depth: 2,
      selected: { type: "node" as const, id: "file:x" },
    };
    expect(decodeState(`#${encodeState(s)}`)).toEqual(s);
    expect(decodeState("#%%%not-json")).toEqual(DEFAULT_STATE);
    expect(decodeState("")).toEqual(DEFAULT_STATE);
  });
});

describe("injectModel", () => {
  const html = '<body><script id="buildrax-data" type="application/json"></script></body>';
  const model = {
    schemaVersion: "buildrax-ir/v1",
    meta: {
      repo: "</script><b>",
      scannedAt: "t",
      generator: { name: "buildrax", version: "0" },
      languages: [],
    },
    nodes: [],
    edges: [],
  } as Model;
  it("embeds JSON and never lets repo text close the script tag", () => {
    const out = injectModel(html, model);
    expect(out).not.toContain("</script><b>");
    const json = /<script id="buildrax-data"[^>]*>([\s\S]*?)<\/script>/.exec(out)![1]!;
    expect(JSON.parse(json).meta.repo).toBe("</script><b>");
  });
  it("throws when the template has no data tag", () => {
    expect(() => injectModel("<html></html>", model)).toThrow();
  });
});

import { GraphIndex } from "@buildrax/graph";
import { LocalStorageStore, ServerStore } from "../app/notes-store.js";
import { parseBlocks, parseInline } from "../app/markdown.js";
import { edgeBadges, nodeBadges } from "../app/notes-logic.js";
import type { Note } from "@buildrax/ir";

describe("markdown subset", () => {
  it("parses inline styles and only http(s) links", () => {
    expect(parseInline("a **b** *c* `d` [e](https://x.io/p)")).toEqual([
      { t: "text", v: "a " },
      { t: "bold", v: "b" },
      { t: "text", v: " " },
      { t: "italic", v: "c" },
      { t: "text", v: " " },
      { t: "code", v: "d" },
      { t: "text", v: " " },
      { t: "link", v: "e", href: "https://x.io/p" },
    ]);
    const evil = parseInline("[x](javascript:alert(1)) <img src=x onerror=alert(1)>");
    expect(evil.every((p) => p.t === "text")).toBe(true);
  });
  it("groups list items", () => {
    expect(parseBlocks("hi\n- a\n- b\nbye").map((b) => b.t)).toEqual(["p", "ul", "p"]);
  });
});

describe("notes store", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      m,
    };
  };
  const input = {
    target: { type: "node" as const, id: "file:a" },
    type: "flag" as const,
    color: "red" as const,
    body: "b",
  };

  it("persists to storage, notifies, and survives reload", () => {
    const st = memory();
    const a = new LocalStorageStore("k", [], st);
    let calls = 0;
    a.subscribe(() => calls++);
    const n = a.create(input);
    a.update(n.id, { resolved: true });
    expect(calls).toBe(2);
    const b = new LocalStorageStore("k", [], st);
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0]).toMatchObject({ resolved: true, body: "b" });
    b.delete(n.id);
    expect(new LocalStorageStore("k", [], st).list()).toHaveLength(0);
  });
  it("seeds from embedded notes and tolerates blocked or corrupt storage", () => {
    const seed: Note[] = [{ id: "s", ...input, createdAt: "t", updatedAt: "t" }];
    expect(new LocalStorageStore("k", seed, undefined).list()).toHaveLength(1);
    const bad = memory();
    bad.setItem("k", "{not json");
    expect(new LocalStorageStore("k", seed, bad).list()).toHaveLength(1);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const s = new LocalStorageStore("k", seed, throwing);
    expect(() => s.create(input)).not.toThrow();
  });
  it("merges imports by id", () => {
    const s = new LocalStorageStore("k", [], undefined);
    const n = s.create(input);
    s.merge([
      { ...n, body: "changed" },
      { ...n, id: "other" },
    ]);
    expect(s.list().map((x) => x.body)).toEqual(["changed", "b"]);
  });
  it("server store loads and saves through the api with a token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const store = new ServerStore("tok", async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: "buildrax-notes/v1", notes: [] }),
      };
    });
    await store.init();
    store.create(input);
    expect(calls[0]!.url).toBe("/api/notes");
    expect(calls[1]!.init?.method).toBe("PUT");
    expect((calls[1]!.init?.headers as Record<string, string>)["x-buildrax-token"]).toBe("tok");
  });
  it("reports server failures instead of silently dropping notes", async () => {
    const errors: string[] = [];
    const store = new ServerStore(
      "t",
      async () => ({ ok: false, status: 403, json: async () => ({}) }),
      (m) => errors.push(m),
    );
    await store.init();
    store.create(input);
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.length).toBe(2);
    expect(store.list()).toHaveLength(1);
  });
});

describe("badges", () => {
  const idx = new GraphIndex({
    schemaVersion: "buildrax-ir/v1",
    meta: {
      repo: "r",
      scannedAt: "t",
      generator: { name: "buildrax", version: "0" },
      languages: [],
    },
    nodes: [
      { id: "project:r", kind: "project", name: "r", evidence: [{ kind: "config" }] },
      {
        id: "module:m",
        kind: "module",
        name: "m",
        parent: "project:r",
        evidence: [{ kind: "config" }],
      },
      {
        id: "file:a",
        kind: "file",
        name: "a",
        parent: "module:m",
        evidence: [{ kind: "verified" }],
      },
    ],
    edges: [],
  });
  const mk = (over: Partial<Note>): Note => ({
    id: Math.random().toString(),
    target: { type: "node", id: "file:a" },
    type: "note",
    body: "",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  });
  it("rolls open notes up to ancestors, picks the most severe color, ignores resolved", () => {
    const b = nodeBadges(
      [
        mk({}),
        mk({ type: "flag", color: "red" }),
        mk({ resolved: true, type: "flag", color: "red" }),
      ],
      idx,
    );
    expect(b.get("file:a")).toEqual({ count: 2, color: "red" });
    expect(b.get("module:m")).toEqual({ count: 2, color: "red" });
    expect(b.has("project:r")).toBe(true);
  });
  it("counts edge notes separately", () => {
    const e = edgeBadges([mk({ target: { type: "edge", id: "a=>b" }, type: "todo" })]);
    expect(e.get("a=>b")).toEqual({ count: 1, color: "todo" });
  });
});

import { findingsFor, parseResearch, safeHref } from "../app/research-ui.js";

describe("research ui logic", () => {
  const idx = new GraphIndex({
    schemaVersion: "buildrax-ir/v1",
    meta: {
      repo: "r",
      scannedAt: "t",
      generator: { name: "buildrax", version: "0" },
      languages: [],
    },
    nodes: [
      { id: "project:r", kind: "project", name: "r", evidence: [{ kind: "config" }] },
      {
        id: "module:m",
        kind: "module",
        name: "m",
        parent: "project:r",
        evidence: [{ kind: "config" }],
      },
      {
        id: "file:a",
        kind: "file",
        name: "a",
        parent: "module:m",
        evidence: [{ kind: "verified" }],
      },
      {
        id: "external:lib",
        kind: "external",
        name: "lib",
        parent: "project:r",
        evidence: [{ kind: "verified" }],
      },
      {
        id: "external:other",
        kind: "external",
        name: "other",
        parent: "project:r",
        evidence: [{ kind: "verified" }],
      },
    ],
    edges: [
      {
        id: "e",
        from: "file:a",
        to: "external:lib",
        kind: "depends-on",
        evidence: [{ kind: "verified" }],
      },
    ],
  });
  const file = parseResearch({
    schemaVersion: "buildrax-research/v1",
    generatedAt: "2026-01-01T00:00:00Z",
    findings: ["lib", "other"].map((n) => ({
      id: `f-${n}`,
      nodeId: `external:${n}`,
      subject: n,
      finding: "x",
      sourceUrl: "https://registry.npmjs.org/x",
      publisher: "npm",
      retrievedAt: "t",
      evidenceType: "registry-metadata",
      reliability: "high",
    })),
    errors: [],
  });
  it("shows a container the findings of dependencies used inside it, and nothing else", () => {
    expect(findingsFor(file, idx, "module:m").map((f) => f.subject)).toEqual(["lib"]);
    expect(findingsFor(file, idx, "external:other").map((f) => f.subject)).toEqual(["other"]);
    expect(findingsFor(undefined, idx, "module:m")).toEqual([]);
  });
  it("only links http(s) and rejects malformed research files", () => {
    expect(safeHref("https://x.io/a")).toBe("https://x.io/a");
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("not a url")).toBeUndefined();
    expect(parseResearch({ schemaVersion: "x" })).toBeUndefined();
  });
});
