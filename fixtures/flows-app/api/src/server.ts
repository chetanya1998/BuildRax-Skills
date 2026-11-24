import express from "express";
import ordersRouter from "./routes/orders";
import { health } from "./routes/health";

const app = express();
app.use(express.json());
app.use("/api/orders", ordersRouter);
app.get("/health", health);
const settings = new Map<string, string>();
settings.get("not-a-route");
app.get("env");
app.listen(3000);
