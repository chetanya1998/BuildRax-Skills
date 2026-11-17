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

import { tokenizeFile, tokenizeLine } from "../app/highlight.js";
import { connectionsFor, excerptRange } from "../app/code-logic.js";
import { EmbeddedSource, NoSource, ServerSource, createCodeSource } from "../app/code-source.js";

describe("highlighter", () => {
  const kinds = (line: string, lang = "typescript") =>
    tokenizeLine(line, lang).toks.map((t) => `${t.k}:${t.v}`);
  it("tokenizes keywords, strings, numbers and comments", () => {
    expect(kinds('import x from "./a"; // hi')).toEqual([
      "kw:import",
      "plain: x ",
      "kw:from",
      "plain: ",
      'str:"./a"',
      "plain:; ",
      "com://" + " hi",
    ]);
    expect(kinds("const n = 42;")).toContain("num:42");
  });
  it("keeps block comments and python docstrings across lines", () => {
    const ts = tokenizeFile("/* a\nb */ const x", "typescript");
    expect(ts[0]!.every((t) => t.k === "com")).toBe(true);
    expect(ts[1]![0]).toEqual({ k: "com", v: "b */" });
    const py = tokenizeFile('"""doc\nmore"""\nimport os  # c', "python");
    expect(py[1]!.every((t) => t.k === "str")).toBe(true);
    expect(py[2]!.some((t) => t.k === "kw" && t.v === "import")).toBe(true);
    expect(py[2]!.some((t) => t.k === "com")).toBe(true);
  });
  it("never loses characters and handles unterminated strings", () => {
    for (const line of ['a = "unterminated', "x = 'it\\'s'", "`tpl ${a}`", ""]) {
      expect(
        tokenizeLine(line, "javascript")
          .toks.map((t) => t.v)
          .join(""),
      ).toBe(line);
    }
  });
});

describe("connectionsFor", () => {
  const ev = (file: string, line: number) => [{ kind: "verified" as const, file, startLine: line }];
  const mk = (id: string, kind: "file" | "module" | "external", parent?: string) => ({
    id,
    kind,
    name: id,
    parent,
    evidence: [{ kind: "verified" as const }],
  });
  const idx = new GraphIndex({
    schemaVersion: "buildrax-ir/v1",
    meta: {
      repo: "r",
      scannedAt: "t",
      generator: { name: "buildrax", version: "0" },
      languages: [],
    },
    nodes: [
      mk("project:r", "module"),
      mk("module:m", "module", "project:r"),
      mk("file:a", "file", "module:m"),
      mk("file:b", "file", "module:m"),
      mk("file:c", "file", "project:r"),
      mk("external:lib", "external", "project:r"),
    ],
    edges: [
      { id: "1", from: "file:a", to: "file:b", kind: "imports", evidence: ev("a", 1) },
      { id: "2", from: "file:a", to: "external:lib", kind: "depends-on", evidence: ev("a", 2) },
      { id: "3", from: "file:c", to: "file:a", kind: "imports", evidence: ev("c", 7) },
    ],
  });
  it("splits a file's connections into used and used-by, with source anchors", () => {
    const c = connectionsFor(idx, "file:a");
    expect(c.down.map((l) => l.other)).toEqual(["external:lib", "file:b"]);
    expect(c.up).toEqual([
      { other: "file:c", count: 1, evidence: [{ kind: "verified", file: "c", startLine: 7 }] },
    ]);
  });
  it("covers everything inside a container and ignores internal links", () => {
    const c = connectionsFor(idx, "module:m");
    expect(c.files).toEqual(["file:a", "file:b"]);
    expect(c.down.map((l) => l.other)).toEqual(["external:lib"]);
    expect(c.up.map((l) => l.other)).toEqual(["file:c"]);
    expect(connectionsFor(idx, "nope")).toEqual({ files: [], down: [], up: [] });
  });
  it("clamps excerpts to the file", () => {
    expect(excerptRange(10, 1, 3)).toEqual({ start: 1, end: 4 });
    expect(excerptRange(10, 10, 3)).toEqual({ start: 7, end: 10 });
  });
});

