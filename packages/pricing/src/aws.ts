import {
  CACHE_LADDER,
  DB_LADDER,
  type PriceRecord,
  type PriceTier,
  priceKey,
} from "@buildrax/cost";

/** Shape of an AWS Price List offer file (only the parts we read). */
export interface OfferFile {
  offerCode?: string;
  publicationDate?: string;
  products: Record<
    string,
    { sku?: string; productFamily?: string; attributes: Record<string, string> }
  >;
  terms: {
    OnDemand?: Record<string, Record<string, { priceDimensions: Record<string, PriceDimension> }>>;
  };
}
interface PriceDimension {
  unit: string;
  beginRange?: string;
  endRange?: string;
  pricePerUnit: { USD?: string };
  description?: string;
}

/** The AWS services an estimate needs, and nothing else (EC2's ~0.5 GB file is never fetched). */
export const AWS_SERVICES = [
  "AmazonECS",
  "AmazonRDS",
  "AmazonElastiCache",
  "AmazonS3",
  "AWSDataTransfer",
  "AWSELB",
  "AmazonSES",
] as const;
export type AwsService = (typeof AWS_SERVICES)[number];

export const AWS_FILE_HOST = "pricing.us-east-1.amazonaws.com";
export const awsOfferUrl = (service: AwsService, region: string): string =>
  `https://${AWS_FILE_HOST}/offers/v1.0/aws/${service}/current/${region}/index.json`;

/** Region codes look like `us-east-1`; anything else is refused before it reaches a URL. */
export const isRegion = (r: string): boolean => /^[a-z]{2}(-[a-z]+)+-\d$/.test(r);

/** `USE1-Recipients` → `Recipients`; usage types carry a regional prefix outside us-east-1. */
const bareUsage = (u: string | undefined): string => (u ?? "").replace(/^[A-Z]{2,4}\d-/, "");

function tiers(dims: PriceDimension[]): PriceTier[] {
  return dims
    .map((d) => {
      const from = Number(d.beginRange ?? 0);
      const end = d.endRange === undefined || d.endRange === "Inf" ? undefined : Number(d.endRange);
      return { from, to: end, usd: Number(d.pricePerUnit.USD ?? NaN) };
    })
    .filter((t) => Number.isFinite(t.usd) && Number.isFinite(t.from))
    .sort((a, b) => a.from - b.from);
}

interface Want {
  key: string;
  label: string;
  unit: PriceRecord["unit"];
  match: (family: string | undefined, a: Record<string, string>) => boolean;
  meta?: PriceRecord["meta"];
}

