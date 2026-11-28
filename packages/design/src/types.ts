import type { Evidence } from "@buildrax/ir";

/**
 * Where a design statement comes from. Every element, relationship, concept and check carries one:
 * code       read from source files (imports, calls, routes, data operations)
 * config     read from deploy or config files (compose, Terraform, Kubernetes, manifests)
 * documented quoted from decision records or docs (rationale index)
 * researched fetched from an allowlisted public source, with URL and date
 * inferred   a deterministic rule drew a conclusion the files do not state outright
 * ai         produced by the user's coding agent; unverified until it cites a source
 */
export type Provenance = "code" | "config" | "documented" | "researched" | "inferred" | "ai";

export type C4Level = 1 | 2 | 3;

export type ElementKind =
  | "person"
  | "system"
  | "external-system"
  | "app"
  | "worker"
  | "service"
  | "library"
  | "datastore"
  | "queue"
  | "component";

export interface C4Element {
  /** Stable: c4:system, c4:person:api-clients, c4:container:<node>, c4:component:<node>, … */
  id: string;
  level: C4Level;
  kind: ElementKind;
  name: string;
  /** Element one level up (container of a component, system of a container). */
  parent?: string;
  /** Frameworks, languages, engines, runtimes. */
  technology: string[];
  /** One deterministic sentence built from counts; never generated prose. */
  description: string;
  /** Roles found inside (endpoints, pages, data access, messaging, worker, models, tests). */
  tags: string[];
  /** Model nodes this element stands for. */
  nodes: string[];
  /** Deployment nodes (compute, hosting) tied to it through config. */
  deployedAs?: string[];
  provenance: Provenance;
  /** Files and functions inside (level 4 counts). */
  files?: number;
  functions?: number;
}

export interface C4Relation {
  /** `<from>-><to>` */
  id: string;
  level: C4Level;
  from: string;
  to: string;
  /** Underlying edge kinds: imports, depends-on, calls, reads, writes, publishes, consumes, uses, http. */
  kinds: string[];
  /** Short label: "reads, writes (orders)", "imports (12)", "6 endpoints". */
  label: string;
  /** Underlying model edges (or endpoints for people). */
  count: number;
  provenance: Provenance;
  /** First few pieces of evidence. */
  evidence: Evidence[];
}

export interface C4Model {
  elements: C4Element[];
  relations: C4Relation[];
  /** Deployment nodes not tied to any container (load balancers, unmatched services). */
  deployment: string[];
}
