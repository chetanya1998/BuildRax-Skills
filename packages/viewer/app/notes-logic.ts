import type { GraphIndex } from "@buildrax/graph";
import type { Note } from "@buildrax/ir";

/** Display priority, most attention-worthy first. */
export const BADGE_ORDER = [
  "red",
  "amber",
  "question",
  "todo",
  "decision",
  "green",
  "blue",
  "note",
] as const;
export type BadgeColor = (typeof BADGE_ORDER)[number];

export function badgeColor(n: Note): BadgeColor {
  if (n.type === "flag") return n.color ?? "red";
  return n.type;
}

export interface Badge {
  count: number;
  color: BadgeColor;
}

/**
 * Open (unresolved) notes per node. A note on a file also counts on every ancestor module, so a
 * collapsed container still shows that something inside it was flagged. Edge notes count on both
 * endpoints' ancestors is avoided on purpose: they are drawn on the edge itself (edgeBadges).
 */
export function nodeBadges(notes: readonly Note[], index: GraphIndex): Map<string, Badge> {
  const out = new Map<string, Badge>();
  const add = (id: string, color: BadgeColor): void => {
    const cur = out.get(id);
    if (!cur) out.set(id, { count: 1, color });
    else {
      cur.count++;
      if (BADGE_ORDER.indexOf(color) < BADGE_ORDER.indexOf(cur.color)) cur.color = color;
    }
  };
  for (const n of notes) {
    if (n.resolved || n.target.type !== "node" || !index.node(n.target.id)) continue;
    const color = badgeColor(n);
    add(n.target.id, color);
    for (const a of index.ancestors(n.target.id)) add(a, color);
  }
  return out;
}

export function edgeBadges(notes: readonly Note[]): Map<string, Badge> {
  const out = new Map<string, Badge>();
  for (const n of notes) {
    if (n.resolved || n.target.type !== "edge") continue;
    const color = badgeColor(n);
    const cur = out.get(n.target.id);
    if (!cur) out.set(n.target.id, { count: 1, color });
    else {
      cur.count++;
      if (BADGE_ORDER.indexOf(color) < BADGE_ORDER.indexOf(cur.color)) cur.color = color;
    }
  }
  return out;
}
