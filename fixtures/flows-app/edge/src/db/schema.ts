import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  plan: text("plan"),
});

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").references(() => accounts.id),
});
