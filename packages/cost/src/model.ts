import type { Model } from "@buildrax/ir";
import { type Assumptions, DEFAULT_ASSUMPTIONS, scenarioAssumptions } from "./assumptions.js";
import { CACHE_LADDER, DB_LADDER, type DbClass, dbMaxConnections, fargateSize } from "./ladders.js";
import { PRICE_PAGES, type PriceBook, type PriceRecord, priceKey, tieredCost } from "./prices.js";
import { type Declared, type Stack, declaredSizing, defaultStack } from "./stack.js";

export const COST_SCHEMA_VERSION = "buildrax-cost/v1" as const;
export const DEFAULT_TIERS = [100, 1_000, 10_000, 100_000, 1_000_000];
const HOURS = 730; // hours in an average month
const DAYS = 30;

export type Mode = "current" | "product";
export interface Range {
  low: number;
  expected: number;
  high: number;
}

export interface CostLine {
  label: string;
  priceKey: string;
  quantity: number;
  unit: string;
  /** Monthly USD; absent when the price is missing. */
  usd?: number;
}

export type ComponentCategory = "infrastructure" | "managed-service" | "usage-api";

export interface CostComponent {
  id: string;
  label: string;
  category: ComponentCategory;
  /** The IR node this prices, when it was detected in the repo. */
  nodeId?: string;
  sizing: string;
  lines: CostLine[];
  monthly: Range;
  /** True when at least one line has no price: the monthly figure is then a lower bound. */
  incomplete: boolean;
  notes: string[];
}

export interface CostTier {
  users: number;
  dau: number;
  avgRps: number;
  peakRps: number;
  components: CostComponent[];
  total: Range;
  incomplete: boolean;
  bottlenecks: string[];
  /** What changes compared with the previous tier. */
  changes: string[];
  /** Assumptions that move this tier's expected total most (+50% each). */
  sensitivity: { assumption: keyof Assumptions; changePct: number }[];
}

export interface CostReport {
  schemaVersion: typeof COST_SCHEMA_VERSION;
  mode: Mode;
  provider: "aws";
  region: string;
  currency: "USD";
  stack: Stack;
  assumptions: Assumptions;
  tiers: CostTier[];
  sources: Pick<
    PriceRecord,
    "key" | "label" | "sourceUrl" | "publishedAt" | "retrievedAt" | "evidenceType" | "region"
  >[];
  missingPrices: { key: string; label: string; lookUp?: string }[];
  notPriced: { nodeId: string; kind: string; label: string }[];
  disclaimer: string;
}

export interface EstimateInput {
  mode: Mode;
  model?: Model;
  stack?: Stack;
  tiers?: number[];
  assumptions?: Partial<Assumptions>;
  prices: PriceBook;
}

export const DISCLAIMER =
  "Estimate, not a quote. Monthly on-demand list prices in USD before tax, free tiers, credits and discounts. " +
  "Traffic and sizing come from the listed assumptions; change them to match your product.";

interface Ctx {
  stack: Stack;
  a: Assumptions;
  users: number;
  prices: Map<string, PriceRecord>;
  declared?: Declared;
  mode: Mode;
}

interface Draft {
  c: Omit<CostComponent, "monthly" | "incomplete">;
  bottlenecks: string[];
}

const LABELS: Record<string, string> = {
  stripe: "Stripe",
  razorpay: "Razorpay",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  sendgrid: "SendGrid",
  resend: "Resend",
  postmark: "Postmark",
  mailgun: "Mailgun",
  twilio: "Twilio",
  vercel: "Vercel",
  netlify: "Netlify",
};

function line(ctx: Ctx, label: string, key: string, quantity: number, unit: string): CostLine {
  const rec = ctx.prices.get(key);
  return { label, priceKey: key, quantity, unit, usd: rec ? tieredCost(rec, quantity) : undefined };
}

const fmt = (n: number): string =>
  n >= 100 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 100) / 100);

function traffic(users: number, a: Assumptions) {
  const dau = users * a.dauRatio;
  const reqDay = dau * a.requestsPerDau;
  const avgRps = reqDay / 86_400;
  return { dau, reqMonth: reqDay * DAYS, avgRps, peakRps: avgRps * a.peakFactor };
}

