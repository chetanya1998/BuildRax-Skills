import { GraphIndex } from "@buildrax/graph";
import type { Evidence, Model, ResearchFile } from "@buildrax/ir";
import type { ConceptHit } from "./concepts.js";
import type { C4Model, Provenance } from "./types.js";

export const NFR_CATEGORIES = [
  "Reliability",
  "Scalability",
  "Performance",
  "Security",
  "Observability",
  "Maintainability",
  "Data",
] as const;
export type NfrCategory = (typeof NFR_CATEGORIES)[number];

/**
 * present  the practice was found, with evidence
 * absent   not found by a static scan; it may still exist in ways a scan cannot see
 * risk     a problem was found, with evidence
 * unknown  needs data the scan does not have (for example `buildrax research --online`)
 */
export type CheckStatus = "present" | "absent" | "risk" | "unknown";

/** One line to show wherever "absent" appears: absence in a static scan is not proof. */
export const ABSENT_NOTE =
  "Absent means a static scan did not see it; it may exist in a form the scan cannot recognise.";

export interface NfrCheck {
  id: string;
  category: NfrCategory;
  label: string;
  status: CheckStatus;
  detail: string;
  provenance: Provenance;
  where: string[];
  evidence: Evidence[];
  /** Concept this check is based on, when it is one. */
  concept?: string;
}

export interface NfrSummary {
  category: NfrCategory;
  present: number;
  absent: number;
  risk: number;
  unknown: number;
}