describe("code sources", () => {
  it("embedded source answers only for embedded paths (no prototype leaks)", async () => {
    const s = new EmbeddedSource({ "a.ts": "x" });
    expect(await s.get("a.ts")).toBe("x");
    expect(await s.get("b.ts")).toBeUndefined();
    expect(await s.get("constructor")).toBeUndefined();
  });
  it("server source sends the token, encodes the path and caches", async () => {
    const calls: string[] = [];
    const s = new ServerSource("tok", async (url, init) => {
      calls.push(`${url}|${(init?.headers as Record<string, string>)["x-buildrax-token"]}`);
      return { ok: true, status: 200, json: async () => ({ text: "code" }) };
    });
    expect(await s.get("a b/c.ts")).toBe("code");
    await s.get("a b/c.ts");
    expect(calls).toEqual(["/api/file?path=a%20b%2Fc.ts|tok"]);
    const failing = new ServerSource("t", async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));
    expect(await failing.get("x")).toBeUndefined();
  });
  it("picks the right source from the page's data", () => {
    const f = async () => ({ ok: true, status: 200, json: async () => ({}) });
    expect(createCodeSource({ server: true, token: "t" }, undefined, f).mode).toBe("server");
    expect(createCodeSource(undefined, { "a.ts": "x" }, f).mode).toBe("embedded");
    expect(createCodeSource(undefined, undefined, f)).toBeInstanceOf(NoSource);
  });
});

import {
  edgeGeometry,
  easeInOutCubic,
  easeOutCubic,
  nodeBox,
  radiusFor,
  quadAt,
} from "../app/geometry.js";
import { ForceSim, type SimNode } from "../app/physics.js";
import { legendFor, packageHues, swatchFor, PACKAGE_HUES } from "../app/palette.js";

describe("geometry", () => {
  it("sizes orbs by files (containers) or connections (files) within bounds", () => {
    expect(radiusFor("module", 0, 0)).toBe(19);
    expect(radiusFor("module", 100, 0)).toBe(39);
    expect(radiusFor("file", 0, 0)).toBeLessThan(radiusFor("file", 50, 50));
    expect(radiusFor("file", 0, 1e9)).toBeLessThanOrEqual(21);
    expect(nodeBox(20, "a-very-long-file-name.ts").w).toBeGreaterThan(40);
  });
  it("eases from 0 to 1 and clamps", () => {
    for (const f of [easeOutCubic, easeInOutCubic]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      expect(f(2)).toBe(1);
      expect(f(-1)).toBe(0);
    }
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
  it("trims edges to the orb rims and bends opposite directions to opposite sides", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 0 };
    const ab = edgeGeometry(a, 20, b, 20, 1);
    const ba = edgeGeometry(b, 20, a, 20, 1);
    expect(Math.hypot(ab.start.x - a.x, ab.start.y - a.y)).toBeCloseTo(22, 5);
    expect(Math.hypot(ab.tip.x - b.x, ab.tip.y - b.y)).toBeCloseTo(23, 5);
    expect(Math.abs(ab.angle)).toBeLessThan(1);
    // A->B and B->A use the same side flag but travel in opposite directions, so they separate.
    expect(Math.sign(ab.ctrl.y)).toBe(-Math.sign(ba.ctrl.y));
    expect(quadAt({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }, 0.5)).toEqual({ x: 5, y: 2.5 });
    expect(edgeGeometry(a, 10, a, 10, 1).d).toContain("M");
  });
});

