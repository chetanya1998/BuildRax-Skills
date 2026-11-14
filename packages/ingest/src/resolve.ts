import { builtinModules } from "node:module";
import path from "node:path";

const posix = path.posix;
const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export function isRelativeSpecifier(spec: string): boolean {
  return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

/** Resolve a relative TS/JS specifier to an existing repo file, or undefined. */
export function resolveRelativeJs(
  fromFile: string,
  spec: string,
  files: ReadonlySet<string>,
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  const candidates: string[] = [base];
  const ext = posix.extname(base);
  if (JS_TO_TS[ext]) {
    const stem = base.slice(0, -ext.length);
    for (const e of JS_TO_TS[ext]!) candidates.push(stem + e);
  }
  for (const e of TS_EXTS) candidates.push(base + e);
  for (const e of TS_EXTS) candidates.push(posix.join(base, `index${e}`));
  return candidates.find((c) => files.has(c));
}

const NODE_BUILTINS = new Set(builtinModules);

export function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0]!);
}

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`. */
export function npmPackageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Aliases we cannot resolve without tsconfig `paths` support. */
export function looksLikePathAlias(spec: string): boolean {
  return spec.startsWith("@/") || spec.startsWith("~/") || spec.startsWith("#");
}

const PY_STDLIB = new Set(
  (
    "abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar cmath collections " +
    "colorsys concurrent configparser contextlib copy csv ctypes dataclasses datetime decimal difflib " +
    "dis email enum errno fnmatch fractions ftplib functools gc getopt getpass gettext glob gzip hashlib " +
    "heapq hmac html http imaplib importlib inspect io ipaddress itertools json keyword linecache locale " +
    "logging lzma math mimetypes multiprocessing numbers operator os pathlib pickle pkgutil platform pprint " +
    "queue random re secrets select shelve shlex shutil signal smtplib socket sqlite3 ssl stat statistics " +
    "string struct subprocess sys tempfile textwrap threading time timeit tkinter token tokenize traceback " +
    "types typing unicodedata unittest urllib uuid venv warnings weakref xml zipfile zlib zoneinfo __future__"
  ).split(" "),
);

export function isPythonStdlib(top: string): boolean {
  return PY_STDLIB.has(top);
}

export interface PythonResolution {
  targets: string[];
  /** Top-level distribution name when the import is third-party. */
  external?: string;
  /** True when a relative import matched nothing. */
  unresolved?: boolean;
  /** True for standard-library imports (ignored). */
  stdlib?: boolean;
}

function pyModuleFile(
  parts: string[],
  base: string,
  files: ReadonlySet<string>,
): string | undefined {
  const rel = posix.normalize(posix.join(base, ...parts));
  return [`${rel}.py`, posix.join(rel, "__init__.py")].find((c) => files.has(c));
}

/** Resolve a Python import. `roots` are directories to try for absolute imports. */
export function resolvePython(
  fromFile: string,
  spec: string,
  names: readonly string[],
  roots: readonly string[],
  files: ReadonlySet<string>,
): PythonResolution {
  const dots = /^\.*/.exec(spec)![0].length;
  const modParts = spec.slice(dots).split(".").filter(Boolean);

  if (dots > 0) {
    let base = posix.dirname(fromFile);
    for (let i = 1; i < dots; i++) base = posix.dirname(base);
    const targets = new Set<string>();
    if (modParts.length) {
      const f = pyModuleFile(modParts, base, files);
      if (f) targets.add(f);
    }
    for (const n of names) {
      const f = pyModuleFile([...modParts, n], base, files);
      if (f) targets.add(f);
    }
    if (!targets.size) {
      const init = pyModuleFile(modParts, base, files);
      if (init) targets.add(init);
    }
    return targets.size ? { targets: [...targets].sort() } : { targets: [], unresolved: true };
  }

  const targets = new Set<string>();
  for (const root of roots) {
    for (let len = modParts.length; len > 0; len--) {
      const f = pyModuleFile(modParts.slice(0, len), root, files);
      if (f) {
        targets.add(f);
        break;
      }
    }
    for (const n of names) {
      const f = pyModuleFile([...modParts, n], root, files);
      if (f) targets.add(f);
    }
    if (targets.size) return { targets: [...targets].sort() };
  }
  const top = modParts[0] ?? spec;
  if (isPythonStdlib(top)) return { targets: [], stdlib: true };
  return { targets: [], external: top.toLowerCase().replace(/_/g, "-") };
}
