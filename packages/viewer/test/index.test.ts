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
