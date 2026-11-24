import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { diffModels, type ModelDiff } from "@buildrax/graph";
import { scan } from "@buildrax/ingest";
import { validateModel, type Model } from "@buildrax/ir";
import { buildraxDir, loadModel } from "./data.js";

const run = promisify(execFile);

export const previousModelPathFor = (repo: string): string =>
  path.join(buildraxDir(repo), "cache", "model.prev.json");
export const scanCachePathFor = (repo: string): string =>
  path.join(buildraxDir(repo), "cache", "scan", "files.json");

async function readModelFile(file: string): Promise<Model> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read a model from ${file}: ${String(err)}`, { cause: err });
  }
  const v = validateModel(raw);
  if (!v.ok || !v.model) throw new Error(`${file} is not a valid model: ${v.errors[0] ?? ""}`);
  return v.model;
}

/**
 * Scan the repository as it was at a git ref, without touching the working tree: the committed
 * files are exported with `git archive` into a temporary folder and scanned there (static, nothing
 * is executed). Unchanged files reuse the parse cache, so this is fast.
 */
export async function scanAtRef(repo: string, ref: string): Promise<Model> {
  const root = path.resolve(repo);
  if (!/^[\w./~^@{}-]+$/.test(ref) || ref.startsWith("-"))
    throw new Error(`"${ref}" does not look like a git ref`);
  let sha: string;
  try {
    sha = (
      await run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    ).stdout.trim();
  } catch {
    throw new Error(`git ref "${ref}" not found in ${root}`);
  }
  const { stdout: top } = await run("git", ["-C", root, "rev-parse", "--show-toplevel"]);
  const prefix = path.relative(top.trim(), root);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-ref-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const git = spawn("git", ["-C", top.trim(), "archive", "--format=tar", sha], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tar = spawn("tar", ["-x", "-C", tmp], { stdio: ["pipe", "ignore", "pipe"] });
      git.stdout.pipe(tar.stdin);
      let failed = false;
      const fail = (what: string) => (code: number | null) => {
        if (code !== 0 && !failed) {
          failed = true;
          reject(new Error(`${what} exited with ${code}`));
        }
      };
      git.on("close", fail("git archive"));
      git.on("error", reject);
      tar.on("error", reject);
      tar.on("close", (code) => {
        fail("tar")(code);
        if (!failed) resolve();
      });
    });
    return await scan(path.join(tmp, prefix), {
      repoName: path.basename(root),
      cacheFile: scanCachePathFor(root),
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export interface DiffOptions {
  /** Compare against this model file instead of the previous scan. */
  against?: string;
  /** Compare against the repository at this git ref. */
  since?: string;
}

/** Compare the current model with the previous scan, a model file or a git ref. */
export async function diffCommand(
  repo: string,
  opts: DiffOptions = {},
): Promise<{ diff: ModelDiff; baseline: string }> {
  const current = await loadModel(repo);
  if (opts.against && opts.since) throw new Error("use either --against or --since, not both");
  if (opts.since) {
    return { diff: diffModels(await scanAtRef(repo, opts.since), current), baseline: opts.since };
  }
  const file = opts.against ? path.resolve(opts.against) : previousModelPathFor(repo);
  try {
    await fs.access(file);
  } catch {
    throw new Error(
      opts.against
        ? `${file} not found`
        : "no previous scan to compare with yet: run `buildrax scan` again after a change, or use --since <git ref>",
    );
  }
  return {
    diff: diffModels(await readModelFile(file), current),
    baseline: opts.against ?? "previous scan",
  };
}

const label = (n: { id: string; kind: string }): string =>
  `${n.kind.padEnd(10)} ${n.id.replace(/^[a-z]+:/, "")}`;

export function formatDiff(d: ModelDiff, baseline: string): string {
  if (d.same && !d.cycles.introduced.length && !d.cycles.resolved.length)
    return `No architecture changes since ${baseline}.`;
  const out = [
    `Architecture changes since ${baseline}: ${d.from.nodes} → ${d.to.nodes} nodes, ${d.from.edges} → ${d.to.edges} edges`,
  ];
  const section = (title: string, lines: string[], max = 40): void => {
    if (!lines.length) return;
    out.push("", `${title} (${lines.length})`);
    out.push(...lines.slice(0, max).map((l) => `  ${l}`));
    if (lines.length > max) out.push(`  … ${lines.length - max} more (use --json)`);
  };
  section(
    "Circular dependencies introduced",
    d.cycles.introduced.map((c) => c.join(" <-> ")),
  );
  section(
    "Circular dependencies resolved",
    d.cycles.resolved.map((c) => c.join(" <-> ")),
  );
  section(
    "Added",
    d.nodes.added.map((n) => `+ ${label(n)}`),
  );
  section(
    "Removed",
    d.nodes.removed.map((n) => `- ${label(n)}`),
  );
  section(
    "Changed",
    d.nodes.changed.map((c) => `~ ${label(c)}  ${c.changes.join("; ")}`),
  );
  const edge = (e: { from: string; kind: string; to: string }): string =>
    `${e.from} -${e.kind}-> ${e.to}`;
  section(
    "Links added",
    d.edges.added.map((e) => `+ ${edge(e)}`),
  );
  section(
    "Links removed",
    d.edges.removed.map((e) => `- ${edge(e)}`),
  );
  return out.join("\n");
}
