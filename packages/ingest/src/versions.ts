import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Evidence, Model } from "@buildrax/ir";

/**
 * Pinned versions (from lockfiles) and declared runtimes (engines, .nvmrc, …). Static: files are
 * only read and parsed, nothing is installed or executed. Results are attached to the model as
 * `meta.version` / `meta.versions` on external nodes and `meta.runtimes` on the project node, each
 * with `config` evidence pointing at the lockfile line.
 */

export interface Locked {
  version: string;
  file: string;
  line?: number;
}

export interface RuntimeDecl {
  /** endoflife.date product id. */
  product: "nodejs" | "python";
  /** As written, e.g. ">=20", "20.11.1", "3.12". */
  declared: string;
  /** The oldest version the declaration allows (what lifecycle checks should use). */
  version: string;
  file: string;
  line?: number;
}

const MAX = 8_000_000;

/** PEP 503 normalisation so `PyYAML`, `pyyaml` and `py_yaml` match. */
export const normalizePy = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

const lineOf = (text: string, needle: string): number | undefined => {
  const i = text.indexOf(needle);
  return i < 0 ? undefined : text.slice(0, i).split("\n").length;
};

type Add = (eco: "npm" | "pypi", name: string, l: Locked) => void;

function packageLock(file: string, text: string, add: Add): void {
  const j = JSON.parse(text) as {
    packages?: Record<string, { version?: string; link?: boolean }>;
    dependencies?: Record<string, { version?: string }>;
  };
  if (j.packages) {
    for (const [key, v] of Object.entries(j.packages)) {
      // Direct installs only: "node_modules/x" or "node_modules/@s/x" (not nested copies).
      const m = /^(?:.*\/)?node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (!m || key.split("node_modules/").length > 2 || v.link || !v.version) continue;
      add("npm", m[1]!, { version: v.version, file, line: lineOf(text, `"${key}"`) });
    }
  } else if (j.dependencies) {
    for (const [name, v] of Object.entries(j.dependencies))
      if (v.version)
        add("npm", name, { version: v.version, file, line: lineOf(text, `"${name}"`) });
  }
}

function pnpmLock(file: string, text: string, add: Add): void {
  const j = parseYaml(text, { maxAliasCount: 100 }) as {
    importers?: Record<string, Record<string, Record<string, unknown>>>;
    dependencies?: Record<string, unknown>;
  };
  const sections = j.importers
    ? Object.values(j.importers)
    : [j as Record<string, Record<string, unknown>>];
  for (const imp of sections)
    for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, v] of Object.entries(imp?.[sec] ?? {})) {
        const raw =
          typeof v === "string"
            ? v
            : typeof v === "object" && v
              ? (v as { version?: unknown }).version
              : undefined;
        if (typeof raw !== "string" || /^(link|file|workspace):/.test(raw)) continue;
        const version = raw.replace(/\(.*$/, "").trim();
        if (/^\d/.test(version))
          add("npm", name, {
            version,
            file,
            line: lineOf(text, `'${name}':`) ?? lineOf(text, `${name}:`),
          });
      }
    }
}

function yarnLock(file: string, text: string, add: Add): void {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!;
    if (!head || head.startsWith(" ") || head.startsWith("#") || !head.endsWith(":")) continue;
    const first = head.slice(0, -1).split(",")[0]!.trim().replace(/^"|"$/g, "");
    const at = first.lastIndexOf("@");
    if (at <= 0) continue;
    const name = first.slice(0, at);
    for (let k = i + 1; k < lines.length && lines[k]!.startsWith(" "); k++) {
      const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(lines[k]!);
      if (m) {
        add("npm", name, { version: m[1]!, file, line: i + 1 });
        break;
      }
    }
  }
}

/** poetry.lock and uv.lock share the `[[package]] name = … version = …` layout. */
function tomlPackages(file: string, text: string, add: Add): void {
  const re = /^\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/gm;
  for (let m = re.exec(text); m; m = re.exec(text))
    add("pypi", m[1]!, {
      version: m[2]!,
      file,
      line: text.slice(0, m.index).split("\n").length + 1,
    });
}

