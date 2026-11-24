import Fastify from "fastify";
import { billing } from "./billing";
const server = Fastify();
server.register(billing, { prefix: "/billing" });