function appTasks(
  ctx: Ctx,
  peakRps: number,
): { tasks: number; vcpu: number; memoryGb: number; floor: number } {
  const { a } = ctx;
  const d = ctx.declared?.compute;
  const size = fargateSize(d?.vcpu ?? a.vcpuPerTask, d?.memoryGb ?? a.memoryGbPerTask);
  const floor = Math.max(ctx.users >= a.haFromUsers ? 2 : 1, d?.replicas ?? 0);
  const tasks = Math.max(floor, Math.ceil(peakRps / (a.rpsPerVcpu * size.vcpu)));
  return { tasks, ...size, floor };
}

function computeDrafts(ctx: Ctx): Draft[] {
  const { a, stack } = ctx;
  const t = traffic(ctx.users, a);
  const out: Draft[] = [];
  const arch = stack.arch;

  // App containers (Fargate).
  const app = appTasks(ctx, t.peakRps);
  const fargateLines = (n: number, label: string) => [
    line(ctx, `${label}: vCPU`, priceKey.fargateVcpu(arch), n * app.vcpu * HOURS, "vCPU-hours"),
    line(ctx, `${label}: memory`, priceKey.fargateGb(arch), n * app.memoryGb * HOURS, "GB-hours"),
  ];
  const appNotes: string[] = [];
  const d = ctx.declared?.compute;
  if (d) appNotes.push(`Container size and minimum replicas from ${d.nodeId} (${d.source}).`);
  if (d?.others.length)
    appNotes.push(
      `Also declared: ${d.others.join(", ")}; not added on top (they may describe the same service).`,
    );
  const appB: string[] = [];
  if (app.tasks > app.floor)
    appB.push(
      `Autoscaling: ${app.floor}–${app.tasks} app containers to absorb a ${fmt(t.peakRps)} req/s peak.`,
    );
  if (app.tasks > 50)
    appB.push("Over 50 containers: use larger containers and check per-service limits.");
  out.push({
    c: {
      id: "app",
      label: `App containers (Fargate, ${arch === "arm" ? "ARM" : "x86"})`,
      category: "infrastructure",
      nodeId: d?.nodeId,
      sizing: `${app.tasks} × ${app.vcpu} vCPU / ${app.memoryGb} GB`,
      lines: fargateLines(app.tasks, "Containers"),
      notes: appNotes,
    },
    bottlenecks: appB,
  });

  if (stack.workers === "yes") {
    const n = Math.max(1, Math.ceil(t.dau / a.workerDauPerTask));
    out.push({
      c: {
        id: "workers",
        label: "Background workers (Fargate)",
        category: "infrastructure",
        sizing: `${n} × ${app.vcpu} vCPU / ${app.memoryGb} GB`,
        lines: fargateLines(n, "Workers"),
        notes: ["Worker count scales with daily active users (assumption)."],
      },
      bottlenecks: [],
    });
  }

  // Load balancer.
  const gbPerHour = (t.reqMonth * a.egressKbPerRequest) / 1024 / 1024 / HOURS;
  const lcu = Math.max(t.avgRps / a.requestsPerConnection / 25, gbPerHour);
  out.push({
    c: {
      id: "alb",
      label: "Application Load Balancer",
      category: "infrastructure",
      sizing: `1 ALB, ~${fmt(lcu)} LCU on average`,
      lines: [
        line(ctx, "ALB hours", priceKey.albHour(), HOURS, "hours"),
        line(ctx, "ALB capacity units", priceKey.albLcu(), lcu * HOURS, "LCU-hours"),
      ],
      notes: ["LCUs approximated from new connections and processed bytes."],
    },
    bottlenecks: [],
  });

  // Database.
  if (stack.database !== "none") {
    const engine = stack.database;
    const peakQps = t.peakRps * a.dbQueriesPerRequest;
    const needVcpu = peakQps / a.qpsPerDbVcpu;
    const dd = ctx.declared?.database;
    const declaredCls = DB_LADDER.find((c) => c.cls === dd?.instanceType);
    const fit = DB_LADDER.find((c) => c.sustainedVcpu >= needVcpu);
    const largest = DB_LADDER.at(-1)!;
    let cls: DbClass = fit ?? largest;
    const b: string[] = [];
    const notes: string[] = [];
    if (declaredCls) {
      if (declaredCls.sustainedVcpu >= needVcpu)
        cls = declaredCls; // current mode prices what the repo declares while it is enough
      else
        b.push(
          `${declaredCls.cls} (declared in ${dd!.nodeId}) sustains ~${declaredCls.sustainedVcpu} vCPU; this tier needs ~${fmt(needVcpu)}: upgrade to ${cls.cls}.`,
        );
    } else if (dd?.instanceType)
      notes.push(
        `Declared class ${dd.instanceType} is not in the sizing ladder; sized from traffic instead.`,
      );
    const replicas = fit ? 0 : Math.ceil(needVcpu / largest.sustainedVcpu) - 1;
    const multiAz = dd?.multiAz ?? ctx.users >= a.haFromUsers;
    if (dd?.multiAz === false && ctx.users >= a.haFromUsers)
      b.push(
        "Declared Single-AZ: one zone outage takes the database down; consider Multi-AZ at this size.",
      );
    const dataGb = (ctx.users * a.dataMbPerUser) / 1024;
    const storageGb = Math.max(20, dd?.storageGb ?? 0, Math.ceil(dataGb * 1.25));
    const tasks =
      app.tasks +
      (stack.workers === "yes" ? Math.max(1, Math.ceil(t.dau / a.workerDauPerTask)) : 0);
    const conns = tasks * a.dbPoolPerTask;
    const maxConn = dbMaxConnections(cls);
    if (conns > maxConn)
      b.push(
        `~${conns} database connections from ${tasks} containers exceed ${cls.cls}'s default limit (~${maxConn}): add a connection pooler (RDS Proxy / PgBouncer).`,
      );
    if (replicas > 0)
      b.push(
        `One primary is not enough (needs ~${fmt(needVcpu)} vCPU): ${replicas} read replica(s) assumed; writes may need sharding or a distributed database.`,
      );
    if (cls.cls.startsWith("db.t4g") && needVcpu > cls.sustainedVcpu * 0.7)
      b.push(`${cls.cls} is a burstable class running near its baseline CPU.`);
    if (multiAz)
      notes.push(
        "Multi-AZ for availability (from the redundancy threshold or the declared setting).",
      );
    notes.push(`Peak ~${fmt(peakQps)} queries/s; ~${fmt(dataGb)} GB data.`);
    const lines = [
      line(
        ctx,
        `${cls.cls} ${multiAz ? "Multi-AZ" : "Single-AZ"}`,
        priceKey.rdsInstance(engine, cls.cls, multiAz),
        HOURS,
        "hours",
      ),
      line(ctx, "Storage (gp3)", priceKey.rdsStorage(engine, multiAz), storageGb, "GB-months"),
    ];
    if (replicas > 0)
      lines.push(
        line(
          ctx,
          `Read replicas ${cls.cls}`,
          priceKey.rdsInstance(engine, cls.cls, false),
          replicas * HOURS,
          "hours",
        ),
      );
    out.push({
      c: {
        id: "database",
        label: `${engine === "postgres" ? "PostgreSQL" : "MySQL"} (Amazon RDS)`,
        category: "managed-service",
        nodeId: dd?.nodeId,
        sizing: `${cls.cls}${multiAz ? " Multi-AZ" : ""}${replicas ? ` + ${replicas} replica(s)` : ""}, ${storageGb} GB`,
        lines,
        notes,
      },
      bottlenecks: b,
    });
  }

  // Cache.
  const dc = ctx.declared?.cache;
  if (stack.cache !== "none" && (dc || ctx.users >= a.cacheFromUsers)) {
    const needGib = (a.cacheMbPer1kDau * t.dau) / 1000 / 1024;
    const declared = CACHE_LADDER.find((c) => c.cls === dc?.instanceType);
    const usable = (c: { memoryGib: number }) => c.memoryGib * 0.75;
    const fit = CACHE_LADDER.find((c) => usable(c) >= needGib);
    const largest = CACHE_LADDER.at(-1)!;
    let cls = fit ?? largest;
    const b: string[] = [];
    if (declared && usable(declared) >= needGib) cls = declared;
    else if (declared)
      b.push(
        `${declared.cls} (declared) holds ~${fmt(usable(declared))} GiB; this tier needs ~${fmt(needGib)} GiB: upgrade to ${cls.cls}.`,
      );
    const shards = fit ? 1 : Math.ceil(needGib / usable(largest));
    if (shards > 1) b.push(`Cache needs ~${fmt(needGib)} GiB: ${shards} shards (cluster mode).`);
    const perShard = Math.max(ctx.users >= a.haFromUsers ? 2 : 1, dc?.replicas ?? 0);
    const nodes = shards * perShard;
    out.push({
      c: {
        id: "cache",
        label: `${stack.cache === "valkey" ? "Valkey" : "Redis"} (ElastiCache)`,
        category: "managed-service",
        nodeId: dc?.nodeId,
        sizing: `${nodes} × ${cls.cls}`,
        lines: [
          line(
            ctx,
            `${nodes} × ${cls.cls}`,
            priceKey.cache(stack.cache, cls.cls),
            nodes * HOURS,
            "node-hours",
          ),
        ],
        notes: perShard > 1 ? ["Primary + replica for availability."] : [],
      },
      bottlenecks: b,
    });
  }

  if (stack.storage === "s3") {
    const gb = (ctx.users * a.fileStorageMbPerUser) / 1024;
    out.push({
      c: {
        id: "storage",
        label: "File storage (Amazon S3)",
        category: "managed-service",
        nodeId: "storage:s3",
        sizing: `~${fmt(gb)} GB stored`,
        lines: [line(ctx, "S3 Standard storage", priceKey.s3(), gb, "GB-months")],
        notes: ["Request charges are not included."],
      },
      bottlenecks: [],
    });
  }

  const egressGb = (t.reqMonth * a.egressKbPerRequest) / 1024 / 1024;
  out.push({
    c: {
      id: "egress",
      label: "Data transfer out",
      category: "infrastructure",
      sizing: `~${fmt(egressGb)} GB / month`,
      lines: [line(ctx, "Internet egress", priceKey.egress(), egressGb, "GB")],
      notes: ["API responses only; frontend assets on a hosting platform are billed there."],
    },
    bottlenecks: [],
  });

  if (stack.frontend !== "backend") {
    const p = stack.frontend;
    out.push({
      c: {
        id: "frontend",
        label: `Frontend hosting (${LABELS[p]})`,
        category: "managed-service",
        nodeId: `hosting:${p}`,
        sizing: "plan fee",
        lines: [line(ctx, `${LABELS[p]} plan`, priceKey.monthly("hosting", p), 1, "month")],
        notes: ["Plan fee only; usage overages are not modelled."],
      },
      bottlenecks: [],
    });
  }

  if (stack.email !== "none") {
    const n = ctx.users * a.emailsPerUserMonth;
    const key =
      stack.email === "ses" ? priceKey.sesRecipient() : priceKey.emailPerMessage(stack.email);
    out.push({
      c: {
        id: "email",
        label: stack.email === "ses" ? "Email (Amazon SES)" : `Email (${LABELS[stack.email]})`,
        category: "usage-api",
        nodeId: `email:${stack.email}`,
        sizing: `~${fmt(n)} emails / month`,
        lines: [line(ctx, "Emails", key, n, "emails")],
        notes:
          stack.email === "ses"
            ? []
            : ["Per-email price from a plan; check which plan fits this volume."],
      },
      bottlenecks: [],
    });
  }

  if (stack.payments !== "none") {
    const p = stack.payments;
    const count = ctx.users * a.paymentsPerUserMonth;
    const volume = count * a.avgPaymentUsd;
    out.push({
      c: {
        id: "payments",
        label: `Payment fees (${LABELS[p]})`,
        category: "usage-api",
        nodeId: `payments:${p}`,
        sizing: `~${fmt(count)} payments, ~$${fmt(volume)} volume`,
        lines: [
          line(ctx, "Percentage fee", priceKey.paymentsPercent(p), volume / 100, "% of volume"),
          line(ctx, "Fixed fee", priceKey.paymentsFixed(p), count, "payments"),
        ],
        notes: ["Proportional to revenue, not to infrastructure."],
      },
      bottlenecks: [],
    });
  }

  if (stack.llm !== "none") {
    const p = stack.llm;
    const calls = t.dau * a.llmCallsPerDau * DAYS;
    const inM = (calls * a.llmInputTokensPerCall) / 1e6;
    const outM = (calls * a.llmOutputTokensPerCall) / 1e6;
    out.push({
      c: {
        id: "llm",
        label: `AI API (${LABELS[p]})`,
        category: "usage-api",
        nodeId: `llm:${p}`,
        sizing: `~${fmt(calls)} calls / month`,
        lines: [
          line(ctx, "Input tokens", priceKey.llmInput(p), inM, "M tokens"),
          line(ctx, "Output tokens", priceKey.llmOutput(p), outM, "M tokens"),
        ],
        notes: ["Token prices depend on the model; record the one you use."],
      },
      bottlenecks:
        inM > 10_000
          ? ["AI tokens dominate at this scale: check rate limits, caching and batching."]
          : [],
    });
  }

  if (stack.sms !== "none") {
    const n = ctx.users * a.smsPerUserMonth;
    out.push({
      c: {
        id: "sms",
        label: "SMS (Twilio)",
        category: "usage-api",
        nodeId: "messaging:twilio",
        sizing: `~${fmt(n)} SMS / month`,
        lines: [line(ctx, "SMS", priceKey.smsPerMessage("twilio"), n, "messages")],
        notes: ["Per-message prices vary by destination country."],
      },
      bottlenecks: [],
    });
  }
  return out;
}

