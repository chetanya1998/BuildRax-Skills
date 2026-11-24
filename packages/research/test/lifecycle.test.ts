import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateResearch, type Model } from "@buildrax/ir";
import {
  endoflifeProvider,
  extractProducts,
  extractTechnologies,
  isSafeVersion,
  matchCycle,
  osvProvider,
  planResearch,
  runResearch,
  type FetchLike,
  type Technology,
} from "../src/index.js";

/** Real responses recorded from api.osv.dev and endoflife.date (2026-11-24). */
const fx = (f: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const NOW = "2026-11-24T00:00:00.000Z";
const ctx = { url: "", now: NOW };
const ev = [{ kind: "config" as const, file: "x", startLine: 1 }];
const model = {
  schemaVersion: "buildrax-ir/v2",
  meta: { repo: "r", scannedAt: NOW, tool: "buildrax", version: "0", languages: [] },
  nodes: [
    {
      id: "project:r",
      kind: "project",
      name: "r",
      evidence: ev,
      meta: {
        runtimes: [{ product: "nodejs", declared: ">=20", version: "20", file: "package.json" }],
      },
    },
    {
      id: "external:express",
      kind: "external",
      name: "express",
      evidence: ev,
      meta: { ecosystem: "npm", version: "4.17.1" },
    },
    {
      id: "external:lodash",
      kind: "external",
      name: "lodash",
      evidence: ev,
      meta: { ecosystem: "npm", versions: ["4.17.20", "4.17.21"] },
    },
    {
      id: "external:evil",
      kind: "external",
      name: "evil",
      evidence: ev,
      meta: { ecosystem: "npm", version: "1.0.0; curl x" },
    },
    {
      id: "database:postgres",
      kind: "database",
      name: "PostgreSQL",
      evidence: ev,
      meta: { infra: true, engine: "postgres", version: "16.3" },
    },
    {
      id: "cache:redis",
      kind: "cache",
      name: "Redis",
      evidence: ev,
      meta: { infra: true, engine: "redis", version: "7" },
    },
    {
      id: "compute:api",
      kind: "compute",
      name: "api",
      evidence: ev,
      meta: { infra: true, runtime: "node:22-alpine" },
    },
  ],
  edges: [],
} as unknown as Model;

describe("technologies with versions", () => {
  it("one entry per locked version; registry facts only once; unsafe versions never sent", () => {
    const t = extractTechnologies(model);
    expect(t.filter((x) => x.name === "lodash").map((x) => [x.version, x.primary])).toEqual([
      ["4.17.20", true],
      ["4.17.21", false],
    ]);
    expect(t.find((x) => x.name === "evil")?.version).toBeUndefined();
    expect(isSafeVersion("1.0.0-rc.1")).toBe(true);
    expect(isSafeVersion("1.0 && rm")).toBe(false);
  });

  it("products come from fixed tables: runtimes, databases, images, frameworks", () => {
    expect(extractProducts(model).map((p) => `${p.name}@${p.version}`)).toEqual([
      "express@4.17.1",
      "nodejs@20",
      "nodejs@22",
      "postgresql@16.3",
      "redis@7",
    ]);
  });

  it("the plan shows exactly what is sent: names and versions only", () => {
    const { requests } = planResearch(model);
    const osv = requests.filter((r) => r.provider === "osv");
    expect(osv.map((r) => r.body)).toContain(
      '{"package":{"name":"express","ecosystem":"npm"},"version":"4.17.1"}',
    );
    expect(
      requests.filter((r) => r.provider === "npm-registry" && r.subject === "lodash"),
    ).toHaveLength(1);
    expect(requests.filter((r) => r.provider === "endoflife").map((r) => r.url)).toContain(
      "https://endoflife.date/api/v1/products/nodejs/",
    );
    for (const r of requests)
      expect(`${r.url} ${r.body ?? ""}`).not.toMatch(/curl|project:r|package\.json/);
  });
});

describe("OSV advisories", () => {
  const express: Technology = {
    name: "express",
    ecosystem: "npm",
    nodeId: "external:express",
    usedBy: 1,
    version: "4.17.1",
  };

  it("turns advisories for the pinned version into findings with fixes", () => {
    const f = osvProvider.parse(express, fx("osv-express-4.17.1.json"), ctx);
    expect(f.length).toBeGreaterThan(1);
    const xss = f.find((x) => x.id.endsWith("GHSA-qw6h-vgh9-j6wx"))!;
    expect(xss).toMatchObject({
      evidenceType: "advisory",
      reliability: "high",
      applicableVersion: "4.17.1",
      sourceUrl: "https://osv.dev/vulnerability/GHSA-qw6h-vgh9-j6wx",
      recommendedAction: "Upgrade express to 4.20.0 or later.",
    });
    expect(xss.finding).toMatch(/CVE-2024-43796.*\[low\].*XSS/);
  });

  it("says when nothing is known, without claiming safety", () => {
    const [f] = osvProvider.parse(express, { vulns: [] }, ctx);
    expect(f).toMatchObject({
      reliability: "medium",
      reliabilityNote: expect.stringMatching(/not proof/),
    });
  });
});

describe("end-of-life dates", () => {
  const node = (version: string): Technology => ({
    name: "nodejs",
    ecosystem: "product",
    label: "Node.js",
    nodeId: "project:r",
    usedBy: 0,
    version,
  });

  it("matches the release line a version belongs to", () => {
    expect(matchCycle("16.3", ["17", "16", "15"]).cycle).toBe("16");
    expect(matchCycle("3.12.4", ["3.13", "3.12", "3.1"]).cycle).toBe("3.12");
    expect(matchCycle("7", ["7.4", "7.2"])).toEqual({ ambiguous: ["7.4", "7.2"] });
  });

  it("flags an end-of-life runtime and suggests a supported one", () => {
    const [f] = endoflifeProvider.parse(node("20"), fx("eol-nodejs.json"), ctx);
    expect(f).toMatchObject({
      evidenceType: "lifecycle",
      reliability: "high",
      sourceUrl: "https://endoflife.date/nodejs",
    });
    expect(f!.finding).toBe(
      "Node.js 20 reached end of life on 2026-04-30: no more security fixes. Latest 20.x release: 20.20.2.",
    );
    expect(f!.recommendedAction).toMatch(
      /^Upgrade to a supported Node\.js release \(for example \d+\)\.$/,
    );
  });

  it("reports support dates, and warns when the end is near", () => {
    const [ok] = endoflifeProvider.parse(node("24.1.0"), fx("eol-nodejs.json"), ctx);
    expect(ok!.finding).toMatch(/^Node\.js 24 is supported until 2028-04-30\./);
    expect(ok!.recommendedAction).toBeUndefined();
    // Node 22 ends on 2027-04-30, 157 days after NOW.
    const [soon] = endoflifeProvider.parse(node("22"), fx("eol-nodejs.json"), ctx);
    expect(soon!.finding).toMatch(/^Node\.js 22 is supported until 2027-04-30 \(157 days left\)/);
    expect(soon!.recommendedAction).toMatch(/Plan the move/);
  });

  it("is honest about versions too coarse to place", () => {
    const [f] = endoflifeProvider.parse(
      { ...node("7"), name: "redis", label: "Redis" },
      fx("eol-redis.json"),
      ctx,
    );
    expect(f).toMatchObject({ reliability: "low" });
    expect(f!.finding).toMatch(/matches several release lines/);
  });

  it("runs end to end into a valid v2 research file, caching POSTs by body", async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(`${init?.method} ${url} ${init?.body ?? ""}`);
      const body = url.includes("osv")
        ? fx("osv-express-4.17.1.json")
        : url.includes("nodejs")
          ? fx("eol-nodejs.json")
          : url.includes("redis")
            ? fx("eol-redis.json")
            : { result: { releases: [] } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const file = await runResearch(model, {
      fetchFn,
      now: NOW,
      providers: [osvProvider, endoflifeProvider],
    });
    expect(validateResearch(file).ok).toBe(true);
    expect(file.schemaVersion).toBe("buildrax-research/v2");
    expect(
      file.findings.some((f) => f.evidenceType === "lifecycle" && f.subject === "Node.js 20"),
    ).toBe(true);
    expect(calls.filter((c) => c.startsWith("POST https://api.osv.dev/v1/query"))).toHaveLength(3); // express, lodash ×2
  });
});
