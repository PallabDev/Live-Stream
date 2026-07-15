import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/app/common/database/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "sqlite.db",
  },
});
