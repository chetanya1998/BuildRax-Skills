import { promises as fs } from "node:fs";
import path from "node:path";

const posix = path.posix;

/**
 * Path aliases from tsconfig.json / jsconfig.json (`compilerOptions.paths` and `baseUrl`), so
 * imports like `@/lib/db` resolve to files instead of being reported as unresolved. Only the
 * config files are read; nothing is executed. `extends` is followed for relative paths.
 */
export interface AliasConfig {
  /** Directory of the config file (repo-relative, "" for the root). */
  dir: string;
  /** Repo-relative base for `paths` targets. */
  base: string;
  /** `baseUrl` set explicitly: bare specifiers may resolve from it. */
  baseUrl?: string;
  paths: { pattern: string; targets: string[] }[];
}

/** Parse JSON with comments and trailing commas (the tsconfig dialect). Strings are respected. */
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface RawCompiler {
  extends?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

async function readConfig(
  root: string,
  rel: string,
  depth = 0,
): Promise<{ baseUrl?: string; paths?: Record<string, string[]>; pathsDir?: string } | undefined> {
  let json: RawCompiler;
  try {
    const text = await fs.readFile(path.join(root, rel), "utf8");
    if (text.length > 1_000_000) return undefined;
    json = parseJsonc(text) as RawCompiler;
  } catch {
    return undefined;
  }
  const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
  let inherited: Awaited<ReturnType<typeof readConfig>>;
  const ext = typeof json.extends === "string" ? json.extends : undefined;
  if (ext && /^\.\.?\//.test(ext) && depth < 4) {
    const target = posix.normalize(posix.join(dir, ext.endsWith(".json") ? ext : `${ext}.json`));
    if (!target.startsWith("..")) inherited = await readConfig(root, target, depth + 1);
  }
  const co = json.compilerOptions ?? {};
  const baseUrl =
    typeof co.baseUrl === "string"
      ? posix.normalize(posix.join(dir, co.baseUrl))
      : inherited?.baseUrl;
  const own =
    co.paths && typeof co.paths === "object"
      ? Object.fromEntries(
          Object.entries(co.paths as Record<string, unknown>)
            .filter(([, v]) => Array.isArray(v))
            .map(([k, v]) => [
              k,
              (v as unknown[]).filter((x): x is string => typeof x === "string"),
            ]),
        )
      : undefined;
  return {
    baseUrl,
    paths: own ?? inherited?.paths,
    // TS resolves `paths` against baseUrl, or against the config that declares them.
    pathsDir: own ? dir : inherited?.pathsDir,
  };
}

export async function readAliasConfigs(
  root: string,
  files: readonly string[],
): Promise<AliasConfig[]> {
  const out: AliasConfig[] = [];
  for (const f of [...files].sort()) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    if (base !== "tsconfig.json" && base !== "jsconfig.json") continue;
    const c = await readConfig(root, f);
    if (!c || (!c.paths && !c.baseUrl)) continue;
    const dir = posix.dirname(f) === "." ? "" : posix.dirname(f);
    const clean = (p: string) => (p === "." ? "" : p);
    out.push({
      dir,
      base: clean(c.baseUrl ?? c.pathsDir ?? dir),
      ...(c.baseUrl ? { baseUrl: clean(c.baseUrl) } : {}),
      paths: Object.entries(c.paths ?? {}).map(([pattern, targets]) => ({ pattern, targets })),
    });
  }
  // Deepest config first: the nearest one applies to a file.
  return out.sort((a, b) => b.dir.length - a.dir.length || (a.dir < b.dir ? -1 : 1));
}

/**
 * Candidate repo-relative paths (without extension handling) for a specifier under the config
 * nearest to `fromFile`, in TypeScript's order: matching `paths` patterns, then `baseUrl`.
 */
export function aliasCandidates(
  configs: readonly AliasConfig[],
  fromFile: string,
  spec: string,
): string[] {
  const cfg = configs.find((c) => c.dir === "" || fromFile.startsWith(`${c.dir}/`));
  if (!cfg) return [];
  const out: string[] = [];
  // Longest prefix wins, like TypeScript.
  const matches = cfg.paths
    .map((p) => {
      const star = p.pattern.indexOf("*");
      if (star < 0)
        return p.pattern === spec ? { p, captured: "", score: p.pattern.length } : undefined;
      const pre = p.pattern.slice(0, star);
      const post = p.pattern.slice(star + 1);
      if (!spec.startsWith(pre) || !spec.endsWith(post) || spec.length < pre.length + post.length)
        return undefined;
      return { p, captured: spec.slice(pre.length, spec.length - post.length), score: pre.length };
    })
    .filter((m): m is NonNullable<typeof m> => !!m)
    .sort((a, b) => b.score - a.score);
  for (const m of matches)
    for (const t of m.p.targets)
      out.push(posix.normalize(posix.join(cfg.base, t.replace("*", m.captured))));
  if (cfg.baseUrl !== undefined) out.push(posix.normalize(posix.join(cfg.baseUrl, spec)));
  return out.filter((p) => !p.startsWith(".."));
}
