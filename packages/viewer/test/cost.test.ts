import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MINIMAL_STACK, estimate, type PriceBook } from "@buildrax/cost";
import { GraphIndex, buildView } from "@buildrax/graph";
import type { Model } from "@buildrax/ir";
import { cliCommand, parseCost, recompute, usd, usersLabel } from "../app/cost-ui.js";
import { INFRA_GROUP, buildGroups } from "../app/groups.js";
import { injectModel } from "../src/index.js";

const prices: PriceBook = JSON.parse(
  readFileSync(
    new URL("../../cost/test/fixtures/aws-us-east-1.book.json", import.meta.url),
    "utf8",
  ),
);
const ev = [{ kind: "config" as const, file: "docker-compose.yml", startLine: 1 }];
const model = {
  schemaVersion: "buildrax-ir/v2",
  meta: {
    root: "app",
    generatedAt: "2026-11-24T00:00:00.000Z",
    tool: { name: "buildrax", version: "0" },
  },
  nodes: [
    { id: "project:app", kind: "project", name: "app", evidence: ev },
    {
      id: "database:postgres",
      kind: "database",
      name: "PostgreSQL",
      parent: "project:app",
      evidence: ev,
      meta: { infra: true },
    },
    {
      id: "cache:redis",
      kind: "cache",
      name: "Redis",
      parent: "project:app",
      evidence: ev,
      meta: { infra: true },
    },
    {
      id: "file:a.ts",
      kind: "file",
      name: "a.ts",
      parent: "project:app",
      path: "a.ts",
      evidence: ev,
    },
  ],
  edges: [],
} as unknown as Model;
const report = estimate({ mode: "product", stack: MINIMAL_STACK, prices });

describe("cost view data", () => {
  it("accepts only a well-formed embedded report", () => {
    expect(parseCost({ report, prices })?.report.tiers).toHaveLength(5);
    expect(parseCost(undefined)).toBeUndefined();
    expect(parseCost({ report: { ...report, schemaVersion: "nope" }, prices })).toBeUndefined();
    expect(parseCost({ report, prices: { records: "x" } })).toBeUndefined();
  });

  it("recomputes from edited assumptions with the same model as the CLI", () => {
    const data = parseCost({ report, prices })!;
    expect(recompute(data, model, {})).toBe(data.report);
    const busier = recompute(data, model, { requestsPerDau: 600 });
    expect(busier.tiers[4]!.total.expected).toBeGreaterThan(report.tiers[4]!.total.expected);
    expect(cliCommand(busier, { requestsPerDau: 600 })).toMatch(
      /^buildrax cost --mode product --stack region=us-east-1,.* --assume requestsPerDau=600$/,
    );
  });

  it("formats money and tiers compactly", () => {
    expect(usd(4.5)).toBe("$4.50");
    expect(usd(1234)).toBe("$1,234");
    expect(usd(12_340)).toBe("$12.3k");
    expect(usersLabel(1_000_000)).toBe("1M");
    expect(usersLabel(10_000)).toBe("10k");
  });

  it("is embedded as inert JSON (no markup injection)", () => {
    const tpl =
      '<script id="buildrax-data" type="application/json"></script><script id="buildrax-cost" type="application/json"></script>';
    const evil = {
      report: { ...report, disclaimer: "</script><script>alert(1)</script>" },
      prices,
    };
    const html = injectModel(tpl, model, { cost: evil });
    expect(html).not.toContain("</script><script>alert");
  });
});

describe("infrastructure segment", () => {
  it("groups detected infrastructure into one box", () => {
    const index = new GraphIndex(model);
    const view = buildView(index, { expanded: new Set(), hideKinds: new Set() });
    const g = buildGroups(index, view, new Set(), () => 200);
    expect(g.specs.find((s) => s.id === INFRA_GROUP)).toMatchObject({
      label: "Infrastructure",
      kind: "infra",
    });
    expect(g.groupOf.get("database:postgres")).toBe(INFRA_GROUP);
    expect(g.groupOf.get("file:a.ts")).toBeUndefined();
  });
});

describe("live updates", () => {
  it("describes a rescan in plain words", async () => {
    const { describeChange } = await import("../app/live.js");
    expect(
      describeChange({ version: 2, added: 3, removed: 1, changed: 0, links: 1, cycles: 1 }),
    ).toBe("3 added, 1 removed, 1 link change, 1 new circular dependency");
    expect(
      describeChange({ version: 2, added: 0, removed: 0, changed: 0, links: 0, cycles: 0 }),
    ).toBe("updated");
  });
});
