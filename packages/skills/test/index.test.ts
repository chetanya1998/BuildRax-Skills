import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_TARGETS, installSkill, planInstall, skillSourceDir } from "../src/index.js";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "brx-skill-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("skill source", () => {
  it("has valid, portable frontmatter and stays short", async () => {
    const text = await fs.readFile(path.join(skillSourceDir(), "SKILL.md"), "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "";
    expect(name).toBe("buildrax");
    expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(description.length).toBeGreaterThan(40);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(text.split("\n").length).toBeLessThan(200);
    for (const ref of ["commands.md", "answering-questions.md", "limits.md"]) {
      await expect(
        fs.access(path.join(skillSourceDir(), "references", ref)),
      ).resolves.toBeUndefined();
    }
  });
  it("contains no analysis logic, only instructions", async () => {
    const entries = await fs.readdir(skillSourceDir(), { recursive: true });
    expect(entries.every((e) => /\.(md)$/.test(e) || !e.includes("."))).toBe(true);
  });
});

describe("planInstall", () => {
  it("shares one destination between codex and antigravity at project scope", () => {
    const plans = planInstall({ targets: ALL_TARGETS, scope: "project", projectRoot: tmp });
    expect(plans.map((p) => path.relative(tmp, p.dir)).sort()).toEqual([
      ".agents/skills/buildrax",
      ".claude/skills/buildrax",
    ]);
    expect(plans.find((p) => p.dir.includes(".agents"))!.targets).toEqual(["codex", "antigravity"]);
  });
  it("uses per-agent user locations", () => {
    const plans = planInstall({
      targets: ALL_TARGETS,
      scope: "user",
      projectRoot: tmp,
      home: "/home/u",
    });
    expect(plans.map((p) => p.dir).sort()).toEqual([
      "/home/u/.agents/skills/buildrax",
      "/home/u/.claude/skills/buildrax",
      "/home/u/.gemini/config/skills/buildrax",
    ]);
  });
  it("honors an explicit directory", () => {
    expect(
      planInstall({ targets: ["claude"], scope: "project", projectRoot: tmp, dir: "/x/y" })[0]!.dir,
    ).toBe("/x/y/buildrax");
  });
});

describe("installSkill", () => {
  const base = () => ({ targets: ALL_TARGETS, scope: "project" as const, projectRoot: tmp });

  it("copies SKILL.md and references, then updates in place", async () => {
    const first = await installSkill(base());
    expect(first.map((r) => r.status)).toEqual(["installed", "installed"]);
    const dir = path.join(tmp, ".claude/skills/buildrax");
    expect((await fs.readdir(dir, { recursive: true })).sort()).toEqual([
      ".buildrax-skill",
      "SKILL.md",
      "references",
      "references/answering-questions.md",
      "references/commands.md",
      "references/limits.md",
    ]);
    expect((await installSkill(base())).map((r) => r.status)).toEqual(["updated", "updated"]);
  });

  it("never overwrites a foreign skill without --force", async () => {
    const dir = path.join(tmp, ".claude/skills/buildrax");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "someone else's skill");
    const r = await installSkill({ ...base(), targets: ["claude"] });
    expect(r[0]!.status).toBe("skipped");
    expect(await fs.readFile(path.join(dir, "SKILL.md"), "utf8")).toBe("someone else's skill");
    const forced = await installSkill({ ...base(), targets: ["claude"], force: true });
    expect(forced[0]!.status).toBe("installed");
    expect(await fs.readFile(path.join(dir, "SKILL.md"), "utf8")).toContain("name: buildrax");
  });

  it("dry run writes nothing", async () => {
    const r = await installSkill({ ...base(), dryRun: true });
    expect(r.every((x) => x.status === "dry-run")).toBe(true);
    expect(await fs.readdir(tmp)).toEqual([]);
  });
});
