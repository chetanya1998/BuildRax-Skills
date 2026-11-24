import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { priceKey } from "@buildrax/cost";
import {
  AWS_SERVICES,
  type AwsService,
  type OfferFile,
  assertAllowed,
  awsOfferUrl,
  extractAws,
  fetchAwsBook,
  loadPriceBook,
  planAws,
  safeFetch,
  writeCachedBook,
} from "../src/index.js";

const fx = (s: AwsService): OfferFile =>
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "fixtures", `${s}.excerpt.json`), "utf8"),
  ) as OfferFile;
const AT = "2026-11-24T00:00:00.000Z";
const price = (s: AwsService, key: string) =>
  extractAws(s, fx(s), "us-east-1", AT).find((r) => r.key === key);

describe("AWS price list extraction (recorded excerpts of the real us-east-1 files)", () => {
  it("Fargate vCPU and memory, x86 and ARM", () => {
    expect(price("AmazonECS", priceKey.fargateVcpu("x86"))?.tiers[0]?.usd).toBe(0.04048);
    expect(price("AmazonECS", priceKey.fargateGb("x86"))?.tiers[0]?.usd).toBe(0.004445);
    expect(price("AmazonECS", priceKey.fargateVcpu("arm"))?.tiers[0]?.usd).toBe(0.03238);
    expect(price("AmazonECS", priceKey.fargateGb("arm"))?.tiers[0]?.usd).toBe(0.00356);
  });

  it("RDS instances by deployment, ignoring UnusedBox and readable-standby SKUs", () => {
    expect(
      price("AmazonRDS", priceKey.rdsInstance("postgres", "db.t4g.micro", false))?.tiers[0]?.usd,
    ).toBe(0.016);
    expect(
      price("AmazonRDS", priceKey.rdsInstance("postgres", "db.m7g.large", false))?.tiers[0]?.usd,
    ).toBe(0.168);
    expect(
      price("AmazonRDS", priceKey.rdsInstance("postgres", "db.m7g.large", true))?.tiers[0]?.usd,
    ).toBe(0.337);
    expect(price("AmazonRDS", priceKey.rdsStorage("postgres", false))?.tiers[0]?.usd).toBe(0.115);
    expect(price("AmazonRDS", priceKey.rdsStorage("postgres", true))?.tiers[0]?.usd).toBe(0.23);
    expect(price("AmazonRDS", priceKey.rdsInstance("mysql", "db.t4g.micro", false))).toBeDefined();
  });

  it("ElastiCache node prices, not extended-support surcharges", () => {
    expect(
      price("AmazonElastiCache", priceKey.cache("redis", "cache.t4g.micro"))?.tiers[0]?.usd,
    ).toBe(0.016);
    expect(
      price("AmazonElastiCache", priceKey.cache("valkey", "cache.t4g.micro"))?.tiers[0]?.usd,
    ).toBe(0.0128);
    expect(
      price("AmazonElastiCache", priceKey.cache("redis", "cache.m7g.large"))?.tiers[0]?.usd,
    ).toBe(0.158);
  });

  it("tiered prices keep their ranges", () => {
    const s3 = price("AmazonS3", priceKey.s3())!;
    expect(s3.tiers).toEqual([
      { from: 0, to: 51200, usd: 0.023 },
      { from: 51200, to: 512000, usd: 0.022 },
      { from: 512000, to: undefined, usd: 0.021 },
    ]);
    expect(price("AWSDataTransfer", priceKey.egress())?.tiers.map((t) => t.usd)).toEqual([
      0.09, 0.085, 0.07, 0.05,
    ]);
  });

  it("load balancer and email", () => {
    expect(price("AWSELB", priceKey.albHour())?.tiers[0]?.usd).toBe(0.0225);
    expect(price("AWSELB", priceKey.albLcu())?.tiers[0]?.usd).toBe(0.008);
    expect(price("AmazonSES", priceKey.sesRecipient())?.tiers[0]?.usd).toBe(0.0001);
  });

  it("every record says where and when it came from", () => {
    const r = price("AWSELB", priceKey.albHour())!;
    expect(r).toMatchObject({
      provider: "aws",
      region: "us-east-1",
      retrievedAt: AT,
      evidenceType: "official-price-list",
      sourceUrl: awsOfferUrl("AWSELB", "us-east-1"),
    });
    expect(r.publishedAt).toMatch(/^2026-/);
  });

  it("other regions are not mixed in", () => {
    expect(extractAws("AmazonECS", fx("AmazonECS"), "eu-west-1", AT)).toEqual([]);
  });
});

describe("fetching is allowlisted and opt-in", () => {
  it("refuses other hosts, plain http and credentials in URLs", () => {
    expect(() => assertAllowed("https://example.com/x")).toThrow(/allowlisted/);
    expect(() => assertAllowed("http://pricing.us-east-1.amazonaws.com/x")).toThrow();
    expect(() => assertAllowed("https://u:p@pricing.us-east-1.amazonaws.com/x")).toThrow();
    expect(() => planAws("us-east-1; rm -rf /")).toThrow(/region/);
  });

  it("never follows redirects", async () => {
    let init: RequestInit | undefined;
    await safeFetch(awsOfferUrl("AWSELB", "us-east-1"), {}, async (_u, i) => {
      init = i;
      return new Response("{}");
    });
    expect(init?.redirect).toBe("error");
  });

  it("builds and caches a price book from the public files", async () => {
    const urls: string[] = [];
    const book = await fetchAwsBook("us-east-1", {
      now: () => new Date(AT),
      fetchFn: async (u) => {
        urls.push(u);
        const s = AWS_SERVICES.find((x) => u.includes(`/${x}/`))!;
        return new Response(JSON.stringify(fx(s)));
      },
    });
    expect(
      urls.every((u) => u.startsWith("https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/")),
    ).toBe(true);
    expect(urls.some((u) => u.includes("AmazonEC2/"))).toBe(false);
    expect(book.records.length).toBeGreaterThan(15);
    const root = mkdtempSync(path.join(tmpdir(), "brx-pricing-"));
    await writeCachedBook(root, book);
    const loaded = await loadPriceBook(root, "us-east-1");
    expect(loaded.cached).toBe(true);
    expect(loaded.book.records.find((r) => r.key === priceKey.albHour())?.tiers[0]?.usd).toBe(
      0.0225,
    );
  });
});
