import { db } from "../../common/database/db.js";
import { stream } from "../../common/database/schema.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

export class StreamService {
  static async createStream(userId: string, title: string) {
    const id = uuidv4();
    // Generate a secure stream key: live_ + 16 chars
    const streamKey = `live_${uuidv4().replace(/-/g, "").substring(0, 16)}`;
    
    await db.insert(stream).values({
      id,
      userId,
      title,
      streamKey,
      isActive: false,
      createdAt: new Date(),
    });

    return this.getStreamById(id);
  }

  static async getStreamById(id: string) {
    const results = await db.select().from(stream).where(eq(stream.id, id)).limit(1);
    return results[0] || null;
  }

  static async getStreamByKey(streamKey: string) {
    const results = await db.select().from(stream).where(eq(stream.streamKey, streamKey)).limit(1);
    return results[0] || null;
  }

  static async getStreamsByUser(userId: string) {
    return await db.select().from(stream).where(eq(stream.userId, userId));
  }

  static async deleteStream(userId: string, streamId: string, isAdmin: boolean = false) {
    if (isAdmin) {
      return await db.delete(stream).where(eq(stream.id, streamId));
    }
    return await db.delete(stream).where(and(eq(stream.id, streamId), eq(stream.userId, userId)));
  }

  static async setStreamActive(streamKey: string, isActive: boolean) {
    return await db.update(stream).set({ isActive }).where(eq(stream.streamKey, streamKey));
  }

  static async setStreamLive(streamKey: string, isLive: boolean) {
    return await db.update(stream).set({ isLive }).where(eq(stream.streamKey, streamKey));
  }

  static async updateStreamSettings(streamKey: string, isRaw: boolean, resolutions: string) {
    return await db.update(stream).set({ isRaw, resolutions }).where(eq(stream.streamKey, streamKey));
  }

  static async getAllActiveStreams() {
    return await db.select().from(stream).where(eq(stream.isActive, true));
  }

  static async resetRuntimeStatuses() {
    return await db.update(stream).set({ isActive: false, isLive: false });
  }
}
