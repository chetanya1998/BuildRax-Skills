import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffCommand, formatDiff, formatSummary, scanCommand } from "../src/index.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/sample-monorepo",
);
let tmp: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", tmp, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    stdio: "pipe",
  });

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-diff-"));
  await fs.cp(FIXTURE, tmp, { recursive: true });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base");
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("diff and incremental scan", () => {
  it("explains there is nothing to compare before a second scan", async () => {
    await scanCommand(tmp);
    await expect(diffCommand(tmp)).rejects.toThrow(/no previous scan/);
  });

  it("second scan reuses every parse; diff shows the change since the previous scan", async () => {
    const again = await scanCommand(tmp);
    expect(again.work?.parsed).toBe(0);
    expect(formatSummary(again)).toMatch(/parsed 0 file\(s\), reused \d+ unchanged/);
    expect(formatDiff((await diffCommand(tmp)).diff, "previous scan")).toBe(
      "No architecture changes since previous scan.",
    );
    await fs.writeFile(
      path.join(tmp, "packages/shared/src/extra.ts"),
      'import "./index.js";\nexport const x = 1;\n',
    );
    const after = await scanCommand(tmp);
    expect(after.work?.parsed).toBe(1);
    const { diff } = await diffCommand(tmp);
    expect(diff.nodes.added.map((n) => n.id)).toContain("file:packages/shared/src/extra.ts");
    expect(formatDiff(diff, "previous scan")).toMatch(/\+ file\s+packages\/shared\/src\/extra\.ts/);
  });

  it("--since compares with a git ref without touching the working tree", async () => {
    const before = await fs.readFile(path.join(tmp, "packages/shared/src/extra.ts"), "utf8");
    const { diff } = await diffCommand(tmp, { since: "HEAD" });
    expect(diff.nodes.added.map((n) => n.id)).toContain("file:packages/shared/src/extra.ts");
    expect(diff.nodes.removed).toEqual([]);
    expect(await fs.readFile(path.join(tmp, "packages/shared/src/extra.ts"), "utf8")).toBe(before);
    expect(String(git("status", "--porcelain"))).toContain("extra.ts");
  });

  it("refuses refs that look like options or do not exist", async () => {
    await expect(diffCommand(tmp, { since: "--output=/tmp/x" })).rejects.toThrow(
      /does not look like a git ref/,
    );
    await expect(diffCommand(tmp, { since: "no-such-branch" })).rejects.toThrow(/not found/);
  });
});
