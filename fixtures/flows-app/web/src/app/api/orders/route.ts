import { db } from "@/lib/db";
export async function GET() {
  return Response.json(await db.query("select * from orders"));
}
export const POST = async (req: Request) => Response.json(await req.json());
