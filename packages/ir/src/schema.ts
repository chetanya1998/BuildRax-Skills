import { z } from "zod";

/**
 * Current scan format. v2 adds infrastructure node kinds and the `uses` edge; v3 adds data-model
 * `entity` nodes and the `relates` edge between them.
 */
export const IR_SCHEMA_VERSION = "buildrax-ir/v3" as const;
/** Still accepted when reading: older models are subsets of v3. */
export const IR_SCHEMA_VERSIONS = ["buildrax-ir/v1", "buildrax-ir/v2", IR_SCHEMA_VERSION] as const;

export const NODE_KINDS = [
  "project",
  "module",
  "file",
  "class",
  "function",
  "route",
  "service",
  "database",
  "external",
  "unresolved",
  // Infrastructure (v2): what the project runs on or pays for.
  "compute",
  "hosting",
  "cache",
  "queue",
  "storage",
  "cdn",
  "email",
  "payments",
  "llm",
  "messaging",
  "search",
  "auth",
  // Data models (v3): a table / model / collection declared in code (Prisma, SQLAlchemy, Django, …).
  "entity",
] as const;

/** Node kinds that describe infrastructure / paid services rather than code. */
export const INFRA_KINDS = [
  "compute",
  "hosting",
  "database",
  "cache",
  "queue",
  "storage",
  "cdn",
  "email",
  "payments",
  "llm",
  "messaging",
  "search",
  "auth",
] as const;
export const EDGE_KINDS = [
  "imports",
  "depends-on",
  "calls",
  "reads",
  "writes",
  "publishes",
  "consumes",
  // v2: code or a service relies on a piece of infrastructure.
  "uses",
  // v3: one data-model entity refers to another (foreign key, relation field).
  "relates",
] as const;

/**
 * How we know a fact:
 *  verified      extracted directly from source code
 *  config        derived from configuration/manifests
 *  inferred      heuristic (e.g. directory grouping)
 *  unresolved    seen in code but target could not be resolved
 *  user-proposed supplied by a person (never produced by a scan)
 */
export const EVIDENCE_KINDS = [
  "verified",
  "config",
  "inferred",
  "unresolved",
  "user-proposed",
] as const;

export const NodeKindSchema = z.enum(NODE_KINDS);
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);

export const EvidenceSchema = z.object({
  kind: EvidenceKindSchema,
  /** Repo-relative POSIX path. */
  file: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  detail: z.string().optional(),
});

export const IRNodeSchema = z.object({
  id: z.string().min(1),
  kind: NodeKindSchema,
  name: z.string(),
  /** Containment hierarchy: project > module > file. */
  parent: z.string().optional(),
  /** Repo-relative POSIX path when the node maps to the filesystem. */
  path: z.string().optional(),
  language: z.string().optional(),
  evidence: z.array(EvidenceSchema).min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const IREdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: EdgeKindSchema,
  evidence: z.array(EvidenceSchema).min(1),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const ModelSchema = z.object({
  schemaVersion: z.enum(IR_SCHEMA_VERSIONS),
  meta: z.object({
    repo: z.string(),
    scannedAt: z.string(),
    generator: z.object({ name: z.literal("buildrax"), version: z.string() }),
    languages: z.array(z.string()),
    stats: z.record(z.string(), z.number()).optional(),
  }),
  nodes: z.array(IRNodeSchema),
  edges: z.array(IREdgeSchema),
});

export type NodeKind = z.infer<typeof NodeKindSchema>;
export type EdgeKind = z.infer<typeof EdgeKindSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type IRNode = z.infer<typeof IRNodeSchema>;
export type IREdge = z.infer<typeof IREdgeSchema>;
export type Model = z.infer<typeof ModelSchema>;
