import { GraphIndex } from "@buildrax/graph";
import type { Model, RationaleFile, RationaleSource } from "@buildrax/ir";
import { loadModel, loadRationale } from "./data.js";
import { resolveTarget } from "./trace.js";

export interface WhyResult {
  node: { id: string; name: string; kind: string; path?: string };
  sources: RationaleSource[];
  /** Sources tied to files or folders inside this node (not listed). */
  inside: number;
  gitRead: boolean;
}

/** Provenance label shown with every source. */
export const PROVENANCE: Record<RationaleSource["kind"], string> = {
  adr: "Documented (decision record)",
  doc: "Documented",
  comment: "From code",
  commit: "From git history",
};

export function whyFor(model: Model, rationale: RationaleFile, target: string): WhyResult {
  const id = resolveTarget(model, target);
  if (!id) throw new Error(`no node matches "${target}". Try a path from \`buildrax digest\`.`);
  const index = new GraphIndex(model);
  const n = index.node(id)!;
  const byId = new Map(rationale.sources.map((s) => [s.id, s] as const));
  const sources = (rationale.byNode[id] ?? [])
    .map((s) => byId.get(s))
    .filter((s): s is RationaleSource => !!s);
  const own = new Set(sources.map((s) => s.id));
  const inside = new Set<string>();
  for (const d of index.descendants(id))
    for (const s of rationale.byNode[d] ?? []) if (!own.has(s)) inside.add(s);
  return {
    node: { id, name: n.name, kind: n.kind, ...(n.path ? { path: n.path } : {}) },
    sources,
    inside: inside.size,
    gitRead: rationale.git.read,
  };
}

async function load(repo: string): Promise<{ model: Model; rationale: RationaleFile }> {
  const [model, rationale] = await Promise.all([loadModel(repo), loadRationale(repo)]);
  if (!rationale)
    throw new Error(
      `no rationale index at .buildrax/rationale.json. Run \`buildrax scan ${repo}\` to create it.`,
    );
  return { model, rationale };
}

export async function whyCommand(repo: string, target: string): Promise<WhyResult> {
  const { model, rationale } = await load(repo);
  return whyFor(model, rationale, target);
}

export async function decisionsCommand(repo: string): Promise<RationaleSource[]> {
  return (await load(repo)).rationale.sources.filter((s) => s.kind === "adr");
}

const where = (s: RationaleSource): string =>
  s.file ? `${s.file}${s.line && s.line > 1 ? `:${s.line}` : ""}` : "";

function line(s: RationaleSource): string[] {
  switch (s.kind) {
    case "adr":
      return [
        `  ${s.title}  (${[s.status, s.date].filter(Boolean).join(", ") || "no status"})  ${where(s)}`,
        `    ${s.excerpt}`,
      ];
    case "doc":
      return [`  ${s.title}  ${where(s)}`, `    ${s.excerpt}`];
    case "comment":
      return [`  ${where(s)}${s.fn ? `  (${s.title})` : ""}`, `    "${s.excerpt}"`];
    case "commit":
      return [
        `  ${s.date} ${s.hash}  ${s.title}`,
        ...(s.excerpt && s.excerpt !== s.title ? [`    ${s.excerpt}`] : []),
      ];
  }
}

export function formatWhy(r: WhyResult): string {
  const out = [`Why: ${r.node.path ?? r.node.name} [${r.node.kind}]`];
  for (const kind of ["adr", "doc", "comment", "commit"] as const) {
    const list = r.sources.filter((s) => s.kind === kind);
    if (!list.length) continue;
    out.push("", `${PROVENANCE[kind]} (${list.length})`, ...list.flatMap(line));
  }
  if (!r.sources.length)
    out.push(
      "",
      "No recorded rationale for this node: no decision record, doc section, explaining comment or commit message names it.",
    );
  if (r.inside) out.push("", `+${r.inside} more tied to files inside it.`);
  if (!r.gitRead) out.push("", "Git history was not read (not a git repository, or --no-git).");
  out.push(
    "",
    "Quoted from the repository as written; links are by exact names and paths, not inferred.",
  );
  return out.join("\n");
}

export function formatDecisions(adrs: RationaleSource[]): string {
  if (!adrs.length)
    return "No decision records found (looked in adr/, decisions/ and files named like 0001-title.md or ADR-12.md).";
  return [
    `${adrs.length} decision record(s)`,
    ...adrs.map(
      (s) =>
        `  ${(s.status ?? "?").padEnd(11)} ${s.date ?? "          "}  ${s.title}  ${s.file ?? ""}`,
    ),
  ].join("\n");
}
