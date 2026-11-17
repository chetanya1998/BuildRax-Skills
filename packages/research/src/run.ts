import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  RESEARCH_SCHEMA_VERSION,
  validateResearch,
  type Finding,
  type Model,
  type ResearchFile,
} from "@buildrax/ir";
import { DEFAULT_PROVIDERS } from "./providers.js";
import { extractTechnologies } from "./tech.js";
import type { FetchLike, PlannedRequest, Provider, Technology } from "./types.js";

export interface PlanOptions {
  providers?: readonly Provider[];
  /** Research at most this many technologies (most used first). */
  limit?: number;
}

/** Exactly what would be requested. Pure: performs no I/O. */
export function planResearch(
  model: Model,
  opts: PlanOptions = {},
): { techs: Technology[]; requests: PlannedRequest[] } {
  const providers = opts.providers ?? DEFAULT_PROVIDERS;
  const techs = extractTechnologies(model).slice(0, opts.limit ?? 50);
  const requests: PlannedRequest[] = [];
  for (const t of techs) {
    const p = providers.find((x) => x.supports(t));
    if (p) requests.push(p.request(t));
  }
  return { techs, requests };
}

export interface RunOptions extends PlanOptions {
  fetchFn?: FetchLike;
  now?: string;
  /** Directory for cached responses; omit to disable caching. */
  cacheDir?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  concurrency?: number;
}

const MAX_BYTES = 2_000_000;

async function cachedFetch(
  url: string,
  hosts: readonly string[],
  opts: RunOptions,
): Promise<unknown> {
  // Hard allowlist: a provider can only ever reach the hosts it declares, over https.
  const u = new URL(url);
  if (u.protocol !== "https:" || !hosts.includes(u.host))
    throw new Error(`blocked request to ${u.host}`);
  const file = opts.cacheDir
    ? path.join(opts.cacheDir, `${createHash("sha256").update(url).digest("hex")}.json`)
    : undefined;
  if (file) {
    try {
      const st = await fs.stat(file);
      if (Date.now() - st.mtimeMs < (opts.cacheTtlMs ?? 86_400_000))
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      /* cache miss */
    }
  }
  const doFetch = opts.fetchFn ?? ((url2, init) => fetch(url2, init));
  const res = await doFetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "buildrax-research (open-source architecture tool)",
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("response too large");
  const json: unknown = JSON.parse(text);
  if (file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return json;
}

/** Run the planned lookups. Failures are recorded, never swallowed, so absence is not misread. */
export async function runResearch(model: Model, opts: RunOptions = {}): Promise<ResearchFile> {
  const providers = opts.providers ?? DEFAULT_PROVIDERS;
  const now = opts.now ?? new Date().toISOString();
  const { techs } = planResearch(model, opts);
  const findings: Finding[] = [];
  const errors: ResearchFile["errors"] = [];

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < techs.length) {
      const tech = techs[next++]!;
      const provider = providers.find((p) => p.supports(tech));
      if (!provider) continue;
      const req = provider.request(tech);
      try {
        const json = await cachedFetch(req.url, provider.hosts, opts);
        findings.push(...provider.parse(tech, json, { url: req.url, now }));
      } catch (err) {
        errors.push({
          subject: tech.name,
          provider: provider.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, techs.length) }, worker));

  const file: ResearchFile = {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    generatedAt: now,
    findings: findings.sort((a, b) => (a.id < b.id ? -1 : 1)),
    errors: errors.sort((a, b) => (a.subject < b.subject ? -1 : 1)),
  };
  const checked = validateResearch(file);
  if (!checked.ok)
    throw new Error(`research output failed validation: ${checked.errors.slice(0, 3).join("; ")}`);
  return file;
}
