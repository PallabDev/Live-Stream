import { db } from "./db.js";
import { stream } from "./schema.js";

async function run() {
  console.log("[Test-DB] Querying database streams...");
  const allStreams = await db.select().from(stream);
  console.log("[Test-DB] Streams found:");
  for (const s of allStreams) {
    console.log(`- ID: ${s.id} | Key: ${s.streamKey} | Title: ${s.title} | isLive: ${s.isLive} | isRaw: ${s.isRaw}`);
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error("[Test-DB] Error querying db:", err);
  process.exit(1);
});
