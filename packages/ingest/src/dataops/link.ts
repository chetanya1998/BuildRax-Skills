import {
  edgeId,
  type EdgeKind,
  type Evidence,
  type IREdge,
  type IRNode,
  type Model,
} from "@buildrax/ir";
import type { BuildContext } from "../build.js";
import type { FileFacts } from "../routes/facts.js";
import type { OpKind, OpSystem, RawClient, RawOp } from "./facts.js";
import { entitiesForTable } from "../entities/build.js";

/** Infrastructure kind each client family talks to. */
const TARGET_KIND: Record<OpSystem, "database" | "cache" | "queue"> = {
  prisma: "database",
  sql: "database",
  drizzle: "database",
  supabase: "database",
  mongo: "database",
  typeorm: "database",
  django: "database",
  sqlalchemy: "database",
  redis: "cache",
  bullmq: "queue",
  kafka: "queue",
  sqs: "queue",
  rabbitmq: "queue",
  celery: "queue",
};

/** Packages that prove a file talks to a family (npm names and lower-case PyPI names). */
const LIBS: Record<OpSystem, string[]> = {
  prisma: ["@prisma/client", "prisma"],
  sql: [
    "pg",
    "postgres",
    "mysql",
    "mysql2",
    "@vercel/postgres",
    "@neondatabase/serverless",
    "better-sqlite3",
    "sqlite3",
    "pg-promise",
    "slonik",
    "psycopg2",
    "psycopg2-binary",
    "psycopg",
    "pymysql",
    "mysqlclient",
    "asyncpg",
    "sqlalchemy",
    "sqlite3",
    "sequelize",
    "knex",
    "kysely",
  ],
  drizzle: ["drizzle-orm"],
  supabase: ["@supabase/supabase-js", "supabase"],
  mongo: ["mongoose", "mongodb", "pymongo", "motor"],
  typeorm: ["typeorm", "@nestjs/typeorm"],
  django: ["django"],
  sqlalchemy: ["sqlalchemy", "flask_sqlalchemy", "flask-sqlalchemy", "sqlmodel"],
  redis: ["redis", "ioredis", "@redis/client", "@upstash/redis"],
  bullmq: ["bullmq", "bull"],
  kafka: ["kafkajs", "kafka-python", "kafka", "confluent-kafka", "confluent_kafka", "aiokafka"],
  sqs: ["@aws-sdk/client-sqs", "boto3", "aioboto3"],
  rabbitmq: ["amqplib", "amqp-connection-manager", "pika", "aio-pika", "aio_pika"],
  celery: ["celery"],
};

/** Client constructors that belong to a family. */
const CTORS: Partial<Record<OpSystem, RegExp>> = {
  prisma: /(^|\.)PrismaClient$/,
  sql: /(^|\.)(Pool|Client|createPool|createConnection|Sequelize|create_engine|sessionmaker|Session|SessionLocal)$/,
  drizzle: /(^|\.)drizzle$/,
  mongo: /(^|\.)(model|MongoClient|AsyncIOMotorClient)$/,
  typeorm: /(^|\.)(DataSource|getRepository)$/,
  redis: /(^|\.)(Redis|Cluster|createClient|StrictRedis|from_url)$/,
  bullmq: /(^|\.)Queue$/,
  kafka: /(^|\.)(producer|consumer|KafkaProducer|KafkaConsumer|Kafka)$/,
  sqs: /(^|\.)(SQSClient|client)$/,
  rabbitmq: /(^|\.)BlockingConnection$/,
  sqlalchemy: /(^|\.)(create_engine|sessionmaker|Session|SessionLocal)$/,
};

/** Infra node keys a queue family maps to when detected (`queue:bullmq`). */
const QUEUE_KEY: Partial<Record<OpSystem, string>> = {
  bullmq: "queue:bullmq",
  celery: "queue:celery",
  kafka: "queue:kafka",
  sqs: "queue:sqs",
  rabbitmq: "queue:rabbitmq",
};