export interface Scorecard {
  checks: NfrCheck[];
  /** Counts per category; deliberately not a grade. */
  summary: NfrSummary[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Practice checks backed by a concept: present when the concept was found. */
const PRACTICES: [NfrCategory, string, string[], string][] = [
  [
    "Reliability",
    "Health check endpoint",
    ["health-check"],
    "No /health, /ready or similar endpoint found.",
  ],
  [
    "Reliability",
    "Retries with backoff",
    ["retries"],
    "No retry library imported; retries may be hand-written.",
  ],
  ["Reliability", "Circuit breaker", ["circuit-breaker"], "No circuit-breaker library imported."],
  [
    "Reliability",
    "Slow work off the request path",
    ["background-workers", "message-queue"],
    "No queue or background worker found.",
  ],
  ["Reliability", "Feature flags", ["feature-flags"], "No feature-flag SDK imported."],
  [
    "Scalability",
    "Multiple instances",
    ["replicas"],
    "No service configured with more than one replica.",
  ],
  [
    "Scalability",
    "Orchestration or managed platform",
    ["orchestration", "managed-platform"],
    "No Kubernetes, ECS or hosting platform config found.",
  ],
  ["Scalability", "Load balancing", ["load-balancing"], "No load balancer declared in config."],
  ["Scalability", "Queue to absorb bursts", ["message-queue"], "No queue found."],
  ["Performance", "Cache", ["caching"], "No cache service found."],
  [
    "Performance",
    "Cache-aside reads",
    ["cache-aside"],
    "No function reads the cache before the database.",
  ],
  ["Performance", "Background processing", ["background-workers"], "No background worker found."],
  ["Security", "Input validation", ["input-validation"], "No validation library imported."],
  ["Security", "Rate limiting", ["rate-limiting"], "No rate-limiting library imported."],
  [
    "Security",
    "Authentication",
    ["auth-library", "managed-auth"],
    "No authentication library or provider found.",
  ],
  [
    "Observability",
    "Structured logging",
    ["structured-logging"],
    "No structured-logging library imported.",
  ],
  [
    "Observability",
    "Tracing and metrics",
    ["tracing-metrics"],
    "No OpenTelemetry, Prometheus or APM client imported.",
  ],
  ["Observability", "Error tracking", ["error-tracking"], "No error-tracking SDK imported."],
  ["Observability", "Health check endpoint", ["health-check"], "No health endpoint found."],
  ["Maintainability", "Automated tests", ["automated-tests"], "No test files found."],
  ["Maintainability", "Static typing", ["static-typing"], "No TypeScript files found."],
  ["Data", "Data models in code", ["orm"], "No ORM models or schema files found."],
  ["Data", "Schema migrations", ["migrations"], "No migrations folder found."],
];

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Non-functional scorecard: what was found, what was not, and what looks risky. No grades. */
export function buildScorecard(input: {
  model: Model;
  c4: C4Model;
  concepts: ConceptHit[];
  research?: ResearchFile;
}): Scorecard {
  const { model, c4, concepts, research } = input;
  const index = new GraphIndex(model);
  const byId = new Map(concepts.map((c) => [c.id, c] as const));
  const checks: NfrCheck[] = [];

  for (const [category, label, ids, absent] of PRACTICES) {
    const hit = ids.map((i) => byId.get(i)).find((x) => !!x);
    checks.push({
      id: `${slug(category)}:${slug(label)}`,
      category,
      label,
      status: hit ? "present" : "absent",
      detail: hit ? hit.detail : absent,
      provenance: hit ? hit.provenance : "inferred",
      where: hit?.where ?? [],
      evidence: hit?.evidence ?? [],
      ...(hit ? { concept: hit.id } : {}),
    });
  }

  // ---- Maintainability risks
  const cycles = byId.get("circular-dependencies");
  checks.push({
    id: "maintainability:circular-imports",
    category: "Maintainability",
    label: "No circular imports",
    status: cycles ? "risk" : "present",
    detail: cycles ? cycles.detail : "No file imports itself through a loop.",
    provenance: "code",
    where: cycles?.where ?? [],
    evidence: [],
    ...(cycles ? { concept: cycles.id } : {}),
  });
  const files = model.nodes.filter((n) => n.kind === "file");
  const hubLimit = Math.max(15, Math.ceil(files.length * 0.1));
  const hubs = files
    .map((f) => ({ f, fanIn: index.in(f.id).filter((e) => e.kind === "imports").length }))
    .filter((x) => x.fanIn >= hubLimit)
    .sort((a, b) => b.fanIn - a.fanIn);
  checks.push({
    id: "maintainability:hub-files",
    category: "Maintainability",
    label: "No file everything depends on",
    status: hubs.length ? "risk" : "present",
    detail: hubs.length
      ? `${hubs
          .slice(0, 3)
          .map((h) => `${h.f.path} (imported by ${h.fanIn})`)
          .join(", ")}: a change there reaches much of the code.`
      : `No file is imported by ${hubLimit} or more files.`,
    provenance: "code",
    where: hubs.map((h) => h.f.id).slice(0, 12),
    evidence: [],
  });
  const unresolved = model.edges.filter((e) => index.node(e.to)?.kind === "unresolved");
  checks.push({
    id: "maintainability:unresolved-imports",
    category: "Maintainability",
    label: "Every import resolves",
    status: unresolved.length ? "risk" : "present",
    detail: unresolved.length
      ? `${plural(unresolved.length, "import")} could not be resolved to a file or package.`
      : "All imports resolve to a repo file or a declared package.",
    provenance: "code",
    where: [...new Set(unresolved.map((e) => e.from))].slice(0, 12),
    evidence: unresolved.flatMap((e) => e.evidence.slice(0, 1)).slice(0, 6),
  });
  // Data access reaching back into request handlers inverts the layers.
  const comps = c4.elements.filter((e) => e.level === 3);
  const inverted = c4.relations.filter((r) => {
    if (r.level !== 3) return false;
    const from = comps.find((c) => c.id === r.from);
    const to = comps.find((c) => c.id === r.to);
    return (
      !!from &&
      !!to &&
      from.tags.includes("data access") &&
      !from.tags.includes("endpoints") &&
      to.tags.includes("endpoints") &&
      !to.tags.includes("data access")
    );
  });
  checks.push({
    id: "maintainability:layer-direction",
    category: "Maintainability",
    label: "Data access does not import request handlers",
    status: inverted.length ? "risk" : "present",
    detail: inverted.length
      ? `${inverted.map((r) => `${r.from.replace("c4:component:", "")} → ${r.to.replace("c4:component:", "")}`).join(", ")}.`
      : "No data-access folder imports an endpoint folder.",
    provenance: "inferred",
    where: [],
    evidence: inverted.flatMap((r) => r.evidence.slice(0, 1)).slice(0, 6),
  });

  // ---- Data risks: one database written by several containers couples their release cycles.
  for (const store of c4.elements.filter(
    (e) => e.kind === "datastore" && e.tags.includes("database"),
  )) {
    const writers = c4.relations.filter(
      (r) =>
        r.level === 2 &&
        r.to === store.id &&
        r.kinds.includes("writes") &&
        r.from.startsWith("c4:container:"),
    );
    if (writers.length < 2) continue;
    checks.push({
      id: `data:shared-database:${store.nodes[0]}`,
      category: "Data",
      label: `One service writes to ${store.name}`,
      status: "risk",
      detail: `${plural(writers.length, "container")} write to it (${writers
        .map((w) => c4.elements.find((e) => e.id === w.from)?.name ?? w.from)
        .join(", ")}); schema changes must be coordinated across them.`,
      provenance: "code",
      where: store.nodes,
      evidence: writers.flatMap((w) => w.evidence.slice(0, 1)).slice(0, 6),
    });
  }

  // ---- Security from research (opt-in, online)
  const advisories = (research?.findings ?? []).filter(
    (f) => f.evidenceType === "advisory" && !/^No known advisories/.test(f.finding),
  );
  const eol = (research?.findings ?? []).filter(
    (f) => f.evidenceType === "lifecycle" && /reached end of life/.test(f.finding),
  );
  const researched = !!research;
  checks.push({
    id: "security:known-advisories",
    category: "Security",
    label: "No known advisories for pinned versions",
    status: !researched ? "unknown" : advisories.length ? "risk" : "present",
    detail: !researched
      ? "Not checked: run `buildrax research --online` to look up pinned versions in OSV.dev."
      : advisories.length
        ? `${plural(advisories.length, "advisory", "advisories")}: ${advisories
            .slice(0, 3)
            .map((a) => a.subject)
            .join(", ")}.`
        : `No advisories for the versions looked up (${research.generatedAt.slice(0, 10)}).`,
    provenance: researched ? "researched" : "inferred",
    where: [...new Set(advisories.map((a) => a.nodeId))].slice(0, 12),
    evidence: [],
  });
  checks.push({
    id: "security:supported-runtimes",
    category: "Security",
    label: "Runtimes and databases still supported",
    status: !researched ? "unknown" : eol.length ? "risk" : "present",
    detail: !researched
      ? "Not checked: run `buildrax research --online` to compare versions with endoflife.date."
      : eol.length
        ? eol
            .slice(0, 3)
            .map((e) => e.finding)
            .join(" ")
        : "No end-of-life versions among those looked up.",
    provenance: researched ? "researched" : "inferred",
    where: [...new Set(eol.map((a) => a.nodeId))].slice(0, 12),
    evidence: [],
  });

  const summary = NFR_CATEGORIES.map((category) => {
    const cs = checks.filter((c) => c.category === category);
    const n = (s: CheckStatus) => cs.filter((c) => c.status === s).length;
    return {
      category,
      present: n("present"),
      absent: n("absent"),
      risk: n("risk"),
      unknown: n("unknown"),
    };
  });
  const order = new Map(NFR_CATEGORIES.map((c, i) => [c, i] as const));
  checks.sort((a, b) => order.get(a.category)! - order.get(b.category)!);
  return { checks, summary };
}
