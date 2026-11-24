import type { IRNode, Model } from "@buildrax/ir";

/** The product stack a cost estimate is built for. Each choice is one short question. */
export interface Stack {
  provider: "aws";
  region: string;
  arch: "x86" | "arm";
  database: "postgres" | "mysql" | "none";
  cache: "redis" | "valkey" | "none";
  storage: "s3" | "none";
  workers: "yes" | "no";
  frontend: "vercel" | "netlify" | "backend";
  email: "ses" | "sendgrid" | "resend" | "postmark" | "mailgun" | "none";
  payments: "stripe" | "razorpay" | "none";
  llm: "openai" | "anthropic" | "gemini" | "none";
  sms: "twilio" | "none";
}

export interface Question {
  key: keyof Stack;
  label: string;
  options: { value: string; label: string }[];
}

/** Minimal options on purpose: the common choices only. Anything else is a contribution. */
export const QUESTIONS: Question[] = [
  {
    key: "region",
    label: "AWS region",
    options: [
      { value: "us-east-1", label: "us-east-1 (N. Virginia)" },
      { value: "us-west-2", label: "us-west-2 (Oregon)" },
      { value: "eu-west-1", label: "eu-west-1 (Ireland)" },
      { value: "eu-central-1", label: "eu-central-1 (Frankfurt)" },
      { value: "ap-south-1", label: "ap-south-1 (Mumbai)" },
    ],
  },
  {
    key: "arch",
    label: "Container CPU",
    options: [
      { value: "x86", label: "x86 (Fargate)" },
      { value: "arm", label: "ARM / Graviton (Fargate, cheaper)" },
    ],
  },
  {
    key: "database",
    label: "Database",
    options: [
      { value: "postgres", label: "PostgreSQL (Amazon RDS)" },
      { value: "mysql", label: "MySQL (Amazon RDS)" },
      { value: "none", label: "None" },
    ],
  },
  {
    key: "cache",
    label: "Cache (added from the cache threshold)",
    options: [
      { value: "redis", label: "Redis (ElastiCache)" },
      { value: "valkey", label: "Valkey (ElastiCache, cheaper)" },
      { value: "none", label: "None" },
    ],
  },
  {
    key: "storage",
    label: "File storage",
    options: [
      { value: "s3", label: "Amazon S3" },
      { value: "none", label: "None" },
    ],
  },
  {
    key: "workers",
    label: "Background workers",
    options: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
  },
  {
    key: "frontend",
    label: "Frontend hosting",
    options: [
      { value: "backend", label: "Served by the backend / S3" },
      { value: "vercel", label: "Vercel" },
      { value: "netlify", label: "Netlify" },
    ],
  },
  {
    key: "email",
    label: "Email",
    options: [
      { value: "ses", label: "Amazon SES" },
      { value: "sendgrid", label: "SendGrid" },
      { value: "resend", label: "Resend" },
      { value: "postmark", label: "Postmark" },
      { value: "mailgun", label: "Mailgun" },
      { value: "none", label: "None" },
    ],
  },
  {
    key: "payments",
    label: "Payments",
    options: [
      { value: "stripe", label: "Stripe" },
      { value: "razorpay", label: "Razorpay" },
      { value: "none", label: "None" },
    ],
  },
  {
    key: "llm",
    label: "AI / LLM API",
    options: [
      { value: "openai", label: "OpenAI" },
      { value: "anthropic", label: "Anthropic" },
      { value: "gemini", label: "Google Gemini" },
      { value: "none", label: "None" },
    ],
  },
  {
    key: "sms",
    label: "SMS",
    options: [
      { value: "twilio", label: "Twilio" },
      { value: "none", label: "None" },
    ],
  },
];

/** The minimal default stack when nothing is detected: one container service and PostgreSQL. */
export const MINIMAL_STACK: Stack = {
  provider: "aws",
  region: "us-east-1",
  arch: "x86",
  database: "postgres",
  cache: "redis",
  storage: "none",
  workers: "no",
  frontend: "backend",
  email: "none",
  payments: "none",
  llm: "none",
  sms: "none",
};

const infra = (m: Model | undefined): IRNode[] =>
  (m?.nodes ?? []).filter((n) => n.meta?.["infra"] === true);
const has = (nodes: IRNode[], kind: string, key?: string): IRNode | undefined =>
  nodes.find((n) => n.kind === kind && (key === undefined || n.id === `${kind}:${key}`));

