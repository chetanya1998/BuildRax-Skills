import { Worker } from "bullmq";
import { db } from "@/lib/db";

// Not data operations: a Map and an array.
const seen = new Map<string, boolean>();
const recent: string[] = [];

new Worker("emails", async (job) => {
  if (seen.get(job.id ?? "")) return;
  seen.set(job.id ?? "", true);
  recent.find((x) => x === job.name);
  await db.query("update orders set emailed = true where id = $1", [job.data.id]);
});
