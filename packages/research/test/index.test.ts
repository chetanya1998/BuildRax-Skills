import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { scan } from "@buildrax/ingest";
import { validateResearch, type Model } from "@buildrax/ir";
import {
  extractTechnologies,
  isSafePackageName,
  npmProvider,
  planResearch,
  pypiProvider,
  runResearch,
  type FetchLike,
  type Provider,
} from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/sample-monorepo",
);
const NOW = "2026-01-01T00:00:00.000Z";
let model: Model;
beforeAll(async () => {
  model = await scan(FIXTURE, { now: NOW });
});

const reply = (body: unknown, status = 200): ReturnType<FetchLike> =>
  Promise.resolve({ ok: status < 400, status, text: async () => JSON.stringify(body) });

const registry: Record<string, unknown> = {
  "https://registry.npmjs.org/express/latest": {
    version: "5.0.0",
    license: "MIT",
    engines: { node: ">= 18" },
    homepage: "https://expressjs.com/",
  },
  "https://registry.npmjs.org/stripe/latest": {
    version: "17.0.0",
    deprecated: "use @stripe/stripe-js",
    repository: { url: "git+https://github.com/stripe/stripe-node.git" },
  },
  "https://pypi.org/pypi/requests/json": {
    info: {
      version: "2.32.0",
      requires_python: ">=3.8",
      project_urls: { Documentation: "https://requests.readthedocs.io" },
    },
  },
};
const mockFetch =
  (calls: string[] = []): FetchLike =>
  (url) => {
    calls.push(url);
    const hit = registry[url];
    return hit ? reply(hit) : reply({ error: "not found" }, 404);
  };

describe("technology extraction and the privacy gate", () => {
  it("extracts npm and pypi externals from the IR, most used first", () => {
    const t = extractTechnologies(model);
    expect(t.map((x) => `${x.ecosystem}:${x.name}`).sort()).toEqual([
      "npm:express",
      "npm:stripe",
      "pypi:redis",
      "pypi:requests",
    ]);
  });
  it("accepts only plain registry names", () => {
    expect(isSafePackageName("@babel/core", "npm")).toBe(true);
    expect(isSafePackageName("scikit-learn", "pypi")).toBe(true);
    for (const bad of [
      "../../etc/passwd",
      "foo bar",
      "a/b/c",
      "x?y=1",
      "SELECT * FROM users",
      "",
      "a".repeat(300),
      "https://evil.example",
    ]) {
      expect(isSafePackageName(bad, "npm"), bad).toBe(false);
      expect(isSafePackageName(bad, "pypi"), bad).toBe(false);
    }
  });
  it("drops unsafe names from a model instead of sending them", () => {
    const evil: Model = {
      ...model,
      nodes: [
        ...model.nodes,
        {
          id: "external:api_key=abc123 secret",
          kind: "external",
          name: "api_key=abc123 secret",
          evidence: [{ kind: "verified" }],
          meta: { ecosystem: "npm" },
        },
      ],
    };
    expect(extractTechnologies(evil).some((t) => t.name.includes("secret"))).toBe(false);
  });
});

