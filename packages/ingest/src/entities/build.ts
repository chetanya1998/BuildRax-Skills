import { edgeId, type IREdge, type IRNode, type Model } from "@buildrax/ir";
import type { RawEntity } from "./facts.js";

export interface EntitySource {
  path: string;
  entities: RawEntity[];
}

/** Lower-case, no separators, singular: "order_items" / "OrderItem" / "orderItems" → "orderitem". */
export function entityKey(s: string): string {
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (k.endsWith("ies") && k.length > 4) return `${k.slice(0, -3)}y`;
  if (k.endsWith("ses") || k.endsWith("xes")) return k.slice(0, -2);
  if (k.endsWith("s") && !/(ss|us|is)$/.test(k) && k.length > 3) return k.slice(0, -1);
  return k;
}

const MAX_FIELDS = 60;

/**
 * Entity nodes (one per declared model) under the database they belong to, and `relates` edges
 * between them. The database is the one Prisma's datasource points at, else the one the declaring
 * file uses, else the only database in the project; entities with no known database hang off the
 * project. Relations whose target cannot be found are counted, not invented.
 */
export function buildEntities(
  model: Model,
  sources: readonly EntitySource[],
): { nodes: IRNode[]; edges: IREdge[]; unresolved: number } {
  const project = model.nodes.find((n) => n.kind === "project")?.id;
  const databases = model.nodes.filter((n) => n.kind === "database");
  const prismaDb = databases.find((d) =>
    ((d.meta?.["sources"] as string[] | undefined) ?? []).includes("prisma"),
  );
  const usedDb = new Map<string, string>();
  for (const e of model.edges)
    if (
      e.kind === "uses" &&
      e.from.startsWith("file:") &&
      databases.some((d) => d.id === e.to) &&
      !usedDb.has(e.from.slice(5))
    )
      usedDb.set(e.from.slice(5), e.to);

  const nodes: IRNode[] = [];
  const all: { id: string; e: RawEntity; path: string }[] = [];
  for (const src of [...sources].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    for (const e of src.entities) {
      const id = `entity:${src.path}:${e.name}`;
      if (all.some((x) => x.id === id)) continue;
      const parent =
        (e.orm === "prisma" && prismaDb?.id) ||
        usedDb.get(src.path) ||
        (databases.length === 1 ? databases[0]!.id : project);
      all.push({ id, e, path: src.path });
      nodes.push({
        id,
        kind: "entity",
        name: e.name,
        ...(parent ? { parent } : {}),
        path: src.path,
        evidence: [
          {
            kind: "verified",
            file: src.path,
            startLine: e.line,
            detail: `${e.orm} model ${e.name}`,
          },
        ],
        meta: {
          orm: e.orm,
          ...(e.table ? { table: e.table } : {}),
          fields: e.fields.slice(0, MAX_FIELDS).map((f) => ({
            name: f.name,
            ...(f.type ? { type: f.type } : {}),
            ...(f.pk ? { pk: true } : {}),
          })),
          ...(e.fields.length > MAX_FIELDS ? { moreFields: e.fields.length - MAX_FIELDS } : {}),
        },
      });
    }
  }

  const edges = new Map<string, IREdge>();
  let unresolved = 0;
  for (const from of all) {
    for (const r of from.e.relations) {
      const sameFile = all.filter((x) => x.path === from.path);
      const pick = (pool: typeof all) =>
        r.targetIs === "table"
          ? pool.filter(
              (x) =>
                (x.e.table ?? "") === r.target ||
                entityKey(x.e.table ?? x.e.name) === entityKey(r.target),
            )
          : pool.filter((x) => x.e.name === r.target);
      let hits = pick(sameFile);
      if (!hits.length) hits = pick(all.filter((x) => x.e.orm === from.e.orm));
      if (hits.length !== 1) {
        unresolved++;
        continue;
      }
      const to = hits[0]!.id;
      if (to === from.id && r.target !== from.e.name) continue;
      const id = edgeId(from.id, "relates", to);
      const edge = edges.get(id) ?? {
        id,
        from: from.id,
        to,
        kind: "relates" as const,
        evidence: [],
        meta: { fields: [] as string[] },
      };
      edge.evidence.push({
        kind: "verified",
        file: from.path,
        startLine: r.line,
        detail: `${r.field} → ${r.target}${r.many ? " (many)" : ""}`,
      });
      (edge.meta!["fields"] as string[]).push(r.field);
      if (r.many) edge.meta!["many"] = true;
      edges.set(id, edge);
    }
  }
  return { nodes, edges: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), unresolved };
}

/** Add entities to a model (deterministic order, updated stats). */
export function withEntities(model: Model, res: ReturnType<typeof buildEntities>): Model {
  const byId = <T extends { id: string }>(a: T, b: T): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const nodes = [...model.nodes, ...res.nodes].sort(byId);
  const edges = [...model.edges, ...res.edges].sort(byId);
  return {
    ...model,
    nodes,
    edges,
    meta: {
      ...model.meta,
      stats: {
        ...(model.meta.stats ?? {}),
        nodes: nodes.length,
        edges: edges.length,
        entities: res.nodes.length,
      },
    },
  };
}

/** Entities a data operation's table / model name refers to (same database first). */
export function entitiesForTable(model: Model, table: string, database: string): string[] {
  const key = entityKey(table);
  const ents = model.nodes.filter((n) => n.kind === "entity");
  const match = (n: IRNode) =>
    entityKey(n.name) === key || entityKey(String(n.meta?.["table"] ?? "")) === key;
  const local = ents.filter((n) => n.parent === database && match(n));
  return (local.length ? local : ents.filter(match)).map((n) => n.id).sort();
}
