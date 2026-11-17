import { promises as fs } from "node:fs";
import path from "node:path";
import type { Model } from "@buildrax/ir";

const MAX_FILE_BYTES = 300_000;
const MAX_TOTAL_BYTES = 8_000_000;
const MAX_SERVED_BYTES = 1_000_000;

/** Repo-relative paths of source files the scan found. Only these may ever be read back. */
export function modelFilePaths(model: Model): Set<string> {
  const out = new Set<string>();
  for (const n of model.nodes) if (n.kind === "file" && n.path) out.add(n.path);
  return out;
}

/**
 * Read one scanned source file. The path must be a file node of the model and, after resolving
 * symlinks, must stay inside the repo root, so this cannot be used to read anything else.
 */
export async function readModelFile(
  repo: string,
  model: Model,
  rel: string,
  maxBytes = MAX_SERVED_BYTES,
): Promise<string | undefined> {
  if (!modelFilePaths(model).has(rel)) return undefined;
  const root = await fs.realpath(path.resolve(repo));
  try {
    const real = await fs.realpath(path.resolve(root, rel));
    const inside = path.relative(root, real);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
    const st = await fs.stat(real);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return await fs.readFile(real, "utf8");
  } catch {
    return undefined;
  }
}

/** Source text to embed in a static viewer file, capped per file and in total. */
export async function collectSources(
  repo: string,
  model: Model,
): Promise<{ files: Record<string, string>; omitted: string[] }> {
  const files: Record<string, string> = {};
  const omitted: string[] = [];
  let total = 0;
  for (const rel of [...modelFilePaths(model)].sort()) {
    const text = await readModelFile(repo, model, rel, MAX_FILE_BYTES);
    if (text === undefined || total + text.length > MAX_TOTAL_BYTES) {
      omitted.push(rel);
      continue;
    }
    total += text.length;
    files[rel] = text;
  }
  return { files, omitted };
}
