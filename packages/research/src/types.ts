import type { Finding } from "@buildrax/ir";

/** npm / PyPI packages, or a `product` tracked by endoflife.date (runtime, database, framework). */
export type Ecosystem = "npm" | "pypi" | "product";

/** A technology the repo uses, extracted from the IR. This is all a query is ever built from. */
export interface Technology {
  name: string;
  ecosystem: Ecosystem;
  /** Architecture node findings attach to. */
  nodeId: string;
  /** How many places in the repo reference it (for prioritising when limiting). */
  usedBy: number;
  /** Pinned (lockfile) or declared version, when the scan found one. */
  version?: string;
  /** False for the extra entries of a package locked at several versions (registry facts once). */
  primary?: boolean;
  /** Human name for products, e.g. "Node.js" (from where it was detected). */
  label?: string;
}

/** One outbound request, shown to the user before anything is sent. */
export interface PlannedRequest {
  provider: string;
  subject: string;
  url: string;
  /** GET unless stated; POST bodies are shown in the plan before anything is sent. */
  method?: "GET" | "POST";
  body?: string;
}

export type FetchLike = (
  url: string,
  init?: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    method?: string;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface Provider {
  id: string;
  /** Hosts this provider may contact. The fetcher refuses everything else. */
  hosts: readonly string[];
  supports(tech: Technology): boolean;
  request(tech: Technology): PlannedRequest;
  /** Pure: turn a response body into findings. */
  parse(tech: Technology, json: unknown, ctx: { url: string; now: string }): Finding[];
}
