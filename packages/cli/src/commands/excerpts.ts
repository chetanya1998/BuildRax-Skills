import { promises as fs } from "node:fs";
import path from "node:path";
import type { Model } from "@buildrax/ir";
import { modelFilePaths } from "./sources.js";

/**
 * Redacted excerpts of deploy/config files (compose, Terraform, Kubernetes, lockfiles, …) around
 * the lines the scan recorded as evidence, for the viewer's Code view. Only ±RADIUS lines around
 * recorded evidence are ever read back, never whole files, and secret-looking values are masked
 * before anything leaves this module.
 */
export const RADIUS = 3;
const MAX_FILE_BYTES = 512_000;
const MAX_EXCERPTS = 2000;
export const MASK = "••••••";

export interface Excerpt {
  start: number;
  lines: string[];
}

/** Keys whose values are secrets: password, token, secret, …key, credentials, connection strings. */
const SECRET_KEY =
  /(pass(word|wd|phrase)?|secret|token|credential|private|auth|api[_-]?key|access[_-]?key|(^|[_\-.])key$|salt|signature|cookie|session|dsn|connection[_-]?string|database[_-]?url|_url$)/i;
/** Values that only refer to a secret elsewhere: not secrets themselves, and useful to see. */
const REFERENCE =
  /^(\$\{[^}]*\}|\$\([^)]*\)|\{\{[^}]*\}\}|var\.[\w.]+|local\.[\w.]+|data\.[\w.]+|module\.[\w.]+|secretKeyRef|valueFrom)$/;
/** Well-known token shapes, masked wherever they appear. */
const TOKENS: RegExp[] = [
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_(live|test)_[A-Za-z0-9]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // Long base64-like runs (key material, certificates).
  /\b[A-Za-z0-9+/]{40,}={0,2}/g,
];

function maskValue(raw: string): string {
  const v = raw.trim();
  if (!v || v === "|" || v === ">" || REFERENCE.test(v.replace(/^["']|["']$/g, ""))) return raw;
  const quote = /^["']/.exec(v)?.[0] ?? "";
  const lead = raw.slice(0, raw.indexOf(v));
  const trail = /,\s*$/.test(v) ? "," : "";
  return `${lead}${quote}${MASK}${quote}${trail}`;
}

/** Mask the secrets in one line of YAML, HCL, TOML, JSON, .env or Procfile text. */
export function redactLine(line: string): string {
  let out = line;
  // user:password@ in connection URLs
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, `$1${MASK}$3`);
  for (const re of TOKENS) out = out.replace(re, MASK);
  // key: value | key = value | "key": value | - KEY=value | KEY=value
  const m = /^(\s*(?:-\s+)?["']?)([A-Za-z_][\w.-]*)(["']?\s*(?::|=)\s*)(.+)$/.exec(out);
  if (m && SECRET_KEY.test(m[2]!) && !/^\s*[{[]\s*$/.test(m[4]!))
    out = `${m[1]}${m[2]}${m[3]}${maskValue(m[4]!)}`;
  return out;
}

export function excerptOf(text: string, line: number): Excerpt | undefined {
  const all = text.split("\n");
  if (line < 1 || line > all.length) return undefined;
  const start = Math.max(1, line - RADIUS);
  const end = Math.min(all.length, line + RADIUS);
  return { start, lines: all.slice(start - 1, end).map(redactLine) };
}

/**
 * Evidence anchors in non-source files: (file, line) pairs the scan recorded on nodes or edges.
 * These are the only places excerpts may come from.
 */
export function configAnchors(model: Model): Map<string, Set<number>> {
  const sources = modelFilePaths(model);
  const out = new Map<string, Set<number>>();
  const add = (file: string | undefined, line: number | undefined): void => {
    if (!file || !line || sources.has(file)) return;
    // Real environment files are never opened by the scanner; never read them here either.
    if (/(^|\/)\.env(\.[\w-]+)?$/.test(file) && !/\.(example|sample|template|dist)$/.test(file))
      return;
    const set = out.get(file) ?? new Set<number>();
    set.add(line);
    out.set(file, set);
  };
  for (const n of model.nodes) for (const ev of n.evidence) add(ev.file, ev.startLine);
  for (const e of model.edges) for (const ev of e.evidence) add(ev.file, ev.startLine);
  return out;
}

async function readInside(repo: string, rel: string): Promise<string | undefined> {
  const root = await fs.realpath(path.resolve(repo));
  try {
    const real = await fs.realpath(path.resolve(root, rel));
    const inside = path.relative(root, real);
    if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
    const st = await fs.stat(real);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    return await fs.readFile(real, "utf8");
  } catch {
    return undefined;
  }
}

/** One excerpt, only if (file, line) is recorded evidence in the model (for `serve`). */
export async function readExcerpt(
  repo: string,
  model: Model,
  file: string,
  line: number,
): Promise<Excerpt | undefined> {
  if (!configAnchors(model).get(file)?.has(line)) return undefined;
  const text = await readInside(repo, file);
  return text === undefined ? undefined : excerptOf(text, line);
}

/** All excerpts for a static viewer, keyed `file:line`. */
export async function collectExcerpts(
  repo: string,
  model: Model,
): Promise<Record<string, Excerpt>> {
  const out: Record<string, Excerpt> = {};
  let count = 0;
  for (const [file, lines] of [...configAnchors(model)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const text = await readInside(repo, file);
    if (text === undefined) continue;
    for (const line of [...lines].sort((a, b) => a - b)) {
      if (count >= MAX_EXCERPTS) return out;
      const ex = excerptOf(text, line);
      if (ex) {
        out[`${file}:${line}`] = ex;
        count++;
      }
    }
  }
  return out;
}
