import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Lang } from "./languages.js";
import type { RawImport } from "./parser.js";
import type { FileFacts } from "./routes/facts.js";

/**
 * Per-file parse cache for incremental scans. Parsing is the expensive step; everything after it
 * (resolution, grouping, infrastructure) is rebuilt from scratch every time, so a cached scan
 * produces exactly the same model as a full one.
 *
 * Entries are keyed by repo-relative path and invalidated by a content hash. The whole cache is
 * discarded when the parser fingerprint (scanner version + grammar package) changes.
 */
export interface ParseEntry {
  hash: string;
  lang: Lang;
  lines: number;
  imports: RawImport[];
  facts: FileFacts;
}

interface CacheFile {
  format: "buildrax-scan-cache/v1";
  fingerprint: string;
  files: Record<string, ParseEntry>;
}

export const hashText = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

export class ParseCache {
  private readonly next: Record<string, ParseEntry> = {};
  hits = 0;
  misses = 0;

  private constructor(
    private readonly file: string | undefined,
    private readonly fingerprint: string,
    private readonly prev: Record<string, ParseEntry>,
  ) {}

  /** Load the cache from `file` (missing, corrupt or stale caches start empty). */
  static async open(file: string | undefined, fingerprint: string): Promise<ParseCache> {
    if (!file) return new ParseCache(undefined, fingerprint, {});
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Partial<CacheFile>;
      const ok =
        raw.format === "buildrax-scan-cache/v1" &&
        raw.fingerprint === fingerprint &&
        raw.files &&
        typeof raw.files === "object";
      return new ParseCache(file, fingerprint, ok ? raw.files! : {});
    } catch {
      return new ParseCache(file, fingerprint, {});
    }
  }

  /** Cached parse for this exact content, if any. */
  get(rel: string, hash: string, lang: Lang): ParseEntry | undefined {
    const e = this.prev[rel];
    if (e && e.hash === hash && e.lang === lang && Array.isArray(e.imports) && e.facts) {
      this.hits++;
      this.next[rel] = e;
      return e;
    }
    this.misses++;
    return undefined;
  }

  put(rel: string, entry: ParseEntry): void {
    this.next[rel] = entry;
  }

  /** Write only entries seen in this scan (deleted files drop out). */
  async save(): Promise<void> {
    if (!this.file) return;
    const out: CacheFile = {
      format: "buildrax-scan-cache/v1",
      fingerprint: this.fingerprint,
      files: Object.fromEntries(Object.entries(this.next).sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(`${this.file}.tmp`, JSON.stringify(out));
    await fs.rename(`${this.file}.tmp`, this.file);
  }
}
