import { GraphIndex, fileCycles } from "@buildrax/graph";
import type { Evidence, FunctionsFile, IRNode, Model, RationaleFile } from "@buildrax/ir";
import type { C4Model, Provenance } from "./types.js";

export type ConceptCategory =
  | "API"
  | "Data"
  | "Messaging"
  | "Architecture"
  | "Deployment"
  | "Integration"
  | "Security"
  | "Observability"
  | "Reliability"
  | "Quality";

/** A system-design concept found in this repository, with the evidence for it. */
export interface ConceptHit {
  id: string;
  name: string;
  category: ConceptCategory;
  /** What the concept is, in plain words (fixed catalogue text, the same for every repo). */
  summary: string;
  /** What was found here, built from counts and names. */
  detail: string;
  provenance: Provenance;
  /** Model nodes where it shows up (at most 12). */
  where: string[];
  /** File:line evidence (at most 6). */
  evidence: Evidence[];
  /** Decision records and docs that name those nodes (rationale index). */
  documentedBy?: string[];
}

interface Ctx {
  model: Model;
  index: GraphIndex;
  functions?: FunctionsFile;
  c4: C4Model;
  externals: Map<string, IRNode>;
}

interface Entry {
  id: string;
  name: string;
  category: ConceptCategory;
  summary: string;
  detect: (ctx: Ctx) => Omit<ConceptHit, "id" | "name" | "category" | "summary"> | undefined;
}

const MAX_WHERE = 12;
const MAX_EVIDENCE = 6;
const evOf = (nodes: IRNode[]): Evidence[] =>
  nodes.flatMap((n) => n.evidence.filter((e) => e.file).slice(0, 1)).slice(0, MAX_EVIDENCE);
