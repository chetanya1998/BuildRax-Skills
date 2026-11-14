import type { Evidence, EdgeKind, IRNode, NodeKind } from "@buildrax/ir";
import { fileCycles, GraphIndex } from "./graph-index.js";
import { tarjanScc } from "./scc.js";

export interface ViewOptions {
  /** Container ids that are expanded (replaced by their children). */
  expanded: ReadonlySet<string>;
  /** Node kinds to leave out of the view (e.g. "external", "unresolved"). */
  hideKinds?: ReadonlySet<NodeKind>;
}

export interface ViewNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Parent in the IR hierarchy (may not be visible). */
  parent?: string;
  expandable: boolean;
  /** Number of file nodes contained (0 for leaves). */
  fileCount: number;
  /** A file-level import cycle lives entirely inside this node, or involves it. */
  inCycle: boolean;
}

export interface ViewEdge {
  id: string;
  from: string;
  to: string;
  /** Number of underlying IR edges collapsed into this one. */
  count: number;
  kinds: EdgeKind[];
  /** Up to 3 underlying evidence anchors, for display. */
  evidence: Evidence[];
  /** Both ends belong to the same dependency cycle at this level of detail. */
  inCycle: boolean;
}

export interface GraphView {
  nodes: ViewNode[];
  edges: ViewEdge[];
}

const isContainer = (n: IRNode): boolean => n.kind === "project" || n.kind === "module";

/**
 * Progressive-disclosure view: starts from the children of the root(s) and replaces each expanded
 * container by its children. Edges between hidden nodes are lifted to their visible ancestors and
 * aggregated, so the same IR serves package-, module- and file-level graphs.
 */
export function buildView(index: GraphIndex, opts: ViewOptions): GraphView {
  const hide = opts.hideKinds ?? new Set<NodeKind>();
  const visible = new Set<string>();
  const place = (id: string): void => {
    const n = index.node(id);
    if (!n || hide.has(n.kind)) return;
    if (isContainer(n) && opts.expanded.has(id) && index.children(id).length) {
      for (const c of index.children(id)) place(c);
    } else visible.add(id);
  };
  for (const root of index.roots()) {
    const r = index.node(root);
    if (r?.kind === "project") for (const c of index.children(root)) place(c);
    else place(root);
  }

  const repOf = new Map<string, string | null>();
  const rep = (id: string): string | null => {
    const cached = repOf.get(id);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    for (const cand of [id, ...index.ancestors(id)]) {
      if (visible.has(cand)) {
        found = cand;
        break;
      }
    }
    repOf.set(id, found);
    return found;
  };

  const agg = new Map<string, ViewEdge>();
  for (const e of index.edges) {
    const a = rep(e.from);
    const b = rep(e.to);
    if (!a || !b || a === b) continue;
    const id = `${a}=>${b}`;
    let ve = agg.get(id);
    if (!ve)
      agg.set(id, (ve = { id, from: a, to: b, count: 0, kinds: [], evidence: [], inCycle: false }));
    ve.count++;
    if (!ve.kinds.includes(e.kind)) ve.kinds.push(e.kind);
    for (const ev of e.evidence) if (ve.evidence.length < 3) ve.evidence.push(ev);
  }

  const viewIds = [...visible].sort();
  const adj = new Map<string, string[]>();
  for (const e of agg.values()) {
    const l = adj.get(e.from);
    if (l) l.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const sccs = tarjanScc(viewIds, adj);
  const sccOf = new Map<string, number>();
  sccs.forEach((c, i) => c.forEach((id) => sccOf.set(id, i)));
  for (const e of agg.values()) {
    const s = sccOf.get(e.from);
    e.inCycle = s !== undefined && s === sccOf.get(e.to);
  }

  const cyclic = new Set<string>();
  for (const comp of fileCycles(index)) {
    for (const f of comp) {
      cyclic.add(f);
      for (const a of index.ancestors(f)) cyclic.add(a);
    }
  }

  const nodes: ViewNode[] = viewIds.map((id) => {
    const n = index.node(id)!;
    const kids = index.children(id);
    return {
      id,
      kind: n.kind,
      name: n.name,
      parent: n.parent,
      expandable: isContainer(n) && kids.length > 0,
      fileCount:
        n.kind === "file"
          ? 0
          : index.descendants(id).filter((d) => index.node(d)?.kind === "file").length,
      inCycle: cyclic.has(id) || sccOf.has(id),
    };
  });
  return { nodes, edges: [...agg.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
}
