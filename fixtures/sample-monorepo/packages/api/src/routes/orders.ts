import { createOrder } from "../services/orders.js";
import { charge } from "../services/billing.js";

export const ordersRouter = { createOrder, charge };
