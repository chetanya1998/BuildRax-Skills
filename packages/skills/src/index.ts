import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillTarget = "claude" | "codex" | "antigravity";
export type SkillScope = "project" | "user";
export const SKILL_NAME = "buildrax";
const MARKER = ".buildrax-skill";

/**
 * Where each agent looks for skills, relative to the project root or the home directory.
 * Codex and Antigravity share the project path `.agents/skills`, so one install serves both.
 * Sources: vendor docs as summarised by public guides; pass `dir` to override if a layout changes.
 */
const LOCATIONS: Record<SkillTarget, Record<SkillScope, string>> = {
  claude: { project: ".claude/skills", user: ".claude/skills" },
  codex: { project: ".agents/skills", user: ".agents/skills" },
  antigravity: { project: ".agents/skills", user: ".gemini/config/skills" },
};

export function skillSourceDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const found = [
    path.join(here, "../skill", SKILL_NAME),
    path.join(here, "skill", SKILL_NAME),
  ].find((p) => existsSync(p));
  if (!found) throw new Error("skill files not found in the package");
  return found;
}

export interface InstallPlan {
  /** Targets served by this destination (e.g. codex and antigravity share one). */
  targets: SkillTarget[];
  dir: string;
}

export function planInstall(opts: {
  targets: SkillTarget[];
  scope: SkillScope;
  projectRoot: string;
  home?: string;
  /** Install into this exact directory instead (the skill lands in <dir>/buildrax). */
  dir?: string;
}): InstallPlan[] {
  if (opts.dir)
    return [{ targets: opts.targets, dir: path.join(path.resolve(opts.dir), SKILL_NAME) }];
  const base = opts.scope === "user" ? (opts.home ?? os.homedir()) : path.resolve(opts.projectRoot);
  const byDir = new Map<string, SkillTarget[]>();
  for (const t of opts.targets) {
    const dir = path.join(base, LOCATIONS[t][opts.scope], SKILL_NAME);
    byDir.set(dir, [...(byDir.get(dir) ?? []), t]);
  }
  return [...byDir.entries()].map(([dir, targets]) => ({ dir, targets }));
}

async function copyDir(src: string, dst: string): Promise<string[]> {
  const written: string[] = [];
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) written.push(...(await copyDir(from, to)));
    else if (e.isFile()) {
      await fs.copyFile(from, to);
      written.push(to);
    }
  }
  return written;
}

export interface InstallResult {
  plan: InstallPlan;
  status: "installed" | "updated" | "skipped" | "dry-run";
  reason?: string;
  files: string[];
}

/**
 * Copy the skill into each destination. An existing directory that BuildRAX did not create is
 * never overwritten unless `force` is set.
 */
export async function installSkill(opts: {
  targets: SkillTarget[];
  scope: SkillScope;
  projectRoot: string;
  home?: string;
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<InstallResult[]> {
  const src = skillSourceDir();
  const results: InstallResult[] = [];
  for (const plan of planInstall(opts)) {
    const exists = existsSync(plan.dir);
    const ours = exists && existsSync(path.join(plan.dir, MARKER));
    if (opts.dryRun) {
      results.push({ plan, status: "dry-run", files: [] });
      continue;
    }
    if (exists && !ours && !opts.force) {
      results.push({
        plan,
        status: "skipped",
        reason: "a different skill already exists here (use --force to replace)",
        files: [],
      });
      continue;
    }
    if (exists) await fs.rm(plan.dir, { recursive: true, force: true });
    const files = await copyDir(src, plan.dir);
    await fs.writeFile(path.join(plan.dir, MARKER), "managed by buildrax install-skill\n");
    results.push({ plan, status: ours ? "updated" : "installed", files });
  }
  return results;
}

export const ALL_TARGETS: SkillTarget[] = ["claude", "codex", "antigravity"];
