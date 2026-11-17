import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { scan } from "@buildrax/ingest";
import type { Model } from "@buildrax/ir";
import {
  contextFor,
  estimateTokens,
  readSnippet,
  renderDigest,
  tokenizeQuery,
} from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/sample-monorepo",
);
let model: Model;
beforeAll(async () => {
  model = await scan(FIXTURE, { now: "2026-01-01T00:00:00.000Z" });
});

describe("digest", () => {
  it("summarizes packages, cycles, externals and unresolved imports compactly", () => {
    const d = renderDigest(model);
    expect(d.text).toContain("BUILDRAX DIGEST repo=sample-monorepo");
    expect(d.text).toContain(
      "packages/api/src/services/billing.ts <-> packages/api/src/services/orders.ts",
    );
    expect(d.text).toContain("express");
    expect(d.text).toContain("./missing.js");
    expect(d.text).toContain("static analysis only");
    expect(d.tokens).toBe(estimateTokens(d.text));
  });
  it("is deterministic and degrades to fit a small budget", () => {
    expect(renderDigest(model).text).toBe(renderDigest(model).text);
    const full = renderDigest(model, { level: 1 });
    const small = renderDigest(model, { level: 1, budgetTokens: 150 });
    expect(full.level).toBe(1);
    expect(small.tokens).toBeLessThan(full.tokens);
    expect(small.level).toBe(0);
  });
});

describe("contextFor", () => {
  it("tokenizes questions, splitting camelCase and dropping stop words", () => {
    expect(tokenizeQuery("How does createOrder talk to the Stripe API?")).toEqual([
      "create",
      "order",
      "talk",
      "stripe",
      "api",
    ]);
  });

  it("finds the relevant files and cites file:line evidence", async () => {
    const p = await contextFor(model, "how does billing talk to stripe", { budgetTokens: 1500 });
    expect(p.fallback).toBe(false);
    expect(p.seeds).toEqual(
      expect.arrayContaining(["file:packages/api/src/services/billing.ts", "external:stripe"]),
    );
    expect(p.text).toContain("@packages/api/src/services/billing.ts:2");
    expect(p.tokens).toBeLessThanOrEqual(1500);
    expect(p.text).not.toContain("worker/jobs.py");
  });

  it("respects a tight budget and reports truncation", async () => {
    const p = await contextFor(model, "billing orders server routes", { budgetTokens: 200 });
    expect(p.tokens).toBeLessThanOrEqual(200);
    expect(p.truncated).toBe(true);
  });

  it("falls back to the digest when nothing matches", async () => {
    const p = await contextFor(model, "kubernetes helm chart");
    expect(p.fallback).toBe(true);
    expect(p.text).toContain("BUILDRAX DIGEST");
  });

  it("includes short real code snippets when a root is given", async () => {
    const p = await contextFor(model, "billing", { root: FIXTURE, budgetTokens: 2000 });
    expect(p.text).toContain("import Stripe");
  });

  it("is deterministic", async () => {
    const a = await contextFor(model, "orders billing");
    const b = await contextFor(model, "orders billing");
    expect(a.text).toBe(b.text);
  });
});

describe("readSnippet safety", () => {
  it("refuses paths outside the repo and secret files", async () => {
    expect(await readSnippet(FIXTURE, "../../package.json", 1)).toBeUndefined();
    expect(await readSnippet(FIXTURE, "/etc/passwd", 1)).toBeUndefined();
    expect(await readSnippet(FIXTURE, ".env", 1)).toBeUndefined();
    expect(await readSnippet(FIXTURE, "node_modules/x/index.js", 1)).toBeUndefined();
  });
  it("caps the snippet size", async () => {
    const s = await readSnippet(FIXTURE, "packages/api/src/server.ts", 5, 50);
    expect(s!.split("\n").length).toBeLessThanOrEqual(20);
  });
});
