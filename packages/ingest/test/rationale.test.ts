import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateRationale, type RationaleFile } from "@buildrax/ir";
import {
  isAdrPath,
  isDocPath,
  markdownSections,
  parseFile,
  parseLog,
  readAdr,
  scanDetailed,
} from "../src/index.js";

describe("rationale in source and docs", () => {
  it("keeps comments that give a reason, merging adjacent line comments", async () => {
    const src = [
      "// Copyright 2026 Example Inc. Licensed under MIT because reasons.",
      "// eslint-disable-next-line no-console",
      "// We retry twice because the payment API drops",
      "// the first request after a cold start.",
      "export function pay() {}",
      "/* increments the counter */",
      "/** Cached on purpose: the price list changes once a day. */",
      "export const prices = {};",
    ].join("\n");
    const whys = (await parseFile(src, "typescript")).facts.whys ?? [];
    expect(whys).toEqual([
      {
        line: 3,
        endLine: 4,
        text: "We retry twice because the payment API drops the first request after a cold start.",
      },
      { line: 7, endLine: 7, text: "Cached on purpose: the price list changes once a day." },
    ]);
    const py = (
      await parseFile("# Use a set instead of a list to avoid duplicates\nx = set()\n", "python")
    ).facts.whys;
    expect(py?.[0]?.text).toBe("Use a set instead of a list to avoid duplicates");
  });

  it("finds ADRs and docs by path", () => {
    expect(isAdrPath("docs/adr/0001-use-postgres.md")).toBe(true);
    expect(isAdrPath("decisions/0007-queues.md")).toBe(true);
    expect(isAdrPath("ADR-12-auth.md")).toBe(true);
    expect(isAdrPath("docs/adr/README.md")).toBe(false);
    expect(isDocPath("packages/api/README.md")).toBe(true);
    expect(isDocPath("docs/guide/setup.md")).toBe(true);
    expect(isDocPath("CHANGELOG.md")).toBe(false);
    expect(isDocPath("src/notes.md")).toBe(false);
  });

  it("reads ADR title, status, date and decision; splits docs by heading outside fences", () => {
    const adr = readAdr(
      "# 4. Use Kafka\n\n## Status\n\nAccepted\n\nDate: 2026-01-05\n\n## Decision\n\nWe use **Kafka** for [events](x.md).\n",
    );
    expect(adr).toMatchObject({
      title: "4. Use Kafka",
      status: "accepted",
      date: "2026-01-05",
      summary: "We use Kafka for events.",
    });
    expect(readAdr("# T\n- Status: Superseded by ADR 5\n").status).toBe("superseded by adr 5");
    const s = markdownSections("intro\n# A\ntext\n```\n# not a heading\n```\n## B\nmore\n");
    expect(s.map((x) => [x.title, x.line, x.endLine])).toEqual([
      ["", 1, 1],
      ["A", 2, 6],
      ["B", 7, 9],
    ]);
  });

  it("parses git log output and drops trailers", () => {
    const out =
      "\x1eabc1234567\x1f2026-11-02\x1ffix: retry payments\x1fThe provider drops the first call after idle.\n\nCo-Authored-By: X <x@y>\nSigned-off-by: Y\n\x1d\nsrc/pay.ts\nsrc/retry.ts\n" +
      "\x1edef7654321\x1f2026-11-01\x1fwip\x1f\x1d\nREADME.md\n";
    expect(parseLog(out)).toEqual([
      {
        hash: "abc1234567",
        date: "2026-11-02",
        subject: "fix: retry payments",
        body: "The provider drops the first call after idle.",
        files: ["src/pay.ts", "src/retry.ts"],
      },
      { hash: "def7654321", date: "2026-11-01", subject: "wip", body: "", files: ["README.md"] },
    ]);
  });
});

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/flows-app",
);
let rat: RationaleFile;
beforeAll(async () => {
  rat = (await scanDetailed(FIXTURE, { now: "2026-11-28T00:00:00.000Z", git: false })).rationale;
});
const src = (id: string) => rat.sources.find((s) => s.id === id)!;
const links = (id: string) => src(id).links.map((l) => `${l.node} ${l.via}`);

describe("rationale index on the fixture", () => {
  it("is valid, and git is reported as not read", () => {
    expect(validateRationale(rat)).toMatchObject({ ok: true });
    expect(rat.git).toEqual({ read: false, commits: 0 });
    expect(rat.stats).toMatchObject({ adrs: 3, commits: 0 });
  });

  it("ties ADRs to what they name, or to the project", () => {
    expect(src("adr:docs/adr/0001-postgres-for-orders.md")).toMatchObject({
      title: "1. Store orders in PostgreSQL",
      status: "accepted",
      date: "2026-03-02",
    });
    expect(links("adr:docs/adr/0001-postgres-for-orders.md")).toEqual([
      "file:web/src/lib/db.ts code",
      "database:postgres name",
    ]);
    expect(src("adr:docs/adr/0002-emails-on-a-queue.md").status).toBe("superseded");
    expect(links("adr:docs/adr/0002-emails-on-a-queue.md")).toEqual(
      expect.arrayContaining(["queue:bullmq name", "route:web:POST /api/orders code"]),
    );
    expect(links("adr:docs/adr/0003-tone.md")).toEqual(["project:flows-app project"]);
  });

  it("keeps only doc sections that name something, and comments in their file", () => {
    const docs = rat.sources.filter((s) => s.kind === "doc" && s.file === "docs/architecture.md");
    expect(docs.map((d) => d.title)).toEqual(["Caching"]);
    expect(docs[0]!.links.map((l) => l.node)).toEqual(["file:web/src/lib/cache.ts", "cache:redis"]);
    const c = src("comment:web/src/lib/cache.ts:2");
    expect(c.excerpt).toMatch(/^One shared client on purpose/);
    expect(rat.byNode["file:web/src/lib/cache.ts"]).toEqual([
      "doc:docs/architecture.md#L3",
      "comment:web/src/lib/cache.ts:2",
    ]);
    expect(rat.byNode["database:postgres"]?.[0]).toBe("adr:docs/adr/0001-postgres-for-orders.md");
  });
});

describe("rationale from local git history", () => {
  let tmp: string;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-why-"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...a], {
        cwd: tmp,
        stdio: "pipe",
      });
    git("init", "-q");
    await fs.writeFile(path.join(tmp, "pay.ts"), "export function pay() { return 1; }\n");
    git("add", ".");
    git("commit", "-q", "-m", "add pay");
    await fs.writeFile(path.join(tmp, "pay.ts"), "export function pay() { return 2; }\n");
    git(
      "commit",
      "-qam",
      "fix: retry payments",
      "-m",
      "The provider drops the first call after idle, so we retry once.",
    );
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("keeps commits that explain, linked to changed files, without author details", async () => {
    const r = (await scanDetailed(tmp, { now: "2026-11-28T00:00:00.000Z" })).rationale;
    expect(r.git).toEqual({ read: true, commits: 2 });
    const commits = r.sources.filter((s) => s.kind === "commit");
    expect(commits.map((c) => [c.title, c.links])).toEqual([
      ["fix: retry payments", [{ node: "file:pay.ts", via: "changed" }]],
    ]);
    expect(JSON.stringify(r)).not.toMatch(/t@example\.com|"T"/);
    const off = (await scanDetailed(tmp, { now: "2026-11-28T00:00:00.000Z", git: false }))
      .rationale;
    expect(off.git.read).toBe(false);
  });
});
