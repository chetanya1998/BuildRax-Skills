import express from "express";
import { readFileSync } from "node:fs";
import { Order } from "@sample/shared";
import { ordersRouter } from "./routes/orders.js";
import { missing } from "./missing.js";

export const app = express();
app.use("/orders", ordersRouter);
