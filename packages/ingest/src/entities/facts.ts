import type { Node } from "web-tree-sitter";

/**
 * Data models declared in code: a table, model or collection and its fields and relations.
 * Read from the syntax tree (TypeORM, Drizzle, Mongoose, SQLAlchemy, Django) or from Prisma
 * schema text. Nothing is executed; values that are not literals are not guessed.
 */
export interface RawField {
  name: string;
  type?: string;
  pk?: boolean;
  line: number;
}

export interface RawRelation {
  /** Field holding the relation (`customer`, `author_id`). */
  field: string;
  /** Target as written: a class / model name, or a table name for SQL foreign keys. */
  target: string;
  targetIs: "model" | "table" | "variable";
  many?: boolean;
  line: number;
}

export interface RawEntity {
  name: string;
  /** Table / collection name when declared (`@@map`, `__tablename__`, `@Entity("orders")`). */
  table?: string;
  orm: "prisma" | "typeorm" | "drizzle" | "mongoose" | "sqlalchemy" | "django";
  line: number;
  fields: RawField[];
  relations: RawRelation[];
}

const lineOf = (n: Node): number => n.startPosition.row + 1;

function lit(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "string") {
    const m = /^[rRbBuU]*(["']{1,3})([\s\S]*)\1$/.exec(n.text);
    return m ? m[2] : undefined;
  }
  if (
    n.type === "template_string" &&
    !n.namedChildren.some((c) => c?.type === "template_substitution")
  )
    return n.text.slice(1, -1);
  return undefined;
}

const args = (call: Node): Node[] =>
  (call.childForFieldName("arguments")?.namedChildren ?? []).filter(
    (x): x is Node => !!x && x.type !== "comment",
  );

/** `() => Order` / `(type) => Order` → "Order". */
function arrowTarget(n: Node | undefined): string | undefined {
  if (n?.type !== "arrow_function") return undefined;
  const body = n.childForFieldName("body");
  return body?.type === "identifier"
    ? body.text
    : body?.type === "member_expression"
      ? body.text.split(".")[0]
      : undefined;
}

const TYPEORM_REL: Record<string, boolean> = {
  ManyToOne: false,
  OneToOne: false,
  OneToMany: true,
  ManyToMany: true,
};

export function jsEntities(root: Node): RawEntity[] {
  const out: RawEntity[] = [];

  // TypeORM: @Entity("orders") class Order { @Column() total; @ManyToOne(() => Customer) customer }
  for (const cls of root.descendantsOfType("class_declaration")) {
    if (!cls) continue;
    const decorators = [
      ...cls.children,
      ...(cls.parent?.type === "export_statement" ? cls.parent.children : []),
    ];
    const ent = decorators.find(
      (d) => d?.type === "decorator" && /^Entity\b/.test(d.namedChildren[0]?.text ?? ""),
    );
    if (!ent) continue;
    const name = cls.childForFieldName("name")?.text;
    if (!name) continue;
    const call = ent.namedChildren[0];
    let table: string | undefined;
    if (call?.type === "call_expression") {
      const a0 = args(call)[0];
      table =
        lit(a0) ??
        (a0?.type === "object"
          ? lit(
              a0
                .descendantsOfType("pair")
                .find((p) => p?.childForFieldName("key")?.text === "name")
                ?.childForFieldName("value"),
            )
          : undefined);
    }
    const e: RawEntity = {
      name,
      orm: "typeorm",
      line: lineOf(cls),
      fields: [],
      relations: [],
      ...(table ? { table } : {}),
    };
    let pending: Node[] = [];
    for (const m of cls.childForFieldName("body")?.children ?? []) {
      if (!m) continue;
      if (m.type === "decorator") {
        pending.push(m);
        continue;
      }
      if (m.type === "public_field_definition" || m.type === "property_declaration") {
        const field = m.childForFieldName("name")?.text ?? "";
        const type = m.childForFieldName("type")?.text.replace(/^:\s*/, "");
        for (const d of [
          ...pending,
          ...m.children.filter((x): x is Node => x?.type === "decorator"),
        ]) {
          const c = d.namedChildren[0];
          const dn =
            c?.type === "call_expression"
              ? (c.childForFieldName("function")?.text ?? "")
              : (c?.text ?? "");
          if (dn in TYPEORM_REL && c?.type === "call_expression") {
            const target = arrowTarget(args(c)[0]);
            if (target)
              e.relations.push({
                field,
                target,
                targetIs: "model",
                many: TYPEORM_REL[dn],
                line: lineOf(d),
              });
          } else if (/Column$/.test(dn)) {
            e.fields.push({
              name: field,
              ...(type ? { type } : {}),
              ...(/^Primary/.test(dn) ? { pk: true } : {}),
              line: lineOf(m),
            });
          }
        }
        pending = [];
      }
    }
    out.push(e);
  }

  // Drizzle: export const orders = pgTable("orders", { id: serial("id").primaryKey(), userId: integer("user_id").references(() => users.id) })
  for (const d of root.descendantsOfType("variable_declarator")) {
    const v = d?.childForFieldName("value");
    if (!d || v?.type !== "call_expression") continue;
    const fn = v.childForFieldName("function")?.text ?? "";
    const varName = d.childForFieldName("name")?.text;
    if (/^(pgTable|mysqlTable|sqliteTable)$/.test(fn) && varName) {
      const [t, cols] = args(v);
      const e: RawEntity = {
        name: varName,
        orm: "drizzle",
        line: lineOf(d),
        fields: [],
        relations: [],
        ...(lit(t) ? { table: lit(t) } : {}),
      };
      for (const p of cols?.type === "object" ? cols.namedChildren : []) {
        if (p?.type !== "pair") continue;
        const field = p.childForFieldName("key")?.text.replace(/["']/g, "") ?? "";
        const val = p.childForFieldName("value");
        const type = /^(\w+)\(/.exec(val?.text ?? "")?.[1];
        e.fields.push({
          name: field,
          ...(type ? { type } : {}),
          ...(/\.primaryKey\(/.test(val?.text ?? "") ? { pk: true } : {}),
          line: lineOf(p),
        });
        const ref = /\.references\(\s*\(\)\s*=>\s*(\w+)\./.exec(val?.text ?? "")?.[1];
        if (ref) e.relations.push({ field, target: ref, targetIs: "variable", line: lineOf(p) });
      }
      out.push(e);
    }
    // Mongoose: const Order = mongoose.model("Order", schema)
    if (/(^|\.)model$/.test(fn) && /mongoose|^model$/.test(fn) && lit(args(v)[0])) {
      out.push({
        name: lit(args(v)[0])!,
        orm: "mongoose",
        line: lineOf(d),
        fields: [],
        relations: [],
      });
    }
  }
  return out;
}

const DJ_REL: Record<string, boolean> = {
  ForeignKey: false,
  OneToOneField: false,
  ManyToManyField: true,
};

export function pyEntities(root: Node): RawEntity[] {
  const out: RawEntity[] = [];
  for (const cls of root.descendantsOfType("class_definition")) {
    if (!cls) continue;
    const name = cls.childForFieldName("name")?.text;
    const supers = cls.childForFieldName("superclasses")?.text ?? "";
    const body = cls.childForFieldName("body");
    if (!name || !body) continue;
    const django = /\bmodels\.Model\b/.test(supers);
    const sqla =
      !django &&
      (/\b(Base|DeclarativeBase|db\.Model|Model)\b/.test(supers) || /\bSQLModel\b/.test(supers)) &&
      /(__tablename__|Column\(|mapped_column\(|Field\()/.test(body.text);
    if (!django && !sqla) continue;
    const e: RawEntity = {
      name,
      orm: django ? "django" : "sqlalchemy",
      line: lineOf(cls),
      fields: [],
      relations: [],
    };
    for (const stmt of body.namedChildren) {
      const asg = stmt?.type === "expression_statement" ? stmt.namedChildren[0] : null;
      if (asg?.type !== "assignment") continue;
      const left = asg.childForFieldName("left")?.text ?? "";
      const right = asg.childForFieldName("right");
      if (left === "__tablename__") {
        const t = lit(right);
        if (t) e.table = t;
        continue;
      }
      if (right?.type !== "call") continue;
      const callee = right.childForFieldName("function")?.text ?? "";
      const a = args(right);
      const short = callee.split(".").pop() ?? "";
      if (django) {
        if (short in DJ_REL) {
          const t = a[0]?.type === "identifier" ? a[0].text : lit(a[0])?.split(".").pop();
          if (t)
            e.relations.push({
              field: left,
              target: t === "self" ? name : t,
              targetIs: "model",
              many: DJ_REL[short],
              line: lineOf(asg),
            });
        } else if (/Field$/.test(short)) {
          e.fields.push({
            name: left,
            type: short,
            ...(/primary_key\s*=\s*True/.test(right.text) ? { pk: true } : {}),
            line: lineOf(asg),
          });
        }
        continue;
      }
      if (short === "relationship") {
        const t = lit(a[0]) ?? (a[0]?.type === "identifier" ? a[0].text : undefined);
        if (t) e.relations.push({ field: left, target: t, targetIs: "model", line: lineOf(asg) });
        continue;
      }
      if (short === "Column" || short === "mapped_column" || short === "Field") {
        const type = a
          .find((x) => x.type === "identifier" || x.type === "call")
          ?.text.split("(")[0];
        e.fields.push({
          name: left,
          ...(type ? { type } : {}),
          ...(/primary_key\s*=\s*True/.test(right.text) ? { pk: true } : {}),
          line: lineOf(asg),
        });
        const fk = /ForeignKey\(\s*["']([\w.]+)["']/.exec(right.text)?.[1];
        if (fk)
          e.relations.push({
            field: left,
            target: fk.split(".")[0]!,
            targetIs: "table",
            line: lineOf(asg),
          });
      }
    }
    out.push(e);
  }
  return out;
}

/** Prisma schema (text): `model Order { … }` blocks with fields, relations and `@@map`. */
export function prismaEntities(text: string): RawEntity[] {
  const out: RawEntity[] = [];
  const lines = text.split("\n");
  const models = new Set([...text.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map((m) => m[1]!));
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*model\s+(\w+)\s*\{/.exec(lines[i]!);
    if (!head) continue;
    const e: RawEntity = { name: head[1]!, orm: "prisma", line: i + 1, fields: [], relations: [] };
    for (i++; i < lines.length && !/^\s*\}/.test(lines[i]!); i++) {
      const l = lines[i]!.replace(/\/\/.*$/, "");
      const map = /^\s*@@map\(\s*"([^"]+)"/.exec(l);
      if (map) e.table = map[1];
      const f = /^\s*(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(l);
      if (!f || l.trim().startsWith("@")) continue;
      const [, field, type, list] = f;
      if (models.has(type!))
        e.relations.push({
          field: field!,
          target: type!,
          targetIs: "model",
          many: !!list,
          line: i + 1,
        });
      else
        e.fields.push({
          name: field!,
          type: type!,
          ...(/@id\b/.test(f[5] ?? "") ? { pk: true } : {}),
          line: i + 1,
        });
    }
    out.push(e);
  }
  return out;
}
