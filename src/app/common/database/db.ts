import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, "../../../../");
const rawDbPath = process.env.DATABASE_URL || "sqlite.db";
const dbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(projectRoot, rawDbPath);

const sqlite = new Database(dbPath);

export const db = drizzle(sqlite, { schema });
export type DbType = typeof db;
