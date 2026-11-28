import type { Node } from "web-tree-sitter";

/**
 * Data operations found in one file's syntax tree: database and cache reads and writes, and
 * queue publishes and consumes. These are *candidates*: whether a call really talks to a
 * database is decided later (dataops/link.ts) from what the receiver is (a client created in this
 * file, or imported from a file that uses that infrastructure) and what the file imports. That
 * keeps `map.get()` or `array.find()` from ever being mistaken for a database read.
 */
export type OpKind = "read" | "write" | "publish" | "consume";

/** Which client library family a call looks like. */
export type OpSystem =
  | "prisma"
  | "sql"
  | "drizzle"
  | "supabase"
  | "mongo"
  | "typeorm"
  | "redis"
  | "bullmq"
  | "kafka"
  | "sqs"
  | "rabbitmq"
  | "django"
  | "sqlalchemy"
  | "celery";

export interface RawOp {
  kind: OpKind;
  system: OpSystem;
  line: number;
  /** Root identifier of the receiver (`prisma` in `prisma.order.create`), "" when none. */
  root: string;
  /** What was called, for evidence: `prisma.order.create`, `db.query`, `emails.add`. */
  call: string;
  /** Table, model or collection when it is a literal or a plain identifier. */
  table?: string;
  /** Queue, topic or task name when it is a literal. */
  channel?: string;
  /** Strong by itself (an SQL literal, a Prisma model call): needs less proof of the receiver. */
  strong?: boolean;
  /** Enclosing function or method, when inside one. */
  fn?: string;
}

/** A client object created in this file: `const prisma = new PrismaClient()`. */
export interface RawClient {
  /** Constructor as written: `PrismaClient`, `Pool`, `Redis`, `createClient`, `Queue`. */
  ctor: string;
  /** Queue / topic name when the constructor takes a literal one. */
  channel?: string;
  line: number;
}

const lineOf = (n: Node): number => n.startPosition.row + 1;

