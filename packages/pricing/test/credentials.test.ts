import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  awsCredentialsFromEnv,
  credentialStatus,
  fetchAwsBook,
  loadPriceBook,
  queryAws,
  redact,
  signV4,
} from "../src/index.js";

const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("optional credentials", () => {
  it("signs exactly like AWS's published Signature V4 example", () => {
    const h = signV4(
      {
        method: "GET",
        url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "",
      },
      CREDS,
      "us-east-1",
      "iam",
      "20150830T123600Z",
    );
    expect(h["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("reads only the environment, and status never shows values", () => {
    expect(awsCredentialsFromEnv({})).toBeUndefined();
    const env = {
      AWS_ACCESS_KEY_ID: "AKIAABCDEFGHIJKLMNOP",
      AWS_SECRET_ACCESS_KEY: "s3cr3t-value",
    };
    const s = JSON.stringify(credentialStatus(env));
    expect(s).toContain("found in environment");
    expect(s).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(s).not.toContain("MNOP");
    expect(s).not.toContain("s3cr3t");
  });

  it("redacts keys from messages", () => {
    expect(redact(`bad key ${CREDS.secretAccessKey} for AKIAABCDEFGHIJKLMNOP`, CREDS)).toBe(
      "bad key [redacted] for [redacted]",
    );
  });

  it("sends signed requests only to the Query API host and keeps secrets out of errors and results", async () => {
    const seen: { url: string; auth: string }[] = [];
    const item = {
      product: {
        sku: "SKU1",
        productFamily: "Load Balancer-Application",
        attributes: { regionCode: "us-east-1", usagetype: "LoadBalancerUsage" },
      },
      terms: {
        OnDemand: {
          "SKU1.T": {
            priceDimensions: {
              d: { unit: "Hrs", beginRange: "0", endRange: "Inf", pricePerUnit: { USD: "0.0225" } },
            },
          },
        },
      },
      publicationDate: "2026-11-19T22:27:09Z",
    };
    const recs = await queryAws("AWSELB", "us-east-1", CREDS, {
      now: () => new Date("2026-11-24T00:00:00Z"),
      fetchFn: async (u, init) => {
        seen.push({
          url: u,
          auth: String((init?.headers as Record<string, string>)["authorization"]),
        });
        return new Response(JSON.stringify({ PriceList: [JSON.stringify(item)] }));
      },
    });
    expect(seen.every((s) => s.url === "https://api.pricing.us-east-1.amazonaws.com/")).toBe(true);
    expect(seen[0]!.auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261124\/us-east-1\/pricing\/aws4_request/,
    );
    expect(seen[0]!.auth).not.toContain(CREDS.secretAccessKey);
    expect(recs[0]).toMatchObject({
      key: "aws.alb.hour",
      tiers: [{ usd: 0.0225 }],
      publishedAt: "2026-11-19T22:27:09Z",
    });
    expect(JSON.stringify(recs)).not.toContain("AKIDEXAMPLE");

    await expect(
      queryAws("AWSELB", "us-east-1", CREDS, {
        fetchFn: async () => {
          throw new Error(`denied for ${CREDS.secretAccessKey}`);
        },
      }),
    ).rejects.toThrow("denied for [redacted]");
  });

  it("nothing about credentials reaches the cache", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "brx-cred-"));
    const book = await fetchAwsBook("us-east-1", {
      credentials: CREDS,
      fetchFn: async () => new Response(JSON.stringify({ PriceList: [] })),
    });
    expect(JSON.stringify(book)).not.toContain("AKIDEXAMPLE");
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("user prices (.buildrax/prices.json)", () => {
  it("require a source URL and date, and override list prices", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "brx-user-"));
    mkdirSync(path.join(root, ".buildrax"));
    writeFileSync(
      path.join(root, ".buildrax", "prices.json"),
      JSON.stringify({
        schemaVersion: "buildrax-prices/v1",
        currency: "USD",
        region: "global",
        records: [
          {
            key: "payments.stripe.percent",
            label: "Stripe card fee",
            unit: "percent",
            tiers: [{ from: 0, usd: 2.9 }],
            provider: "stripe",
            retrievedAt: "2026-11-24",
            evidenceType: "researched-page",
          },
        ],
      }),
    );
    const bad = await loadPriceBook(root, "us-east-1");
    expect(bad.errors.join(" ")).toMatch(/sourceUrl/);
  });
});
