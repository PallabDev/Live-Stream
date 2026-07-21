import Database from "better-sqlite3";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../../../");
const rawDbPath = process.env.DATABASE_URL || "sqlite.db";
const dbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(projectRoot, rawDbPath);

console.log("[Migration] Running migration on SQLite database:", dbPath);
const sqlite = new Database(dbPath);

try {
  // Add maxAllowedStreams if not exists
  const columns = sqlite.pragma("table_info(user)") as any[];
  const hasMaxAllowedStreams = columns.some(c => c.name === "maxAllowedStreams");
  const hasIsBlocked = columns.some(c => c.name === "isBlockedFromStreaming");

  if (!hasMaxAllowedStreams) {
    console.log("[Migration] Adding maxAllowedStreams column to user table...");
    sqlite.exec("ALTER TABLE user ADD COLUMN maxAllowedStreams INTEGER NOT NULL DEFAULT 30;");
  }

  if (!hasIsBlocked) {
    console.log("[Migration] Adding isBlockedFromStreaming column to user table...");
    sqlite.exec("ALTER TABLE user ADD COLUMN isBlockedFromStreaming INTEGER NOT NULL DEFAULT 0;");
  }

  // Create stream_telemetry table if not exists
  console.log("[Migration] Ensuring stream_telemetry table exists...");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS stream_telemetry (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      streamKey TEXT NOT NULL,
      startTime INTEGER NOT NULL,
      endTime INTEGER,
      durationSeconds INTEGER NOT NULL DEFAULT 0,
      countedTowardsQuota INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    );
  `);

  console.log("[Migration] Migration completed successfully!");
} catch (err: any) {
  console.error("[Migration] Migration error:", err.message);
  process.exit(1);
}
