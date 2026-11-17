import type { GraphIndex, GraphView } from "@buildrax/graph";

/** One dotted code-segmentation box on the canvas. */
export interface GroupSpec {
  id: string;
  label: string;
  /** Small caption, e.g. "6 files". */
  sub: string;
  hue: number;
  /** Enclosing box (nested segmentation: service > folder). */
  parent?: string;
  depth: number;
  kind: "container" | "external" | "unresolved";
  /** Model node to collapse when the box's header "−" is clicked. */
  collapseId?: string;
}

export interface Groups {
  specs: GroupSpec[];
  /** Innermost box of each visible node (undefined when it sits outside every box). */
  groupOf: Map<string, string | undefined>;
}

export const EXTERNAL_GROUP = "group:external";
export const UNRESOLVED_GROUP = "group:unresolved";

/**
 * Decide the segmentation boxes for the nodes currently on screen. Every expanded container
 * (service/package/folder) that has visible contents becomes a box around them, nested like the
 * code is; outside dependencies get their own box so they read as a separate segment.
 */
export function buildGroups(
  index: GraphIndex,
  view: GraphView,
  expanded: ReadonlySet<string>,
  hueOf: (containerId: string) => number,
): Groups {
  const isBox = (id: string): boolean => expanded.has(id) && index.node(id)?.kind === "module";
  const specs = new Map<string, GroupSpec>();
  const groupOf = new Map<string, string | undefined>();

  const ensure = (id: string, parent: string | undefined): void => {
    if (specs.has(id)) return;
    const n = index.node(id)!;
    const files = index.descendants(id).filter((d) => index.node(d)?.kind === "file").length;
    specs.set(id, {
      id,
      label: n.name,
      sub: `${files} file${files === 1 ? "" : "s"}`,
      hue: hueOf(id),
      parent,
      depth: 0,
      kind: "container",
      collapseId: id,
    });
  };

  for (const vn of view.nodes) {
    if (vn.kind === "external" || vn.kind === "unresolved") continue;
    const chain = index.ancestors(vn.id).filter(isBox); // nearest first
    groupOf.set(vn.id, chain[0]);
    chain.forEach((gid, i) => ensure(gid, chain[i + 1]));
  }

  const externals = view.nodes.filter((n) => n.kind === "external");
  if (externals.length >= 2) {
    specs.set(EXTERNAL_GROUP, {
      id: EXTERNAL_GROUP,
      label: "External dependencies",
      sub: `${externals.length} packages`,
      hue: 36,
      depth: 0,
      kind: "external",
    });
    for (const e of externals) groupOf.set(e.id, EXTERNAL_GROUP);
  }
  const unresolved = view.nodes.filter((n) => n.kind === "unresolved");
  if (unresolved.length >= 1) {
    specs.set(UNRESOLVED_GROUP, {
      id: UNRESOLVED_GROUP,
      label: "Unresolved imports",
      sub: `${unresolved.length}`,
      hue: 4,
      depth: 0,
      kind: "unresolved",
    });
    for (const u of unresolved) groupOf.set(u.id, UNRESOLVED_GROUP);
  }

  const depthOf = (id: string): number => {
    let d = 0;
    for (let p = specs.get(id)?.parent; p; p = specs.get(p)?.parent) d++;
    return d;
  };
  const list = [...specs.values()].map((g) => ({ ...g, depth: depthOf(g.id) }));
  list.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
  return { specs: list, groupOf };
}

/** Containment path from the outermost box to the node's innermost box. */
export function groupPath(specs: readonly GroupSpec[], innermost: string | undefined): string[] {
  const byId = new Map(specs.map((g) => [g.id, g]));
  const path: string[] = [];
  for (let id = innermost; id; id = byId.get(id)?.parent) path.unshift(id);
  return path;
}
