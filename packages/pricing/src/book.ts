import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type PriceBook,
  type PriceRecord,
  PRICES_SCHEMA_VERSION,
  mergeBooks,
  validatePriceBook,
} from "@buildrax/cost";
import {
  AWS_SERVICES,
  type AwsService,
  type OfferFile,
  awsOfferUrl,
  extractAws,
  isRegion,
} from "./aws.js";
import { type AwsCredentials, queryAws } from "./credentials.js";
import { type FetchLike, safeFetch } from "./safe-fetch.js";

/** Rough sizes (us-east-1, 2026-11), shown in the plan so nobody is surprised by a 32 MB download. */
const APPROX_MB: Record<AwsService, number> = {
  AmazonECS: 1.2,
  AmazonRDS: 32,
  AmazonElastiCache: 2.2,
  AmazonS3: 0.5,
  AWSDataTransfer: 1.5,
  AWSELB: 0.02,
  AmazonSES: 0.1,
};

export interface PricingPlan {
  region: string;
  method: "public-files" | "query-api";
  requests: { service: AwsService; url: string; approxMb?: number }[];
  sends: string;
}

export function planAws(
  region: string,
  method: PricingPlan["method"] = "public-files",
): PricingPlan {
  if (!isRegion(region)) throw new Error(`"${region}" is not an AWS region code`);
  return {
    region,
    method,
    requests: AWS_SERVICES.map((s) =>
      method === "public-files"
        ? { service: s, url: awsOfferUrl(s, region), approxMb: APPROX_MB[s] }
        : { service: s, url: `https://api.pricing.us-east-1.amazonaws.com/ (GetProducts ${s})` },
    ),
    sends:
      method === "public-files"
        ? "Plain GET requests for public price files. Nothing about your repository is sent."
        : "Signed GetProducts requests with service, region and product filters only. Nothing about your repository is sent.",
  };
}

export interface FetchOptions {
  fetchFn?: FetchLike;
  now?: () => Date;
  credentials?: AwsCredentials;
  onProgress?: (msg: string) => void;
}

/** Fetch AWS prices for a region into a compact price book. Network: allowlisted hosts only. */
export async function fetchAwsBook(region: string, opts: FetchOptions = {}): Promise<PriceBook> {
  if (!isRegion(region)) throw new Error(`"${region}" is not an AWS region code`);
  const now = opts.now ?? (() => new Date());
  const records: PriceRecord[] = [];
  for (const service of AWS_SERVICES) {
    opts.onProgress?.(`${service}…`);
    if (opts.credentials) {
      records.push(
        ...(await queryAws(service, region, opts.credentials, { fetchFn: opts.fetchFn, now })),
      );
    } else {
      const url = awsOfferUrl(service, region);
      const offer = JSON.parse(await safeFetch(url, {}, opts.fetchFn)) as OfferFile;
      records.push(...extractAws(service, offer, region, now().toISOString(), url));
    }
  }
  return { schemaVersion: PRICES_SCHEMA_VERSION, currency: "USD", region, records };
}

export const cachePath = (root: string, region: string): string =>
  path.join(root, ".buildrax", "cache", "pricing", `aws-${region}.json`);
export const userPricesPath = (root: string): string => path.join(root, ".buildrax", "prices.json");

async function readBook(file: string): Promise<{ book?: PriceBook; errors: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { errors: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { errors: [`${file}: not valid JSON`] };
  }
  const v = validatePriceBook(json);
  return v.ok ? { book: v.book, errors: [] } : { errors: v.errors.map((e) => `${file}: ${e}`) };
}

export async function readCachedBook(root: string, region: string) {
  return readBook(cachePath(root, region));
}

export async function writeCachedBook(root: string, book: PriceBook): Promise<string> {
  const file = cachePath(root, book.region);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(book, null, 2) + "\n");
  return file;
}

/**
 * Prices with no machine-readable list (Stripe fees, LLM tokens, hosting plans, …) live in
 * `.buildrax/prices.json`, written by the user or an agent after reading the provider's page.
 * Every entry must carry its source URL and retrieval date; they override list prices by key.
 */
export async function readUserPrices(root: string) {
  return readBook(userPricesPath(root));
}

/** Cached list prices + the user's own prices (user wins). */
export async function loadPriceBook(
  root: string,
  region: string,
): Promise<{ book: PriceBook; errors: string[]; cached: boolean; retrievedAt?: string }> {
  const cached = await readCachedBook(root, region);
  const user = await readUserPrices(root);
  const retrievedAt = cached.book?.records.map((r) => r.retrievedAt).sort()[0];
  return {
    book: mergeBooks(region, cached.book, user.book),
    errors: [...cached.errors, ...user.errors],
    cached: !!cached.book,
    retrievedAt,
  };
}

/** A starter `.buildrax/prices.json`: keys the estimate needs, to be filled from pricing pages. */
export function userPricesTemplate(
  keys: { key: string; label: string; lookUp?: string }[],
): unknown {
  return {
    schemaVersion: PRICES_SCHEMA_VERSION,
    currency: "USD",
    region: "global",
    records: [],
    _todo: keys.map((k) => ({
      key: k.key,
      label: k.label,
      lookUp: k.lookUp,
      example: {
        key: k.key,
        label: k.label,
        unit: "count",
        tiers: [{ from: 0, usd: 0 }],
        provider: k.key.split(".")[1],
        sourceUrl: k.lookUp ?? "https://…",
        retrievedAt: "YYYY-MM-DD",
        evidenceType: "researched-page",
      },
    })),
  };
}