describe("force simulation", () => {
  const ring = (n: number): SimNode[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      x: Number.NaN,
      y: Number.NaN,
      vx: 0,
      vy: 0,
      r: 16,
    }));
  const chain = (n: number) =>
    Array.from({ length: n - 1 }, (_, i) => ({ a: `n${i}`, b: `n${i + 1}`, weight: 1 }));
  const dist = (a: SimNode, b: SimNode) => Math.hypot(a.x - b.x, a.y - b.y);

  it("is deterministic and settles", () => {
    const run = () => {
      const s = new ForceSim(ring(12), chain(12));
      const steps = s.settle(900);
      return {
        steps,
        pos: s.nodes.map((n) => [Math.round(n.x * 100) / 100, Math.round(n.y * 100) / 100]),
      };
    };
    const a = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(run()));
    expect(a.steps).toBeLessThan(900);
    expect(a.pos.flat().every(Number.isFinite)).toBe(true);
  });

  it("keeps linked nodes closer than unlinked ones and never overlaps orbs", () => {
    const s = new ForceSim(ring(10), chain(10));
    s.settle(900);
    const n = s.nodes;
    expect(dist(n[0]!, n[1]!)).toBeLessThan(dist(n[0]!, n[9]!));
    for (let i = 0; i < n.length; i++)
      for (let j = i + 1; j < n.length; j++)
        expect(dist(n[i]!, n[j]!)).toBeGreaterThan(n[i]!.r + n[j]!.r - 1);
  });

  it("holds pinned nodes in place and lets the rest react", () => {
    const s = new ForceSim(ring(6), chain(6));
    s.settle(900);
    const pin = s.node("n0")!;
    pin.pinned = true;
    pin.x = 500;
    pin.y = 0;
    const before = s.node("n1")!.x;
    s.reheat(0.8);
    s.settle(900);
    expect(pin.x).toBe(500);
    expect(s.node("n1")!.x).toBeGreaterThan(before + 50);
  });

  it("pulls group members together when clustering is on", () => {
    const mk = (cluster: number) => {
      const ns = ring(8).map((n, i) => ({ ...n, groups: [i % 2 ? "a" : "b"] }));
      const s = new ForceSim(ns, chain(8), { cluster });
      s.settle(900);
      const spread = (g: string) => {
        const m = s.nodes.filter((n) => n.groups?.[0] === g);
        const cx = m.reduce((t, n) => t + n.x, 0) / m.length;
        const cy = m.reduce((t, n) => t + n.y, 0) / m.length;
        return m.reduce((t, n) => t + Math.hypot(n.x - cx, n.y - cy), 0) / m.length;
      };
      return spread("a") + spread("b");
    };
    expect(mk(0.2)).toBeLessThan(mk(0));
  });

  it("ignores links to unknown nodes and handles empty graphs", () => {
    const s = new ForceSim(ring(2), [{ a: "n0", b: "ghost", weight: 1 }]);
    expect(() => s.settle(50)).not.toThrow();
    expect(new ForceSim([], []).settle(50)).toBeGreaterThan(0);
  });
});

describe("color coding", () => {
  const mkN = (
    id: string,
    kind: "file" | "module" | "external",
    parent?: string,
    extra: object = {},
  ) => ({ id, kind, name: id, parent, evidence: [{ kind: "verified" as const }], ...extra });
  const idx = new GraphIndex({
    schemaVersion: "buildrax-ir/v1",
    meta: {
      repo: "r",
      scannedAt: "t",
      generator: { name: "buildrax", version: "0" },
      languages: [],
    },
    nodes: [
      mkN("project:r", "module"),
      mkN("module:b", "module", "project:r", { meta: { package: true } }),
      mkN("module:a", "module", "project:r", { meta: { package: true } }),
      mkN("file:a/x", "file", "module:a", { language: "typescript" }),
      mkN("file:b/y", "file", "module:b", { language: "python" }),
      mkN("external:lib", "external", "project:r"),
    ],
    edges: [
      {
        id: "e",
        from: "file:a/x",
        to: "file:b/y",
        kind: "imports",
        evidence: [{ kind: "verified" }],
      },
    ],
  });
  const hues = packageHues(idx);
  const ctx = { index: idx, maxDegree: 2 };

  it("assigns distinct, stable hues per package regardless of order", () => {
    expect(hues.get("module:a")).toBe(PACKAGE_HUES[0]);
    expect(hues.get("module:b")).toBe(PACKAGE_HUES[1]);
    expect(swatchFor({ id: "file:a/x", kind: "file" }, "package", ctx, hues).hue).toBe(
      PACKAGE_HUES[0],
    );
    expect(swatchFor({ id: "file:b/y", kind: "file" }, "package", ctx, hues).hue).toBe(
      PACKAGE_HUES[1],
    );
  });
  it("colors by kind, language and connectivity", () => {
    expect(swatchFor({ id: "external:lib", kind: "external" }, "package", ctx, hues).label).toBe(
      "external dependency",
    );
    expect(
      swatchFor({ id: "file:a/x", kind: "file", language: "python" }, "language", ctx, hues).label,
    ).toBe("python");
    const cold = swatchFor({ id: "external:lib", kind: "external" }, "heat", ctx, hues);
    const hot = swatchFor({ id: "file:a/x", kind: "file" }, "heat", ctx, hues);
    expect(hot.hue).toBeGreaterThan(cold.hue);
    expect(hot.label).not.toBe(cold.label);
  });
  it("builds a legend with counts for what is on screen", () => {
    const nodes = idx.model.nodes.filter((n) => n.kind !== "module");
    const leg = legendFor(nodes, "package", ctx, hues);
    expect(leg.map((l) => l.label).sort()).toEqual(
      ["external dependency", "module:a", "module:b"].sort(),
    );
    expect(leg.reduce((t, l) => t + l.count, 0)).toBe(3);
  });
});

