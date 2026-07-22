import Database from "better-sqlite3";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import fs from "fs";

const projectRoot = path.resolve(__dirname, "../../../../");
const rawDbPath = process.env.DATABASE_URL || "data/sqlite.db";
const dbPath = path.isAbsolute(rawDbPath) ? rawDbPath : path.resolve(projectRoot, rawDbPath);

try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
} catch (_) {}

console.log("[Migration] Running migration on SQLite database:", dbPath);
const sqlite = new Database(dbPath);

try {
  console.log("[Migration] Ensuring all schema tables exist...");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL,
      "email" TEXT NOT NULL UNIQUE,
      "emailVerified" INTEGER NOT NULL,
      "image" TEXT,
      "createdAt" INTEGER NOT NULL,
      "updatedAt" INTEGER NOT NULL,
      "role" TEXT DEFAULT 'user' NOT NULL,
      "hasAccess" INTEGER DEFAULT 0 NOT NULL,
      "maxAllowedStreams" INTEGER DEFAULT 30 NOT NULL,
      "isBlockedFromStreaming" INTEGER DEFAULT 0 NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "session" (
      "id" TEXT PRIMARY KEY,
      "expiresAt" INTEGER NOT NULL,
      "token" TEXT NOT NULL UNIQUE,
      "createdAt" INTEGER NOT NULL,
      "updatedAt" INTEGER NOT NULL,
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "account" (
      "id" TEXT PRIMARY KEY,
      "accountId" TEXT NOT NULL,
      "providerId" TEXT NOT NULL,
      "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "accessToken" TEXT,
      "refreshToken" TEXT,
      "idToken" TEXT,
      "accessTokenExpiresAt" INTEGER,
      "refreshTokenExpiresAt" INTEGER,
      "scope" TEXT,
      "password" TEXT,
      "createdAt" INTEGER NOT NULL,
      "updatedAt" INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "verification" (
      "id" TEXT PRIMARY KEY,
      "identifier" TEXT NOT NULL,
      "value" TEXT NOT NULL,
      "expiresAt" INTEGER NOT NULL,
      "createdAt" INTEGER,
      "updatedAt" INTEGER
    );

    CREATE TABLE IF NOT EXISTS "stream" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "title" TEXT NOT NULL,
      "streamKey" TEXT NOT NULL UNIQUE,
      "isActive" INTEGER DEFAULT 0 NOT NULL,
      "isLive" INTEGER DEFAULT 0 NOT NULL,
      "isRaw" INTEGER DEFAULT 0 NOT NULL,
      "resolutions" TEXT DEFAULT '480p,1080p' NOT NULL,
      "createdAt" INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "stream_log" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "streamKey" TEXT NOT NULL,
      "message" TEXT NOT NULL,
      "level" TEXT DEFAULT 'info' NOT NULL,
      "timestamp" INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "stream_telemetry" (
      "id" TEXT PRIMARY KEY,
      "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
      "streamKey" TEXT NOT NULL,
      "startTime" INTEGER NOT NULL,
      "endTime" INTEGER,
      "durationSeconds" INTEGER DEFAULT 0 NOT NULL,
      "countedTowardsQuota" INTEGER DEFAULT 0 NOT NULL,
      "createdAt" INTEGER NOT NULL
    );
  `);

  // Add columns if migrating from an older schema version
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

  console.log("[Migration] Migration completed successfully!");
} catch (err: any) {
  console.error("[Migration] Migration error:", err.message);
  process.exit(1);
}