const sumLines = (lines: CostLine[]): number => lines.reduce((s, l) => s + (l.usd ?? 0), 0);

function tierAt(
  ctx: Ctx,
  scenarios: ReturnType<typeof scenarioAssumptions>,
): Omit<CostTier, "changes" | "sensitivity"> {
  const run = (a: Assumptions) => computeDrafts({ ...ctx, a });
  const exp = run(scenarios.expected);
  const low = new Map(run(scenarios.low).map((d) => [d.c.id, sumLines(d.c.lines)]));
  const high = new Map(run(scenarios.high).map((d) => [d.c.id, sumLines(d.c.lines)]));
  const components: CostComponent[] = exp.map((d) => {
    const e = sumLines(d.c.lines);
    const l = low.get(d.c.id) ?? 0;
    const h = high.get(d.c.id) ?? 0;
    return {
      ...d.c,
      monthly: { low: Math.min(l, e), expected: e, high: Math.max(h, e) },
      incomplete: d.c.lines.some((x) => x.usd === undefined),
    };
  });
  const t = traffic(ctx.users, scenarios.expected);
  const total = components.reduce(
    (s, c) => ({
      low: s.low + c.monthly.low,
      expected: s.expected + c.monthly.expected,
      high: s.high + c.monthly.high,
    }),
    { low: 0, expected: 0, high: 0 },
  );
  return {
    users: ctx.users,
    dau: t.dau,
    avgRps: t.avgRps,
    peakRps: t.peakRps,
    components,
    total,
    incomplete: components.some((c) => c.incomplete),
    bottlenecks: exp.flatMap((d) => d.bottlenecks),
  };
}