describe("heat legend", () => {
  it("never repeats a label and orders buckets from least to most connected", () => {
    const mk = (id: string, parent?: string) => ({
      id,
      kind: "file" as const,
      name: id,
      parent,
      evidence: [{ kind: "verified" as const }],
    });
    const nodes = [
      mk("project:r"),
      ...Array.from({ length: 12 }, (_, i) => mk(`file:f${i}`, "project:r")),
    ];
    const edges = Array.from({ length: 11 }, (_, i) => ({
      id: `e${i}`,
      from: "file:f0",
      to: `file:f${i + 1}`,
      kind: "imports" as const,
      evidence: [{ kind: "verified" as const }],
    }));
    const i2 = new GraphIndex({
      schemaVersion: "buildrax-ir/v1",
      meta: {
        repo: "r",
        scannedAt: "t",
        generator: { name: "buildrax", version: "0" },
        languages: [],
      },
      nodes,
      edges,
    });
    const leg = legendFor(nodes.slice(1), "heat", { index: i2, maxDegree: 11 }, new Map());
    expect(new Set(leg.map((l) => l.label)).size).toBe(leg.length);
    expect(leg[0]!.label).toBe("some links");
    expect(leg[leg.length - 1]!.label).toBe("hub");
  });
});

describe("box clustering", () => {
  const mk = (id: string, groups: string[]): SimNode => ({
    id,
    x: Number.NaN,
    y: Number.NaN,
    vx: 0,
    vy: 0,
    r: 18,
    groups,
  });
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const d = (a: SimNode, b: SimNode) => Math.hypot(a.x - b.x, a.y - b.y);

  it("separates unrelated services into distinct, non-overlapping regions", () => {
    const ns = [
      ...Array.from({ length: 6 }, (_, i) => mk(`a${i}`, ["A"])),
      ...Array.from({ length: 6 }, (_, i) => mk(`b${i}`, ["B"])),
    ];
    const s = new ForceSim(ns, [], { cluster: 0.08 });
    s.settle(900);
    const A = ns.filter((n) => n.groups![0] === "A");
    const B = ns.filter((n) => n.groups![0] === "B");
    const intra = mean(
      [
        ...A.flatMap((x) => A.map((y) => (x === y ? NaN : d(x, y)))),
        ...B.flatMap((x) => B.map((y) => (x === y ? NaN : d(x, y)))),
      ].filter(Number.isFinite),
    );
    const inter = mean(A.flatMap((x) => B.map((y) => d(x, y))));
    expect(intra / inter).toBeLessThan(0.7);
    // every A node is closer to its own box's centroid than to B's
    const c = (g: SimNode[]) => ({ x: mean(g.map((n) => n.x)), y: mean(g.map((n) => n.y)) });
    const ca = c(A),
      cb = c(B);
    for (const n of A)
      expect(Math.hypot(n.x - ca.x, n.y - ca.y)).toBeLessThan(Math.hypot(n.x - cb.x, n.y - cb.y));
  });

  it("nests: folders inside a service stay together, and the service stays together", () => {
    const ns = [
      ...Array.from({ length: 4 }, (_, i) => mk(`r${i}`, ["svc", "svc/routes"])),
      ...Array.from({ length: 4 }, (_, i) => mk(`s${i}`, ["svc", "svc/services"])),
      ...Array.from({ length: 4 }, (_, i) => mk(`w${i}`, ["worker", "worker/jobs"])),
    ];
    const s = new ForceSim(ns, [], { cluster: 0.08 });
    s.settle(1200);
    const grp = (f: (n: SimNode) => boolean) => ns.filter(f);
    const spread = (g: SimNode[]) =>
      mean(g.map((n) => Math.hypot(n.x - mean(g.map((m) => m.x)), n.y - mean(g.map((m) => m.y)))));
    const svc = grp((n) => n.groups![0] === "svc");
    const wk = grp((n) => n.groups![0] === "worker");
    const routes = grp((n) => n.groups![1] === "svc/routes");
    expect(spread(routes)).toBeLessThan(spread(svc));
    const cs = { x: mean(svc.map((n) => n.x)), y: mean(svc.map((n) => n.y)) };
    const cw = { x: mean(wk.map((n) => n.x)), y: mean(wk.map((n) => n.y)) };
    expect(Math.hypot(cs.x - cw.x, cs.y - cw.y)).toBeGreaterThan(spread(svc) + spread(wk));
  });

  it("is still deterministic with boxes", () => {
    const run = () => {
      const ns = Array.from({ length: 10 }, (_, i) => mk(`n${i}`, [i < 5 ? "A" : "B"]));
      new ForceSim(ns, [], { cluster: 0.08 }).settle(600);
      return JSON.stringify(ns.map((n) => [Math.round(n.x * 100), Math.round(n.y * 100)]));
    };
    expect(run()).toBe(run());
  });
});

