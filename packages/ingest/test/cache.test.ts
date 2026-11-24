import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scan, type ScanStats } from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/sample-monorepo",
);
const NOW = "2026-11-24T00:00:00.000Z";
let tmp: string;
let cacheFile: string;
const stats = (): ScanStats => ({ files: 0, parsed: 0, reused: 0, ms: 0 });

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-cache-"));
  await fs.cp(FIXTURE, path.join(tmp, "repo"), { recursive: true });
  cacheFile = path.join(tmp, "cache", "files.json");
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("incremental scan", () => {
  const repo = () => path.join(tmp, "repo");

  it("a cached scan is identical to a full scan and parses nothing unchanged", async () => {
    const full = await scan(repo(), { now: NOW });
    const s1 = stats();
    const first = await scan(repo(), { now: NOW, cacheFile, stats: s1 });
    expect(s1.reused).toBe(0);
    expect(s1.parsed).toBe(s1.files);
    const s2 = stats();
    const second = await scan(repo(), { now: NOW, cacheFile, stats: s2 });
    expect(s2.parsed).toBe(0);
    expect(s2.reused).toBe(s1.files);
    expect(JSON.stringify(first)).toBe(JSON.stringify(full));
    expect(JSON.stringify(second)).toBe(JSON.stringify(full));
  });

  it("re-parses only changed files and picks up their new imports", async () => {
    const f = path.join(repo(), "packages/shared/src/index.ts");
    await fs.appendFile(f, '\nimport { extra } from "./brand-new.js";\n');
    const s = stats();
    const m = await scan(repo(), { now: NOW, cacheFile, stats: s });
    expect(s.parsed).toBe(1);
    expect(m.nodes.some((n) => n.kind === "unresolved" && n.name.includes("brand-new"))).toBe(true);
    expect(JSON.stringify(m)).toBe(JSON.stringify(await scan(repo(), { now: NOW })));
  });

  it("ignores a corrupt or foreign cache instead of trusting it", async () => {
    await fs.writeFile(cacheFile, "{not json");
    const s = stats();
    await scan(repo(), { now: NOW, cacheFile, stats: s });
    expect(s.reused).toBe(0);
    const forged = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    forged.fingerprint = "ingest@older";
    await fs.writeFile(cacheFile, JSON.stringify(forged));
    const s2 = stats();
    await scan(repo(), { now: NOW, cacheFile, stats: s2 });
    expect(s2.reused).toBe(0);
  });

  it("can name the project so a copy keeps the same IDs", async () => {
    const m = await scan(repo(), { now: NOW, repoName: "sample-monorepo" });
    expect(m.nodes.some((n) => n.id === "project:sample-monorepo")).toBe(true);
  });
});
