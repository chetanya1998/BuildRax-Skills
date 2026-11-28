import type { Node } from "web-tree-sitter";

/** A call made inside a function, as written (`saveOrder`, `db.query`, `this.repo.find`). */
export interface RawCall {
  callee: string;
  line: number;
  count?: number;
  /** `new X()` */
  ctor?: boolean;
}

/** A function, method or named callback declared in a file, with the calls made directly in it. */
export interface RawFn {
  name: string;
  kind: "function" | "method" | "arrow" | "callback";
  line: number;
  endLine: number;
  exported?: boolean;
  async?: boolean;
  calls: RawCall[];
  /** Calls dropped past the per-function cap. */
  moreCalls?: number;
}

const MAX_CALLS = 80;
const MAX_FNS = 400;
const lineOf = (n: Node): number => n.startPosition.row + 1;
const endOf = (n: Node): number => n.endPosition.row + 1;

const short = (s: string, max = 60): string => {
  const t = s.replace(/\s+/g, "").replace(/\?\./g, ".");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function lit(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "string" || n.type === "template_string") {
    const t = n.text;
    if (n.type === "template_string" && t.includes("${")) return undefined;
    return t.slice(1, -1);
  }
  return undefined;
}

/** Collects calls into the innermost recorded function around them. */
class Collector {
  readonly fns: RawFn[] = [];
  private readonly byNode = new Map<number, RawFn>();

  add(node: Node, fn: Omit<RawFn, "calls" | "line" | "endLine">): void {
    if (this.fns.length >= MAX_FNS) return;
    const f: RawFn = { ...fn, line: lineOf(node), endLine: endOf(node), calls: [] };
    this.fns.push(f);
    this.byNode.set(node.id, f);
  }
  owner(n: Node): RawFn | undefined {
    for (let p = n.parent; p; p = p.parent) {
      const f = this.byNode.get(p.id);
      if (f) return f;
    }
    return undefined;
  }
  call(n: Node, callee: string, ctor = false): void {
    const f = this.owner(n);
    if (!f || !callee) return;
    const hit = f.calls.find((c) => c.callee === callee && !!c.ctor === ctor);
    if (hit) {
      hit.count = (hit.count ?? 1) + 1;
      return;
    }
    if (f.calls.length >= MAX_CALLS) {
      f.moreCalls = (f.moreCalls ?? 0) + 1;
      return;
    }
    f.calls.push({ callee, line: lineOf(n), ...(ctor ? { ctor: true } : {}) });
  }
  /** Name an enclosing recorded function would give a nested one (`outer.inner`). */
  qualify(n: Node, name: string): string {
    const outer = this.owner(n);
    return outer && outer.kind !== "callback" ? `${outer.name}.${name}` : name;
  }
}

const isAsync = (n: Node): boolean => n.children.some((c) => c?.type === "async");

function jsExported(n: Node): boolean {
  for (let p = n.parent, i = 0; p && i < 3; p = p.parent, i++)
    if (p.type === "export_statement") return true;
  return false;
}

/** `this.repo.find` / `db.query` / `save` from a call's function node. */
function jsCallee(fn: Node): string | undefined {
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "member_expression") {
    // Only plain chains of names; a call or index in the chain ends it.
    const parts: string[] = [];
    let cur: Node | null = fn;
    while (cur?.type === "member_expression") {
      parts.unshift(cur.childForFieldName("property")?.text ?? "");
      cur = cur.childForFieldName("object");
    }
    if (cur?.type === "identifier") parts.unshift(cur.text);
    else if (cur?.type === "this") parts.unshift("this");
    else if (cur?.type === "super") parts.unshift("super");
    else return undefined;
    return short(parts.join("."));
  }
  return undefined;
}

