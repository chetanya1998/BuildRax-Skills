import {
  GraphIndex,
  findRoutes,
  listRoutes,
  routeFlow,
  routesReaching,
  stepDetail,
  type Flow,
  type RouteInfo,
} from "@buildrax/graph";
import { loadModel } from "./data.js";
import { resolveTarget } from "./trace.js";

/** All endpoints, or only those whose flow reaches a component (`--reaching PostgreSQL`). */
export async function routesCommand(
  repo: string,
  opts: { reaching?: string } = {},
): Promise<RouteInfo[]> {
  const model = await loadModel(repo);
  const index = new GraphIndex(model);
  if (!opts.reaching) return listRoutes(index);
  const target = resolveTarget(model, opts.reaching);
  if (!target) throw new Error(`nothing in the model matches "${opts.reaching}"`);
  return routesReaching(index, target);
}

export function formatRoutes(routes: RouteInfo[]): string {
  if (!routes.length)
    return "No endpoints found. Supported: Next.js (app and pages routers), Express, Fastify, Hono, Koa, NestJS, FastAPI, Flask.";
  const api = routes.filter((r) => r.type === "api");
  const pages = routes.filter((r) => r.type === "page");
  const row = (r: RouteInfo) =>
    `  ${r.method.padEnd(7)} ${(r.path ?? "(computed path)").padEnd(34)} ${r.framework.padEnd(8)} ${r.file ?? ""}${r.line ? `:${r.line}` : ""}`;
  return [
    `${api.length} API endpoint(s)${pages.length ? `, ${pages.length} page(s)` : ""}`,
    ...api.map(row),
    ...(pages.length ? ["Pages", ...pages.map(row)] : []),
    ...(routes.some((r) => !r.resolved)
      ? ["Paths built at runtime are listed as (computed path); they are never guessed."]
      : []),
  ].join("\n");
}

export async function flowCommand(
  repo: string,
  query: string,
  opts: { depth?: number } = {},
): Promise<{ flows: Flow[]; matches: RouteInfo[] }> {
  const index = new GraphIndex(await loadModel(repo));
  const matches = findRoutes(index, query);
  const flows = matches
    .map((r) => routeFlow(index, r.id, { depth: opts.depth }))
    .filter((f): f is Flow => !!f);
  return { flows, matches };
}

export async function formatFlows(repo: string, flows: Flow[], query: string): Promise<string> {
  if (!flows.length)
    return `No endpoint matches "${query}". List them with \`buildrax routes\` (use "METHOD /path", a path, or a route id).`;
  const index = new GraphIndex(await loadModel(repo));
  const label = (id: string): string => {
    const n = index.node(id);
    if (!n) return id;
    if (n.kind === "file") return n.path ?? n.name;
    return `${n.name} [${n.kind}]`;
  };
  const out: string[] = [];
  for (const f of flows) {
    const r = f.route;
    out.push(
      `${r.method} ${r.path ?? "(computed path)"}  (${r.framework}, ${r.file ?? ""}${r.line ? `:${r.line}` : ""}${r.handler ? `, handler ${r.handler}` : ""})`,
    );
    for (const s of f.steps) {
      const ev = s.evidence?.file
        ? `  ${s.evidence.file}${s.evidence.startLine ? `:${s.evidence.startLine}` : ""}`
        : "";
      const what = stepDetail(s);
      out.push(
        `  ${String(s.n).padStart(3)}. ${"  ".repeat(s.hop - 1)}${label(s.from)} -${s.kind}-> ${label(s.to)}${what ? ` (${what})` : ""}${s.async ? " [async]" : ""}${ev}`,
      );
    }
    const p = f.participants;
    out.push(
      `  Reaches ${p.files.length} file(s)` +
        (p.infra.length
          ? ` · infrastructure: ${p.infra.map((i) => index.node(i)?.name ?? i).join(", ")}`
          : "") +
        (p.external.length
          ? ` · packages: ${p.external.map((i) => index.node(i)?.name ?? i).join(", ")}`
          : "") +
        (p.packages.length
          ? ` · workspace packages: ${p.packages.map((i) => index.node(i)?.name ?? i).join(", ")}`
          : ""),
    );
    if (f.truncated) out.push("  (cut short by --depth; raise it to see more)");
    out.push("");
  }
  out.push(
    "Static and file-level: everything the handler's file can reach through imports, not one runtime path.",
  );
  return out.join("\n");
}
