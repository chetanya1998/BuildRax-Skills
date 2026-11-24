import type { IREdge, IRNode, Model } from "@buildrax/ir";
import { GraphIndex, fileCycles } from "./graph-index.js";

/** Facts that only move when code moves around; a change in them is not an architecture change. */
const NOISY_META = new Set(["lines"]);

export interface NodeChange {
  id: string;
  kind: string;
  name: string;
  changes: string[];
}

export interface ModelDiff {
  from: { scannedAt?: string; nodes: number; edges: number };
  to: { scannedAt?: string; nodes: number; edges: number };
  nodes: { added: IRNode[]; removed: IRNode[]; changed: NodeChange[] };
  edges: { added: IREdge[]; removed: IREdge[] };
  cycles: { introduced: string[][]; resolved: string[][] };
  /** True when nothing architectural changed. */
  same: boolean;
}

const byId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : x,
  );

function nodeChanges(a: IRNode, b: IRNode): string[] {
  const out: string[] = [];
  if (a.kind !== b.kind) out.push(`kind ${a.kind} → ${b.kind}`);
  if (a.name !== b.name) out.push(`name ${a.name} → ${b.name}`);
  if (a.parent !== b.parent) out.push(`moved ${a.parent ?? "(root)"} → ${b.parent ?? "(root)"}`);
  const keys = new Set([...Object.keys(a.meta ?? {}), ...Object.keys(b.meta ?? {})]);
  for (const k of [...keys].sort()) {
    if (NOISY_META.has(k)) continue;
    const x = a.meta?.[k];
    const y = b.meta?.[k];
    if (stable(x) !== stable(y))
      out.push(`${k}: ${x === undefined ? "–" : stable(x)} → ${y === undefined ? "–" : stable(y)}`);
  }
  return out;
}

const cycleKey = (c: string[]): string => [...c].sort().join("|");

/**
 * Architecture-level difference between two models: nodes and edges added or removed, nodes whose
 * kind, place or declared facts changed, and circular dependencies introduced or resolved.
 * Evidence line numbers and file line counts are ignored (they move with every edit). Pure.
 */
export function diffModels(before: Model, after: Model): ModelDiff {
  const A = new Map(before.nodes.map((n) => [n.id, n]));
  const B = new Map(after.nodes.map((n) => [n.id, n]));
  const added = after.nodes.filter((n) => !A.has(n.id)).sort(byId);
  const removed = before.nodes.filter((n) => !B.has(n.id)).sort(byId);
  const changed: NodeChange[] = [];
  for (const b of [...after.nodes].sort(byId)) {
    const a = A.get(b.id);
    if (!a) continue;
    const c = nodeChanges(a, b);
    if (c.length) changed.push({ id: b.id, kind: b.kind, name: b.name, changes: c });
  }
  const EA = new Set(before.edges.map((e) => e.id));
  const EB = new Set(after.edges.map((e) => e.id));
  const edgesAdded = after.edges.filter((e) => !EA.has(e.id)).sort(byId);
  const edgesRemoved = before.edges.filter((e) => !EB.has(e.id)).sort(byId);
  const ca = fileCycles(new GraphIndex(before));
  const cb = fileCycles(new GraphIndex(after));
  const ka = new Set(ca.map(cycleKey));
  const kb = new Set(cb.map(cycleKey));
  const introduced = cb.filter((c) => !ka.has(cycleKey(c)));
  const resolved = ca.filter((c) => !kb.has(cycleKey(c)));
  return {
    from: {
      scannedAt: before.meta.scannedAt,
      nodes: before.nodes.length,
      edges: before.edges.length,
    },
    to: { scannedAt: after.meta.scannedAt, nodes: after.nodes.length, edges: after.edges.length },
    nodes: { added, removed, changed },
    edges: { added: edgesAdded, removed: edgesRemoved },
    cycles: { introduced, resolved },
    same:
      !added.length &&
      !removed.length &&
      !changed.length &&
      !edgesAdded.length &&
      !edgesRemoved.length,
  };
}
