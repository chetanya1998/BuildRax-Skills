import type { Finding } from "@buildrax/ir";

export type Ecosystem = "npm" | "pypi";

/** A technology the repo uses, extracted from the IR. This is all a query is ever built from. */
export interface Technology {
  name: string;
  ecosystem: Ecosystem;
  /** Architecture node findings attach to. */
  nodeId: string;
  /** How many places in the repo reference it (for prioritising when limiting). */
  usedBy: number;
}

/** One outbound request, shown to the user before anything is sent. */
export interface PlannedRequest {
  provider: string;
  subject: string;
  url: string;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
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