import { buildGroups, groupPath, EXTERNAL_GROUP, UNRESOLVED_GROUP } from "../app/groups.js";
import { layoutView } from "../app/layout.js";
import { buildView } from "@buildrax/graph";

describe("code segmentation boxes", () => {
  const ev = [{ kind: "verified" as const }];
  const n = (
    id: string,
    kind: "project" | "module" | "file" | "external" | "unresolved",
    parent?: string,
    extra: object = {},
  ) => ({ id, kind, name: id.split(/[:/]/).pop()!, parent, evidence: ev, ...extra });
  const model = {
    schemaVersion: "buildrax-ir/v1" as const,
    meta: {
      repo: "r",
      scannedAt: "t",
      generator: { name: "buildrax" as const, version: "0" },
      languages: [],
    },
    nodes: [
      n("project:r", "project"),
      n("module:api", "module", "project:r", { meta: { package: true } }),
      n("module:api/routes", "module", "module:api"),
      n("module:api/services", "module", "module:api"),
      n("file:api/server.ts", "file", "module:api"),
      n("file:api/routes/a.ts", "file", "module:api/routes"),
      n("file:api/services/b.ts", "file", "module:api/services"),
      n("module:worker", "module", "project:r", { meta: { package: true } }),
      n("file:worker/w.ts", "file", "module:worker"),
      n("external:express", "external", "project:r"),
      n("external:zod", "external", "project:r"),
      n("unresolved:./x", "unresolved", "project:r"),
    ],
    edges: [
      {
        id: "1",
        from: "file:api/server.ts",
        to: "file:api/routes/a.ts",
        kind: "imports" as const,
        evidence: ev,
      },
      {
        id: "2",
        from: "file:api/routes/a.ts",
        to: "file:api/services/b.ts",
        kind: "imports" as const,
        evidence: ev,
      },
      {
        id: "3",
        from: "file:worker/w.ts",
        to: "external:zod",
        kind: "depends-on" as const,
        evidence: ev,
      },
    ],
  };
  const idx = new GraphIndex(model);
  const hue = (id: string) => (id.startsWith("module:api") ? 212 : 162);

  it("makes no boxes while everything is collapsed except dependency segments", () => {
    const g = buildGroups(idx, buildView(idx, { expanded: new Set() }), new Set(), hue);
    expect(g.specs.map((s) => s.id).sort()).toEqual([EXTERNAL_GROUP, UNRESOLVED_GROUP].sort());
  });

  it("nests service > folder boxes for expanded containers and assigns the innermost box", () => {
    const expanded = new Set(["module:api", "module:api/routes", "module:api/services"]);
    const g = buildGroups(idx, buildView(idx, { expanded }), expanded, hue);
    const byId = new Map(g.specs.map((s) => [s.id, s]));
    expect(byId.get("module:api")).toMatchObject({
      depth: 0,
      parent: undefined,
      sub: "3 files",
      label: "api",
      hue: 212,
      collapseId: "module:api",
    });
    expect(byId.get("module:api/routes")).toMatchObject({
      depth: 1,
      parent: "module:api",
      sub: "1 file",
    });
    expect(g.groupOf.get("file:api/routes/a.ts")).toBe("module:api/routes");
    expect(g.groupOf.get("file:api/server.ts")).toBe("module:api");
    expect(g.groupOf.get("module:worker")).toBeUndefined();
    expect(groupPath(g.specs, "module:api/routes")).toEqual(["module:api", "module:api/routes"]);
    expect(byId.get(EXTERNAL_GROUP)).toMatchObject({ kind: "external", sub: "2 packages" });
    expect(g.groupOf.get("external:zod")).toBe(EXTERNAL_GROUP);
  });

  it("lays out boxes as compound nodes so sibling boxes never overlap", async () => {
    const expanded = new Set([
      "module:api",
      "module:api/routes",
      "module:api/services",
      "module:worker",
    ]);
    const view = buildView(idx, { expanded });
    const groups = buildGroups(idx, view, expanded, hue);
    const radii = new Map(view.nodes.map((v) => [v.id, 18] as const));
    const pos = await layoutView(view, radii, groups);
    expect(pos.size).toBe(view.nodes.length);
    const bbox = (gid: string) => {
      const ids = view.nodes
        .filter((v) => {
          const path = groupPath(groups.specs, groups.groupOf.get(v.id));
          return path.includes(gid);
        })
        .map((v) => pos.get(v.id)!);
      return {
        x0: Math.min(...ids.map((p) => p.x)),
        x1: Math.max(...ids.map((p) => p.x)),
        y0: Math.min(...ids.map((p) => p.y)),
        y1: Math.max(...ids.map((p) => p.y)),
      };
    };
    const a = bbox("module:api");
    const w = bbox("module:worker");
    const overlap = a.x0 < w.x1 && w.x0 < a.x1 && a.y0 < w.y1 && w.y0 < a.y1;
    expect(overlap).toBe(false);
    // folder boxes inside a service do not overlap each other either
    const r = bbox("module:api/routes");
    const sv = bbox("module:api/services");
    expect(r.x0 < sv.x1 && sv.x0 < r.x1 && r.y0 < sv.y1 && sv.y0 < r.y1).toBe(false);
  });
});