function requirements(file: string, text: string, add: Add): void {
  text.split("\n").forEach((l, i) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([0-9][^\s;#,]*)/.exec(l);
    if (m) add("pypi", m[1]!, { version: m[2]!, file, line: i + 1 });
  });
}

function pipfileLock(file: string, text: string, add: Add): void {
  const j = JSON.parse(text) as Record<string, Record<string, { version?: string }>>;
  for (const sec of ["default", "develop"])
    for (const [name, v] of Object.entries(j[sec] ?? {})) {
      const version = v.version?.replace(/^==/, "");
      if (version) add("pypi", name, { version, file, line: lineOf(text, `"${name}"`) });
    }
}

const LOCKFILES: [RegExp, (file: string, text: string, add: Add) => void][] = [
  [/(^|\/)package-lock\.json$/, packageLock],
  [/(^|\/)npm-shrinkwrap\.json$/, packageLock],
  [/(^|\/)pnpm-lock\.yaml$/, pnpmLock],
  [/(^|\/)yarn\.lock$/, yarnLock],
  [/(^|\/)(poetry|uv)\.lock$/, tomlPackages],
  [/(^|\/)requirements[\w.-]*\.txt$/, requirements],
  [/(^|\/)Pipfile\.lock$/, pipfileLock],
];

async function read(root: string, rel: string): Promise<string | undefined> {
  try {
    const abs = path.join(root, rel);
    if ((await fs.stat(abs)).size > MAX) return undefined;
    return await fs.readFile(abs, "utf8");
  } catch {
    return undefined;
  }
}

/** Every locked version per `npm:<name>` / `pypi:<normalized name>`, sorted for determinism. */
export async function readLockedVersions(
  root: string,
  files: readonly string[],
): Promise<Map<string, Locked[]>> {
  const out = new Map<string, Locked[]>();
  const add: Add = (eco, name, l) => {
    const key = eco === "npm" ? `npm:${name}` : `pypi:${normalizePy(name)}`;
    const list = out.get(key) ?? [];
    if (!list.some((x) => x.version === l.version && x.file === l.file)) list.push(l);
    out.set(key, list);
  };
  for (const f of [...files].sort()) {
    const parser = LOCKFILES.find(([re]) => re.test(f))?.[1];
    if (!parser) continue;
    const text = await read(root, f);
    if (text === undefined) continue;
    try {
      parser(f, text, add);
    } catch {
      /* malformed lockfile: skip it, never guess */
    }
  }
  return out;
}

/** Oldest version a declaration allows: ">=20.11" → "20.11", "^3.12" → "3.12", "v22" → "22". */
export function minimumVersion(declared: string): string | undefined {
  const lower = /(?:>=|\^|~>?|==|=)\s*v?(\d+(?:\.\d+){0,2})/.exec(declared);
  if (lower) return lower[1];
  if (/[<>]/.test(declared)) return undefined; // only an upper bound, or a strict one: unknown minimum
  return /^\s*v?(\d+(?:\.\d+){0,2})/.exec(declared)?.[1];
}

export async function readRuntimes(root: string, files: readonly string[]): Promise<RuntimeDecl[]> {
  const out: RuntimeDecl[] = [];
  const push = (product: RuntimeDecl["product"], declared: string, file: string, text: string) => {
    const version = minimumVersion(declared.trim());
    if (version)
      out.push({
        product,
        declared: declared.trim(),
        version,
        file,
        line: lineOf(text, declared.trim()),
      });
  };
  for (const f of [...files].sort()) {
    if (f.includes("/")) continue; // root files decide the runtime
    const base = f;
    if (base === "package.json") {
      const text = await read(root, f);
      try {
        const node = (JSON.parse(text ?? "{}") as { engines?: { node?: unknown } }).engines?.node;
        if (typeof node === "string" && text) push("nodejs", node, f, text);
      } catch {
        /* invalid manifest */
      }
    } else if (base === ".nvmrc" || base === ".node-version") {
      const text = (await read(root, f)) ?? "";
      const v = text.split("\n")[0]?.trim();
      if (v && /\d/.test(v)) push("nodejs", v, f, text);
    } else if (base === ".python-version") {
      const text = (await read(root, f)) ?? "";
      const v = text.split("\n")[0]?.trim();
      if (v && /^\d/.test(v)) push("python", v, f, text);
    } else if (base === "pyproject.toml") {
      const text = (await read(root, f)) ?? "";
      const m = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(text);
      if (m) push("python", m[1]!, f, text);
    }
  }
  return out;
}

/** Attach versions and runtimes to the model (new objects; deterministic). */
export function withVersions(
  model: Model,
  locked: Map<string, Locked[]>,
  runtimes: RuntimeDecl[],
): Model {
  const nodes = model.nodes.map((n) => {
    if (n.kind === "project" && runtimes.length)
      return {
        ...n,
        meta: {
          ...(n.meta ?? {}),
          runtimes: runtimes.map(({ product, declared, version, file }) => ({
            product,
            declared,
            version,
            file,
          })),
        },
        evidence: [
          ...n.evidence,
          ...runtimes.map<Evidence>((r) => ({
            kind: "config",
            file: r.file,
            startLine: r.line,
            detail: `${r.product} ${r.declared}`,
          })),
        ],
      };
    if (n.kind !== "external") return n;
    const eco = n.meta?.["ecosystem"];
    const key =
      eco === "npm" ? `npm:${n.name}` : eco === "pypi" ? `pypi:${normalizePy(n.name)}` : undefined;
    const list = key ? locked.get(key) : undefined;
    if (!list?.length) return n;
    const versions = [...new Set(list.map((l) => l.version))].sort();
    return {
      ...n,
      meta: {
        ...(n.meta ?? {}),
        ...(versions.length === 1 ? { version: versions[0] } : { versions }),
      },
      evidence: [
        ...n.evidence,
        ...list.slice(0, 5).map<Evidence>((l) => ({
          kind: "config",
          file: l.file,
          startLine: l.line,
          detail: `locked ${l.version}`,
        })),
      ],
    };
  });
  return { ...model, nodes };
}
