import { promises as fs } from "node:fs";
import path from "node:path";
import ignore from "ignore";

const ALWAYS_IGNORED = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "coverage",
  ".buildrax",
  ".turbo",
  ".cache",
  "target",
  ".pytest_cache",
  ".mypy_cache",
]);

/**
 * List repo files as sorted, repo-relative POSIX paths. Honors the root .gitignore, skips
 * well-known build/vendor dirs and never follows symlinks (stays inside the repo root).
 */
export async function walkRepo(root: string): Promise<string[]> {
  const ig = ignore();
  try {
    ig.add(await fs.readFile(path.join(root, ".gitignore"), "utf8"));
  } catch {
    /* no .gitignore */
  }
  const out: string[] = [];

  async function visit(dirRel: string): Promise<void> {
    const entries = await fs.readdir(path.join(root, dirRel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ALWAYS_IGNORED.has(e.name) || ig.ignores(`${rel}/`)) continue;
        await visit(rel);
      } else if (e.isFile()) {
        if (!ig.ignores(rel)) out.push(rel);
      }
    }
  }

  await visit("");
  return out;
}
