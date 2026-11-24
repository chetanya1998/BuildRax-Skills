import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ASSUMPTION_LABELS,
  type Assumptions,
  type CostReport,
  DEFAULT_ASSUMPTIONS,
  type Mode,
  type PriceBook,
  QUESTIONS,
  type Stack,
  applyAnswers,
  defaultStack,
  estimate,
} from "@buildrax/cost";
import type { Model } from "@buildrax/ir";
import {
  type FetchLike,
  type PricingPlan,
  awsCredentialsFromEnv,
  fetchAwsBook,
  loadPriceBook,
  planAws,
  redact,
  writeCachedBook,
} from "@buildrax/pricing";
import { buildraxDir, loadModel, modelPathFor } from "./data.js";

export const costPathFor = (repo: string): string => path.join(buildraxDir(repo), "cost.json");
export const costPricesPathFor = (repo: string): string =>
  path.join(buildraxDir(repo), "cost-prices.json");

/** `100,1k,10k,100k,1m` → numbers. */
export function parseTiers(spec: string): number[] {
  const out = spec.split(",").map((s) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(s);
    if (!m) throw new Error(`bad tier "${s}" (use e.g. 100,1k,10k,100k,1m)`);
    const mult = { "": 1, k: 1_000, m: 1_000_000 }[m[2]!.toLowerCase() as "" | "k" | "m"];
    return Math.round(Number(m[1]) * mult);
  });
  if (!out.length || out.some((n) => n <= 0 || n > 1e9))
    throw new Error("tiers must be between 1 and 1,000,000,000 users");
  return out;
}

/** `a=1,b=2` → record (shared by --stack and --assume). */
export function parsePairs(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) throw new Error(`expected key=value, got "${part}"`);
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function parseAssumptions(spec: string | undefined): Partial<Assumptions> {
  const out: Partial<Assumptions> = {};
  for (const [k, v] of Object.entries(parsePairs(spec))) {
    if (!(k in DEFAULT_ASSUMPTIONS))
      throw new Error(`unknown assumption "${k}" (see: buildrax cost --list-assumptions)`);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0)
      throw new Error(`assumption ${k} must be a non-negative number`);
    out[k as keyof Assumptions] = n;
  }
  return out;
}

async function maybeModel(repo: string): Promise<Model | undefined> {
  try {
    await fs.access(modelPathFor(repo));
  } catch {
    return undefined;
  }
  return loadModel(repo);
}

export interface CostOptions {
  mode: Mode;
  tiers?: number[];
  stack?: Record<string, string>;
  assumptions?: Partial<Assumptions>;
  online?: boolean;
  useCredentials?: boolean;
  fetchFn?: FetchLike;
  env?: Record<string, string | undefined>;
  onProgress?: (msg: string) => void;
}

export interface CostResult {
  report: CostReport;
  file: string;
  prices: PriceBook;
  /** Shown when list prices are not cached and --online was not given. */
  plan?: PricingPlan;
  fetched?: string;
  warnings: string[];
}

/** Resolve the stack a run uses: detected defaults + explicit answers (validated). */
export async function resolveStack(
  repo: string,
  answers: Record<string, string> = {},
): Promise<{ stack: Stack; model?: Model }> {
  const model = await maybeModel(repo);
  const r = applyAnswers(defaultStack(model), answers);
  if (r.errors.length) throw new Error(r.errors.join("\n"));
  return { stack: r.stack, model };
}

export async function costCommand(repo: string, opts: CostOptions): Promise<CostResult> {
  const root = path.resolve(repo);
  const { stack, model } = await resolveStack(root, opts.stack ?? {});
  if (opts.mode === "current" && !model)
    throw new Error(
      `current mode needs a scan: run \`buildrax scan ${repo}\` first (or use --mode product)`,
    );
  if (opts.useCredentials && !opts.online)
    throw new Error("--use-credentials only applies with --online");
  const warnings: string[] = [];
  let fetched: string | undefined;
  if (opts.online) {
    const creds = opts.useCredentials ? awsCredentialsFromEnv(opts.env ?? process.env) : undefined;
    if (opts.useCredentials && !creds)
      throw new Error(
        "--use-credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set in the environment",
      );
    try {
      const book = await fetchAwsBook(stack.region, {
        credentials: creds,
        fetchFn: opts.fetchFn,
        onProgress: opts.onProgress,
      });
      fetched = await writeCachedBook(root, book);
    } catch (e) {
      // The original error is dropped on purpose: its message or cause could hold a credential.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `price lookup failed: ${redact(e instanceof Error ? e.message : String(e), creds)}`,
      );
    }
  }
  const loaded = await loadPriceBook(root, stack.region);
  warnings.push(...loaded.errors);
  const plan = loaded.cached ? undefined : planAws(stack.region);
  const report = estimate({
    mode: opts.mode,
    model,
    stack,
    tiers: opts.tiers,
    assumptions: opts.assumptions,
    prices: loaded.book,
  });
  const file = costPathFor(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, { ...report, generatedAt: new Date().toISOString() });
  // Only the prices this stack can use travel with the report (the viewer recomputes from them).
  const prices: PriceBook = {
    ...loaded.book,
    records: loaded.book.records.filter((r) => keyUsable(r.key, stack)),
  };
  await writeAtomic(costPricesPathFor(root), prices);
  return { report, file, prices, plan, fetched, warnings };
}

