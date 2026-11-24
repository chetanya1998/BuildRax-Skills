import { Hono } from "hono";
const users = new Hono();
users.get("/:id", (c) => c.json({}));
const app = new Hono();
app.route("/users", users);
export default app;
