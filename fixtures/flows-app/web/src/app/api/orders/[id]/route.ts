import { db } from "@/lib/db";
export async function DELETE() {
  await db.query("delete from orders");
  return new Response(null, { status: 204 });
}
