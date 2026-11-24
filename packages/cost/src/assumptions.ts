/** Every number the model uses that is not a price. Visible and editable; ranges drive low/high. */
export interface Assumptions {
  /** Share of users active on a given day. */
  dauRatio: number;
  requestsPerDau: number;
  /** Peak-to-average traffic ratio. */
  peakFactor: number;
  /** Requests per second one vCPU of the app serves. */
  rpsPerVcpu: number;
  vcpuPerTask: number;
  memoryGbPerTask: number;
  /** From this many users, run at least two of everything (redundancy) and Multi-AZ databases. */
  haFromUsers: number;
  dbQueriesPerRequest: number;
  /** Queries per second per database vCPU. */
  qpsPerDbVcpu: number;
  dataMbPerUser: number;
  fileStorageMbPerUser: number;
  egressKbPerRequest: number;
  /** Product mode adds a cache from this many users. */
  cacheFromUsers: number;
  cacheMbPer1kDau: number;
  /** Connections each app task opens to the database. */
  dbPoolPerTask: number;
  /** Requests sent over one keep-alive connection (load balancer capacity units). */
  requestsPerConnection: number;
  /** Daily active users one background worker container serves. */
  workerDauPerTask: number;
  emailsPerUserMonth: number;
  paymentsPerUserMonth: number;
  avgPaymentUsd: number;
  llmCallsPerDau: number;
  llmInputTokensPerCall: number;
  llmOutputTokensPerCall: number;
  smsPerUserMonth: number;
}

export const DEFAULT_ASSUMPTIONS: Assumptions = {
  dauRatio: 0.2,
  requestsPerDau: 60,
  peakFactor: 3,
  rpsPerVcpu: 40,
  vcpuPerTask: 0.5,
  memoryGbPerTask: 1,
  haFromUsers: 10_000,
  dbQueriesPerRequest: 4,
  qpsPerDbVcpu: 400,
  dataMbPerUser: 5,
  fileStorageMbPerUser: 20,
  egressKbPerRequest: 40,
  cacheFromUsers: 10_000,
  cacheMbPer1kDau: 50,
  dbPoolPerTask: 10,
  requestsPerConnection: 20,
  workerDauPerTask: 20_000,
  emailsPerUserMonth: 4,
  paymentsPerUserMonth: 0.05,
  avgPaymentUsd: 20,
  llmCallsPerDau: 2,
  llmInputTokensPerCall: 800,
  llmOutputTokensPerCall: 300,
  smsPerUserMonth: 0.2,
};

/** Human labels, shown next to every assumption in the CLI and viewer. */
export const ASSUMPTION_LABELS: Record<keyof Assumptions, string> = {
  dauRatio: "Share of users active per day",
  requestsPerDau: "API requests per active user per day",
  peakFactor: "Peak-to-average traffic",
  rpsPerVcpu: "Requests/second one app vCPU serves",
  vcpuPerTask: "vCPU per app container",
  memoryGbPerTask: "Memory (GB) per app container",
  haFromUsers: "Redundancy (2+ containers, Multi-AZ DB) from users",
  dbQueriesPerRequest: "Database queries per request",
  qpsPerDbVcpu: "Queries/second per database vCPU",
  dataMbPerUser: "Database data per user (MB)",
  fileStorageMbPerUser: "Stored files per user (MB)",
  egressKbPerRequest: "Response size (KB) leaving AWS per request",
  cacheFromUsers: "Add a cache from users (product mode)",
  cacheMbPer1kDau: "Cache memory (MB) per 1,000 daily users",
  dbPoolPerTask: "Database connections per container",
  requestsPerConnection: "Requests per client connection",
  workerDauPerTask: "Daily active users per worker container",
  emailsPerUserMonth: "Emails per user per month",
  paymentsPerUserMonth: "Payments per user per month",
  avgPaymentUsd: "Average payment (USD)",
  llmCallsPerDau: "AI calls per active user per day",
  llmInputTokensPerCall: "AI input tokens per call",
  llmOutputTokensPerCall: "AI output tokens per call",
  smsPerUserMonth: "SMS per user per month",
};

/**
 * Low/high scenarios: traffic-shaped assumptions vary, so the totals are ranges, not single
 * numbers. Everything else stays at the base value.
 */
export function scenarioAssumptions(base: Assumptions): {
  low: Assumptions;
  expected: Assumptions;
  high: Assumptions;
} {
  return {
    low: {
      ...base,
      dauRatio: base.dauRatio * 0.5,
      requestsPerDau: base.requestsPerDau * 0.5,
      peakFactor: Math.max(1.5, base.peakFactor * 0.67),
    },
    expected: base,
    high: {
      ...base,
      dauRatio: Math.min(1, base.dauRatio * 1.5),
      requestsPerDau: base.requestsPerDau * 2,
      peakFactor: base.peakFactor * 1.5,
    },
  };
}