export function jsFunctions(root: Node): RawFn[] {
  const c = new Collector();
  // Pre-order walk so outer functions are recorded before inner ones and calls.
  const walk = (n: Node): void => {
    switch (n.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = n.childForFieldName("name")?.text;
        if (name)
          c.add(n, {
            name: c.qualify(n, name),
            kind: "function",
            ...(jsExported(n) ? { exported: true } : {}),
            ...(isAsync(n) ? { async: true } : {}),
          });
        break;
      }
      case "method_definition": {
        const name = n.childForFieldName("name")?.text;
        const owner = n.parent?.parent;
        const cls =
          owner?.type === "class_declaration" || owner?.type === "class"
            ? owner.childForFieldName("name")?.text
            : undefined;
        if (name)
          c.add(n, {
            name: cls ? `${cls}.${name}` : c.qualify(n, name),
            kind: "method",
            ...(cls && jsExported(owner!) ? { exported: true } : {}),
            ...(isAsync(n) ? { async: true } : {}),
          });
        break;
      }
      case "arrow_function":
      case "function_expression":
      case "function": {
        const p = n.parent;
        let name: string | undefined;
        let kind: RawFn["kind"] = "arrow";
        if (p?.type === "variable_declarator") name = p.childForFieldName("name")?.text;
        else if (p?.type === "pair") name = p.childForFieldName("key")?.text.replace(/["']/g, "");
        else if (p?.type === "public_field_definition") {
          const cls = p.parent?.parent?.childForFieldName("name")?.text;
          const f = p.childForFieldName("name")?.text;
          name = f && cls ? `${cls}.${f}` : f;
        } else if (
          p?.type === "arguments" &&
          (p.parent?.type === "call_expression" || p.parent?.type === "new_expression")
        ) {
          // Inline callback, named after the call (`router.get("/orders")`, `new Worker("emails")`).
          // One-expression callbacks (`x => x.id`, `() => Post`) are part of their caller.
          const isNew = p.parent.type === "new_expression";
          const target = p.parent.childForFieldName(isNew ? "constructor" : "function");
          const callee = target ? jsCallee(target) : undefined;
          const first = lit(p.namedChildren[0]);
          const block = n.childForFieldName("body")?.type === "statement_block";
          if (callee && (block || first !== undefined)) {
            name = `${isNew ? "new " : ""}${callee}(${first !== undefined ? JSON.stringify(first) : ""})`;
            kind = "callback";
          }
        }
        if (name)
          c.add(n, {
            name:
              kind === "callback" || p?.type === "public_field_definition"
                ? name
                : c.qualify(n, name),
            kind,
            ...(p?.type === "variable_declarator" && jsExported(p) ? { exported: true } : {}),
            ...(isAsync(n) ? { async: true } : {}),
          });
        break;
      }
      case "call_expression": {
        const fn = n.childForFieldName("function");
        const callee = fn ? jsCallee(fn) : undefined;
        if (callee) c.call(n, callee);
        break;
      }
      case "new_expression": {
        const ctor = n.childForFieldName("constructor");
        const callee = ctor ? jsCallee(ctor) : undefined;
        if (callee) c.call(n, callee, true);
        break;
      }
    }
    for (const ch of n.namedChildren) if (ch) walk(ch);
  };
  walk(root);
  return c.fns;
}

function pyCallee(fn: Node): string | undefined {
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "attribute") {
    const parts: string[] = [];
    let cur: Node | null = fn;
    while (cur?.type === "attribute") {
      parts.unshift(cur.childForFieldName("attribute")?.text ?? "");
      cur = cur.childForFieldName("object");
    }
    if (cur?.type !== "identifier") return undefined;
    parts.unshift(cur.text);
    return short(parts.join("."));
  }
  return undefined;
}

export function pyFunctions(root: Node): RawFn[] {
  const c = new Collector();
  const walk = (n: Node): void => {
    if (n.type === "function_definition") {
      const name = n.childForFieldName("name")?.text;
      const body = n.parent; // block
      const cls = body?.parent?.type === "class_definition" ? body.parent : undefined;
      const clsName = cls?.childForFieldName("name")?.text;
      if (name)
        c.add(n, {
          name: clsName ? `${clsName}.${name}` : c.qualify(n, name),
          kind: clsName ? "method" : "function",
          ...(!name.startsWith("_") && !c.owner(n) && !cls ? { exported: true } : {}),
          ...(isAsync(n) ? { async: true } : {}),
        });
    } else if (n.type === "call") {
      const fn = n.childForFieldName("function");
      const callee = fn ? pyCallee(fn) : undefined;
      if (callee) c.call(n, callee);
    }
    for (const ch of n.namedChildren) if (ch) walk(ch);
  };
  walk(root);
  return c.fns;
}