describe("loose nodes versus boxes", () => {
  it("keeps nodes that belong to no box out of a box's region", () => {
    const box = Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      x: Number.NaN,
      y: Number.NaN,
      vx: 0,
      vy: 0,
      r: 18,
      groups: ["A"],
    }));
    const loose = Array.from({ length: 3 }, (_, i) => ({
      id: `f${i}`,
      x: Number.NaN,
      y: Number.NaN,
      vx: 0,
      vy: 0,
      r: 18,
      groups: [`free:f${i}`],
    }));
    // each loose node depends on box members, which would normally drag it inside
    const links = loose.flatMap((l, i) =>
      box.slice(i, i + 3).map((b) => ({ a: l.id, b: b.id, weight: 1 })),
    );
    const s = new ForceSim([...box, ...loose], links, { cluster: 0.11 });
    s.settle(1200);
    const cx = box.reduce((t, n) => t + n.x, 0) / box.length;
    const cy = box.reduce((t, n) => t + n.y, 0) / box.length;
    const radius = Math.max(...box.map((n) => Math.hypot(n.x - cx, n.y - cy) + n.r));
    for (const l of loose) expect(Math.hypot(l.x - cx, l.y - cy)).toBeGreaterThan(radius);
  });
});

import { boxRects } from "../app/physics.js";

