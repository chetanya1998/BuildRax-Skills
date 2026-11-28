import { edgeId, type EdgeKind, type Evidence, type IREdge, type IRNode } from "@buildrax/ir";
import type { InfraKind, ServiceDef } from "./catalog.js";

/** Where a fact came from; higher wins when two sources disagree about a size. */
export type InfraSource =
  "terraform" | "kubernetes" | "platform" | "compose" | "dockerfile" | "prisma" | "sdk" | "env";
const PRIORITY: Record<InfraSource, number> = {
  terraform: 7,
  kubernetes: 6,
  platform: 5,
  compose: 4,
  dockerfile: 3,
  prisma: 3,
  sdk: 2,
  env: 1,
};

/** Normalized sizing facts, only when a file actually declares them. */
export interface InfraFacts {
  provider?: string;
  engine?: string;
  version?: string;
  instanceType?: string;
  replicas?: number;
  /** vCPU per replica. */
  cpu?: number;
  memoryMb?: number;
  storageGb?: number;
  multiAz?: boolean;
  runtime?: string;
  /** Compose `build` context, repo-relative ("." for the root). */
  buildContext?: string;
  plan?: string;
  image?: string;
}

interface Entry {
  node: IRNode;
  facts: InfraFacts;
  factSource: Partial<Record<keyof InfraFacts, number>>;
  sources: Set<InfraSource>;
  /** Only weak evidence (env names) so far. */
  weak: boolean;
}

/** Builds infrastructure nodes and edges, merging what several files say about one service. */
export class InfraCollector {
  private readonly entries = new Map<string, Entry>();
  private readonly edges = new Map<string, IREdge>();

  constructor(private readonly projectId: string) {}

  add(
    def: Pick<ServiceDef, "kind" | "key" | "label" | "provider" | "engine">,
    source: InfraSource,
    evidence: Evidence,
    facts: InfraFacts = {},
  ): string {
    const id = `${def.kind}:${def.key}`;
    let e = this.entries.get(id);
    if (!e) {
      e = {
        node: {
          id,
          kind: def.kind as InfraKind,
          name: def.label,
          parent: this.projectId,
          evidence: [],
        },
        facts: {},
        factSource: {},
        sources: new Set(),
        weak: true,
      };
      this.entries.set(id, e);
    }
    if (
      !e.node.evidence.some(
        (x) =>
          x.file === evidence.file &&
          x.startLine === evidence.startLine &&
          x.kind === evidence.kind,
      )
    ) {
      e.node.evidence.push(evidence);
    }
    e.sources.add(source);
    if (source !== "env") e.weak = false;
    // A more specific label (e.g. "Amazon RDS" over "PostgreSQL") from a stronger source wins.
    if (PRIORITY[source] >= 5 && def.label) e.node.name = def.label;
    const all: InfraFacts = { provider: def.provider, engine: def.engine, ...facts };
    for (const [k, v] of Object.entries(all) as [keyof InfraFacts, unknown][]) {
      if (v === undefined || v === "") continue;
      if ((e.factSource[k] ?? -1) <= PRIORITY[source]) {
        (e.facts as Record<string, unknown>)[k] = v;
        e.factSource[k] = PRIORITY[source];
      }
    }
    return id;
  }

  link(from: string, to: string, kind: EdgeKind, evidence: Evidence): void {
    if (from === to) return;
    const id = edgeId(from, kind, to);
    const existing = this.edges.get(id);
    if (existing) {
      if (
        !existing.evidence.some(
          (x) => x.file === evidence.file && x.startLine === evidence.startLine,
        )
      )
        existing.evidence.push(evidence);
    } else this.edges.set(id, { id, from, to, kind, evidence: [evidence] });
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  result(): { nodes: IRNode[]; edges: IREdge[] } {
    const nodes: IRNode[] = [];
    for (const e of this.entries.values()) {
      // Seen only through environment variable names: keep, but say it is a guess.
      const evidence = e.weak
        ? e.node.evidence.map((x) => ({ ...x, kind: "inferred" as const }))
        : e.node.evidence;
      nodes.push({
        ...e.node,
        evidence: evidence.sort((a, b) =>
          `${a.file}:${a.startLine}`.localeCompare(`${b.file}:${b.startLine}`),
        ),
        meta: {
          ...e.facts,
          infra: true,
          sources: [...e.sources].sort(),
          ...(e.weak ? { confidence: 0.4 } : {}),
        },
      });
    }
    const byId = <T extends { id: string }>(a: T, b: T): number =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return { nodes: nodes.sort(byId), edges: [...this.edges.values()].sort(byId) };
  }
}

/** "250m" → 0.25 vCPU; "1.5" → 1.5. */
export function parseCpu(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const m = /^\s*([\d.]+)\s*(m)?\s*$/.exec(v);
  if (!m) return undefined;
  return m[2] ? Number(m[1]) / 1000 : Number(m[1]);
}

/** "512Mi", "1Gi", "512M", "2g", "512mb", 512 → megabytes. */
export function parseMemoryMb(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const m = /^\s*([\d.]+)\s*([kmgt]i?b?)?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase().replace(/b$/, "");
  const factor: Record<string, number> = {
    k: 1 / 1024,
    ki: 1 / 1024,
    m: 1,
    mi: 1,
    g: 1024,
    gi: 1024,
    t: 1024 * 1024,
    ti: 1024 * 1024,
  };
  const f = factor[unit];
  return f === undefined ? undefined : Math.round(n * f);
}
