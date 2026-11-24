import { promises as fs } from "node:fs";
import path from "node:path";
import type { ResearchFile } from "@buildrax/ir";
import { planResearch, runResearch, type PlannedRequest } from "@buildrax/research";
import { buildraxDir, loadModel, researchPathFor } from "./data.js";

export interface ResearchPlan {
  requests: PlannedRequest[];
  hosts: string[];
}

/** What `research` would send. Performs no network access. */
export async function researchPlan(
  repo: string,
  opts: { limit?: number } = {},
): Promise<ResearchPlan> {
  const { requests } = planResearch(await loadModel(repo), { limit: opts.limit });
  return { requests, hosts: [...new Set(requests.map((r) => new URL(r.url).host))].sort() };
}

export function formatPlan(plan: ResearchPlan): string {
  if (!plan.requests.length)
    return "Nothing to research: no npm or PyPI dependencies, runtimes or databases with versions were found in the model.";
  return [
    `Research plan: ${plan.requests.length} request(s) to ${plan.hosts.join(", ")}. Nothing has been sent.`,
    ...plan.requests.map(
      (r) =>
        `  ${r.provider.padEnd(13)} ${r.subject.padEnd(24)} ${r.method ?? "GET"} ${r.url}${r.body ? `  ${r.body}` : ""}`,
    ),
    "Only public package and product names, and the versions pinned in your lockfiles, are sent. Source code, file paths, repo name and notes never leave this machine.",
    "Run again with --online to fetch these.",
  ].join("\n");
}

/** Fetch findings (explicit opt-in) and write `.buildrax/research.json` atomically. */
export async function researchCommand(
  repo: string,
  opts: { limit?: number; cache?: boolean } = {},
): Promise<ResearchFile> {
  const model = await loadModel(repo);
  const root = path.resolve(repo);
  const file = await runResearch(model, {
    limit: opts.limit,
    cacheDir: opts.cache === false ? undefined : path.join(buildraxDir(root), "cache", "research"),
  });
  const out = researchPathFor(root);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(`${out}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
  await fs.rename(`${out}.tmp`, out);
  return file;
}

export function formatResearch(f: ResearchFile): string {
  const subjects = new Set(f.findings.map((x) => x.subject));
  return [
    `${f.findings.length} finding(s) for ${subjects.size} dependenc${subjects.size === 1 ? "y" : "ies"}, retrieved ${f.generatedAt}`,
    ...f.findings.map(
      (x) => `  [${x.reliability}] ${x.subject}: ${x.finding}\n      source: ${x.sourceUrl}`,
    ),
    ...(f.errors.length
      ? [
          `${f.errors.length} lookup(s) failed (absence of a finding is not evidence):`,
          ...f.errors.map((e) => `  ${e.subject} (${e.provider}): ${e.message}`),
        ]
      : []),
  ].join("\n");
}
