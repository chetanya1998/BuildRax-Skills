import { createOrder } from "./orders.js";
import Stripe from "stripe";

export function charge() {
  return [createOrder, Stripe];
}
