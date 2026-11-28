import type { Node } from "web-tree-sitter";
import type { RawClient, RawOp } from "../dataops/facts.js";
import type { RawEntity } from "../entities/facts.js";
import type { RawFn } from "../functions/facts.js";
import type { RawWhy } from "../rationale/comments.js";

/**
 * Per-file facts for endpoint detection, read from the syntax tree (never executed). They are
 * cached with the parse, and turned into route nodes once all files are known (prefixes from
 * router mounts can come from other files).
 */
export interface RawRoute {
  /** Upper-case HTTP method, `ANY` for all methods. */
  method: string;
  /** Literal path, or undefined when it is computed at runtime. */
  path?: string;
  line: number;
  /** The app/router object the route is registered on (JS) or decorated with (Python). */
  receiver: string;
  /** Handler function name when it is a named function (not inline). */
  handler?: string;
  framework: string;
  /** Registered on a conventional parameter name (e.g. a Fastify plugin's `fastify`). */
  implicit?: boolean;
}

export interface RawMount {
  /** Object the mount is called on (`app` in `app.use('/api', router)`). */
  receiver: string;
  prefix: string;
  /** Mounted router expression: `router`, `items.router`. */
  target: string;
  line: number;
}

export interface FileFacts {
  routes: RawRoute[];
  mounts: RawMount[];
  /** Own prefix of a router object: `APIRouter(prefix=…)`, `Blueprint(url_prefix=…)`. */
  prefixes: Record<string, string>;
  /** Next.js route handlers exported by name (`export async function GET`). */
  httpExports: string[];
  /** Line of each exported route handler. */
  exportLines?: Record<string, number>;
  /** File starts with the "use server" directive (Next.js server actions). */
  useServer: boolean;
  /** App/router objects created in this file (`const app = express()`, `router = APIRouter()`). */
  receivers: string[];
  /** Candidate data operations (database, cache, queue); confirmed when linked. */
  ops?: RawOp[];
  /** Client objects created in this file, by variable name. */
  clients?: Record<string, RawClient>;
  /** Celery task functions defined in this file. */
  tasks?: string[];
  /** Data models declared in this file (TypeORM, Drizzle, Mongoose, SQLAlchemy, Django). */
  entities?: RawEntity[];
  /** Functions declared in this file and the calls made in each. */
  functions?: RawFn[];
  /** Comments that explain a choice (rationale), for `buildrax why`. */
  whys?: RawWhy[];
}

export const emptyFacts = (): FileFacts => ({
  routes: [],
  mounts: [],
  prefixes: {},
  httpExports: [],
  useServer: false,
  receivers: [],
});

const HTTP = ["get", "post", "put", "patch", "delete", "options", "head", "all"];
const HTTP_EXPORTS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

/** JS constructors that create an app or router, and the framework they belong to. */
const JS_CTORS: Record<string, string> = {
  express: "express",
  "express.Router": "express",
  Router: "express",
  fastify: "fastify",
  Fastify: "fastify",
  Hono: "hono",
  Elysia: "elysia",
  Koa: "koa",
  KoaRouter: "koa",
};
/** Receivers accepted without a visible constructor (plugins, handlers taking the app). */
const IMPLICIT = new Set(["app", "router", "fastify", "server", "api", "instance"]);

const lineOf = (n: Node): number => n.startPosition.row + 1;

/** Literal string value (JS string, template without substitutions, Python string). */
export function literal(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "string") {
    const t = n.text;
    // Python prefixes (r"", f"") are not plain literals when formatted.
    if (/^[fF]/.test(t)) return undefined;
    const m = /^[rRbBuU]*(["']{1,3})([\s\S]*)\1$/.exec(t);
    return m ? m[2] : undefined;
  }
  if (n.type === "template_string")
    return n.namedChildren.some((c) => c?.type === "template_substitution")
      ? undefined
      : n.text.slice(1, -1);
  return undefined;
}

const args = (call: Node): Node[] =>
  (call.childForFieldName("arguments")?.namedChildren ?? []).filter(
    (x): x is Node => !!x && x.type !== "comment",
  );

/** Name of a handler argument, when it is a named reference rather than an inline function. */
function handlerName(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "identifier" || n.type === "member_expression") return n.text;
  return undefined;
}