describe("box rectangles never overlap after settling", () => {
  const mk = (id: string, groups: string[], r = 20): SimNode => ({
    id,
    x: Number.NaN,
    y: Number.NaN,
    vx: 0,
    vy: 0,
    r,
    groups,
  });
  it("keeps sibling boxes and loose nodes apart even with many cross-box links", () => {
    const ns: SimNode[] = [
      ...Array.from({ length: 14 }, (_, i) => mk(`v${i}`, ["V"])),
      ...Array.from({ length: 6 }, (_, i) => mk(`g${i}`, ["G"])),
      ...Array.from({ length: 8 }, (_, i) => mk(`i${i}`, ["I"])),
      ...Array.from({ length: 5 }, (_, i) => mk(`x${i}`, [`free:x${i}`], 30)),
    ];
    const links = ns.flatMap((n, i) => [
      { a: n.id, b: ns[(i * 5 + 7) % ns.length]!.id, weight: 1 },
      { a: n.id, b: ns[(i * 3 + 1) % ns.length]!.id, weight: 2 },
    ]);
    const sim = new ForceSim(ns, links, { cluster: 0.11 });
    sim.settle(1500);
    const rects = [...boxRects(ns).entries()].filter(([, b]) => b.parent === "");
    expect(rects.length).toBe(8);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]![1],
          c = rects[j]![1];
        const overlap = a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1;
        expect(overlap, `${rects[i]![0]} vs ${rects[j]![0]}`).toBe(false);
      }
    }
  });

  it("keeps nested boxes inside their parent and siblings apart", () => {
    const ns = [
      ...Array.from({ length: 4 }, (_, i) => mk(`r${i}`, ["S", "S/r"])),
      ...Array.from({ length: 4 }, (_, i) => mk(`q${i}`, ["S", "S/q"])),
      ...Array.from({ length: 4 }, (_, i) => mk(`w${i}`, ["W"])),
    ];
    new ForceSim(ns, [], { cluster: 0.11 }).settle(1500);
    const r = boxRects(ns);
    const [S, Sr, Sq, W] = ["S", "S\u0000S/r", "S\u0000S/q", "W"].map((k) => r.get(k)!);
    const inside = (a: typeof S, b: typeof S) =>
      a!.x0 >= b!.x0 && a!.y0 >= b!.y0 && a!.x1 <= b!.x1 && a!.y1 <= b!.y1;
    expect(inside(Sr, S) && inside(Sq, S)).toBe(true);
    expect(Sr!.x0 < Sq!.x1 && Sq!.x0 < Sr!.x1 && Sr!.y0 < Sq!.y1 && Sq!.y0 < Sr!.y1).toBe(false);
    expect(S!.x0 < W!.x1 && W!.x0 < S!.x1 && S!.y0 < W!.y1 && W!.y0 < S!.y1).toBe(false);
  });
});

describe("box sizing rules", () => {
  const one = (id: string, groups: string[]): SimNode => ({
    id,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: 10,
    groups,
  });
  it("never makes a box narrower than its header tab", () => {
    const r = boxRects([one("a", ["A"])], new Map([["A", 300]])).get("A")!;
    expect(r.x1 - r.x0).toBeGreaterThanOrEqual(300);
    expect((r.x0 + r.x1) / 2).toBeCloseTo(0);
  });
  it("reserves header room for real boxes but not for loose one-node segments", () => {
    const rects = boxRects([one("a", ["A"]), one("b", ["A", "free:b"])]);
    const box = rects.get("A")!;
    const loose = rects.get("A\u0000free:b")!;
    expect(-box.y0).toBeGreaterThan(40);
    expect(-loose.y0).toBeLessThan(20);
  });
});

describe("nested boxes enclose children even when a child grows to fit its tab", () => {
  it("parent contains a widened child", () => {
    const n = (id: string, groups: string[]): SimNode => ({
      id,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: 10,
      groups,
    });
    const rects = boxRects(
      [n("a", ["P", "P/c"]), n("b", ["P", "P/c"])],
      new Map([["P\u0000P/c", 400]]),
    );
    const p = rects.get("P")!;
    const c = rects.get("P\u0000P/c")!;
    expect(c.x1 - c.x0).toBeGreaterThanOrEqual(400);
    expect(c.x0 >= p.x0 && c.x1 <= p.x1 && c.y0 >= p.y0 && c.y1 <= p.y1).toBe(true);
    expect(c.y0 - p.y0).toBeGreaterThanOrEqual(40);
  });
});

import {
  DEFAULT_PANELS,
  MIN_FLOAT,
  clampFloat,
  parsePanelPrefs,
  toggled,
} from "../app/panel-prefs.js";

