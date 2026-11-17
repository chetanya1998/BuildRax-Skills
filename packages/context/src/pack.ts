import { GraphIndex, traverse } from "@buildrax/graph";
import type { IRNode, Model } from "@buildrax/ir";
import { renderDigest } from "./digest.js";
import { readSnippet } from "./snippet.js";
import { estimateTokens } from "./tokens.js";

export interface PackOptions {
  budgetTokens?: number;
  /** Repo root; when set, short code snippets for seed edges are included. */
  root?: string;
  maxSeeds?: number;
}

export interface PackItem {
  id: string;
  role: "seed" | "neighbor";
  score: number;
}

export interface ContextPack {
  query: string;
  text: string;
  /** Estimated, not measured. */
  tokens: number;
  seeds: string[];
  items: PackItem[];
  /** True when candidates were dropped to respect the budget. */
  truncated: boolean;
  /** True when nothing matched and the digest was returned instead. */
  fallback: boolean;
}

const STOP = new Set(
  "a an and are as at be by do does for from how i if in is it of on or our that the this to we what when where which who why with without my your can could should would".split(
    " ",
  ),
);

export function tokenizeQuery(q: string): string[] {
  const words = q
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)];
}

function scoreNode(n: IRNode, tokens: readonly string[]): number {
  const name = n.name.toLowerCase().replace(/\.[a-z]+$/, "");
  const path = (n.path ?? n.id).toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (name === t) score += 10;
    else if (name.startsWith(t)) score += 7;
    else if (name.includes(t)) score += 5;
    else if (path.includes(t)) score += 2;
  }
  if (!score) return 0;
  return score * (n.kind === "project" ? 0 : n.kind === "module" ? 0.8 : 1);
}

const label = (index: GraphIndex, id: string): string => {
  const n = index.node(id);
  return n?.path ?? n?.name ?? id;
};

function block(index: GraphIndex, id: string, role: string): string {
  const n = index.node(id)!;
  const outs = index.out(id).slice(0, 8);
  const ins = index.in(id).slice(0, 8);
  const lines = [`## ${n.kind} ${label(index, id)} [${role}]`];
  const at = n.evidence[0];
  if (at?.file)
    lines.push(
      `at ${at.file}${at.startLine ? `:${at.startLine}${at.endLine ? `-${at.endLine}` : ""}` : ""} (${at.kind})`,
    );
  const edge = (e: (typeof outs)[number], other: string): string => {
    const ev = e.evidence[0];
    return `${label(index, other)} ${ev?.file ? `@${ev.file}:${ev.startLine ?? "?"}` : ""}${ev?.kind === "unresolved" ? " UNRESOLVED" : ""}`.trim();
  };
  if (outs.length) lines.push(`imports/uses: ${outs.map((e) => edge(e, e.to)).join("; ")}`);
  if (ins.length) lines.push(`used by: ${ins.map((e) => edge(e, e.from)).join("; ")}`);
  return lines.join("\n");
}

/**
 * Build a bounded context package for a question: find matching nodes, expand their graph
 * neighbourhood, rank, and pack the best evidence under a token budget. Deterministic; no LLM.
 */
export async function contextFor(
  model: Model,
  query: string,
  opts: PackOptions = {},
): Promise<ContextPack> {
  const budget = opts.budgetTokens ?? 4000;
  const index = new GraphIndex(model);
  const tokens = tokenizeQuery(query);
  const scored = model.nodes
    .map((n) => ({ id: n.id, score: scoreNode(n, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  if (!scored.length) {
    const d = renderDigest(model, { budgetTokens: budget });
    const text = `QUESTION: ${query}\nNo architecture node matched; returning the repo digest instead.\n\n${d.text}`;
    return {
      query,
      text,
      tokens: estimateTokens(text),
      seeds: [],
      items: [],
      truncated: false,
      fallback: true,
    };
  }

  const seeds = scored.slice(0, opts.maxSeeds ?? 3);
  const rank = new Map<string, number>();
  const bump = (id: string, v: number): void => void rank.set(id, (rank.get(id) ?? 0) + v);
  for (const s of seeds) {
    bump(s.id, s.score * 2);
    for (const [id, dist] of traverse(index, s.id, { direction: "both", depth: 2 }))
      if (id !== s.id) bump(id, s.score / (1 + dist));
    // A matched container brings its direct children into view.
    for (const c of index.children(s.id)) bump(c, s.score / 2);
  }
  const seedIds = new Set(seeds.map((s) => s.id));
  const candidates = [...rank.entries()]
    .filter(([id]) => index.node(id)?.kind !== "project")
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 40);

  const header = [
    `QUESTION: ${query}`,
    `matched: ${seeds.map((s) => label(index, s.id)).join(", ")}`,
    "evidence: file:line anchors come from static analysis of source/manifests; UNRESOLVED = target not found",
    "",
  ].join("\n");
  const parts: string[] = [header];
  let used = estimateTokens(header);
  const items: PackItem[] = [];
  let truncated = false;

  for (const [id, score] of candidates) {
    let text = block(index, id, seedIds.has(id) ? "seed" : "neighbor");
    if (opts.root && seedIds.has(id)) {
      const snips: string[] = [];
      for (const e of index.out(id).slice(0, 3)) {
        const ev = e.evidence[0];
        if (!ev?.file || !ev.startLine) continue;
        const code = await readSnippet(opts.root, ev.file, ev.startLine, 1);
        if (code) snips.push(code);
      }
      if (snips.length) text += `\n${snips.join("\n--\n")}`;
    }
    const cost = estimateTokens(text) + 1;
    if (used + cost > budget) {
      truncated = true;
      continue;
    }
    parts.push(text);
    used += cost;
    items.push({
      id,
      role: seedIds.has(id) ? "seed" : "neighbor",
      score: Math.round(score * 100) / 100,
    });
  }
  const text = parts.join("\n\n");
  return {
    query,
    text,
    tokens: estimateTokens(text),
    seeds: seeds.map((s) => s.id),
    items,
    truncated,
    fallback: false,
  };
}
