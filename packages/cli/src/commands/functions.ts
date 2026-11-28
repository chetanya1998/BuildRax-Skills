import type { FnEntry, FunctionsFile } from "@buildrax/ir";
import { loadFunctions } from "./data.js";

export interface FnLookup {
  /** Set when the query named a file: all its functions. */
  file?: string;
  functions: FnEntry[];
}

/** Find functions by file path (all functions in it), function id, `Class.method` or bare name. */
export function findFunctions(index: FunctionsFile, query: string): FnLookup {
  const q = query.trim().replace(/^\.\//, "");
  const file =
    index.files.find((f) => f.path === q) ??
    (q.includes("/") || /\.\w+$/.test(q)
      ? index.files.filter((f) => f.path.endsWith(`/${q}`)).at(0)
      : undefined);
  if (file) return { file: file.path, functions: file.functions };
  const all = index.files.flatMap((f) => f.functions);
  const byId = all.filter((f) => f.id === q);
  if (byId.length) return { functions: byId };
  const exact = all.filter((f) => f.name === q);
  if (exact.length) return { functions: exact };
  return { functions: all.filter((f) => f.name.split(".").pop() === q) };
}

export async function functionsCommand(repo: string, query: string): Promise<FnLookup> {
  const index = await loadFunctions(repo);
  if (!index)
    throw new Error(
      `no function index at .buildrax/functions.json. Run \`buildrax scan ${repo}\` to create it.`,
    );
  return findFunctions(index, query);
}

const fileOf = (id: string): string => id.slice(3, id.lastIndexOf("#"));
const target = (to: string): string =>
  to.startsWith("fn:") ? `${to.slice(to.lastIndexOf("#") + 1)} (${fileOf(to)})` : to;

export function formatFunctions(res: FnLookup, query: string): string {
  if (!res.functions.length)
    return `No function matches "${query}". Give a file path, a function name, or Class.method.`;
  const out: string[] = [];
  const detail = !res.file || res.functions.length <= 3;
  if (res.file) out.push(`${res.file}: ${res.functions.length} function(s)`);
  for (const f of res.functions) {
    const tags = [f.kind, f.exported && "exported", f.async && "async"].filter(Boolean).join(", ");
    out.push(
      `${res.file ? "  " : ""}${f.name}  ${res.file ? "" : `${fileOf(f.id)}:`}${f.line}-${f.endLine}  (${tags})`,
    );
    const pad = res.file ? "    " : "  ";
    if (f.routes?.length)
      out.push(`${pad}handles ${f.routes.map((r) => r.replace(/^route:[^:]*:/, "")).join(", ")}`);
    for (const o of f.ops)
      out.push(
        `${pad}${o.kind} ${o.to}  :${o.line}${o.detail ? `  ${o.detail.replace(` in ${f.name}`, "")}` : ""}`,
      );
    if (detail) {
      for (const c of f.calls)
        out.push(
          `${pad}calls ${c.name}${c.count ? ` ×${c.count}` : ""} -> ${c.to ? target(c.to) : "?"} [${c.via}]  :${c.line}`,
        );
      if (f.calledBy?.length) out.push(`${pad}called by ${f.calledBy.map(target).join(", ")}`);
    } else if (f.calls.length || f.calledBy?.length) {
      out.push(`${pad}${f.calls.length} call(s) out, ${f.calledBy?.length ?? 0} caller(s)`);
    }
    if (detail && f.otherCalls)
      out.push(`${pad}+${f.otherCalls} other call(s) (built-ins, parameters, locals)`);
  }
  out.push(
    "",
    "Static: calls are matched by name through imports; calls through variables or callbacks are counted, not followed.",
  );
  return out.join("\n");
}