describe("panel preferences", () => {
  it("falls back to defaults for missing, corrupt or partly invalid data", () => {
    expect(parsePanelPrefs(null)).toEqual(DEFAULT_PANELS);
    expect(parsePanelPrefs("{nope")).toEqual(DEFAULT_PANELS);
    const p = parsePanelPrefs(
      JSON.stringify({
        left: "floating",
        right: "sideways",
        minimap: "yes",
        leftFloat: { x: 5, y: 6, w: 300, h: 300 },
      }),
    );
    expect(p.left).toBe("floating");
    expect(p.right).toBe("docked");
    expect(p.minimap).toBe(true);
    expect(p.leftFloat).toEqual({ x: 5, y: 6, w: 300, h: 300 });
  });
  it("does not let callers mutate the defaults", () => {
    const p = parsePanelPrefs(null);
    p.leftFloat.w = 999;
    expect(DEFAULT_PANELS.leftFloat.w).toBe(260);
  });
  it("keeps floating windows inside the area and above a minimum size", () => {
    const area = { w: 1000, h: 700 };
    expect(clampFloat({ x: 5000, y: -50, w: 300, h: 300 }, area, "left")).toEqual({
      x: 692,
      y: 8,
      w: 300,
      h: 300,
    });
    const tiny = clampFloat({ x: 10, y: 10, w: 20, h: 20 }, area, "left");
    expect([tiny.w, tiny.h]).toEqual([MIN_FLOAT.w, MIN_FLOAT.h]);
    const huge = clampFloat({ x: 0, y: 0, w: 5000, h: 5000 }, area, "right");
    expect(huge.w).toBeLessThanOrEqual(area.w - 16);
    expect(huge.h).toBeLessThanOrEqual(area.h - 16);
  });
  it("places a never-moved window at its own side", () => {
    const area = { w: 1000, h: 700 };
    expect(clampFloat({ x: -1, y: 16, w: 300, h: 400 }, area, "left").x).toBe(16);
    expect(clampFloat({ x: -1, y: 16, w: 300, h: 400 }, area, "right").x).toBe(1000 - 300 - 16);
  });
  it("toggles between hidden and the last visible mode", () => {
    expect(toggled("docked", "docked")).toBe("collapsed");
    expect(toggled("floating", "floating")).toBe("collapsed");
    expect(toggled("collapsed", "floating")).toBe("floating");
  });
});

import { NODE_VIEW_COLUMN_GAP, focusView, nodeViewLayout } from "../app/node-view.js";

describe("node view", () => {
  const ve = (from: string, to: string) => ({
    id: `${from}=>${to}`,
    from,
    to,
    count: 1,
    kinds: ["imports" as const],
    evidence: [],
    inCycle: false,
  });
  const vn = (id: string) => ({
    id,
    kind: "file" as const,
    name: id,
    expandable: false,
    fileCount: 0,
    inCycle: false,
  });
  // u2 -> u1 -> F -> d1 -> d2 ; F -> d1b ; x -> y (unrelated)
  const view = {
    nodes: ["u2", "u1", "F", "d1", "d1b", "d2", "x", "y"].map(vn),
    edges: [
      ve("u2", "u1"),
      ve("u1", "F"),
      ve("F", "d1"),
      ve("F", "d1b"),
      ve("d1", "d2"),
      ve("x", "y"),
    ],
  };

  it("lineage records hop distance", () => {
    const l = computeLineage(view, "F", 0);
    expect([l.dist.get("F"), l.dist.get("u1"), l.dist.get("u2"), l.dist.get("d2")]).toEqual([
      0, 1, 2, 2,
    ]);
  });

  it("keeps only the focused neighbourhood, respecting depth", () => {
    const all = focusView(view, computeLineage(view, "F", 0));
    expect(all.nodes.map((n) => n.id).sort()).toEqual(["F", "d1", "d1b", "d2", "u1", "u2"]);
    expect(all.edges.some((e) => e.from === "x")).toBe(false);
    const one = focusView(view, computeLineage(view, "F", 1));
    expect(one.nodes.map((n) => n.id).sort()).toEqual(["F", "d1", "d1b", "u1"]);
  });

  it("puts the focus in the middle, dependents left and dependencies right, by hops", () => {
    const l = computeLineage(view, "F", 0);
    const fv = focusView(view, l);
    const pos = nodeViewLayout(fv, l, new Map());
    expect(pos.get("F")).toEqual({ x: 0, y: 0 });
    expect(pos.get("u1")!.x).toBe(-NODE_VIEW_COLUMN_GAP);
    expect(pos.get("u2")!.x).toBe(-2 * NODE_VIEW_COLUMN_GAP);
    expect(pos.get("d1")!.x).toBe(NODE_VIEW_COLUMN_GAP);
    expect(pos.get("d2")!.x).toBe(2 * NODE_VIEW_COLUMN_GAP);
    // two nodes in the same column never overlap
    const a = pos.get("d1")!,
      b = pos.get("d1b")!;
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(2 * 16 + 48);
    expect(pos.has("x")).toBe(false);
  });

  it("round-trips the focus in the URL state", () => {
    const st = { ...DEFAULT_STATE, focus: "file:a.ts" };
    expect(decodeState(`#${encodeState(st)}`).focus).toBe("file:a.ts");
    expect(decodeState(`#${encodeState(DEFAULT_STATE)}`).focus).toBeUndefined();
  });
});
