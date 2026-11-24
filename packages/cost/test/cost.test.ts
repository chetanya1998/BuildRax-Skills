import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Model } from "@buildrax/ir";
import {
  DEFAULT_TIERS,
  MINIMAL_STACK,
  type PriceBook,
  applyAnswers,
  defaultStack,
  estimate,
  fargateSize,
  mergeBooks,
  neededPriceKeys,
  priceKey,
  tieredCost,
  validatePriceBook,
} from "../src/index.js";

/** Real us-east-1 prices extracted from the AWS Price List files published in November 2026. */
const AWS: PriceBook = JSON.parse(
  readFileSync(new URL("./fixtures/aws-us-east-1.book.json", import.meta.url), "utf8"),
);

const ev = [{ kind: "config" as const, file: "infra/main.tf", startLine: 1 }];
const node = (id: string, name: string, meta: Record<string, unknown>) => ({
  id,
  kind: id.split(":")[0] as never,
  name,
  evidence: ev,
  meta: { infra: true, ...meta },
});
const MODEL: Model = {
  schemaVersion: "buildrax-ir/v2",
  meta: {
    root: "app",
    generatedAt: "2026-11-24T00:00:00.000Z",
    tool: { name: "buildrax", version: "0" },
  },
  nodes: [
    { id: "project:app", kind: "project", name: "app", evidence: ev },
    node("compute:tf-api", "api", {
      provider: "aws",
      engine: "ecs",
      cpu: 0.5,
      memoryMb: 1024,
      replicas: 2,
      sources: ["terraform"],
    }),
    node("compute:svc-api", "api", { replicas: 2, cpu: 0.5, memoryMb: 512, sources: ["compose"] }),
    node("database:postgres", "PostgreSQL", {
      engine: "postgres",
      instanceType: "db.t4g.small",
      storageGb: 20,
      multiAz: false,
      sources: ["terraform"],
    }),
    node("cache:redis", "Redis", {
      engine: "redis",
      instanceType: "cache.t4g.micro",
      sources: ["terraform"],
    }),
    node("payments:stripe", "Stripe", { sources: ["sdk"] }),
    node("search:algolia", "Algolia", { sources: ["sdk"] }),
  ],
  edges: [],
} as unknown as Model;

const comp = (r: ReturnType<typeof estimate>, users: number, id: string) =>
  r.tiers.find((t) => t.users === users)?.components.find((c) => c.id === id);

describe("price maths", () => {
  it("applies tiered prices band by band", () => {
    const egress = AWS.records.find((r) => r.key === priceKey.egress())!;
    expect(tieredCost(egress, 100)).toBeCloseTo(9, 6);
    expect(tieredCost(egress, 10240 + 1000)).toBeCloseTo(10240 * 0.09 + 1000 * 0.085, 6);
    expect(tieredCost(egress, 0)).toBe(0);
  });

  it("rounds containers up to sizes Fargate runs", () => {
    expect(fargateSize(0.5, 0.5)).toEqual({ vcpu: 0.5, memoryGb: 1 });
    expect(fargateSize(0.3, 3)).toEqual({ vcpu: 0.5, memoryGb: 3 });
    expect(fargateSize(1, 1)).toEqual({ vcpu: 1, memoryGb: 2 });
  });

  it("validates price books: source URL and retrieval date are required", () => {
    expect(validatePriceBook(AWS).ok).toBe(true);
    const bad = { ...AWS, records: [{ ...AWS.records[0], sourceUrl: undefined }] };
    expect(validatePriceBook(bad).errors.join()).toMatch(/sourceUrl/);
  });
});

