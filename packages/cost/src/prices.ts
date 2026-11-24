import { z } from "zod";

export const PRICES_SCHEMA_VERSION = "buildrax-prices/v1" as const;

export const PRICE_UNITS = [
  "hour",
  "gb-month",
  "gb",
  "count",
  "lcu-hour",
  "percent",
  "transaction",
  "1m-tokens",
  "month",
] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

/**
 * Where a price came from:
 *  official-price-list  a provider's machine-readable price list (e.g. AWS Price List files)
 *  researched-page      a provider's public pricing page, recorded with URL and date
 *  user-contract        the user's own negotiated price
 */
export const PRICE_EVIDENCE = ["official-price-list", "researched-page", "user-contract"] as const;

export const PriceTierSchema = z.object({
  /** Units from which this tier applies (0-based, inclusive). */
  from: z.number().min(0),
  /** Units up to which it applies (exclusive); absent = no upper bound. */
  to: z.number().positive().optional(),
  usd: z.number().min(0),
});

export const PriceRecordSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  unit: z.enum(PRICE_UNITS),
  tiers: z.array(PriceTierSchema).min(1),
  provider: z.string().min(1),
  region: z.string().optional(),
  sourceUrl: z.string().url(),
  /** When the provider published it (price list files carry this). */
  publishedAt: z.string().optional(),
  /** When BuildRAX (or the user / agent) retrieved it. */
  retrievedAt: z.string().min(1),
  evidenceType: z.enum(PRICE_EVIDENCE),
  /** Instance facts used for sizing (vCPU, memory). */
  meta: z.object({ vcpu: z.number().optional(), memoryGib: z.number().optional() }).optional(),
  notes: z.string().optional(),
});

export const PriceBookSchema = z.object({
  schemaVersion: z.literal(PRICES_SCHEMA_VERSION),
  currency: z.literal("USD"),
  region: z.string(),
  records: z.array(PriceRecordSchema),
});

export type PriceTier = z.infer<typeof PriceTierSchema>;
export type PriceRecord = z.infer<typeof PriceRecordSchema>;
export type PriceBook = z.infer<typeof PriceBookSchema>;

export function validatePriceBook(input: unknown): {
  ok: boolean;
  errors: string[];
  book?: PriceBook;
} {
  const p = PriceBookSchema.safeParse(input);
  if (!p.success)
    return {
      ok: false,
      errors: p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  return { ok: true, errors: [], book: p.data };
}

/** Merge books; later books override earlier ones key by key (user prices beat list prices). */
export function mergeBooks(region: string, ...books: (PriceBook | undefined)[]): PriceBook {
  const byKey = new Map<string, PriceRecord>();
  for (const b of books) for (const r of b?.records ?? []) byKey.set(r.key, r);
  return {
    schemaVersion: PRICES_SCHEMA_VERSION,
    currency: "USD",
    region,
    records: [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}

/** Cost of `quantity` units under a (possibly tiered) price. */
export function tieredCost(record: Pick<PriceRecord, "tiers">, quantity: number): number {
  if (quantity <= 0) return 0;
  let total = 0;
  for (const t of [...record.tiers].sort((a, b) => a.from - b.from)) {
    const upper = t.to ?? Infinity;
    if (quantity <= t.from) break;
    total += (Math.min(quantity, upper) - t.from) * t.usd;
  }
  return total;
}

/** Price keys. One place, so the pricing fetcher and the model always agree. */
export const priceKey = {
  fargateVcpu: (arch: "x86" | "arm" = "x86") => `aws.fargate.${arch}.vcpu-hour`,
  fargateGb: (arch: "x86" | "arm" = "x86") => `aws.fargate.${arch}.gb-hour`,
  rdsInstance: (engine: string, cls: string, multiAz: boolean) =>
    `aws.rds.${engine}.${cls}.${multiAz ? "multi-az" : "single-az"}`,
  rdsStorage: (engine: string, multiAz: boolean) =>
    `aws.rds.${engine}.gp3.${multiAz ? "multi-az" : "single-az"}`,
  cache: (engine: string, cls: string) => `aws.elasticache.${engine}.${cls}`,
  s3: () => "aws.s3.standard",
  egress: () => "aws.data-transfer.out",
  albHour: () => "aws.alb.hour",
  albLcu: () => "aws.alb.lcu-hour",
  sesRecipient: () => "aws.ses.recipient",
  paymentsPercent: (p: string) => `payments.${p}.percent`,
  paymentsFixed: (p: string) => `payments.${p}.fixed`,
  llmInput: (p: string) => `llm.${p}.input`,
  llmOutput: (p: string) => `llm.${p}.output`,
  emailPerMessage: (p: string) => `email.${p}.per-email`,
  smsPerMessage: (p: string) => `messaging.${p}.per-sms`,
  monthly: (kind: string, p: string) => `${kind}.${p}.monthly`,
};

/** Where to look up prices that have no machine-readable list (shown when a price is missing). */
export const PRICE_PAGES: Record<string, string> = {
  stripe: "https://stripe.com/pricing",
  openai: "https://openai.com/api/pricing/",
  anthropic: "https://www.anthropic.com/pricing",
  gemini: "https://ai.google.dev/pricing",
  sendgrid: "https://sendgrid.com/en-us/pricing",
  resend: "https://resend.com/pricing",
  postmark: "https://postmarkapp.com/pricing",
  mailgun: "https://www.mailgun.com/pricing/",
  twilio: "https://www.twilio.com/en-us/sms/pricing/us",
  vercel: "https://vercel.com/pricing",
  netlify: "https://www.netlify.com/pricing/",
  fly: "https://fly.io/docs/about/pricing/",
  render: "https://render.com/pricing",
  supabase: "https://supabase.com/pricing",
  algolia: "https://www.algolia.com/pricing/",
  auth0: "https://auth0.com/pricing",
  clerk: "https://clerk.com/pricing",
};
