import {
  FUNCTIONS_SCHEMA_VERSION,
  type FnCall,
  type FnEntry,
  type FnOp,
  type FunctionsFile,
  type Model,
} from "@buildrax/ir";
import type { BuildContext } from "../build.js";
import type { RawFn } from "./facts.js";

export interface FunctionSource {
  path: string;
  functions: RawFn[];
}

const DATA = new Set(["reads", "writes", "publishes", "consumes"]);

/** `fn:<file>#<name>`; a name declared twice in one file gets `@<line>`. */
function assignIds(path: string, fns: readonly RawFn[]): string[] {
  const seen = new Map<string, number>();
  for (const f of fns) seen.set(f.name, (seen.get(f.name) ?? 0) + 1);
  const used = new Set<string>();
  return fns.map((f) => {
    const base = `fn:${path}#${f.name}${(seen.get(f.name) ?? 0) > 1 ? `@${f.line}` : ""}`;
    let id = base;
    for (let k = 2; used.has(id); k++) id = `${base}~${k}`;
    used.add(id);
    return id;
  });
}

/** Innermost function whose line range holds `line`. */
function innermost(fns: readonly { f: RawFn; i: number }[], line: number): number | undefined {
  let best: { f: RawFn; i: number } | undefined;
  for (const x of fns)
    if (x.f.line <= line && line <= x.f.endLine)
      if (!best || x.f.endLine - x.f.line <= best.f.endLine - best.f.line) best = x;
  return best?.i;
}

/**
 * The function index: every function with the calls it makes (resolved through the file's imports
 * where possible), the data operations proven inside it, the routes it handles, and its callers.
 * Static: a call through a variable, parameter or dynamic dispatch is counted, not followed.
 */