function lit(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "string") {
    const t = n.text;
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

const argsOf = (call: Node): Node[] =>
  (call.childForFieldName("arguments")?.namedChildren ?? []).filter(
    (x): x is Node => !!x && x.type !== "comment",
  );

/** `SELECT … FROM orders` → read "orders"; `INSERT INTO orders` → write "orders". */
export function classifySql(sql: string): { kind: "read" | "write"; table?: string } | undefined {
  const s = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim();
  const first = /^(\w+)/.exec(s)?.[1]?.toLowerCase();
  if (!first) return undefined;
  const kind =
    first === "select" || first === "with" || first === "show"
      ? "read"
      : ["insert", "update", "delete", "merge", "upsert", "replace", "truncate"].includes(first)
        ? "write"
        : undefined;
  if (!kind) return undefined;
  const t = /\b(?:from|into|update|join|truncate(?:\s+table)?)\s+["`[]?([A-Za-z_][\w.]*)/i.exec(
    s,
  )?.[1];
  return { kind, ...(t ? { table: t.replace(/^public\./, "") } : {}) };
}

const PRISMA_READ = new Set([
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);
const PRISMA_WRITE = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);
const MONGO_READ = new Set([
  "find",
  "findOne",
  "findById",
  "countDocuments",
  "estimatedDocumentCount",
  "aggregate",
  "exists",
  "distinct",
]);
const MONGO_WRITE = new Set([
  "create",
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "findByIdAndUpdate",
  "findOneAndUpdate",
  "findByIdAndDelete",
  "findOneAndDelete",
  "replaceOne",
  "bulkWrite",
]);
const TYPEORM_READ = new Set([
  "find",
  "findOne",
  "findOneBy",
  "findBy",
  "findAndCount",
  "count",
  "exist",
  "exists",
]);
const TYPEORM_WRITE = new Set([
  "save",
  "insert",
  "update",
  "delete",
  "remove",
  "upsert",
  "softDelete",
]);
const REDIS_READ = new Set([
  "get",
  "mget",
  "hget",
  "hgetall",
  "hmget",
  "exists",
  "lrange",
  "smembers",
  "sismember",
  "zrange",
  "zscore",
  "ttl",
  "keys",
  "scan",
  "llen",
  "scard",
]);
const REDIS_WRITE = new Set([
  "set",
  "setex",
  "setnx",
  "mset",
  "hset",
  "hmset",
  "del",
  "unlink",
  "incr",
  "incrby",
  "decr",
  "expire",
  "lpush",
  "rpush",
  "lpop",
  "rpop",
  "sadd",
  "srem",
  "zadd",
  "zrem",
  "hdel",
]);
const SUPA_WRITE = new Set(["insert", "update", "upsert", "delete"]);

/** Name of the function, method or arrow-assigned variable around a node. */
function enclosingFn(n: Node): string | undefined {
  for (let p = n.parent; p; p = p.parent) {
    if (
      p.type === "function_declaration" ||
      p.type === "method_definition" ||
      p.type === "function_definition"
    ) {
      const name = p.childForFieldName("name")?.text;
      if (p.type === "method_definition") {
        const cls = p.parent?.parent?.childForFieldName("name")?.text;
        return cls && name ? `${cls}.${name}` : name;
      }
      if (p.type === "function_definition") {
        const cls =
          p.parent?.parent?.type === "class_definition"
            ? p.parent.parent.childForFieldName("name")?.text
            : undefined;
        return cls && name ? `${cls}.${name}` : name;
      }
      return name;
    }
    if (
      (p.type === "arrow_function" || p.type === "function_expression") &&
      p.parent?.type === "variable_declarator"
    )
      return p.parent.childForFieldName("name")?.text;
  }
  return undefined;
}

/** `this.prisma.order.findMany` → ["prisma", "order", "findMany"]; non-member roots end the chain. */
function memberChain(n: Node): { parts: string[]; base: Node | null } {
  const parts: string[] = [];
  let cur: Node | null = n;
  while (cur?.type === "member_expression") {
    parts.unshift(cur.childForFieldName("property")?.text ?? "");
    cur = cur.childForFieldName("object");
  }
  if (cur?.type === "identifier") return { parts: [cur.text, ...parts], base: null };
  if (cur?.type === "this") return { parts, base: null };
  return { parts, base: cur };
}

export function jsDataFacts(root: Node): { ops: RawOp[]; clients: Record<string, RawClient> } {
  const ops: RawOp[] = [];
  const clients: Record<string, RawClient> = {};
  const push = (n: Node, op: Omit<RawOp, "line" | "fn">): void => {
    const fn = enclosingFn(n);
    ops.push({ ...op, line: lineOf(n), ...(fn ? { fn } : {}) });
  };

  for (const d of root.descendantsOfType("variable_declarator")) {
    const name = d?.childForFieldName("name");
    let value = d?.childForFieldName("value");
    if (!d || name?.type !== "identifier" || !value) continue;
    if (value.type === "await_expression") value = value.namedChildren[0] ?? value;
    const callee =
      value.type === "new_expression"
        ? value.childForFieldName("constructor")
        : value.type === "call_expression"
          ? value.childForFieldName("function")
          : null;
    if (!callee) continue;
    const ctor = callee.text.split(".").pop() ?? "";
    if (
      !/^(PrismaClient|Pool|Client|Redis|Cluster|createClient|createPool|createConnection|Queue|Worker|Kafka|SQSClient|drizzle|Sequelize|MongoClient|DataSource|model|producer|consumer|getRepository)$/.test(
        ctor,
      )
    )
      continue;
    const a =
      value.type === "new_expression" || value.type === "call_expression" ? argsOf(value) : [];
    clients[name.text] = {
      ctor: callee.text,
      line: lineOf(d),
      ...(lit(a[0]) ? { channel: lit(a[0]) } : {}),
    };
    // A BullMQ worker consumes its queue where it is created.
    if (ctor === "Worker" && lit(a[0]))
      push(d, {
        kind: "consume",
        system: "bullmq",
        root: name.text,
        call: `new Worker("${lit(a[0])}")`,
        channel: lit(a[0]),
      });
  }
  // `new Worker("emails", …)` not assigned to a variable.
  for (const n of root.descendantsOfType("new_expression")) {
    if (!n || n.parent?.type === "variable_declarator") continue;
    if (n.childForFieldName("constructor")?.text !== "Worker") continue;
    const ch = lit(argsOf(n)[0]);
    if (ch)
      push(n, {
        kind: "consume",
        system: "bullmq",
        root: "",
        call: `new Worker("${ch}")`,
        channel: ch,
      });
  }

  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    const a = argsOf(call);
    if (!fn) continue;
    // sql`select …` (postgres.js, @vercel/postgres, slonik)
    if (
      fn.type === "identifier" &&
      call.childForFieldName("arguments")?.type === "template_string"
    ) {
      const sql = classifySql(
        call
          .childForFieldName("arguments")!
          .text.slice(1, -1)
          .replace(/\$\{[^}]*\}/g, "?"),
      );
      if (sql)
        push(call, {
          kind: sql.kind,
          system: "sql",
          root: fn.text,
          call: `${fn.text}\`…\``,
          ...(sql.table ? { table: sql.table } : {}),
          strong: true,
        });
      continue;
    }
    if (fn.type !== "member_expression") continue;
    const method = fn.childForFieldName("property")?.text ?? "";
    const obj = fn.childForFieldName("object");
    const { parts, base } = memberChain(fn);
    const rootName = parts[0] ?? "";

    // Builder chains: supabase.from("orders").select(), db.select().from(orders), getRepository(E).find()
    if (base?.type === "call_expression" || obj?.type === "call_expression") {
      const inner = (obj?.type === "call_expression" ? obj : base)!;
      const innerFn = inner.childForFieldName("function");
      const innerMethod =
        innerFn?.type === "member_expression"
          ? innerFn.childForFieldName("property")?.text
          : innerFn?.text;
      const innerArg = argsOf(inner)[0];
      const innerRoot =
        innerFn?.type === "member_expression" ? (memberChain(innerFn).parts[0] ?? "") : "";
      if (
        innerMethod === "from" &&
        lit(innerArg) &&
        (method === "select" || SUPA_WRITE.has(method))
      ) {
        push(call, {
          kind: method === "select" ? "read" : "write",
          system: "supabase",
          root: innerRoot,
          call: `${innerRoot}.from("${lit(innerArg)}").${method}`,
          table: lit(innerArg),
        });
        continue;
      }
      if (method === "from" && innerMethod === "select") {
        const t = a[0]?.type === "identifier" ? a[0].text : lit(a[0]);
        push(call, {
          kind: "read",
          system: "drizzle",
          root: innerRoot,
          call: `${innerRoot}.select().from(${t ?? "…"})`,
          ...(t ? { table: t } : {}),
        });
        continue;
      }
      if (
        innerMethod === "getRepository" &&
        (TYPEORM_READ.has(method) || TYPEORM_WRITE.has(method))
      ) {
        const t = innerArg?.type === "identifier" ? innerArg.text : lit(innerArg);
        push(call, {
          kind: TYPEORM_READ.has(method) ? "read" : "write",
          system: "typeorm",
          root: innerRoot || "getRepository",
          call: `getRepository(${t ?? "…"}).${method}`,
          ...(t ? { table: t } : {}),
          strong: true,
        });
        continue;
      }
      if (
        innerMethod === "collection" &&
        lit(innerArg) &&
        (MONGO_READ.has(method) || MONGO_WRITE.has(method))
      ) {
        push(call, {
          kind: MONGO_READ.has(method) ? "read" : "write",
          system: "mongo",
          root: innerRoot,
          call: `${innerRoot}.collection("${lit(innerArg)}").${method}`,
          table: lit(innerArg),
        });
        continue;
      }
    }
    if (!rootName) continue;
    const chainText = parts.join(".");

    // Drizzle writes: db.insert(orders), db.update(orders), db.delete(orders)
    if (
      parts.length === 2 &&
      ["insert", "update", "delete"].includes(method) &&
      a[0]?.type === "identifier"
    ) {
      push(call, {
        kind: "write",
        system: "drizzle",
        root: rootName,
        call: `${chainText}(${a[0].text})`,
        table: a[0].text,
      });
      // TypeORM's repo.delete(id) looks the same: both stay candidates, the linker keeps the proven one.
    }
    // Prisma: prisma.order.findMany(...)
    if (parts.length >= 3 && (PRISMA_READ.has(method) || PRISMA_WRITE.has(method))) {
      const model = parts[parts.length - 2]!;
      push(call, {
        kind: PRISMA_READ.has(method) ? "read" : "write",
        system: "prisma",
        root: rootName,
        call: chainText,
        table: model,
        strong: /prisma|db/i.test(rootName),
      });
      continue;
    }
    if (
      parts.length === 2 &&
      (method === "$queryRaw" ||
        method === "$executeRaw" ||
        method === "$queryRawUnsafe" ||
        method === "$executeRawUnsafe")
    ) {
      push(call, {
        kind: method.startsWith("$query") ? "read" : "write",
        system: "prisma",
        root: rootName,
        call: chainText,
        strong: true,
      });
      continue;
    }
    // SQL through a client: db.query("select …"), pool.execute(`insert …`)
    if (["query", "execute", "raw", "unsafe", "run", "all", "get", "prepare"].includes(method)) {
      const s = lit(a[0]);
      const sql = s ? classifySql(s) : undefined;
      if (sql) {
        push(call, {
          kind: sql.kind,
          system: "sql",
          root: rootName,
          call: chainText,
          ...(sql.table ? { table: sql.table } : {}),
          strong: true,
        });
        continue;
      }
    }
    // Queues
    if ((method === "add" || method === "addBulk") && parts.length === 2) {
      push(call, { kind: "publish", system: "bullmq", root: rootName, call: chainText });
      continue;
    }
    if (method === "send" && a[0]?.type === "object") {
      const topic = a[0].namedChildren.find(
        (p) =>
          p?.type === "pair" && p.childForFieldName("key")?.text.replace(/["']/g, "") === "topic",
      );
      push(call, {
        kind: "publish",
        system: "kafka",
        root: rootName,
        call: chainText,
        ...(lit(topic?.childForFieldName("value"))
          ? { channel: lit(topic?.childForFieldName("value")) }
          : {}),
      });
      continue;
    }
    if (method === "subscribe" && a[0]?.type === "object") {
      const topic = a[0].namedChildren.find(
        (p) =>
          p?.type === "pair" && /^["']?topics?["']?$/.test(p.childForFieldName("key")?.text ?? ""),
      );
      const v = topic?.childForFieldName("value");
      const ch = lit(v) ?? (v?.type === "array" ? lit(v.namedChildren[0]) : undefined);
      push(call, {
        kind: "consume",
        system: "kafka",
        root: rootName,
        call: chainText,
        ...(ch ? { channel: ch } : {}),
      });
      continue;
    }
    if (method === "send" && a[0]?.type === "new_expression") {
      const cmd = a[0].childForFieldName("constructor")?.text ?? "";
      if (/^(SendMessage|SendMessageBatch)Command$/.test(cmd) || cmd === "ReceiveMessageCommand") {
        const url = a[0]
          .descendantsOfType("pair")
          .find((p) => p?.childForFieldName("key")?.text.replace(/["']/g, "") === "QueueUrl");
        const u = lit(url?.childForFieldName("value"));
        push(call, {
          kind: cmd === "ReceiveMessageCommand" ? "consume" : "publish",
          system: "sqs",
          root: rootName,
          call: `${chainText}(new ${cmd})`,
          ...(u ? { channel: u.split("/").pop() } : {}),
          strong: true,
        });
        continue;
      }
    }
    if (
      method === "sendToQueue" ||
      method === "consume" ||
      (method === "publish" && a.length >= 2 && lit(a[0]) !== undefined)
    ) {
      const ch = method === "publish" ? (lit(a[1]) ?? lit(a[0])) : lit(a[0]);
      push(call, {
        kind: method === "consume" ? "consume" : "publish",
        system: "rabbitmq",
        root: rootName,
        call: chainText,
        ...(ch ? { channel: ch } : {}),
      });
      continue;
    }
    // Redis and Mongo-style model calls: only kept if the receiver proves to be such a client.
    if (parts.length === 2 && (REDIS_READ.has(method) || REDIS_WRITE.has(method)))
      push(call, {
        kind: REDIS_READ.has(method) ? "read" : "write",
        system: "redis",
        root: rootName,
        call: chainText,
        ...(lit(a[0]) ? { table: lit(a[0]) } : {}),
      });
    if (parts.length === 2 && (MONGO_READ.has(method) || MONGO_WRITE.has(method)))
      push(call, {
        kind: MONGO_READ.has(method) ? "read" : "write",
        system: "mongo",
        root: rootName,
        call: chainText,
      });
    if (parts.length === 2 && (TYPEORM_READ.has(method) || TYPEORM_WRITE.has(method)))
      push(call, {
        kind: TYPEORM_READ.has(method) ? "read" : "write",
        system: "typeorm",
        root: rootName,
        call: chainText,
      });
  }
  ops.sort((x, y) => x.line - y.line);
  return { ops, clients };
}

const DJANGO_READ = new Set([
  "all",
  "filter",
  "get",
  "exclude",
  "first",
  "last",
  "count",
  "exists",
  "values",
  "values_list",
  "aggregate",
  "annotate",
  "order_by",
  "get_or_none",
  "in_bulk",
  "iterator",
]);
const DJANGO_WRITE = new Set([
  "create",
  "update",
  "delete",
  "bulk_create",
  "bulk_update",
  "get_or_create",
  "update_or_create",
]);

export function pyDataFacts(root: Node): {
  ops: RawOp[];
  clients: Record<string, RawClient>;
  tasks: string[];
} {
  const ops: RawOp[] = [];
  const clients: Record<string, RawClient> = {};
  const tasks: string[] = [];
  const push = (n: Node, op: Omit<RawOp, "line" | "fn">): void => {
    const fn = enclosingFn(n);
    ops.push({ ...op, line: lineOf(n), ...(fn ? { fn } : {}) });
  };
  const kw = (call: Node, name: string): Node | undefined =>
    argsOf(call)
      .find((x) => x.type === "keyword_argument" && x.childForFieldName("name")?.text === name)
      ?.childForFieldName("value") ?? undefined;

  for (const asg of root.descendantsOfType("assignment")) {
    const left = asg?.childForFieldName("left");
    const right = asg?.childForFieldName("right");
    if (!asg || left?.type !== "identifier" || right?.type !== "call") continue;
    const callee = right.childForFieldName("function")?.text ?? "";
    const ctor = callee.split(".").pop() ?? "";
    if (
      !/^(Redis|StrictRedis|from_url|create_engine|sessionmaker|Session|SessionLocal|KafkaProducer|KafkaConsumer|client|BlockingConnection|Celery|MongoClient|AsyncIOMotorClient)$/.test(
        ctor,
      )
    )
      continue;
    const first = argsOf(right).filter((x) => x.type !== "keyword_argument")[0];
    clients[left.text] = {
      ctor: callee,
      line: lineOf(asg),
      ...(lit(first) ? { channel: lit(first) } : {}),
    };
    if (ctor === "KafkaConsumer" && lit(first))
      push(asg, {
        kind: "consume",
        system: "kafka",
        root: left.text,
        call: `KafkaConsumer("${lit(first)}")`,
        channel: lit(first),
      });
  }

  // Celery tasks: @app.task / @shared_task / @celery.task def send_receipt(...)
  for (const dd of root.descendantsOfType("decorated_definition")) {
    const def = dd?.childForFieldName("definition");
    const name = def?.childForFieldName("name")?.text;
    if (!dd || !name) continue;
    const isTask = dd.children.some(
      (d) =>
        d?.type === "decorator" && /(^|\.)(task|shared_task)(\(|$)/.test(d.text.replace(/^@/, "")),
    );
    if (!isTask) continue;
    tasks.push(name);
    push(dd, { kind: "consume", system: "celery", root: "", call: `@task ${name}`, channel: name });
  }

  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "attribute") continue;
    const method = fn.childForFieldName("attribute")?.text ?? "";
    const obj = fn.childForFieldName("object");
    const a = argsOf(call).filter((x) => x.type !== "keyword_argument");
    const objText = obj?.text ?? "";
    const rootName = objText.split(/[.(]/)[0] ?? "";

    // Django ORM: Order.objects.filter(...)
    const dj = /^([A-Z]\w*)\.objects(?:\.\w+\([^)]*\))*$/.exec(objText);
    if (dj && (DJANGO_READ.has(method) || DJANGO_WRITE.has(method))) {
      push(call, {
        kind: DJANGO_READ.has(method) ? "read" : "write",
        system: "django",
        root: dj[1]!,
        call: `${dj[1]}.objects.${method}`,
        table: dj[1],
      });
      continue;
    }
    // SQLAlchemy: session.query(Item), session.add(x), db.session.commit()
    if (method === "query" && a[0]?.type === "identifier" && /session|db/i.test(objText)) {
      push(call, {
        kind: "read",
        system: "sqlalchemy",
        root: rootName,
        call: `${objText}.query(${a[0].text})`,
        table: a[0].text,
      });
      continue;
    }
    if (
      ["add", "add_all", "delete", "merge", "bulk_save_objects"].includes(method) &&
      /session/i.test(objText)
    ) {
      push(call, {
        kind: "write",
        system: "sqlalchemy",
        root: rootName,
        call: `${objText}.${method}`,
      });
      continue;
    }
    // Raw SQL: cursor.execute("select …"), session.execute(text("…"))
    if (method === "execute" || method === "executemany") {
      let s = lit(a[0]);
      if (!s && a[0]?.type === "call" && a[0].childForFieldName("function")?.text === "text")
        s = lit(argsOf(a[0])[0]);
      const sql = s ? classifySql(s) : undefined;
      if (sql) {
        push(call, {
          kind: sql.kind,
          system: "sql",
          root: rootName,
          call: `${objText}.${method}`,
          ...(sql.table ? { table: sql.table } : {}),
          strong: true,
        });
        continue;
      }
    }
    // Celery: send_receipt.delay(...)
    if ((method === "delay" || method === "apply_async") && obj?.type === "identifier") {
      push(call, {
        kind: "publish",
        system: "celery",
        root: obj.text,
        call: `${obj.text}.${method}`,
        channel: obj.text,
      });
      continue;
    }
    // Kafka, RabbitMQ (pika), SQS (boto3)
    if (method === "send" && lit(a[0])) {
      push(call, {
        kind: "publish",
        system: "kafka",
        root: rootName,
        call: `${objText}.send`,
        channel: lit(a[0]),
      });
      continue;
    }
    if (method === "basic_publish") {
      const ch = lit(kw(call, "routing_key")) ?? lit(a[1]);
      push(call, {
        kind: "publish",
        system: "rabbitmq",
        root: rootName,
        call: `${objText}.basic_publish`,
        ...(ch ? { channel: ch } : {}),
        strong: true,
      });
      continue;
    }
    if (method === "basic_consume") {
      const ch = lit(kw(call, "queue")) ?? lit(a[0]);
      push(call, {
        kind: "consume",
        system: "rabbitmq",
        root: rootName,
        call: `${objText}.basic_consume`,
        ...(ch ? { channel: ch } : {}),
        strong: true,
      });
      continue;
    }
    if (method === "send_message" || method === "receive_message") {
      const u = lit(kw(call, "QueueUrl"));
      push(call, {
        kind: method === "send_message" ? "publish" : "consume",
        system: "sqs",
        root: rootName,
        call: `${objText}.${method}`,
        ...(u ? { channel: u.split("/").pop() } : {}),
      });
      continue;
    }
    // redis-py
    if (obj?.type === "identifier" && (REDIS_READ.has(method) || REDIS_WRITE.has(method)))
      push(call, {
        kind: REDIS_READ.has(method) ? "read" : "write",
        system: "redis",
        root: rootName,
        call: `${objText}.${method}`,
        ...(lit(a[0]) ? { table: lit(a[0]) } : {}),
      });
  }
  ops.sort((x, y) => x.line - y.line);
  return { ops, clients, tasks };
}
