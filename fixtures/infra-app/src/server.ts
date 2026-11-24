import express from "express";
import { pool } from "./db.js";
import { cache } from "./cache.js";
import { charge } from "./billing.js";
import { upload } from "./upload.js";

export const app = express();
export const deps = { pool, cache, charge, upload };