/** Price keys relevant to a stack (any instance size, so the viewer can resize on edits). */
function keyUsable(key: string, s: Stack): boolean {
  if (key.startsWith("aws.fargate.")) return key.startsWith(`aws.fargate.${s.arch}.`);
  if (key.startsWith("aws.rds.")) return key.startsWith(`aws.rds.${s.database}.`);
  if (key.startsWith("aws.elasticache.")) return key.startsWith(`aws.elasticache.${s.cache}.`);
  return true;
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
}

const usd = (n: number): string =>
  n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(n < 10 ? 2 : 0)}`;
const users = (n: number): string =>
  n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(n);

export function formatPricingPlan(plan: PricingPlan): string {
  return [
    `No cached AWS prices for ${plan.region}: AWS line items show as "price needed". To fetch them, run again with --online:`,
    ...plan.requests.map((r) => `  GET ${r.url}${r.approxMb ? `  (~${r.approxMb} MB)` : ""}`),
    `  ${plan.sends}`,
  ].join("\n");
}

export function formatCost(r: CostReport): string {
  const out: string[] = [];
  out.push(
    `Cost estimate (${r.mode === "product" ? "as a product, hypothetical" : "current project"}), AWS ${r.region}, USD per month`,
  );
  out.push(
    `Stack: ${QUESTIONS.filter((q) => q.key !== "region")
      .map((q) => `${q.key}=${r.stack[q.key]}`)
      .join(" ")}`,
  );
  out.push("");
  out.push(
    [
      "Users".padEnd(7),
      "Low".padStart(10),
      "Expected".padStart(10),
      "High".padStart(10),
      "  Notes",
    ].join(" "),
  );
  for (const t of r.tiers)
    out.push(
      [
        users(t.users).padEnd(7),
        usd(t.total.low).padStart(10),
        usd(t.total.expected).padStart(10),
        usd(t.total.high).padStart(10),
        `  ${t.incomplete ? "+ items with no price yet" : ""}`,
      ].join(" "),
    );
  for (const t of r.tiers) {
    out.push(
      "",
      `${users(t.users)} users: ~${Math.round(t.dau).toLocaleString("en-US")} daily active, peak ~${t.peakRps.toFixed(1)} req/s, expected ${usd(t.total.expected)}${t.incomplete ? " + unpriced items" : ""}`,
    );
    for (const c of t.components) {
      const cost =
        c.incomplete && c.monthly.expected === 0
          ? "price needed"
          : usd(c.monthly.expected) + (c.incomplete ? "+" : "");
      out.push(`  ${c.label.padEnd(36)} ${cost.padStart(12)}  ${c.sizing}`);
    }
    for (const x of t.changes) out.push(`  change: ${x}`);
    for (const b of t.bottlenecks) out.push(`  watch:  ${b}`);
    if (t.sensitivity.length)
      out.push(
        `  most sensitive to: ${t.sensitivity
          .map(
            (s) =>
              `${ASSUMPTION_LABELS[s.assumption]} (+50% → ${s.changePct > 0 ? "+" : ""}${s.changePct}%)`,
          )
          .join("; ")}`,
      );
  }
  if (r.missingPrices.length) {
    out.push(
      "",
      "Prices needed (not invented; add them to .buildrax/prices.json with source URL and date):",
    );
    for (const m of r.missingPrices)
      out.push(`  ${m.key.padEnd(34)} ${m.label}${m.lookUp ? `  → ${m.lookUp}` : ""}`);
  }
  if (r.notPriced.length)
    out.push("", `Detected but not priced yet: ${r.notPriced.map((n) => n.label).join(", ")}`);
  if (r.sources.length) {
    const dates = [
      ...new Set(r.sources.map((s) => (s.publishedAt ?? s.retrievedAt).slice(0, 10))),
    ].sort();
    const hosts = [...new Set(r.sources.map((s) => new URL(s.sourceUrl).host))];
    out.push(
      "",
      `Prices: ${r.sources.length} from ${hosts.join(", ")} (published ${dates[0]}${dates.length > 1 ? ` … ${dates.at(-1)}` : ""}).`,
    );
  }
  out.push(
    "",
    r.disclaimer,
    "Assumptions: buildrax cost --list-assumptions; change them with --assume key=value.",
  );
  return out.join("\n");
}

export function formatAssumptions(a: Assumptions = DEFAULT_ASSUMPTIONS): string {
  return (Object.keys(a) as (keyof Assumptions)[])
    .map((k) => `  ${k.padEnd(24)} ${String(a[k]).padStart(8)}  ${ASSUMPTION_LABELS[k]}`)
    .join("\n");
}

/** Interactive questionnaire: one line per question, Enter keeps the pre-selected default. */
export async function askStack(
  defaults: Stack,
  ask: (q: string) => Promise<string>,
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const q of QUESTIONS) {
    const def = String(defaults[q.key]);
    const opts = q.options.map((o) => (o.value === def ? `[${o.value}]` : o.value)).join(" / ");
    for (;;) {
      const a = (await ask(`${q.label}: ${opts} › `)).trim();
      if (!a) break;
      const ok =
        q.key === "region"
          ? /^[a-z]{2}(-[a-z]+)+-\d$/.test(a)
          : q.options.some((o) => o.value === a);
      if (ok) {
        answers[q.key] = a;
        break;
      }
    }
  }
  return answers;
}