const EDGE_OF: Record<OpKind, EdgeKind> = {
  read: "reads",
  write: "writes",
  publish: "publishes",
  consume: "consumes",
};

export interface LinkSource {
  path: string;
  facts: FileFacts;
}

export interface DataOpsResult {
  edges: IREdge[];
  stats: { candidates: number; linked: number; inferred: number };
}

/**
 * Confirm candidate data operations and link them to infrastructure:
 *  file -reads/writes-> database or cache, file -publishes/consumes-> queue.
 * A candidate is kept only with proof: a client of that family created in the file, a receiver
 * imported from a repo file that holds such a client or uses that infrastructure, or (for strong
 * signals such as an SQL literal) the file importing the family's library. When the only target
 * found is "the one database in the project", the evidence says `inferred`.
 */
export function linkDataOps(
  model: Model,
  sources: readonly LinkSource[],
  ctx: BuildContext,
): DataOpsResult {
  const byPath = new Map(sources.map((s) => [s.path, s]));
  const nodes = new Map(model.nodes.map((n) => [n.id, n]));
  const usesOf = new Map<string, string[]>(); // file path -> infra node ids it uses
  for (const e of model.edges) {
    if (e.kind !== "uses" || !e.from.startsWith("file:")) continue;
    const p = e.from.slice(5);
    usesOf.set(p, [...(usesOf.get(p) ?? []), e.to]);
  }
  const ofKind = (ids: readonly string[] | undefined, kind: string): string[] =>
    (ids ?? []).filter((id) => nodes.get(id)?.kind === kind).sort();
  const allOfKind = (kind: string): IRNode[] =>
    model.nodes.filter((n) => n.kind === kind && n.meta?.["infra"] === true);
  const imports = (path: string, system: OpSystem): boolean =>
    LIBS[system].some((l) => ctx.externalImports.get(path)?.has(l));
  const ctorFits = (c: RawClient | undefined, system: OpSystem): boolean =>
    !!c && !!CTORS[system]?.test(c.ctor);

  /** The constructor itself is imported from a repo file holding a client of this family. */
  const ctorFactory = (path: string, c: RawClient, system: OpSystem): boolean => {
    const name = c.ctor.split(".")[0]!;
    const file = ctx.bindings.get(path)?.get(name);
    const f = file ? byPath.get(file) : undefined;
    return (
      !!f &&
      Object.entries(f.facts.clients ?? {}).some(([v, cl]) => v === name && ctorFits(cl, system))
    );
  };
  const edges = new Map<string, IREdge>();
  const stats = { candidates: 0, linked: 0, inferred: 0 };

  for (const src of [...sources].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const ops = src.facts.ops ?? [];
    const done = new Set<string>(); // one operation per line and kind (several families can match one call)
    for (const op of ops) {
      stats.candidates++;
      if (done.has(`${op.line}:${op.kind}`)) continue;
      const kind = TARGET_KIND[op.system];
      const local = op.root ? src.facts.clients?.[op.root] : undefined;
      const boundPath = op.root ? ctx.bindings.get(src.path)?.get(op.root) : undefined;
      const bound = boundPath ? byPath.get(boundPath) : undefined;
      const boundClient = bound
        ? Object.values(bound.facts.clients ?? {}).find((c) => ctorFits(c, op.system))
        : undefined;

      // --- Proof that this call really talks to a database / cache / queue ---
      let proven = false;
      if (op.system === "celery") {
        const own = src.facts.tasks?.includes(op.channel ?? "");
        proven = op.kind === "consume" ? true : !!own || !!bound?.facts.tasks?.includes(op.root);
      } else if (op.system === "django") {
        proven =
          imports(src.path, "django") || !!(boundPath && /(^|\/)models(\.py|\/)/.test(boundPath));
      } else if (op.kind === "consume" && op.system === "bullmq" && !op.root) {
        proven = imports(src.path, "bullmq");
      } else if (local && ctorFactory(src.path, local, op.system)) {
        // `session = SessionLocal()` where SessionLocal is a session factory imported from a repo file.
        proven = true;
      } else if (ctorFits(local, op.system)) {
        // A client built here: its library must be imported here too (Pool / Client / createClient are generic names).
        proven = imports(src.path, op.system) || op.system === "prisma";
      } else if (boundClient) {
        proven = true;
      } else if (bound && ofKind(usesOf.get(bound.path), kind).length) {
        proven = true;
      } else if (op.strong) {
        proven =
          imports(src.path, op.system) ||
          ofKind(usesOf.get(src.path), kind).length > 0 ||
          (!!bound && imports(bound.path, op.system));
      } else if (op.system === "rabbitmq" || op.system === "kafka" || op.system === "sqs") {
        proven = imports(src.path, op.system);
      }
      if (!proven) continue;

      // --- Which node it talks to ---
      let target: string | undefined;
      let inferred = false;
      const fromBound = bound ? ofKind(usesOf.get(bound.path), kind) : [];
      const fromSelf = ofKind(usesOf.get(src.path), kind);
      const queueKey = QUEUE_KEY[op.system];
      if (queueKey && nodes.has(queueKey)) target = queueKey;
      else if (fromBound.length === 1) target = fromBound[0];
      else if (fromSelf.length === 1) target = fromSelf[0];
      else {
        const only = allOfKind(kind);
        if (only.length === 1) {
          target = only[0]!.id;
          inferred = true;
        }
      }
      if (!target) continue;

      const channel =
        op.channel ?? (op.system === "bullmq" ? (local ?? boundClient)?.channel : undefined);
      const from = `file:${src.path}`;
      const ek = EDGE_OF[op.kind];
      const id = edgeId(from, ek, target);
      const what = [op.table ? `→ ${op.table}` : "", channel ? `→ ${channel}` : ""]
        .filter(Boolean)
        .join(" ");
      const ev: Evidence = {
        kind: inferred ? "inferred" : "verified",
        file: src.path,
        startLine: op.line,
        detail: `${op.call}${what ? ` ${what}` : ""}${op.fn ? ` in ${op.fn}` : ""}`,
      };
      const e = edges.get(id) ?? { id, from, to: target, kind: ek, evidence: [], meta: {} };
      if (
        e.evidence.length < 8 &&
        !e.evidence.some((x) => x.startLine === ev.startLine && x.detail === ev.detail)
      )
        e.evidence.push(ev);
      const meta = e.meta as {
        tables?: string[];
        channels?: string[];
        functions?: string[];
        systems?: string[];
        entities?: string[];
      };
      const add = (
        k: "tables" | "channels" | "functions" | "systems" | "entities",
        v: string | undefined,
      ): void => {
        if (!v) return;
        const list = meta[k] ?? [];
        if (!list.includes(v)) list.push(v);
        meta[k] = list.sort();
      };
      add("tables", op.table);
      if (op.table && target.startsWith("database:"))
        for (const ent of entitiesForTable(model, op.table, target)) add("entities", ent);
      add("channels", channel);
      add("functions", op.fn);
      add("systems", op.system);
      edges.set(id, e);
      done.add(`${op.line}:${op.kind}`);
      stats.linked++;
      if (inferred) stats.inferred++;
    }
  }
  return { edges: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), stats };
}

/** Add linked data-operation edges to a model (deterministic order). */
export function withDataOps(model: Model, res: DataOpsResult): Model {
  const ids = new Set(model.edges.map((e) => e.id));
  const edges = [...model.edges, ...res.edges.filter((e) => !ids.has(e.id))].sort((a, b) =>
    a.id < b.id ? -1 : 1,
  );
  return {
    ...model,
    edges,
    meta: {
      ...model.meta,
      stats: { ...(model.meta.stats ?? {}), edges: edges.length, dataOps: res.stats.linked },
    },
  };
}

export type { RawOp };
