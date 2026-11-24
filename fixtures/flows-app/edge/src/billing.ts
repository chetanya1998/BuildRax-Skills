import type { FastifyInstance } from "fastify";
export async function billing(fastify: FastifyInstance) {
  fastify.post("/invoices", async () => ({}));
}
