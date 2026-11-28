import { GraphIndex, buildView, fileCycles, hubs } from "@buildrax/graph";
import type { Model, RationaleFile } from "@buildrax/ir";
import { estimateTokens } from "./tokens.js";

export interface DigestOptions {
  /** 0 = packages only, 1 = packages plus their directory modules. */
  level?: 0 | 1;
  /** Soft cap; the digest degrades to level 0 and shorter lists to fit. */
  budgetTokens?: number;
  /** Rationale index: its decision records are listed under DECISIONS. */
  rationale?: RationaleFile;
}

export interface Digest {
  text: string;
  /** Estimated, not measured. */
  tokens: number;
  level: 0 | 1;
}

const short = (path: string): string => path.replace(/^file:/, "");

function render(
  model: Model,
  level: 0 | 1,
  caps: { lists: number },
  rationale?: RationaleFile,
): string {
  const index = new GraphIndex(model);
  const top = model.nodes
    .filter((n) => n.kind === "module" && n.parent?.startsWith("project:"))
    .map((n) => n.id);
  const view = buildView(index, { expanded: new Set(level === 1 ? top : []) });

  const ids = new Map<string, string>();
  const counters: Record<string, number> = { M: 0, X: 0, U: 0, F: 0 };
  for (const n of view.nodes) {
    const p =
      n.kind === "external" ? "X" : n.kind === "unresolved" ? "U" : n.kind === "file" ? "F" : "M";
    ids.set(n.id, `${p}${++counters[p]!}`);
  }
  const label = (id: string): string => ids.get(id) ?? id;

  const s = model.meta.stats;
  const lines: string[] = [
    `BUILDRAX DIGEST repo=${model.meta.repo} schema=${model.schemaVersion} scanned=${model.meta.scannedAt.slice(0, 10)}`,
    `languages: ${model.meta.languages.join(", ") || "none"} | files=${s?.files ?? "?"} nodes=${model.nodes.length} edges=${model.edges.length}`,
    "legend: M=module F=file X=external dependency U=unresolved import; -> depends on; (n)=underlying import count",
    "static analysis only: relationships are extracted from source/manifests, not observed at runtime",
    "",
    "MODULES",
  ];
  for (const n of view.nodes.filter((x) => x.kind === "module" || x.kind === "file")) {
    const orig = index.node(n.id)!;
    const out = view.edges.filter((e) => e.from === n.id);
    const deps = out
      .slice(0, caps.lists + 4)
      .map((e) => `${label(e.to)}${e.count > 1 ? `(${e.count})` : ""}`);
    const extra = out.length > caps.lists + 4 ? ` +${out.length - caps.lists - 4} more` : "";
    const meta = orig.meta?.package ? ` [${String(orig.meta.ecosystem)} ${orig.name}]` : "";
    lines.push(
      `${label(n.id)} ${orig.path ?? orig.name}${meta} files=${n.fileCount}${n.inCycle ? " CYCLE" : ""} -> ${deps.join(" ") || "-"}${extra}`,
    );
  }

  const externals = view.nodes.filter((n) => n.kind === "external");
  if (externals.length) {
    lines.push("", "EXTERNAL (name: used by)");
    for (const x of externals.slice(0, caps.lists * 3)) {
      lines.push(
        `${label(x.id)} ${x.name}: ${view.edges
          .filter((e) => e.to === x.id)
          .map((e) => label(e.from))
          .join(",")}`,
      );
    }
    if (externals.length > caps.lists * 3) lines.push(`+${externals.length - caps.lists * 3} more`);
  }

  const cycles = fileCycles(index);
  lines.push("", cycles.length ? "CYCLES (circular imports)" : "CYCLES: none");
  for (const c of cycles.slice(0, caps.lists)) lines.push(c.map((id) => short(id)).join(" <-> "));

  const hub = hubs(index, "file", Math.min(5, caps.lists));
  if (hub.length) {
    lines.push("", "MOST CONNECTED FILES (in/out)");
    for (const h of hub) lines.push(`${short(h.id)} ${h.fanIn}/${h.fanOut}`);
  }

  const entities = model.nodes.filter((n) => n.kind === "entity");
  if (entities.length) {
    lines.push("", "DATA MODELS (name [table] orm file -> related)");
    for (const n of entities.slice(0, caps.lists * 3)) {
      const rel = model.edges
        .filter((e) => e.kind === "relates" && e.from === n.id)
        .map((e) => `${index.node(e.to)?.name ?? e.to}${e.meta?.["many"] ? "[]" : ""}`);
      const table = n.meta?.["table"] ? ` [${String(n.meta["table"])}]` : "";
      lines.push(
        `${n.name}${table} ${String(n.meta?.["orm"] ?? "")} ${n.path ?? ""} -> ${rel.join(" ") || "-"}`,
      );
    }
    if (entities.length > caps.lists * 3) lines.push(`+${entities.length - caps.lists * 3} more`);
  }

  const adrs = rationale?.sources.filter((s) => s.kind === "adr") ?? [];
  if (adrs.length) {
    lines.push("", "DECISIONS (status date title file; `buildrax why <node>` for details)");
    for (const a of adrs.slice(0, caps.lists * 2))
      lines.push(`${a.status ?? "?"} ${a.date ?? "-"} ${a.title} ${a.file ?? ""}`);
    if (adrs.length > caps.lists * 2) lines.push(`+${adrs.length - caps.lists * 2} more`);
  }

  const unresolved = model.edges.filter((e) => index.node(e.to)?.kind === "unresolved");
  if (unresolved.length) {
    lines.push("", "UNRESOLVED IMPORTS (could not be resolved; do not assume they exist)");
    for (const e of unresolved.slice(0, caps.lists)) {
      const ev = e.evidence[0];
      lines.push(`${ev?.file ?? short(e.from)}:${ev?.startLine ?? "?"} ${index.node(e.to)?.name}`);
    }
  }
  return lines.join("\n");
}

/** Compact, deterministic overview of the whole repo for an agent's first look. Zero LLM tokens. */
export function renderDigest(model: Model, opts: DigestOptions = {}): Digest {
  const budget = opts.budgetTokens ?? Infinity;
  const attempts: { level: 0 | 1; lists: number }[] = [];
  const want = opts.level ?? 0;
  if (want === 1) attempts.push({ level: 1, lists: 8 }, { level: 1, lists: 4 });
  attempts.push({ level: 0, lists: 8 }, { level: 0, lists: 4 }, { level: 0, lists: 2 });
  let last: Digest | undefined;
  for (const a of attempts) {
    const text = render(model, a.level, { lists: a.lists }, opts.rationale);
    last = { text, tokens: estimateTokens(text), level: a.level };
    if (last.tokens <= budget) break;
  }
  return last!;
}