export function jsFacts(root: Node): FileFacts {
  const f = emptyFacts();
  const receivers = new Map<string, string>(); // name -> framework

  for (const d of root.descendantsOfType("variable_declarator")) {
    if (!d) continue;
    const name = d.childForFieldName("name");
    const value = d.childForFieldName("value");
    if (name?.type !== "identifier" || !value) continue;
    let ctor: string | undefined;
    if (value.type === "call_expression") ctor = value.childForFieldName("function")?.text;
    else if (value.type === "new_expression") ctor = value.childForFieldName("constructor")?.text;
    const fw = ctor ? JS_CTORS[ctor] : undefined;
    if (fw) receivers.set(name.text, fw);
  }
  f.receivers = [...receivers.keys()].sort();

  // "use server" directive: the first statement of the file.
  const first = root.namedChildren.find((c) => c && c.type !== "comment");
  if (
    first?.type === "expression_statement" &&
    /^["']use server["']$/.test(first.text.replace(/;$/, ""))
  )
    f.useServer = true;

  for (const e of root.descendantsOfType("export_statement")) {
    const decl = e?.childForFieldName("declaration");
    if (!decl) continue;
    const names =
      decl.type === "function_declaration"
        ? [decl.childForFieldName("name")?.text]
        : decl.type === "lexical_declaration"
          ? decl.namedChildren.map((v) => v?.childForFieldName("name")?.text)
          : [];
    for (const n of names)
      if (n && HTTP_EXPORTS.has(n)) {
        f.httpExports.push(n);
        (f.exportLines ??= {})[n] = lineOf(decl);
      }
  }

  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "member_expression") continue;
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property")?.text ?? "";
    const a = args(call);
    if (!obj) continue;

    // router.route('/x').get(h).post(h): walk down the chain to `router.route('/x')`.
    if (obj.type === "call_expression" && HTTP.includes(prop)) {
      let cur: Node | null = obj;
      while (cur?.type === "call_expression") {
        const f2 = cur.childForFieldName("function");
        if (f2?.type !== "member_expression") break;
        if (f2.childForFieldName("property")?.text === "route") break;
        if (!HTTP.includes(f2.childForFieldName("property")?.text ?? "")) {
          cur = null;
          break;
        }
        cur = f2.childForFieldName("object");
      }
      const inner = cur?.type === "call_expression" ? cur.childForFieldName("function") : null;
      const base = inner?.childForFieldName("object");
      if (
        cur &&
        inner?.type === "member_expression" &&
        inner.childForFieldName("property")?.text === "route" &&
        base?.type === "identifier"
      ) {
        const known = receivers.get(base.text);
        if (known || IMPLICIT.has(base.text))
          f.routes.push({
            method: prop === "all" ? "ANY" : prop.toUpperCase(),
            path: literal(args(cur)[0]),
            line: lineOf(call),
            receiver: base.text,
            handler: handlerName(a.at(-1)),
            framework: known ?? "express",
            ...(known ? {} : { implicit: true }),
          });
      }
      continue;
    }
    if (obj.type !== "identifier") continue;
    const known = receivers.get(obj.text);
    if (!known && !IMPLICIT.has(obj.text)) continue;
    const fw = known ?? "express";

    if (HTTP.includes(prop) && a.length >= 2) {
      f.routes.push({
        method: prop === "all" ? "ANY" : prop.toUpperCase(),
        path: literal(a[0]),
        line: lineOf(call),
        receiver: obj.text,
        handler: handlerName(a.at(-1)),
        framework: fw,
        ...(known ? {} : { implicit: true }),
      });
    } else if ((prop === "use" || prop === "route") && a.length >= 2) {
      // Express app.use('/api', router) / Hono app.route('/api', sub)
      const prefix = literal(a[0]);
      const target = a.at(-1);
      if (
        prefix !== undefined &&
        target &&
        (target.type === "identifier" || target.type === "member_expression")
      )
        f.mounts.push({ receiver: obj.text, prefix, target: target.text, line: lineOf(call) });
    } else if (prop === "register" && a.length >= 2) {
      // Fastify app.register(plugin, { prefix: '/api' })
      const target = a[0]!;
      const opts = a[1]!;
      const pair =
        opts.type === "object"
          ? opts.namedChildren.find(
              (p) =>
                p?.type === "pair" &&
                p.childForFieldName("key")?.text.replace(/["']/g, "") === "prefix",
            )
          : undefined;
      const prefix = literal(pair?.childForFieldName("value"));
      if (
        prefix !== undefined &&
        (target.type === "identifier" || target.type === "member_expression")
      )
        f.mounts.push({ receiver: obj.text, prefix, target: target.text, line: lineOf(call) });
    }
  }

  // NestJS: @Controller('users') class … { @Get(':id') find() {} }
  for (const cls of root.descendantsOfType("class_declaration")) {
    if (!cls) continue;
    // Class decorators sit on the class, or on `export` for `@Controller() export class`.
    const decorators = [
      ...cls.children,
      ...(cls.parent?.type === "export_statement" ? cls.parent.children : []),
    ];
    const ctl = decorators.find(
      (c) => c?.type === "decorator" && /^Controller\b/.test(c.namedChildren[0]?.text ?? ""),
    );
    if (!ctl) continue;
    const ctlCall = ctl.namedChildren[0];
    const base = ctlCall?.type === "call_expression" ? (literal(args(ctlCall)[0]) ?? "") : "";
    const body = cls.childForFieldName("body");
    let pending: { method: string; path?: string; line: number }[] = [];
    for (const m of body?.children ?? []) {
      if (!m) continue;
      if (m.type === "decorator") {
        const c = m.namedChildren[0];
        const name =
          c?.type === "call_expression" ? c.childForFieldName("function")?.text : c?.text;
        const verb =
          name &&
          ["Get", "Post", "Put", "Patch", "Delete", "Options", "Head", "All"].find(
            (v) => v === name,
          );
        if (verb) {
          const sub = c?.type === "call_expression" ? args(c)[0] : undefined;
          pending.push({
            method: verb === "All" ? "ANY" : verb.toUpperCase(),
            path: sub === undefined ? "" : literal(sub),
            line: lineOf(m),
          });
        }
      } else if (m.type === "method_definition") {
        const handler = `${cls.childForFieldName("name")?.text ?? ""}.${m.childForFieldName("name")?.text ?? ""}`;
        for (const p of pending)
          f.routes.push({
            method: p.method,
            path: p.path === undefined ? undefined : joinPath(base, p.path),
            line: p.line,
            receiver: "",
            handler,
            framework: "nestjs",
          });
        pending = [];
      }
    }
  }
  return f;
}

const PY_CTORS: Record<string, string> = {
  FastAPI: "fastapi",
  APIRouter: "fastapi",
  Flask: "flask",
  Blueprint: "flask",
};
const PY_VERBS = ["get", "post", "put", "patch", "delete", "options", "head"];

function kwarg(call: Node, name: string): Node | undefined {
  return (
    args(call)
      .find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === name)
      ?.childForFieldName("value") ?? undefined
  );
}