/** Defaults pre-selected from what the scan found; everything else stays minimal. */
export function defaultStack(model?: Model): Stack {
  const nodes = infra(model);
  const s: Stack = { ...MINIMAL_STACK };
  if (has(nodes, "database", "mysql")) s.database = "mysql";
  else if (has(nodes, "database", "postgres") || has(nodes, "database", "supabase"))
    s.database = "postgres";
  else if (nodes.some((n) => n.kind === "database")) s.database = "postgres";
  if (has(nodes, "cache", "valkey")) s.cache = "valkey";
  if (has(nodes, "storage")) s.storage = "s3";
  if (has(nodes, "queue")) s.workers = "yes";
  if (has(nodes, "hosting", "vercel")) s.frontend = "vercel";
  else if (has(nodes, "hosting", "netlify")) s.frontend = "netlify";
  for (const p of ["ses", "sendgrid", "resend", "postmark", "mailgun"] as const)
    if (has(nodes, "email", p)) {
      s.email = p;
      break;
    }
  for (const p of ["stripe", "razorpay"] as const)
    if (has(nodes, "payments", p)) {
      s.payments = p;
      break;
    }
  for (const p of ["openai", "anthropic", "gemini"] as const)
    if (has(nodes, "llm", p)) {
      s.llm = p;
      break;
    }
  if (has(nodes, "messaging", "twilio")) s.sms = "twilio";
  const region = nodes
    .map((n) => n.meta?.["region"])
    .find((r): r is string => typeof r === "string");
  if (region) s.region = region;
  return s;
}

/** Apply `key=value` answers; unknown keys or values are errors, never silently ignored. */
export function applyAnswers(
  base: Stack,
  answers: Record<string, string>,
): { stack: Stack; errors: string[] } {
  const stack = { ...base } as Record<string, string>;
  const errors: string[] = [];
  for (const [k, v] of Object.entries(answers)) {
    const q = QUESTIONS.find((x) => x.key === k);
    if (!q)
      errors.push(
        `unknown stack question "${k}" (known: ${QUESTIONS.map((x) => x.key).join(", ")})`,
      );
    else if (k !== "region" && !q.options.some((o) => o.value === v))
      errors.push(`"${k}" must be one of ${q.options.map((o) => o.value).join(", ")}`);
    else if (k === "region" && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(v))
      errors.push(`"${v}" is not an AWS region code`);
    else stack[k] = v;
  }
  return { stack: stack as unknown as Stack, errors };
}

/** Sizing declared in the repo (current mode): the most authoritative declaration per kind. */
export interface Declared {
  compute?: {
    nodeId: string;
    vcpu?: number;
    memoryGb?: number;
    replicas?: number;
    source: string;
    others: string[];
  };
  database?: { nodeId: string; instanceType?: string; storageGb?: number; multiAz?: boolean };
  cache?: { nodeId: string; instanceType?: string; replicas?: number };
  /** Detected services the model has no price model for (shown as "not priced"). */
  unpriced: { nodeId: string; kind: string; label: string }[];
}

const SOURCE_RANK = ["terraform", "kubernetes", "platform", "compose", "dockerfile"];
const rank = (n: IRNode): number => {
  const src = (n.meta?.["sources"] as string[] | undefined) ?? [];
  const r = Math.min(...src.map((s) => SOURCE_RANK.indexOf(s) + 1 || 99));
  return Number.isFinite(r) ? r : 99;
};
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function declaredSizing(model: Model): Declared {
  const nodes = infra(model);
  const out: Declared = { unpriced: [] };
  const computes = nodes
    .filter(
      (n) =>
        n.kind === "compute" && n.meta?.["engine"] !== "alb" && n.meta?.["engine"] !== "lambda",
    )
    .filter((n) => !/worker/i.test(n.name))
    .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
  const top = computes[0];
  if (top) {
    const mem = num(top.meta?.["memoryMb"]);
    out.compute = {
      nodeId: top.id,
      vcpu: num(top.meta?.["cpu"]),
      memoryGb: mem !== undefined ? mem / 1024 : undefined,
      replicas: num(top.meta?.["replicas"]),
      source: ((top.meta?.["sources"] as string[] | undefined) ?? []).join(", "),
      others: computes.slice(1).map((n) => n.id),
    };
  }
  const db = nodes.find(
    (n) => n.kind === "database" && (n.id === "database:postgres" || n.id === "database:mysql"),
  );
  if (db)
    out.database = {
      nodeId: db.id,
      instanceType: str(db.meta?.["instanceType"]),
      storageGb: num(db.meta?.["storageGb"]),
      multiAz:
        typeof db.meta?.["multiAz"] === "boolean" ? (db.meta["multiAz"] as boolean) : undefined,
    };
  const cache = nodes.find(
    (n) => n.kind === "cache" && (n.id === "cache:redis" || n.id === "cache:valkey"),
  );
  if (cache)
    out.cache = {
      nodeId: cache.id,
      instanceType: str(cache.meta?.["instanceType"]),
      replicas: num(cache.meta?.["replicas"]),
    };
  const priced = new Set([
    "database:postgres",
    "database:mysql",
    "database:supabase",
    "cache:redis",
    "cache:valkey",
    "storage:s3",
    "email:ses",
    "email:sendgrid",
    "email:resend",
    "email:postmark",
    "email:mailgun",
    "payments:stripe",
    "payments:razorpay",
    "llm:openai",
    "llm:anthropic",
    "llm:gemini",
    "messaging:twilio",
    "hosting:vercel",
    "hosting:netlify",
    "queue:celery",
    "queue:bullmq",
  ]);
  for (const n of nodes)
    if (n.kind !== "compute" && !priced.has(n.id))
      out.unpriced.push({ nodeId: n.id, kind: n.kind, label: n.name });
  return out;
}
