import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

const dbPath = process.env.DATABASE_URL || "sqlite.db";
const sqlite = new Database(dbPath);

export const db = drizzle(sqlite, { schema });
export type DbType = typeof db;