export function buildFunctionIndex(
  model: Model,
  sources: readonly FunctionSource[],
  ctx: Pick<BuildContext, "bindings" | "externalBindings">,
): FunctionsFile {
  const sorted = [...sources]
    .filter((s) => s.functions.length)
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const ids = new Map<string, string[]>();
  const byName = new Map<string, Map<string, string>>(); // file → name → id (first wins)
  for (const s of sorted) {
    const list = assignIds(s.path, s.functions);
    ids.set(s.path, list);
    const m = new Map<string, string>();
    s.functions.forEach((f, i) => {
      if (!m.has(f.name)) m.set(f.name, list[i]!);
    });
    byName.set(s.path, m);
  }

  // Proven data operations and routes, by file.
  const opsByFile = new Map<string, FnOp[]>();
  for (const e of model.edges) {
    if (!DATA.has(e.kind) || !e.from.startsWith("file:")) continue;
    const file = e.from.slice(5);
    const list = opsByFile.get(file) ?? [];
    for (const ev of e.evidence)
      if (ev.startLine && ev.file === file)
        list.push({
          kind: e.kind,
          to: e.to,
          line: ev.startLine,
          ...(ev.detail ? { detail: ev.detail } : {}),
        });
    opsByFile.set(file, list);
  }
  const routesByFile = new Map<string, { id: string; line: number }[]>();
  for (const n of model.nodes) {
    if (n.kind !== "route") continue;
    const ev = n.evidence.find((x) => x.file && x.startLine);
    if (!ev?.file || !ev.startLine) continue;
    const list = routesByFile.get(ev.file) ?? [];
    list.push({ id: n.id, line: ev.startLine });
    routesByFile.set(ev.file, list);
  }

  // Exported functions per workspace package directory, for `import { scan } from "@org/pkg"`.
  const exportedIn = (dir: string, name: string): string[] => {
    const prefix = dir === "." || dir === "" ? "" : `${dir}/`;
    const hits: string[] = [];
    for (const s of sorted) {
      if (!s.path.startsWith(prefix)) continue;
      s.functions.forEach((f, i) => {
        if (f.exported && (f.name === name || f.name === `${name}.constructor`))
          hits.push(ids.get(s.path)![i]!);
      });
    }
    return hits;
  };
  const viaWorkspace = (pkg: string, name: string): Pick<FnCall, "to" | "via"> => {
    const hits = exportedIn(pkg.slice("module:".length), name);
    return hits.length === 1 ? { to: hits[0]!, via: "workspace" } : { to: pkg, via: "workspace" };
  };

  let callsTotal = 0;
  let resolvedTotal = 0;
  const files: FunctionsFile["files"] = [];
  const entries = new Map<string, FnEntry>();
  for (const s of sorted) {
    const fileIds = ids.get(s.path)!;
    const local = byName.get(s.path)!;
    const bound = ctx.bindings.get(s.path);
    const ext = ctx.externalBindings.get(s.path);
    const indexed = s.functions.map((f, i) => ({ f, i }));

    const resolve = (callee: string, fn: RawFn): Pick<FnCall, "to" | "via"> | undefined => {
      const parts = callee.split(".");
      const head = parts[0]!;
      const cls = fn.kind === "method" ? fn.name.split(".")[0] : undefined;
      if ((head === "this" || head === "self" || head === "cls") && cls && parts.length === 2) {
        const id = local.get(`${cls}.${parts[1]}`);
        return id ? { to: id, via: "local" } : undefined;
      }
      // `save()` or a static call on a local class, `Orders.create()`.
      const own = local.get(`${fn.name}.${callee}`) ?? local.get(callee);
      if (own) return { to: own, via: "local" };
      const target = bound?.get(head);
      if (target) {
        const there = byName.get(target);
        const name = parts.length === 1 ? head : parts.slice(1).join(".");
        // `orders.save()` (namespace import), then `sendReceipt.delay()` (a call on the function).
        const id =
          there?.get(name) ??
          (parts.length === 1 ? undefined : (there?.get(parts[1]!) ?? there?.get(head)));
        if (id) return { to: id, via: "import" };
        return { to: `file:${target}`, via: "file" };
      }
      const pkg = ext?.get(head);
      if (pkg?.startsWith("module:"))
        return viaWorkspace(pkg, parts.length === 1 ? head : parts[1]!);
      if (pkg) return { to: pkg, via: "external" };
      return undefined;
    };

    const out: FnEntry[] = s.functions.map((f, i) => {
      const calls: FnCall[] = [];
      let other = 0;
      for (const c of f.calls) {
        const name = c.ctor ? `new ${c.callee}` : c.callee;
        const r = c.ctor ? resolveCtor(c.callee) : resolve(c.callee, f);
        callsTotal++;
        if (!r) {
          other++;
          continue;
        }
        resolvedTotal++;
        calls.push({ name, line: c.line, ...(c.count ? { count: c.count } : {}), ...r });
      }
      const entry: FnEntry = {
        id: fileIds[i]!,
        name: f.name,
        kind: f.kind,
        line: f.line,
        endLine: f.endLine,
        ...(f.exported ? { exported: true } : {}),
        ...(f.async ? { async: true } : {}),
        calls,
        ops: [],
        ...(other + (f.moreCalls ?? 0) ? { otherCalls: other + (f.moreCalls ?? 0) } : {}),
      };
      return entry;

      function resolveCtor(callee: string): Pick<FnCall, "to" | "via"> | undefined {
        const head = callee.split(".")[0]!;
        const ctorId = local.get(`${callee}.constructor`) ?? local.get(`${callee}.__init__`);
        if (ctorId) return { to: ctorId, via: "local" };
        const target = bound?.get(head);
        if (target) {
          const there = byName.get(target);
          const id = there?.get(`${callee}.constructor`) ?? there?.get(`${callee}.__init__`);
          return id ? { to: id, via: "import" } : { to: `file:${target}`, via: "file" };
        }
        const pkg = ext?.get(head);
        if (pkg?.startsWith("module:")) return viaWorkspace(pkg, callee);
        return pkg ? { to: pkg, via: "external" } : undefined;
      }
    });

    for (const op of (opsByFile.get(s.path) ?? []).sort(
      (a, b) => a.line - b.line || (a.kind < b.kind ? -1 : 1),
    )) {
      const at = innermost(indexed, op.line);
      if (
        at !== undefined &&
        !out[at]!.ops.some((o) => o.line === op.line && o.kind === op.kind && o.to === op.to)
      )
        out[at]!.ops.push(op);
    }
    for (const r of (routesByFile.get(s.path) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const at = innermost(indexed, r.line);
      if (at === undefined) continue;
      const e = out[at]!;
      e.routes = [...(e.routes ?? []), r.id];
    }
    for (const e of out) entries.set(e.id, e);
    files.push({ path: s.path, functions: out });
  }

  // Callers (resolved function-to-function calls only).
  for (const e of entries.values())
    for (const c of e.calls) {
      const target = c.to ? entries.get(c.to) : undefined;
      if (!target || target.id === e.id) continue;
      if (!(target.calledBy ??= []).includes(e.id)) target.calledBy.push(e.id);
    }
  for (const e of entries.values()) e.calledBy?.sort();

  return {
    schemaVersion: FUNCTIONS_SCHEMA_VERSION,
    repo: model.meta.repo,
    scannedAt: model.meta.scannedAt,
    stats: {
      files: files.length,
      functions: entries.size,
      calls: callsTotal,
      resolved: resolvedTotal,
    },
    files,
  };
}
