import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { validateModel, type Model } from "@buildrax/ir";
import { entityKey, parseFile, prismaEntities, scan } from "../src/index.js";

describe("data models in source", () => {
  it("reads Prisma models, relations, @id and @@map", () => {
    const e = prismaEntities(
      [
        "model User {",
        "  id    Int    @id",
        "  posts Post[] // many",
        "}",
        "model Post {",
        "  id     Int  @id",
        "  author User @relation(fields: [authorId], references: [id])",
        "  authorId Int",
        '  @@map("blog_posts")',
        "}",
      ].join("\n"),
    );
    expect(e.map((x) => [x.name, x.table, x.line])).toEqual([
      ["User", undefined, 1],
      ["Post", "blog_posts", 5],
    ]);
    expect(e[0]!.relations).toEqual([
      { field: "posts", target: "Post", targetIs: "model", many: true, line: 3 },
    ]);
    expect(e[1]!.fields.map((f) => [f.name, !!f.pk])).toEqual([
      ["id", true],
      ["authorId", false],
    ]);
  });

  it("reads TypeORM entities and Drizzle tables, and ignores plain classes", async () => {
    const src = [
      'import { Entity, Column, ManyToOne, PrimaryColumn } from "typeorm";',
      'import { pgTable, serial, integer } from "drizzle-orm/pg-core";',
      '@Entity("orders")',
      "export class Order {",
      "  @PrimaryColumn() id: string;",
      "  @Column() total: number;",
      "  @ManyToOne(() => Customer) customer: Customer;",
      "}",
      "class NotAnEntity { @Column() x: number; }",
      'export const items = pgTable("items", { id: serial("id").primaryKey(), orderId: integer("order_id").references(() => orders.id) });',
    ].join("\n");
    const { facts } = await parseFile(src, "typescript");
    const ents = facts.entities ?? [];
    expect(ents.map((e) => [e.orm, e.name, e.table])).toEqual([
      ["typeorm", "Order", "orders"],
      ["drizzle", "items", "items"],
    ]);
    expect(ents[0]!.fields.map((f) => f.name)).toEqual(["id", "total"]);
    expect(ents[0]!.relations[0]).toMatchObject({
      field: "customer",
      target: "Customer",
      many: false,
    });
    expect(ents[1]!.relations[0]).toMatchObject({
      field: "orderId",
      target: "orders",
      targetIs: "variable",
    });
  });

  it("reads Django and SQLAlchemy models but not other classes", async () => {
    const src = [
      "from django.db import models",
      "class Tag(models.Model):",
      "    label = models.CharField(max_length=9)",
      "    parent = models.ForeignKey('self', on_delete=models.CASCADE)",
      "class Row(Base):",
      "    __tablename__ = 'rows'",
      "    id = Column(Integer, primary_key=True)",
      "    tag_id = Column(Integer, ForeignKey('tags.id'))",
      "class Service(Base):",
      "    def run(self): pass",
    ].join("\n");
    const ents = (await parseFile(src, "python")).facts.entities ?? [];
    expect(ents.map((e) => [e.orm, e.name, e.table])).toEqual([
      ["django", "Tag", undefined],
      ["sqlalchemy", "Row", "rows"],
    ]);
    expect(ents[0]!.relations[0]).toMatchObject({ field: "parent", target: "Tag" });
    expect(ents[1]!.relations[0]).toMatchObject({
      field: "tag_id",
      target: "tags",
      targetIs: "table",
    });
  });

  it("normalises names for matching", () => {
    expect(
      ["orders", "Order", "order_items", "OrderItem", "categories", "addresses", "status"].map(
        entityKey,
      ),
    ).toEqual(["order", "order", "orderitem", "orderitem", "category", "address", "status"]);
  });
});

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/flows-app",
);
let model: Model;
beforeAll(async () => {
  model = await scan(FIXTURE, { now: "2026-11-28T00:00:00.000Z" });
});

describe("entities in the model", () => {
  it("writes valid v3 entity nodes under the database, with evidence", () => {
    expect(model.schemaVersion).toBe("buildrax-ir/v3");
    expect(validateModel(model)).toMatchObject({ ok: true });
    const ents = model.nodes.filter((n) => n.kind === "entity");
    expect(ents.map((n) => n.id)).toEqual([
      "entity:edge/src/db/schema.ts:accounts",
      "entity:edge/src/db/schema.ts:invoices",
      "entity:flask/shop/models.py:Product",
      "entity:flask/shop/models.py:Review",
      "entity:nest/src/entities/user.entity.ts:Post",
      "entity:nest/src/entities/user.entity.ts:User",
      "entity:py/app/models.py:Item",
      "entity:web/prisma/schema.prisma:Customer",
      "entity:web/prisma/schema.prisma:Order",
    ]);
    for (const n of ents) {
      expect(n.parent).toBe("database:postgres");
      expect(n.evidence[0]).toMatchObject({ kind: "verified", file: n.path });
    }
    expect(model.meta.stats?.["entities"]).toBe(9);
  });

  it("links relations both ways where declared, and only to entities that exist", () => {
    const rel = model.edges
      .filter((e) => e.kind === "relates")
      .map(
        (e) =>
          `${e.from.split(":").pop()} -> ${e.to.split(":").pop()}${e.meta?.["many"] ? " (many)" : ""}`,
      );
    expect(rel).toEqual([
      "invoices -> accounts",
      "Review -> Product",
      "Post -> User",
      "User -> Post (many)",
      "Customer -> Order (many)",
      "Order -> Customer",
    ]);
  });

  it("names the entities that data operations touch", () => {
    const touched = model.edges
      .filter((e) => (e.meta?.["entities"] as string[] | undefined)?.length)
      .map((e) => `${e.from} ${e.kind} ${(e.meta!["entities"] as string[]).join(",")}`);
    expect(touched).toContain(
      "file:web/src/app/api/orders/route.ts writes entity:web/prisma/schema.prisma:Order",
    );
    expect(touched).toContain("file:py/app/routers/items.py reads entity:py/app/models.py:Item");
  });
});
