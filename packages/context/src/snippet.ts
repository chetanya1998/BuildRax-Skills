import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_LINES = 20;

/**
 * Read a few lines around `line` from a repo file. Refuses paths outside the repo root, hidden
 * secret files and anything over the line cap, so context packs can never leak arbitrary files.
 */
export async function readSnippet(
  root: string,
  file: string,
  line: number,
  radius = 1,
): Promise<string | undefined> {
  const abs = path.resolve(root, file);
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep);
  if (parts.some((p) => p === ".git" || p === "node_modules" || p.startsWith(".env")))
    return undefined;
  try {
    const lines = (await fs.readFile(abs, "utf8")).split("\n");
    const start = Math.max(1, line - radius);
    const end = Math.min(lines.length, start + Math.min(MAX_LINES, radius * 2 + 1) - 1);
    return lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}| ${l}`)
      .join("\n");
  } catch {
    return undefined;
  }
}