export function pyFacts(root: Node): FileFacts {
  const f = emptyFacts();
  const receivers = new Map<string, string>();

  for (const asg of root.descendantsOfType("assignment")) {
    if (!asg) continue;
    const left = asg.childForFieldName("left");
    const right = asg.childForFieldName("right");
    if (left?.type !== "identifier" || right?.type !== "call") continue;
    const ctor = right.childForFieldName("function")?.text.split(".").pop() ?? "";
    const fw = PY_CTORS[ctor];
    if (!fw) continue;
    receivers.set(left.text, fw);
    const prefix = literal(kwarg(right, ctor === "Blueprint" ? "url_prefix" : "prefix"));
    if (prefix) f.prefixes[left.text] = prefix;
  }
  f.receivers = [...receivers.keys()].sort();

  for (const dd of root.descendantsOfType("decorated_definition")) {
    if (!dd) continue;
    const def = dd.childForFieldName("definition");
    const handler = def?.childForFieldName("name")?.text;
    for (const dec of dd.children) {
      if (dec?.type !== "decorator") continue;
      const call = dec.namedChildren[0];
      if (call?.type !== "call") continue;
      const fn = call.childForFieldName("function");
      if (fn?.type !== "attribute") continue;
      const recv = fn.childForFieldName("object")?.text ?? "";
      const verb = fn.childForFieldName("attribute")?.text ?? "";
      const fw = receivers.get(recv) ?? (IMPLICIT.has(recv) ? "fastapi" : undefined);
      if (!fw) continue;
      const path = literal(args(call)[0]);
      const base = {
        path,
        line: lineOf(dec),
        receiver: recv,
        handler,
        framework: fw,
        ...(receivers.has(recv) ? {} : { implicit: true }),
      };
      if (PY_VERBS.includes(verb)) f.routes.push({ ...base, method: verb.toUpperCase() });
      else if (verb === "route" || verb === "api_route") {
        // Flask/FastAPI: methods=["GET", "POST"]; Flask defaults to GET.
        const list = kwarg(call, "methods");
        const methods =
          list?.type === "list"
            ? list.namedChildren
                .map((x) => literal(x)?.toUpperCase())
                .filter((x): x is string => !!x)
            : [];
        for (const m of methods.length ? methods : [verb === "route" ? "GET" : "ANY"])
          f.routes.push({ ...base, method: m });
      } else if (verb === "websocket") f.routes.push({ ...base, method: "WS" });
    }
  }

  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "attribute") continue;
    const recv = fn.childForFieldName("object")?.text ?? "";
    const verb = fn.childForFieldName("attribute")?.text ?? "";
    if (!receivers.has(recv) && !IMPLICIT.has(recv)) continue;
    const a = args(call).filter((x) => x.type !== "keyword_argument");
    if (verb === "include_router" || verb === "register_blueprint") {
      const target = a[0];
      const prefix =
        literal(kwarg(call, verb === "include_router" ? "prefix" : "url_prefix")) ?? "";
      if (target && (target.type === "identifier" || target.type === "attribute"))
        f.mounts.push({ receiver: recv, prefix, target: target.text, line: lineOf(call) });
    } else if (verb === "mount") {
      const prefix = literal(a[0]);
      const target = a[1];
      if (
        prefix !== undefined &&
        target &&
        (target.type === "identifier" || target.type === "attribute")
      )
        f.mounts.push({ receiver: recv, prefix, target: target.text, line: lineOf(call) });
    }
  }
  return f;
}

/** Join URL path pieces: "/api" + "items/" + "/:id" → "/api/items/:id". */
export function joinPath(...parts: string[]): string {
  const joined = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/");
  const withSlash = joined.startsWith("/") ? joined : `/${joined}`;
  return withSlash.length > 1 ? withSlash.replace(/\/$/, "") : withSlash;
}