describe("plan (what would be sent)", () => {
  it("lists only registry URLs built from package names", () => {
    const { requests } = planResearch(model);
    expect(requests.map((r) => r.url).sort()).toEqual([
      "https://pypi.org/pypi/redis/json",
      "https://pypi.org/pypi/requests/json",
      "https://registry.npmjs.org/express/latest",
      "https://registry.npmjs.org/stripe/latest",
    ]);
    expect(requests.every((r) => /^https:\/\/(registry\.npmjs\.org|pypi\.org)\//.test(r.url))).toBe(
      true,
    );
  });
  it("encodes scoped npm names and honors the limit", () => {
    expect(
      npmProvider.request({ name: "@babel/core", ecosystem: "npm", nodeId: "x", usedBy: 1 }).url,
    ).toBe("https://registry.npmjs.org/@babel%2Fcore/latest");
    expect(planResearch(model, { limit: 1 }).requests).toHaveLength(1);
  });
});

describe("providers parse registry metadata into dated, source-linked findings", () => {
  it("npm: latest, deprecation, engines and docs link", () => {
    const tech = {
      name: "stripe",
      ecosystem: "npm" as const,
      nodeId: "external:stripe",
      usedBy: 1,
    };
    const f = npmProvider.parse(tech, registry["https://registry.npmjs.org/stripe/latest"], {
      url: "https://registry.npmjs.org/stripe/latest",
      now: NOW,
    });
    expect(f.map((x) => x.id)).toEqual([
      "research:npm-registry:stripe:latest",
      "research:npm-registry:stripe:deprecated",
      "research:npm-registry:stripe:docs",
    ]);
    const dep = f.find((x) => x.id.endsWith("deprecated"))!;
    expect(dep).toMatchObject({
      reliability: "high",
      evidenceType: "registry-metadata",
      nodeId: "external:stripe",
      retrievedAt: NOW,
    });
    expect(dep.recommendedAction).toBeTruthy();
    expect(f.find((x) => x.id.endsWith("docs"))).toMatchObject({
      reliability: "medium",
      sourceUrl: "https://github.com/stripe/stripe-node",
    });
  });
  it("pypi: latest, python requirement, docs link; ignores unusable responses", () => {
    const tech = {
      name: "requests",
      ecosystem: "pypi" as const,
      nodeId: "external:requests",
      usedBy: 1,
    };
    const f = pypiProvider.parse(tech, registry["https://pypi.org/pypi/requests/json"], {
      url: "https://pypi.org/pypi/requests/json",
      now: NOW,
    });
    expect(f.map((x) => x.id.split(":").pop())).toEqual(["latest", "requires-python", "docs"]);
    expect(pypiProvider.parse(tech, { nope: 1 }, { url: "https://pypi.org/x", now: NOW })).toEqual(
      [],
    );
    expect(
      npmProvider.parse({ ...tech, ecosystem: "npm" }, "garbage", {
        url: "https://x.io",
        now: NOW,
      }),
    ).toEqual([]);
  });
  it("never links non-http(s) homepages", () => {
    const tech = { name: "x", ecosystem: "npm" as const, nodeId: "external:x", usedBy: 1 };
    const f = npmProvider.parse(
      tech,
      { version: "1.0.0", homepage: "javascript:alert(1)" },
      { url: "https://registry.npmjs.org/x/latest", now: NOW },
    );
    expect(f.some((x) => x.evidenceType === "docs-link")).toBe(false);
  });
});

describe("runResearch", () => {
  it("returns valid, deterministic findings and records failures explicitly", async () => {
    const calls: string[] = [];
    const out = await runResearch(model, { fetchFn: mockFetch(calls), now: NOW });
    expect(validateResearch(out).ok).toBe(true);
    expect(
      out.findings.some((f) => f.nodeId === "external:express" && f.finding.includes("5.0.0")),
    ).toBe(true);
    expect(out.errors).toEqual([{ subject: "redis", provider: "pypi", message: "HTTP 404" }]);
    expect(calls).toHaveLength(4);
    const again = await runResearch(model, { fetchFn: mockFetch(), now: NOW });
    expect(JSON.stringify(again)).toBe(JSON.stringify(out));
  });

  it("caches responses so repeat runs do not hit the network", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brx-cache-"));
    const first: string[] = [];
    await runResearch(model, { fetchFn: mockFetch(first), now: NOW, cacheDir: dir });
    const second: string[] = [];
    const out = await runResearch(model, { fetchFn: mockFetch(second), now: NOW, cacheDir: dir });
    expect(first.length).toBe(4);
    expect(second.length).toBe(1); // only the uncached 404 is retried
    expect(out.findings.length).toBeGreaterThan(0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("blocks requests to hosts a provider did not declare", async () => {
    const rogue: Provider = {
      id: "rogue",
      hosts: ["registry.npmjs.org"],
      supports: () => true,
      request: (t) => ({
        provider: "rogue",
        subject: t.name,
        url: "https://evil.example/collect?pkg=" + t.name,
      }),
      parse: () => [],
    };
    const calls: string[] = [];
    const out = await runResearch(model, {
      providers: [rogue],
      fetchFn: mockFetch(calls),
      now: NOW,
    });
    expect(calls).toEqual([]);
    expect(out.errors.length).toBe(4);
    expect(out.errors[0]!.message).toContain("blocked request to evil.example");
  });

  it("survives network failures and malformed responses", async () => {
    const out = await runResearch(model, {
      now: NOW,
      fetchFn: (url) =>
        url.includes("express")
          ? Promise.reject(new Error("offline"))
          : Promise.resolve({ ok: true, status: 200, text: async () => "<html>not json" }),
    });
    expect(out.findings).toEqual([]);
    expect(out.errors.map((e) => e.subject).sort()).toEqual([
      "express",
      "redis",
      "requests",
      "stripe",
    ]);
  });
});