function wants(service: AwsService): Want[] {
  switch (service) {
    case "AmazonECS":
      return (["x86", "arm"] as const).flatMap((arch) => {
        const p = arch === "arm" ? "Fargate-ARM-" : "Fargate-";
        return [
          {
            key: priceKey.fargateVcpu(arch),
            label: `Fargate ${arch} vCPU-hour (Linux)`,
            unit: "hour" as const,
            match: (_f: string | undefined, a: Record<string, string>) =>
              bareUsage(a["usagetype"]) === `${p}vCPU-Hours:perCPU`,
          },
          {
            key: priceKey.fargateGb(arch),
            label: `Fargate ${arch} GB-hour (Linux)`,
            unit: "hour" as const,
            match: (_f: string | undefined, a: Record<string, string>) =>
              bareUsage(a["usagetype"]) === `${p}GB-Hours`,
          },
        ];
      });
    case "AmazonRDS":
      return (["postgres", "mysql"] as const).flatMap((engine) => {
        const name = engine === "postgres" ? "PostgreSQL" : "MySQL";
        return [false, true].flatMap((multi) => [
          ...DB_LADDER.map((c) => ({
            key: priceKey.rdsInstance(engine, c.cls, multi),
            label: `RDS ${name} ${c.cls} ${multi ? "Multi-AZ" : "Single-AZ"} hour`,
            unit: "hour" as const,
            meta: { vcpu: c.vcpu, memoryGib: c.memoryGib },
            match: (f: string | undefined, a: Record<string, string>) =>
              f === "Database Instance" &&
              a["databaseEngine"] === name &&
              a["instanceType"] === c.cls &&
              a["deploymentOption"] === (multi ? "Multi-AZ" : "Single-AZ") &&
              // AWS abbreviates sizes in usage types (`db.m7g.xlarge` → `InstanceUsage:db.m7g.xl`).
              bareUsage(a["usagetype"]).startsWith(multi ? "Multi-AZUsage:" : "InstanceUsage:"),
          })),
          {
            key: priceKey.rdsStorage(engine, multi),
            label: `RDS ${name} gp3 storage GB-month ${multi ? "Multi-AZ" : "Single-AZ"}`,
            unit: "gb-month" as const,
            match: (f: string | undefined, a: Record<string, string>) =>
              f === "Database Storage" &&
              a["databaseEngine"] === name &&
              a["volumeType"] === "General Purpose-GP3" &&
              a["deploymentOption"] === (multi ? "Multi-AZ" : "Single-AZ"),
          },
        ]);
      });
    case "AmazonElastiCache":
      return (["redis", "valkey"] as const).flatMap((engine) =>
        CACHE_LADDER.map((c) => ({
          key: priceKey.cache(engine, c.cls),
          label: `ElastiCache ${engine === "redis" ? "Redis" : "Valkey"} ${c.cls} node-hour`,
          unit: "hour" as const,
          meta: { memoryGib: c.memoryGib },
          match: (f: string | undefined, a: Record<string, string>) =>
            f === "Cache Instance" &&
            a["cacheEngine"] === (engine === "redis" ? "Redis" : "Valkey") &&
            a["instanceType"] === c.cls &&
            bareUsage(a["usagetype"]) === `NodeUsage:${c.cls}`,
        })),
      );
    case "AmazonS3":
      return [
        {
          key: priceKey.s3(),
          label: "S3 Standard storage GB-month",
          unit: "gb-month",
          match: (_f, a) =>
            bareUsage(a["usagetype"]) === "TimedStorage-ByteHrs" && a["volumeType"] === "Standard",
        },
      ];
    case "AWSDataTransfer":
      return [
        {
          key: priceKey.egress(),
          label: "Data transfer out to the internet, GB",
          unit: "gb",
          match: (_f, a) =>
            a["transferType"] === "AWS Outbound" &&
            a["toLocation"] === "External" &&
            bareUsage(a["usagetype"]) === "DataTransfer-Out-Bytes",
        },
      ];
    case "AWSELB":
      return [
        {
          key: priceKey.albHour(),
          label: "Application Load Balancer hour",
          unit: "hour",
          match: (f, a) =>
            f === "Load Balancer-Application" && bareUsage(a["usagetype"]) === "LoadBalancerUsage",
        },
        {
          key: priceKey.albLcu(),
          label: "Application Load Balancer LCU-hour",
          unit: "lcu-hour",
          match: (f, a) =>
            f === "Load Balancer-Application" && bareUsage(a["usagetype"]) === "LCUUsage",
        },
      ];
    case "AmazonSES":
      return [
        {
          key: priceKey.sesRecipient(),
          label: "SES outbound email, per recipient",
          unit: "count",
          match: (_f, a) => a["operation"] === "Send" && bareUsage(a["usagetype"]) === "Recipients",
        },
      ];
  }
}

const inRegion = (a: Record<string, string>, region: string): boolean =>
  (a["regionCode"] ?? a["fromRegionCode"]) === region;

/**
 * Pull the handful of prices an estimate needs out of one offer file. Deterministic: when AWS
 * lists equivalent SKUs, the lowest SKU id wins.
 */
export function extractAws(
  service: AwsService,
  offer: OfferFile,
  region: string,
  retrievedAt: string,
  sourceUrl = awsOfferUrl(service, region),
): PriceRecord[] {
  const out: PriceRecord[] = [];
  const skus = Object.keys(offer.products).sort();
  for (const w of wants(service)) {
    for (const sku of skus) {
      const p = offer.products[sku]!;
      if (!inRegion(p.attributes, region) || !w.match(p.productFamily, p.attributes)) continue;
      const dims = Object.values(offer.terms.OnDemand?.[sku] ?? {}).flatMap((t) =>
        Object.values(t.priceDimensions),
      );
      const tt = tiers(dims);
      if (!tt.length) continue;
      out.push({
        key: w.key,
        label: w.label,
        unit: w.unit,
        tiers: tt,
        provider: "aws",
        region,
        sourceUrl,
        publishedAt: offer.publicationDate,
        retrievedAt,
        evidenceType: "official-price-list",
        ...(w.meta ? { meta: w.meta } : {}),
        notes: `SKU ${sku}`,
      });
      break;
    }
  }
  return out;
}