describe("product mode (hypothesis)", () => {
  const r = estimate({ mode: "product", stack: MINIMAL_STACK, prices: AWS });

  it("models five tiers by default, cheapest first", () => {
    expect(r.tiers.map((t) => t.users)).toEqual(DEFAULT_TIERS);
    const totals = r.tiers.map((t) => t.total.expected);
    expect([...totals].sort((a, b) => a - b)).toEqual(totals);
    for (const t of r.tiers) {
      expect(t.total.low).toBeLessThanOrEqual(t.total.expected);
      expect(t.total.high).toBeGreaterThanOrEqual(t.total.expected);
    }
  });

  it("prices the smallest tier from real list prices", () => {
    const t = r.tiers[0]!;
    expect(comp(r, 100, "app")!.monthly.expected).toBeCloseTo(
      730 * (0.5 * 0.04048 + 1 * 0.004445),
      2,
    );
    expect(comp(r, 100, "database")!.sizing).toBe("db.t4g.micro, 20 GB");
    expect(comp(r, 100, "database")!.monthly.expected).toBeCloseTo(730 * 0.016 + 20 * 0.115, 2);
    expect(comp(r, 100, "cache")).toBeUndefined(); // product mode adds a cache only from 10k users
    expect(t.total.expected).toBeGreaterThan(45);
    expect(t.total.expected).toBeLessThan(55);
    expect(t.incomplete).toBe(false);
  });

  it("adds redundancy, a cache and bigger databases as traffic grows, and says so", () => {
    expect(comp(r, 10_000, "app")!.sizing).toMatch(/^2 ×/);
    expect(comp(r, 10_000, "database")!.sizing).toMatch(/Multi-AZ/);
    expect(comp(r, 10_000, "cache")).toBeDefined();
    expect(r.tiers[2]!.changes.join(" ")).toMatch(/Add Redis/);
    expect(comp(r, 1_000_000, "database")!.sizing).toMatch(/^db\.m7g/);
    expect(r.tiers[4]!.bottlenecks.join(" ")).toMatch(/Autoscaling/);
  });

  it("reports which assumptions move the total most", () => {
    const s = r.tiers[4]!.sensitivity;
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]!.changePct).toBeGreaterThan(5);
  });

  it("never invents prices: unknown services are reported as missing with where to look", () => {
    const r2 = estimate({
      mode: "product",
      stack: { ...MINIMAL_STACK, payments: "stripe", llm: "anthropic" },
      prices: AWS,
    });
    const pay = comp(r2, 1000, "payments")!;
    expect(pay.incomplete).toBe(true);
    expect(pay.lines.every((l) => l.usd === undefined)).toBe(true);
    expect(r2.tiers[1]!.incomplete).toBe(true);
    expect(r2.missingPrices.find((m) => m.key === "payments.stripe.percent")?.lookUp).toBe(
      "https://stripe.com/pricing",
    );
    expect(r2.missingPrices.map((m) => m.key)).toContain("llm.anthropic.input");
  });

  it("uses the user's researched prices, and lists every source with its date", () => {
    const user: PriceBook = {
      schemaVersion: "buildrax-prices/v1",
      currency: "USD",
      region: "global",
      records: [
        {
          key: "payments.stripe.percent",
          label: "Stripe card %",
          unit: "percent",
          tiers: [{ from: 0, usd: 2.9 }],
          provider: "stripe",
          sourceUrl: "https://stripe.com/pricing",
          retrievedAt: "2026-11-24",
          evidenceType: "researched-page",
        },
        {
          key: "payments.stripe.fixed",
          label: "Stripe fixed fee",
          unit: "transaction",
          tiers: [{ from: 0, usd: 0.3 }],
          provider: "stripe",
          sourceUrl: "https://stripe.com/pricing",
          retrievedAt: "2026-11-24",
          evidenceType: "researched-page",
        },
      ],
    };
    const r3 = estimate({
      mode: "product",
      stack: { ...MINIMAL_STACK, payments: "stripe" },
      prices: mergeBooks("us-east-1", AWS, user),
    });
    const pay = comp(r3, 1000, "payments")!;
    // 1,000 users × 0.05 payments × $20 = $1,000 volume → 2.9% + 50 × $0.30
    expect(pay.monthly.expected).toBeCloseTo(29 + 15, 6);
    expect(pay.incomplete).toBe(false);
    expect(r3.sources.find((s) => s.key === "payments.stripe.fixed")).toMatchObject({
      retrievedAt: "2026-11-24",
      evidenceType: "researched-page",
    });
    expect(r3.sources.every((s) => s.sourceUrl.startsWith("https://"))).toBe(true);
  });

  it("is deterministic and honours edited assumptions", () => {
    expect(JSON.stringify(estimate({ mode: "product", stack: MINIMAL_STACK, prices: AWS }))).toBe(
      JSON.stringify(r),
    );
    const busy = estimate({
      mode: "product",
      stack: MINIMAL_STACK,
      prices: AWS,
      assumptions: { requestsPerDau: 600 },
    });
    expect(busy.tiers[4]!.total.expected).toBeGreaterThan(r.tiers[4]!.total.expected);
    expect(busy.assumptions.requestsPerDau).toBe(600);
  });
});

describe("current mode (what the repo declares)", () => {
  const r = estimate({ mode: "current", model: MODEL, prices: AWS });

  it("derives the stack from detected infrastructure", () => {
    expect(r.stack).toMatchObject({ database: "postgres", cache: "redis", payments: "stripe" });
    expect(defaultStack(undefined)).toEqual(MINIMAL_STACK);
  });

  it("prices declared sizes and flags when a tier outgrows them", () => {
    expect(comp(r, 100, "database")!.sizing).toBe("db.t4g.small, 20 GB");
    expect(comp(r, 100, "database")!.nodeId).toBe("database:postgres");
    expect(comp(r, 100, "app")!.sizing).toMatch(/^2 × 0\.5 vCPU \/ 1 GB/); // terraform wins over compose
    expect(comp(r, 100, "app")!.notes.join(" ")).toMatch(/compute:svc-api/);
    expect(comp(r, 100, "cache")!.sizing).toBe("1 × cache.t4g.micro");
    expect(r.tiers.at(-1)!.bottlenecks.join(" ")).toMatch(
      /db\.t4g\.small \(declared.*upgrade to db\.m7g/,
    );
  });

  it("lists detected services it cannot price instead of guessing", () => {
    expect(r.notPriced).toEqual([{ nodeId: "search:algolia", kind: "search", label: "Algolia" }]);
  });
});

describe("stack questions", () => {
  it("accepts known answers and rejects anything else", () => {
    expect(applyAnswers(MINIMAL_STACK, { database: "mysql", region: "eu-west-1" })).toMatchObject({
      stack: { database: "mysql", region: "eu-west-1" },
      errors: [],
    });
    expect(applyAnswers(MINIMAL_STACK, { database: "oracle" }).errors[0]).toMatch(/one of/);
    expect(applyAnswers(MINIMAL_STACK, { colour: "x" }).errors[0]).toMatch(/unknown/);
    expect(applyAnswers(MINIMAL_STACK, { region: "../etc" }).errors[0]).toMatch(/region/);
  });

  it("knows which list prices a stack needs", () => {
    const keys = neededPriceKeys(MINIMAL_STACK);
    expect(keys).toContain(priceKey.rdsInstance("postgres", "db.t4g.micro", false));
    expect(keys.every((k) => AWS.records.some((r) => r.key === k))).toBe(true);
  });
});
