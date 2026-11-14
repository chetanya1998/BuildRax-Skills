import { promises as fs } from "node:fs";
import path from "node:path";

const posix = path.posix;

export interface PackageInfo {
  /** Repo-relative directory ("" for the repo root). */
  dir: string;
  manifest: string;
  /** Package name from the manifest, when readable. */
  name?: string;
  ecosystem: "npm" | "python";
}

/** Detect package roots from manifests only (package.json, pyproject.toml). Nothing is executed. */
export async function detectPackages(
  root: string,
  files: readonly string[],
): Promise<PackageInfo[]> {
  const out: PackageInfo[] = [];
  for (const f of files) {
    const base = posix.basename(f);
    if (base !== "package.json" && base !== "pyproject.toml") continue;
    const dir = posix.dirname(f) === "." ? "" : posix.dirname(f);
    let name: string | undefined;
    try {
      const text = await fs.readFile(path.join(root, f), "utf8");
      if (base === "package.json") {
        const n = (JSON.parse(text) as { name?: unknown }).name;
        if (typeof n === "string") name = n;
      } else {
        name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
      }
    } catch {
      /* unreadable or invalid manifest: keep going without a name */
    }
    out.push({ dir, manifest: f, name, ecosystem: base === "package.json" ? "npm" : "python" });
  }
  return out;
}

/** Nearest ancestor package for a file (deepest dir wins). */
export function owningPackage(
  file: string,
  packages: readonly PackageInfo[],
): PackageInfo | undefined {
  let best: PackageInfo | undefined;
  for (const p of packages) {
    const inside = p.dir === "" || file.startsWith(`${p.dir}/`);
    if (inside && (!best || p.dir.length > best.dir.length)) best = p;
  }
  return best;
}

/**
 * Directory grouping inside a package: the first directory below the package root (skipping a
 * leading `src/`). Returns undefined for files that sit directly at the source root.
 */
export function groupDirFor(file: string, pkgDir: string): string | undefined {
  let rel = pkgDir ? file.slice(pkgDir.length + 1) : file;
  let prefix = pkgDir;
  if (rel.startsWith("src/")) {
    rel = rel.slice(4);
    prefix = prefix ? `${prefix}/src` : "src";
  }
  const parts = rel.split("/");
  if (parts.length < 2) return undefined;
  return prefix ? `${prefix}/${parts[0]}` : parts[0]!;
}
