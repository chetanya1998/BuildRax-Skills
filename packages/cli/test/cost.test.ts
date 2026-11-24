import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MINIMAL_STACK } from "@buildrax/cost";
import { AWS_SERVICES } from "@buildrax/pricing";
import {
  askStack,
  costCommand,
  formatCost,
  parseAssumptions,
  parseTiers,
  scanCommand,
} from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../../../fixtures/infra-app");
const EXCERPTS = path.resolve(HERE, "../../pricing/test/fixtures");
let tmp: string;

/** Serves the recorded AWS excerpts; records every URL asked for. */
function fakeAws(urls: string[]) {
  return async (url: string): Promise<Response> => {
    urls.push(url);
    const s = AWS_SERVICES.find((x) => url.includes(`/${x}/`));
    if (!s) return new Response("not found", { status: 404 });
    return new Response(await fs.readFile(path.join(EXCERPTS, `${s}.excerpt.json`), "utf8"));
  };
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-cost-"));
  await fs.cp(FIXTURE, tmp, { recursive: true });
  await scanCommand(tmp);
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("cost command", () => {
  it("parses tiers and assumptions strictly", () => {
    expect(parseTiers("100,1k,10k,100k,1m")).toEqual([100, 1000, 10000, 100000, 1000000]);
    expect(parseTiers("2.5k")).toEqual([2500]);
    expect(() => parseTiers("lots")).toThrow(/bad tier/);
    expect(parseAssumptions("dauRatio=0.3")).toEqual({ dauRatio: 0.3 });
    expect(() => parseAssumptions("bogus=1")).toThrow(/unknown assumption/);
    expect(() => parseAssumptions("dauRatio=-1")).toThrow(/non-negative/);
  });

  it("without --online it sends nothing, shows the plan and still reports what it knows", async () => {
    const urls: string[] = [];
    const r = await costCommand(tmp, { mode: "current", fetchFn: fakeAws(urls) });
    expect(urls).toEqual([]);
    expect(
      r.plan?.requests.every((q) => q.url.startsWith("https://pricing.us-east-1.amazonaws.com/")),
    ).toBe(true);
    expect(r.report.tiers[0]!.incomplete).toBe(true);
    expect(formatCost(r.report)).toMatch(/price needed/);
  });

  it("with --online it fetches only allowlisted price files, caches them and writes cost.json", async () => {
    const urls: string[] = [];
    const r = await costCommand(tmp, { mode: "current", online: true, fetchFn: fakeAws(urls) });
    expect(urls).toHaveLength(AWS_SERVICES.length);
    expect(r.plan).toBeUndefined();
    const written = JSON.parse(await fs.readFile(r.file, "utf8"));
    expect(written.schemaVersion).toBe("buildrax-cost/v1");
    expect(written.tiers).toHaveLength(5);
    const db = r.report.tiers[0]!.components.find((c) => c.id === "database")!;
    expect(db.sizing).toBe("db.t4g.small, 20 GB"); // declared in infra/main.tf
    await fs.access(path.join(tmp, ".buildrax", "cache", "pricing", "aws-us-east-1.json"));
    // The repo's own deploy files are not uploaded anywhere: only price list URLs were requested.
    expect(urls.every((u) => u.includes("/offers/v1.0/aws/"))).toBe(true);
  });

  it("product mode honours stack answers and rejects unknown ones", async () => {
    const r = await costCommand(tmp, {
      mode: "product",
      stack: { database: "mysql", cache: "none", payments: "none" },
    });
    expect(r.report.stack).toMatchObject({ database: "mysql", cache: "none" });
    expect(r.report.tiers.at(-1)!.components.some((c) => c.id === "cache")).toBe(false);
    await expect(
      costCommand(tmp, { mode: "product", stack: { database: "oracle" } }),
    ).rejects.toThrow(/one of/);
  });

  it("credentials are opt-in, never written, and redacted from errors", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    await expect(costCommand(tmp, { mode: "current", useCredentials: true })).rejects.toThrow(
      /only applies with --online/,
    );
    await expect(
      costCommand(tmp, { mode: "current", online: true, useCredentials: true, env: {} }),
    ).rejects.toThrow(/not set/);
    await expect(
      costCommand(tmp, {
        mode: "current",
        online: true,
        useCredentials: true,
        env: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: secret },
        fetchFn: async () => {
          throw new Error(`rejected signature for ${secret}`);
        },
      }),
    ).rejects.toThrow(/rejected signature for \[redacted\]/);
    for (const f of await fs.readdir(path.join(tmp, ".buildrax"), { recursive: true })) {
      const p = path.join(tmp, ".buildrax", String(f));
      if ((await fs.stat(p)).isFile()) {
        const text = await fs.readFile(p, "utf8");
        expect(text).not.toContain(secret);
        expect(text).not.toContain("AKIDEXAMPLE");
      }
    }
  });

  it("the questionnaire keeps defaults on Enter and re-asks on invalid input", async () => {
    const replies = ["", "", "mysql", "nope", "none"];
    const answers = await askStack(MINIMAL_STACK, async () => replies.shift() ?? "");
    expect(answers).toEqual({ database: "mysql", cache: "none" });
  });
});
