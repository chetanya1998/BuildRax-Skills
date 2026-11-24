/** Hosts the pricing package may ever contact. Everything else is refused before any I/O. */
export const PRICING_HOSTS = [
  "pricing.us-east-1.amazonaws.com",
  "api.pricing.us-east-1.amazonaws.com",
] as const;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function assertAllowed(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refusing malformed URL`);
  }
  if (
    u.protocol !== "https:" ||
    !(PRICING_HOSTS as readonly string[]).includes(u.host) ||
    u.username ||
    u.password
  )
    throw new Error(`refusing ${u.protocol}//${u.host}: not an allowlisted pricing host`);
  return u;
}

/**
 * GET/POST an allowlisted URL. Redirects are refused (they could leave the allowlist), bodies are
 * size-capped, and requests time out.
 */
export async function safeFetch(
  url: string,
  init: RequestInit & { maxBytes?: number; timeoutMs?: number } = {},
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<string> {
  assertAllowed(url);
  const { maxBytes = 64 * 1024 * 1024, timeoutMs = 120_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { ...rest, redirect: "error", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxBytes) throw new Error(`response too large (${len} bytes)`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Error(`response too large`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
