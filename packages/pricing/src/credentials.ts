import { createHash, createHmac } from "node:crypto";
import { extractAws, type AwsService, type OfferFile } from "./aws.js";
import { assertAllowed, type FetchLike, safeFetch } from "./safe-fetch.js";
import type { PriceRecord } from "@buildrax/cost";

/**
 * Optional AWS credentials for the Price List Query API. Security rules:
 *  - read only from the process environment, only when the caller passes `--use-credentials`;
 *  - never written anywhere by BuildRAX (no file, cache, model, report or log);
 *  - only ever sent, signed, to api.pricing.us-east-1.amazonaws.com;
 *  - redacted from every error message;
 *  - least privilege is enough: pricing:GetProducts (see docs/privacy.md).
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export const QUERY_API_HOST = "api.pricing.us-east-1.amazonaws.com";

export function awsCredentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AwsCredentials | undefined {
  const id = env["AWS_ACCESS_KEY_ID"];
  const secret = env["AWS_SECRET_ACCESS_KEY"];
  if (!id || !secret) return undefined;
  return {
    accessKeyId: id,
    secretAccessKey: secret,
    sessionToken: env["AWS_SESSION_TOKEN"] || undefined,
  };
}

/** What `buildrax cost credentials status` reports: presence only, never values or fragments. */
export function credentialStatus(env: Record<string, string | undefined> = process.env): {
  aws: string;
  stored: string;
} {
  const c = awsCredentialsFromEnv(env);
  return {
    aws: c
      ? `found in environment (AWS_ACCESS_KEY_ID${c.sessionToken ? ", temporary session" : ""}); used only with --use-credentials`
      : "not set",
    stored: "BuildRAX stores no credentials (nothing to clear)",
  };
}

export function redact(text: string, creds?: AwsCredentials): string {
  let out = text;
  for (const s of [creds?.secretAccessKey, creds?.sessionToken, creds?.accessKeyId])
    if (s) out = out.split(s).join("[redacted]");
  return out.replace(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}/g, "[redacted]");
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (k: Buffer | string, s: string): Buffer =>
  createHmac("sha256", k).update(s, "utf8").digest();

/** AWS Signature Version 4 (header form). Returns the headers to send, including Authorization. */
export function signV4(
  req: { method: string; url: string; headers: Record<string, string>; body: string },
  creds: AwsCredentials,
  region: string,
  service: string,
  amzDate: string,
): Record<string, string> {
  const u = new URL(req.url);
  const headers: Record<string, string> = { ...req.headers, host: u.host, "x-amz-date": amzDate };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]),
  );
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    req.method,
    u.pathname || "/",
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    names.join(";"),
    sha256(req.body),
  ].join("\n");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, date), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

type Filter = { Field: string; Value: string };
/** Narrow GetProducts filters per service, so lookups stay small. */
export function queryFilters(service: AwsService, region: string): Filter[][] {
  const r = { Field: "regionCode", Value: region };
  switch (service) {
    case "AmazonECS":
      return [[r]];
    case "AmazonRDS":
      return ["PostgreSQL", "MySQL"].flatMap((e) => [
        [
          r,
          { Field: "databaseEngine", Value: e },
          { Field: "productFamily", Value: "Database Instance" },
        ],
        [
          r,
          { Field: "databaseEngine", Value: e },
          { Field: "productFamily", Value: "Database Storage" },
          { Field: "volumeType", Value: "General Purpose-GP3" },
        ],
      ]);
    case "AmazonElastiCache":
      return [[r, { Field: "productFamily", Value: "Cache Instance" }]];
    case "AmazonS3":
      return [[r, { Field: "volumeType", Value: "Standard" }]];
    case "AWSDataTransfer":
      return [
        [
          { Field: "fromRegionCode", Value: region },
          { Field: "toLocation", Value: "External" },
          { Field: "transferType", Value: "AWS Outbound" },
        ],
      ];
    case "AWSELB":
      return [[r, { Field: "productFamily", Value: "Load Balancer-Application" }]];
    case "AmazonSES":
      return [[r, { Field: "operation", Value: "Send" }]];
  }
}

/** Fetch prices for one service through the signed Price List Query API. */
export async function queryAws(
  service: AwsService,
  region: string,
  creds: AwsCredentials,
  opts: { fetchFn?: FetchLike; now?: () => Date; maxPages?: number } = {},
): Promise<PriceRecord[]> {
  const url = `https://${QUERY_API_HOST}/`;
  assertAllowed(url);
  const offer: OfferFile = { products: {}, terms: { OnDemand: {} } };
  const now = opts.now ?? (() => new Date());
  try {
    for (const filters of queryFilters(service, region)) {
      let token: string | undefined;
      let pages = 0;
      do {
        const body = JSON.stringify({
          ServiceCode: service,
          FormatVersion: "aws_v1",
          MaxResults: 100,
          Filters: filters.map((f) => ({ Type: "TERM_MATCH", ...f })),
          ...(token ? { NextToken: token } : {}),
        });
        const amzDate = now()
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}/, "");
        const headers = signV4(
          {
            method: "POST",
            url,
            headers: {
              "content-type": "application/x-amz-json-1.1",
              "x-amz-target": "AWSPriceListService.GetProducts",
            },
            body,
          },
          creds,
          "us-east-1",
          "pricing",
          amzDate,
        );
        const text = await safeFetch(
          url,
          { method: "POST", headers, body, maxBytes: 16 * 1024 * 1024 },
          opts.fetchFn,
        );
        const res = JSON.parse(text) as { PriceList?: string[]; NextToken?: string };
        for (const raw of res.PriceList ?? []) {
          const item = JSON.parse(raw) as {
            product: OfferFile["products"][string] & { sku: string };
            terms: { OnDemand?: Record<string, unknown> };
            publicationDate?: string;
          };
          offer.products[item.product.sku] = item.product;
          offer.terms.OnDemand![item.product.sku] = (item.terms.OnDemand ?? {}) as never;
          if (
            item.publicationDate &&
            (!offer.publicationDate || item.publicationDate > offer.publicationDate)
          )
            offer.publicationDate = item.publicationDate;
        }
        token = res.NextToken;
      } while (token && ++pages < (opts.maxPages ?? 20));
    }
  } catch (e) {
    // The original error is dropped on purpose: its message or cause could hold a credential.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redact(e instanceof Error ? e.message : String(e), creds));
  }
  return extractAws(
    service,
    offer,
    region,
    now().toISOString(),
    `https://${QUERY_API_HOST}/?ServiceCode=${service}`,
  );
}
