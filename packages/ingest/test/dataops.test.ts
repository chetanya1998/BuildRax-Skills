import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Model } from "@buildrax/ir";
import { classifySql, parseFile, scan } from "../src/index.js";

const ops = async (src: string, lang: "typescript" | "python" = "typescript") =>
  ((await parseFile(src, lang)).facts.ops ?? []).map((o) =>
    `${o.kind} ${o.system} ${o.table ?? ""}${o.channel ? `#${o.channel}` : ""}`.trim(),
  );

describe("SQL classification", () => {
  it("reads and writes, with the table", () => {
    expect(classifySql("SELECT * FROM public.orders WHERE id = $1")).toEqual({
      kind: "read",
      table: "orders",
    });
    expect(classifySql("  -- note\n insert into orders (a) values (1)")).toEqual({
      kind: "write",
      table: "orders",
    });
    expect(classifySql('UPDATE "users" SET x = 1')).toEqual({ kind: "write", table: "users" });
    expect(classifySql("with t as (select 1) select * from t")?.kind).toBe("read");
    expect(classifySql("hello world")).toBeUndefined();
  });
});

describe("candidate operations in source", () => {
  it("Prisma, SQL clients, sql`` tags, Drizzle, Supabase, TypeORM, Mongo collections", async () => {
    expect(
      await ops(`
        await prisma.order.findMany();
        await this.prisma.user.create({ data });
        await db.query("delete from carts where id = $1");
        await sql\`select * from invoices where id = \${id}\`;
        await db.select().from(orders);
        await db.insert(payments).values(p);
        await supabase.from("profiles").select("*");
        await supabase.from("profiles").upsert(p);
        await dataSource.getRepository(Order).save(o);
        await client.db().collection("events").insertOne(e);`),
    ).toEqual([
      "read prisma order",
      "write prisma user",
      "write sql carts",
      "read sql invoices",
      "read drizzle orders",
      "write drizzle payments",
      "write typeorm", // same call shape as TypeORM's repo.insert(): resolved by proof when linking
      "read supabase profiles",
      "write supabase profiles",
      "write typeorm Order",
      "write mongo events",
    ]);
  });

  it("queues: BullMQ, Kafka, SQS, RabbitMQ", async () => {
    expect(
      await ops(`
        const q = new Queue("emails");
        await q.add("welcome", data);
        new Worker("emails", handler);
        await producer.send({ topic: "orders", messages });
        await consumer.subscribe({ topic: "orders" });
        await sqs.send(new SendMessageCommand({ QueueUrl: "https://sqs.eu-west-1.amazonaws.com/1/jobs", MessageBody: b }));
        ch.sendToQueue("tasks", buf);
        ch.consume("tasks", fn);`),
    ).toEqual([
      "publish bullmq",
      "consume bullmq #emails",
      "publish kafka #orders",
      "consume kafka #orders",
      "publish sqs #jobs",
      "publish rabbitmq #tasks",
      "consume rabbitmq #tasks",
    ]);
  });

  it("Python: Django ORM, SQLAlchemy, raw SQL, Celery, Kafka, pika, redis", async () => {
    expect(
      await ops(
        `
Order.objects.filter(paid=True)
Order.objects.create(total=1)
session.query(Item).all()
db.session.add(item)
cursor.execute("UPDATE stock SET n = n - 1")
send_receipt.delay(1)
producer.send("audit", b"x")
channel.basic_publish(exchange="", routing_key="jobs", body=b)
r.get("k")
`,
        "python",
      ),
    ).toEqual([
      "read django Order",
      "write django Order",
      "read sqlalchemy Item",
      "write sqlalchemy",
      "write sql stock",
      "publish celery #send_receipt",
      "publish kafka #audit",
      "publish rabbitmq #jobs",
      "read redis k",
    ]);
  });

  it("records the enclosing function", async () => {
    const f = (
      await parseFile(
        `class Repo { async save(o) { await prisma.order.create(o); } }\nexport async function GET() { await db.query("select 1 from t"); }`,
        "typescript",
      )
    ).facts.ops!;
    expect(f.map((o) => o.fn)).toEqual(["Repo.save", "GET"]);
  });
});

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/flows-app",
);
let model: Model;
let tmp: string;
beforeAll(async () => {
  model = await scan(FIXTURE, { now: "2026-11-28T00:00:00.000Z" });
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "buildrax-ops-"));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});
const dataEdges = (m: Model) =>
  m.edges
    .filter((e) => ["reads", "writes", "publishes", "consumes"].includes(e.kind))
    .map((e) => `${e.from.slice(5)} ${e.kind} ${e.to}`);

describe("linking with proof", () => {
  it("links the fixture's operations to the right database, cache and queue", () => {
    expect(dataEdges(model)).toEqual([
      "py/app/routers/items.py publishes queue:celery",
      "py/app/routers/items.py reads database:postgres",
      "py/app/routers/items.py writes database:postgres",
      "py/app/tasks.py consumes queue:celery",
      "web/src/app/api/orders/[id]/route.ts writes database:postgres",
      "web/src/app/api/orders/route.ts publishes queue:bullmq",
      "web/src/app/api/orders/route.ts reads cache:redis",
      "web/src/app/api/orders/route.ts reads database:postgres",
      "web/src/app/api/orders/route.ts writes cache:redis",
      "web/src/app/api/orders/route.ts writes database:postgres",
      "web/src/worker/emails.ts consumes queue:bullmq",
      "web/src/worker/emails.ts writes database:postgres",
    ]);
  });

  it("carries tables, queue names and functions, with file:line evidence", () => {
    const pub = model.edges.find(
      (e) => e.id === "file:web/src/app/api/orders/route.ts->publishes->queue:bullmq",
    )!;
    expect(pub.meta).toMatchObject({
      channels: ["emails"],
      functions: ["POST"],
      systems: ["bullmq"],
    });
    expect(pub.evidence[0]).toMatchObject({
      kind: "verified",
      file: "web/src/app/api/orders/route.ts",
      startLine: 14,
    });
    // Only one database in the project and no client named in the file: said to be inferred.
    const py = model.edges.find(
      (e) => e.id === "file:py/app/routers/items.py->reads->database:postgres",
    )!;
    expect(py.evidence[0]?.kind).toBe("inferred");
  });

  it("never turns Map#get/set or Array#find into data operations", () => {
    const worker = model.edges.filter((e) => e.from === "file:web/src/worker/emails.ts");
    expect(worker.some((e) => e.to === "cache:redis")).toBe(false);
    expect(worker.find((e) => e.kind === "writes")?.evidence).toHaveLength(1);
  });

  it("needs proof: a generic .get() on an unknown object is dropped", async () => {
    const dir = path.join(tmp, "noproof");
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { ioredis: "5" } }),
    );
    await fs.writeFile(
      path.join(dir, "src/cache.ts"),
      'import Redis from "ioredis";\nexport const redis = new Redis();\n',
    );
    await fs.writeFile(
      path.join(dir, "src/a.ts"),
      'import { redis } from "./cache";\nconst store = new Map();\nstore.get("x");\nredis.get("y");\n',
    );
    const m = await scan(dir, { now: "2026-11-28T00:00:00.000Z" });
    expect(dataEdges(m)).toEqual(["src/a.ts reads cache:redis"]);
    const e = m.edges.find((x) => x.kind === "reads")!;
    expect(e.evidence.map((v) => v.startLine)).toEqual([4]);
  });
});
