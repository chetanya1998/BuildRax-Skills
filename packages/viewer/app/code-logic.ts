import type { GraphIndex } from "@buildrax/graph";
import type { Evidence } from "@buildrax/ir";

export interface Link {
  /** The node on the other side of the connection. */
  other: string;
  /** Source anchors (file:line) of the underlying imports, capped for display. */
  evidence: Evidence[];
  /** Number of underlying edges. */
  count: number;
}

export interface Connections {
  /** File nodes inside the selection (the node itself when it is a file). */
  files: string[];
  /** What the selection uses. */
  down: Link[];
  /** What uses the selection. */
  up: Link[];
}

const MAX_EVIDENCE = 3;

/**
 * Connections of a node at file granularity, independent of how much of the graph is expanded.
 * Containers include everything inside them; links within the selection are ignored.
 */
export function connectionsFor(index: GraphIndex, nodeId: string): Connections {
  const node = index.node(nodeId);
  if (!node) return { files: [], down: [], up: [] };
  const scope = new Set([nodeId, ...index.descendants(nodeId)]);
  const files = [...scope].filter((id) => index.node(id)?.kind === "file").sort();

  const down = new Map<string, Link>();
  const up = new Map<string, Link>();
  const add = (m: Map<string, Link>, other: string, ev: readonly Evidence[]): void => {
    const cur = m.get(other) ?? { other, evidence: [], count: 0 };
    cur.count++;
    for (const e of ev) if (cur.evidence.length < MAX_EVIDENCE) cur.evidence.push(e);
    m.set(other, cur);
  };
  for (const id of scope) {
    for (const e of index.out(id)) if (!scope.has(e.to)) add(down, e.to, e.evidence);
    for (const e of index.in(id)) if (!scope.has(e.from)) add(up, e.from, e.evidence);
  }
  const sorted = (m: Map<string, Link>): Link[] =>
    [...m.values()].sort((a, b) => (a.other < b.other ? -1 : 1));
  return { files, down: sorted(down), up: sorted(up) };
}

/** 1-based inclusive window of `total` lines around `line`, clamped to the file. */
export function excerptRange(
  total: number,
  line: number,
  radius: number,
): { start: number; end: number } {
  const start = Math.max(1, line - radius);
  const end = Math.min(total, line + radius);
  return { start, end: Math.max(start, end) };
}