const names = (nodes: IRNode[], max = 4): string =>
  `${nodes
    .slice(0, max)
    .map((n) => n.name)
    .join(", ")}${nodes.length > max ? ` and ${nodes.length - max} more` : ""}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Files that import any of these packages (exact names, or scopes ending in "/"). */
function byPackages(
  ctx: Ctx,
  packages: readonly string[],
): { pkgs: IRNode[]; files: string[]; evidence: Evidence[] } | undefined {
  const pkgs = [...ctx.externals.values()].filter((x) =>
    packages.some((p) => (p.endsWith("/") ? x.name.startsWith(p) : x.name.toLowerCase() === p)),
  );
  if (!pkgs.length) return undefined;
  const edges = ctx.model.edges.filter(
    (e) => pkgs.some((p) => p.id === e.to) && e.from.startsWith("file:"),
  );
  return {
    pkgs,
    files: [...new Set(edges.map((e) => e.from))].sort(),
    evidence: edges.flatMap((e) => e.evidence.slice(0, 1)).slice(0, MAX_EVIDENCE),
  };
}

function packageEntry(
  id: string,
  name: string,
  category: ConceptCategory,
  summary: string,
  packages: string[],
): Entry {
  return {
    id,
    name,
    category,
    summary,
    detect: (ctx) => {
      const hit = byPackages(ctx, packages);
      if (!hit) return undefined;
      return {
        detail: `${names(hit.pkgs)}${hit.files.length ? `, imported in ${plural(hit.files.length, "file")}` : ""}.`,
        provenance: "code",
        where: [...hit.pkgs.map((p) => p.id), ...hit.files].slice(0, MAX_WHERE),
        evidence: hit.evidence,
      };
    },
  };
}

function infraEntry(
  id: string,
  name: string,
  category: ConceptCategory,
  summary: string,
  match: (n: IRNode) => boolean,
): Entry {
  return {
    id,
    name,
    category,
    summary,
    detect: (ctx) => {
      const hits = ctx.model.nodes.filter((n) => n.meta?.["infra"] && match(n));
      if (!hits.length) return undefined;
      const fromCode = hits.some((h) =>
        ctx.model.edges.some((e) => e.to === h.id && e.from.startsWith("file:")),
      );
      return {
        detail: `${names(hits)}.`,
        provenance: fromCode ? "code" : "config",
        where: hits.map((h) => h.id).slice(0, MAX_WHERE),
        evidence: evOf(hits),
      };
    },
  };
}

const engine = (n: IRNode): string => String(n.meta?.["engine"] ?? "");
const sources = (n: IRNode): string[] => (n.meta?.["sources"] as string[] | undefined) ?? [];

export const CATALOGUE: readonly Entry[] = [
  // ---- API
  {
    id: "rest-api",
    name: "HTTP API",
    category: "API",
    summary:
      "Endpoints that other programs call over HTTP, each with a method and a path. The contract between the system and its clients.",
    detect: ({ model }) => {
      const r = model.nodes.filter((n) => n.kind === "route" && n.meta?.["type"] !== "page");
      if (!r.length) return undefined;
      const fw = [...new Set(r.map((x) => String(x.meta?.["framework"] ?? "")))]
        .filter(Boolean)
        .sort();
      return {
        detail: `${plural(r.length, "endpoint")} (${fw.join(", ")}).`,
        provenance: "code",
        where: r.map((x) => x.id).slice(0, MAX_WHERE),
        evidence: evOf(r),
      };
    },
  },
  {
    id: "web-ui",
    name: "Server-rendered web pages",
    category: "API",
    summary:
      "Pages the server renders or routes for browsers, as opposed to a separate front-end app.",
    detect: ({ model }) => {
      const r = model.nodes.filter((n) => n.kind === "route" && n.meta?.["type"] === "page");
      if (!r.length) return undefined;
      return {
        detail: `${plural(r.length, "page")}.`,
        provenance: "code",
        where: r.map((x) => x.id).slice(0, MAX_WHERE),
        evidence: evOf(r),
      };
    },
  },
  packageEntry(
    "graphql",
    "GraphQL API",
    "API",
    "One endpoint where clients ask for exactly the fields they need, described by a typed schema.",
    [
      "graphql",
      "@apollo/server",
      "apollo-server",
      "graphql-yoga",
      "strawberry-graphql",
      "graphene",
    ],
  ),
  packageEntry(
    "rpc",
    "Typed RPC",
    "API",
    "Client and server share function signatures instead of hand-written HTTP contracts.",
    ["@trpc/server", "grpcio", "@grpc/grpc-js"],
  ),
  {
    id: "webhooks",
    name: "Webhooks",
    category: "Integration",
    summary:
      "Endpoints another service calls when something happens on its side (a payment, a message), so this system does not have to poll.",
    detect: ({ model }) => {
      const r = model.nodes.filter(
        (n) => n.kind === "route" && /webhook|hook|callback/i.test(String(n.meta?.["path"] ?? "")),
      );
      if (!r.length) return undefined;
      return {
        detail: `${names(r)}.`,
        provenance: "code",
        where: r.map((x) => x.id),
        evidence: evOf(r),
      };
    },
  },
  {
    id: "health-check",
    name: "Health check endpoint",
    category: "Reliability",
    summary:
      "A cheap endpoint a load balancer or orchestrator calls to know whether an instance is alive and ready for traffic.",
    detect: ({ model }) => {
      const r = model.nodes.filter(
        (n) =>
          n.kind === "route" &&
          /^\/(health|healthz|healthcheck|ready|readyz|live|livez|status|ping)\/?$/i.test(
            String(n.meta?.["path"] ?? ""),
          ),
      );
      if (!r.length) return undefined;
      return {
        detail: `${names(r)}.`,
        provenance: "code",
        where: r.map((x) => x.id),
        evidence: evOf(r),
      };
    },
  },

  // ---- Data
  infraEntry(
    "relational-database",
    "Relational database",
    "Data",
    "Data kept in tables with a fixed schema, queried with SQL, with transactions that keep related changes consistent.",
    (n) =>
      n.kind === "database" &&
      /postgres|mysql|mariadb|sqlite|mssql|sqlserver|aurora|cockroach/.test(engine(n)),
  ),
  infraEntry(
    "document-database",
    "Document database",
    "Data",
    "Data kept as flexible JSON-like documents; easy to change shape, weaker at joins and multi-record transactions.",
    (n) => n.kind === "database" && /mongo|dynamo|firestore|couch|cosmos/.test(engine(n)),
  ),
  {
    id: "orm",
    name: "Data models in code (ORM)",
    category: "Data",
    summary:
      "Tables are declared as classes or schemas in code and queried through them, so the schema lives next to the code that uses it.",
    detect: ({ model }) => {
      const e = model.nodes.filter((n) => n.kind === "entity");
      if (!e.length) return undefined;
      const orms = [...new Set(e.map((x) => String(x.meta?.["orm"] ?? "")))].filter(Boolean).sort();
      const rels = model.edges.filter((x) => x.kind === "relates").length;
      return {
        detail: `${plural(e.length, "model")} (${orms.join(", ")}), ${plural(rels, "relation")}.`,
        provenance: "code",
        where: e.map((x) => x.id).slice(0, MAX_WHERE),
        evidence: evOf(e),
      };
    },
  },
  {
    id: "migrations",
    name: "Schema migrations",
    category: "Data",
    summary:
      "Database changes are written as versioned steps kept in the repository, so every environment can be brought to the same schema.",
    detect: ({ model }) => {
      const files = model.nodes.filter(
        (n) =>
          n.kind === "file" && /(^|\/)(migrations|alembic\/versions|migrate)\//.test(n.path ?? ""),
      );
      const hit = files.length ? files : [];
      if (!hit.length) return undefined;
      return {
        detail: `${plural(hit.length, "migration file")}.`,
        provenance: "code",
        where: hit.map((f) => f.id).slice(0, MAX_WHERE),
        evidence: evOf(hit),
      };
    },
  },
  infraEntry(
    "caching",
    "Cache",
    "Data",
    "A fast store (often in memory) that keeps copies of expensive results so repeated reads skip the slower source.",
    (n) => n.kind === "cache",
  ),
  {
    id: "cache-aside",
    name: "Cache-aside",
    category: "Data",
    summary:
      "Read the cache first; on a miss read the database, then put the result in the cache. The code, not the cache, decides what is cached and when.",
    detect: ({ functions, model }) => {
      const kindOf = (id: string): string | undefined => model.nodes.find((n) => n.id === id)?.kind;
      const hits: { id: string; file: string; line: number }[] = [];
      for (const f of functions?.files ?? [])
        for (const fn of f.functions) {
          const ops = [...fn.ops].sort((a, b) => a.line - b.line);
          const cacheRead = ops.findIndex((o) => o.kind === "reads" && kindOf(o.to) === "cache");
          if (cacheRead < 0) continue;
          const dbRead = ops.findIndex(
            (o, i) => i > cacheRead && o.kind === "reads" && kindOf(o.to) === "database",
          );
          if (dbRead < 0) continue;
          if (ops.some((o, i) => i > dbRead && o.kind === "writes" && kindOf(o.to) === "cache"))
            hits.push({ id: fn.id, file: f.path, line: fn.line });
        }
      if (!hits.length) return undefined;
      return {
        detail: `${plural(hits.length, "function")} read the cache, fall back to the database and fill the cache: ${hits
          .slice(0, 3)
          .map((h) => `${h.id.slice(h.id.lastIndexOf("#") + 1)} (${h.file}:${h.line})`)
          .join(", ")}.`,
        provenance: "code",
        where: [...new Set(hits.map((h) => `file:${h.file}`))].slice(0, MAX_WHERE),
        evidence: hits.slice(0, MAX_EVIDENCE).map((h) => ({
          kind: "verified" as const,
          file: h.file,
          startLine: h.line,
          detail: "cache read → database read → cache write",
        })),
      };
    },
  },
  infraEntry(
    "object-storage",
    "Object storage",
    "Data",
    "Files and blobs kept in a bucket service instead of the database or the server's disk.",
    (n) => n.kind === "storage",
  ),
  infraEntry(
    "search-index",
    "Search index",
    "Data",
    "A separate index built for full-text or faceted search, kept in sync with the main data.",
    (n) => n.kind === "search",
  ),

  // ---- Messaging
  {
    id: "message-queue",
    name: "Message queue",
    category: "Messaging",
    summary:
      "Work is put on a queue and handled later by another process, so the caller does not wait and bursts are absorbed.",
    detect: ({ model }) => {
      const q = model.nodes.filter((n) => n.kind === "queue");
      if (!q.length) return undefined;
      const pubs = model.edges.filter(
        (e) => e.kind === "publishes" && q.some((x) => x.id === e.to),
      );
      return {
        detail: `${names(q)}${pubs.length ? `; ${plural(new Set(pubs.map((p) => p.from)).size, "file")} publish to it` : ""}.`,
        provenance: pubs.length ? "code" : "config",
        where: [...q.map((x) => x.id), ...new Set(pubs.map((p) => p.from))].slice(0, MAX_WHERE),
        evidence: [...pubs.flatMap((p) => p.evidence.slice(0, 1)), ...evOf(q)].slice(
          0,
          MAX_EVIDENCE,
        ),
      };
    },
  },
  {
    id: "background-workers",
    name: "Background workers",
    category: "Messaging",
    summary:
      "Processes that take jobs off a queue and run them outside the request, for slow or retryable work like emails and exports.",
    detect: ({ model }) => {
      const c = model.edges.filter((e) => e.kind === "consumes");
      if (!c.length) return undefined;
      const files = [...new Set(c.map((e) => e.from))].sort();
      return {
        detail: `${plural(files.length, "file")} consume from ${names(model.nodes.filter((n) => c.some((e) => e.to === n.id)))}.`,
        provenance: "code",
        where: files.slice(0, MAX_WHERE),
        evidence: c.flatMap((e) => e.evidence.slice(0, 1)).slice(0, MAX_EVIDENCE),
      };
    },
  },
  packageEntry(
    "event-streaming",
    "Event streaming",
    "Messaging",
    "An ordered, replayable log of events that many consumers read at their own pace.",
    ["kafkajs", "confluent-kafka", "kafka-python", "aiokafka", "@aws-sdk/client-kinesis", "nats"],
  ),

  // ---- Architecture
  {
    id: "monorepo",
    name: "Monorepo with workspace packages",
    category: "Architecture",
    summary:
      "Several packages or services live in one repository and can share code and change together in one commit.",
    detect: ({ model }) => {
      const p = model.nodes.filter((n) => n.kind === "module" && n.meta?.["package"]);
      if (p.length < 2) return undefined;
      return {
        detail: `${plural(p.length, "package")}: ${names(p)}.`,
        provenance: "config",
        where: p.map((x) => x.id).slice(0, MAX_WHERE),
        evidence: evOf(p),
      };
    },
  },
  {
    id: "shared-library",
    name: "Shared library",
    category: "Architecture",
    summary:
      "Code other packages import instead of copying, so a fix lands everywhere at once (and a breaking change does too).",
    detect: ({ c4 }) => {
      const libs = c4.elements.filter((e) => e.kind === "library");
      if (!libs.length) return undefined;
      const users = (id: string) =>
        c4.relations.filter(
          (r) =>
            r.level === 2 &&
            r.to === id &&
            r.kinds.some((k) => k === "imports" || k === "depends-on"),
        ).length;
      return {
        detail: `${libs
          .slice(0, 4)
          .map((l) => `${l.name} (used by ${plural(users(l.id), "package")})`)
          .join(", ")}${libs.length > 4 ? ` and ${libs.length - 4} more` : ""}.`,
        provenance: "code",
        where: libs.flatMap((l) => l.nodes).slice(0, MAX_WHERE),
        evidence: [],
      };
    },
  },
  {
    id: "layering",
    name: "Layers: endpoints over data access",
    category: "Architecture",
    summary:
      "Request handlers call into separate code that talks to the database, instead of querying it themselves, so storage can change without touching every endpoint.",
    detect: ({ c4 }) => {
      const comps = c4.elements.filter((e) => e.level === 3);
      const endpoints = comps.filter(
        (c) => c.tags.includes("endpoints") && !c.tags.includes("data access"),
      );
      const data = new Set(
        comps.filter((c) => c.tags.includes("data access") || c.tags.length === 0).map((c) => c.id),
      );
      const links = c4.relations.filter(
        (r) => r.level === 3 && endpoints.some((e) => e.id === r.from) && data.has(r.to),
      );
      if (!links.length) return undefined;
      return {
        detail:
          links
            .map(
              (l) =>
                `${l.from.replace("c4:component:module:", "")} → ${l.to.replace("c4:component:module:", "")}`,
            )
            .slice(0, 4)
            .join(", ") + ".",
        provenance: "inferred",
        where: [...new Set(links.flatMap((l) => [l.from, l.to]))]
          .flatMap((id) => comps.find((c) => c.id === id)?.nodes ?? [])
          .slice(0, MAX_WHERE),
        evidence: links.flatMap((l) => l.evidence.slice(0, 1)).slice(0, MAX_EVIDENCE),
      };
    },
  },
  {
    id: "circular-dependencies",
    name: "Circular imports",
    category: "Quality",
    summary:
      "Files that import each other in a loop. They must be understood and changed together and can fail at start-up depending on load order.",
    detect: ({ index }) => {
      const cycles = fileCycles(index);
      if (!cycles.length) return undefined;
      const files = [...new Set(cycles.flat())];
      return {
        detail: `${plural(cycles.length, "cycle")} across ${plural(files.length, "file")}.`,
        provenance: "code",
        where: files.slice(0, MAX_WHERE),
        evidence: [],
      };
    },
  },

  // ---- Deployment
  infraEntry(
    "containers",
    "Containers",
    "Deployment",
    "The app is packaged with its runtime into an image, so it runs the same on a laptop and in production.",
    (n) =>
      n.kind === "compute" &&
      sources(n).some((s) => s === "compose" || s === "dockerfile" || s === "docker"),
  ),
  infraEntry(
    "orchestration",
    "Container orchestration",
    "Deployment",
    "A scheduler (such as Kubernetes) keeps the requested number of copies running, restarts failed ones and rolls out new versions.",
    (n) => n.kind === "compute" && /kubernetes|ecs|nomad/.test(engine(n)),
  ),
  infraEntry(
    "iac",
    "Infrastructure as code",
    "Deployment",
    "Cloud resources are declared in files in the repository and created by a tool, so they can be reviewed and recreated.",
    (n) =>
      sources(n).includes("terraform") ||
      sources(n).includes("pulumi") ||
      sources(n).includes("cloudformation"),
  ),
  infraEntry(
    "managed-platform",
    "Managed hosting platform",
    "Deployment",
    "A platform runs and scales the app from the repository; less to operate, less control over the machines.",
    (n) => n.kind === "hosting",
  ),
  infraEntry(
    "load-balancing",
    "Load balancer",
    "Deployment",
    "Spreads incoming traffic over several copies of a service and stops sending to unhealthy ones.",
    (n) =>
      n.kind === "compute" &&
      /alb|elb|nlb|load.?balancer|nginx|traefik|haproxy/i.test(`${engine(n)} ${n.name}`),
  ),
  {
    id: "replicas",
    name: "Multiple instances",
    category: "Deployment",
    summary:
      "More than one copy of a service runs at once, for capacity and so one failure does not take it down.",
    detect: ({ model }) => {
      const r = model.nodes.filter((n) => Number(n.meta?.["replicas"] ?? 0) > 1);
      if (!r.length) return undefined;
      return {
        detail: r.map((n) => `${n.name} × ${String(n.meta?.["replicas"])}`).join(", ") + ".",
        provenance: "config",
        where: r.map((n) => n.id),
        evidence: evOf(r),
      };
    },
  },
  infraEntry(
    "cdn",
    "CDN",
    "Deployment",
    "Copies of static files served from locations near users, so pages load faster and the origin does less work.",
    (n) => n.kind === "cdn",
  ),

  // ---- Integration
  infraEntry(
    "payments-provider",
    "Payments provider",
    "Integration",
    "Card payments and billing handled by a specialist service; card data stays out of this system.",
    (n) => n.kind === "payments",
  ),
  infraEntry(
    "transactional-email",
    "Transactional email service",
    "Integration",
    "Emails such as receipts and password resets sent through a provider that handles delivery and reputation.",
    (n) => n.kind === "email",
  ),
  infraEntry(
    "llm-integration",
    "LLM integration",
    "Integration",
    "Calls to a large language model API; results vary between calls and cost per token, so they need limits and checks.",
    (n) => n.kind === "llm",
  ),
  infraEntry(
    "managed-auth",
    "Managed authentication",
    "Security",
    "Sign-in, sessions and user accounts handled by a dedicated service.",
    (n) => n.kind === "auth",
  ),

  // ---- Security
  packageEntry(
    "auth-library",
    "Authentication library",
    "Security",
    "Sign-in, tokens or sessions handled by a library in the app.",
    [
      "passport",
      "next-auth",
      "@auth/core",
      "@clerk/",
      "jsonwebtoken",
      "jose",
      "pyjwt",
      "python-jose",
      "authlib",
      "django-allauth",
      "fastapi-users",
      "lucia",
      "better-auth",
    ],
  ),
  packageEntry(
    "input-validation",
    "Input validation",
    "Security",
    "Incoming data is checked against a schema before use, which stops malformed or malicious input early.",
    [
      "zod",
      "joi",
      "yup",
      "valibot",
      "class-validator",
      "ajv",
      "pydantic",
      "marshmallow",
      "@sinclair/typebox",
    ],
  ),
  packageEntry(
    "rate-limiting",
    "Rate limiting",
    "Security",
    "Caps how often one client can call, protecting against abuse and runaway retries.",
    [
      "express-rate-limit",
      "@fastify/rate-limit",
      "rate-limiter-flexible",
      "@upstash/ratelimit",
      "slowapi",
      "django-ratelimit",
      "hono-rate-limiter",
    ],
  ),

  // ---- Observability
  packageEntry(
    "structured-logging",
    "Structured logging",
    "Observability",
    "Logs written as fields (JSON) rather than free text, so they can be searched and aggregated.",
    ["pino", "winston", "bunyan", "structlog", "loguru", "consola"],
  ),
  packageEntry(
    "tracing-metrics",
    "Tracing and metrics",
    "Observability",
    "Timing and counts recorded per request and service, to see where time goes and when things degrade.",
    [
      "@opentelemetry/",
      "opentelemetry-api",
      "opentelemetry-sdk",
      "prom-client",
      "prometheus-client",
      "dd-trace",
      "ddtrace",
      "newrelic",
      "@vercel/otel",
    ],
  ),
  packageEntry(
    "error-tracking",
    "Error tracking",
    "Observability",
    "Unhandled errors are reported to a service with stack traces and context, instead of only to a log.",
    ["@sentry/", "sentry-sdk", "rollbar", "bugsnag", "@bugsnag/js", "honeybadger"],
  ),

  // ---- Reliability
  packageEntry(
    "retries",
    "Retries with backoff",
    "Reliability",
    "Failed calls are tried again after growing waits, riding out brief outages without hammering the other side.",
    [
      "p-retry",
      "async-retry",
      "axios-retry",
      "retry",
      "tenacity",
      "backoff",
      "exponential-backoff",
    ],
  ),
  packageEntry(
    "circuit-breaker",
    "Circuit breaker",
    "Reliability",
    "After repeated failures, calls to a dependency stop for a while so the system fails fast instead of piling up.",
    ["opossum", "cockatiel", "pybreaker", "circuitbreaker"],
  ),
  packageEntry(
    "feature-flags",
    "Feature flags",
    "Reliability",
    "Behaviour switched on or off at runtime without a deploy, for gradual rollouts and quick rollback.",
    [
      "launchdarkly-node-server-sdk",
      "@launchdarkly/",
      "unleash-client",
      "@growthbook/growthbook",
      "flagsmith",
      "posthog-node",
    ],
  ),

  // ---- Quality
  {
    id: "automated-tests",
    name: "Automated tests",
    category: "Quality",
    summary:
      "Code that checks the code, run on every change, so regressions are caught before release.",
    detect: ({ model }) => {
      const t = model.nodes.filter(
        (n) =>
          n.kind === "file" &&
          /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/.test(
            n.path ?? "",
          ),
      );
      if (!t.length) return undefined;
      const all = model.nodes.filter((n) => n.kind === "file").length;
      return {
        detail: `${plural(t.length, "test file")} of ${plural(all, "source file")}.`,
        provenance: "code",
        where: t.map((x) => x.id).slice(0, MAX_WHERE),
        evidence: [],
      };
    },
  },
  {
    id: "static-typing",
    name: "Static typing",
    category: "Quality",
    summary:
      "Types are checked before the code runs, catching a class of mistakes early and documenting what functions expect.",
    detect: ({ model }) => {
      const files = model.nodes.filter((n) => n.kind === "file");
      const ts = files.filter((f) => f.language === "typescript");
      if (!ts.length) return undefined;
      return {
        detail: `${Math.round((ts.length / files.length) * 100)}% of source files are TypeScript.`,
        provenance: "code",
        where: [],
        evidence: [],
      };
    },
  },
];

/** Concepts found in the repository, in catalogue order, each with its evidence and any docs about it. */
export function detectConcepts(input: {
  model: Model;
  c4: C4Model;
  functions?: FunctionsFile;
  rationale?: RationaleFile;
}): ConceptHit[] {
  const index = new GraphIndex(input.model);
  const externals = new Map(
    input.model.nodes.filter((n) => n.kind === "external").map((n) => [n.name, n] as const),
  );
  const ctx: Ctx = {
    model: input.model,
    index,
    functions: input.functions,
    c4: input.c4,
    externals,
  };
  const docKinds = new Set(["adr", "doc"]);
  const docsFor = (nodes: string[]): string[] => {
    if (!input.rationale) return [];
    const kinds = new Map(input.rationale.sources.map((s) => [s.id, s.kind] as const));
    return [
      ...new Set(
        nodes.flatMap((n) =>
          (input.rationale!.byNode[n] ?? []).filter((id) => docKinds.has(kinds.get(id) ?? "")),
        ),
      ),
    ].slice(0, 6);
  };
  const out: ConceptHit[] = [];
  for (const e of CATALOGUE) {
    const hit = e.detect(ctx);
    if (!hit) continue;
    const documentedBy = docsFor(hit.where);
    out.push({
      id: e.id,
      name: e.name,
      category: e.category,
      summary: e.summary,
      ...hit,
      ...(documentedBy.length ? { documentedBy } : {}),
    });
  }
  return out;
}
