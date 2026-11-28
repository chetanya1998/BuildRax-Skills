import { db } from "@/lib/db";
import { cache } from "@/lib/cache";
import { emails } from "@/lib/queue";
export async function GET() {
  const hit = await cache.get("orders:all");
  if (hit) return Response.json(JSON.parse(hit));
  const rows = await db.query("select * from orders");
  await cache.set("orders:all", JSON.stringify(rows));
  return Response.json(rows);
}
export const POST = async (req: Request) => {
  const order = await req.json();
  await db.query("insert into orders (data) values ($1)", [order]);
  await emails.add("order-created", order);
  return Response.json(order);
};