/** Assumptions whose change is tested for sensitivity. */
const SENSITIVE: (keyof Assumptions)[] = [
  "dauRatio",
  "requestsPerDau",
  "peakFactor",
  "rpsPerVcpu",
  "dbQueriesPerRequest",
  "egressKbPerRequest",
  "dataMbPerUser",
  "fileStorageMbPerUser",
  "llmCallsPerDau",
  "emailsPerUserMonth",
];

function changesBetween(
  prev: Omit<CostTier, "changes" | "sensitivity"> | undefined,
  cur: Omit<CostTier, "changes" | "sensitivity">,
): string[] {
  if (!prev) return [];
  const before = new Map(prev.components.map((c) => [c.id, c]));
  const out: string[] = [];
  for (const c of cur.components) {
    const p = before.get(c.id);
    if (!p) out.push(`Add ${c.label}: ${c.sizing}.`);
    else if (p.sizing !== c.sizing && ["app", "workers", "database", "cache"].includes(c.id))
      out.push(`${c.label}: ${p.sizing} → ${c.sizing}.`);
  }
  return out;
}

/** Price everything for each traffic tier. Pure: same input, same output (browser-safe). */
export function estimate(input: EstimateInput): CostReport {
  const a: Assumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };
  const stack = input.stack ?? defaultStack(input.model);
  const declared =
    input.mode === "current" && input.model ? declaredSizing(input.model) : undefined;
  const prices = new Map(input.prices.records.map((r) => [r.key, r]));
  const tiersIn = [...new Set(input.tiers ?? DEFAULT_TIERS)]
    .filter((n) => n > 0)
    .sort((x, y) => x - y);
  const base: Omit<Ctx, "users"> = { stack, a, prices, declared, mode: input.mode };

  const tiers: CostTier[] = [];
  let prev: Omit<CostTier, "changes" | "sensitivity"> | undefined;
  for (const users of tiersIn) {
    const ctx: Ctx = { ...base, users };
    const t = tierAt(ctx, scenarioAssumptions(a));
    const sensitivity = SENSITIVE.map((k) => {
      const bumped = computeDrafts({ ...ctx, a: { ...a, [k]: a[k] * 1.5 } }).reduce(
        (s, d) => s + sumLines(d.c.lines),
        0,
      );
      return {
        assumption: k,
        changePct:
          t.total.expected > 0
            ? Math.round(((bumped - t.total.expected) / t.total.expected) * 1000) / 10
            : 0,
      };
    })
      .filter((s) => Math.abs(s.changePct) >= 0.5)
      .sort((x, y) => Math.abs(y.changePct) - Math.abs(x.changePct))
      .slice(0, 4);
    tiers.push({ ...t, changes: changesBetween(prev, t), sensitivity });
    prev = t;
  }

  const used = new Set<string>();
  const missing = new Map<string, { key: string; label: string; lookUp?: string }>();
  for (const t of tiers)
    for (const c of t.components)
      for (const l of c.lines) {
        if (l.usd !== undefined) used.add(l.priceKey);
        else if (!missing.has(l.priceKey)) {
          const provider = l.priceKey.split(".")[1] ?? "";
          missing.set(l.priceKey, {
            key: l.priceKey,
            label: `${c.label}: ${l.label}`,
            lookUp:
              PRICE_PAGES[provider] ??
              (l.priceKey.startsWith("aws.") ? "buildrax cost --online" : undefined),
          });
        }
      }
  const sources = [...used].sort().map((k) => {
    const r = prices.get(k)!;
    return {
      key: r.key,
      label: r.label,
      sourceUrl: r.sourceUrl,
      publishedAt: r.publishedAt,
      retrievedAt: r.retrievedAt,
      evidenceType: r.evidenceType,
      region: r.region,
    };
  });
  return {
    schemaVersion: COST_SCHEMA_VERSION,
    mode: input.mode,
    provider: "aws",
    region: stack.region,
    currency: "USD",
    stack,
    assumptions: a,
    tiers,
    sources,
    missingPrices: [...missing.values()].sort((x, y) => (x.key < y.key ? -1 : 1)),
    notPriced: declared?.unpriced ?? [],
    disclaimer: DISCLAIMER,
  };
}

/** The price keys an estimate for this stack may need (so a fetcher can extract only those). */
export function neededPriceKeys(stack: Stack): string[] {
  const keys = new Set<string>([
    priceKey.fargateVcpu(stack.arch),
    priceKey.fargateGb(stack.arch),
    priceKey.albHour(),
    priceKey.albLcu(),
    priceKey.egress(),
  ]);
  if (stack.database !== "none")
    for (const c of DB_LADDER)
      for (const m of [false, true]) {
        keys.add(priceKey.rdsInstance(stack.database, c.cls, m));
        keys.add(priceKey.rdsStorage(stack.database, m));
      }
  if (stack.cache !== "none")
    for (const c of CACHE_LADDER) keys.add(priceKey.cache(stack.cache, c.cls));
  if (stack.storage === "s3") keys.add(priceKey.s3());
  if (stack.email === "ses") keys.add(priceKey.sesRecipient());
  return [...keys].sort();
}
