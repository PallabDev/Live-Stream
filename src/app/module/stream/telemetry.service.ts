import { db } from "../../common/database/db.js";
import { user, streamTelemetry } from "../../common/database/schema.js";
import { eq, and, count } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

export class TelemetryService {
  /**
   * Check if a user is eligible to start a live broadcast based on quotas and block status.
   */
  static async canUserStartStream(userId: string) {
    const users = await db.select().from(user).where(eq(user.id, userId)).limit(1);
    const currentUser = users[0];

    if (!currentUser) {
      return { allowed: false, reason: "User not found." };
    }

    if (currentUser.isBlockedFromStreaming) {
      return { 
        allowed: false, 
        reason: "Your account has been blocked from broadcasting live streams by an administrator." 
      };
    }

    // Admins have unlimited streams
    if (currentUser.role === "admin") {
      return { allowed: true, currentUser };
    }

    // Count streams that reached the 1.5-hour (5400s) threshold
    const countedResult = await db
      .select({ value: count() })
      .from(streamTelemetry)
      .where(and(eq(streamTelemetry.userId, userId), eq(streamTelemetry.countedTowardsQuota, true)));

    const usedCount = countedResult[0]?.value || 0;

    if (usedCount >= currentUser.maxAllowedStreams) {
      return {
        allowed: false,
        reason: `Streaming quota reached (${usedCount}/${currentUser.maxAllowedStreams} counted live streams used). Contact an administrator to request a limit increase.`,
      };
    }

    return { allowed: true, currentUser, usedCount };
  }

  /**
   * Record the start of a stream session in telemetry logs.
   */
  static async startSession(userId: string, streamKey: string) {
    const id = uuidv4();
    const now = new Date();

    await db.insert(streamTelemetry).values({
      id,
      userId,
      streamKey,
      startTime: now,
      durationSeconds: 0,
      countedTowardsQuota: false,
      createdAt: now,
    });

    return id;
  }

  /**
   * Record the termination of a stream session, calculating duration and quota eligibility.
   * Only sessions >= 1.5 hours (5400 seconds) count towards the 30-stream limit.
   */
  static async endSession(telemetryId: string) {
    if (!telemetryId) return;

    const existing = await db
      .select()
      .from(streamTelemetry)
      .where(eq(streamTelemetry.id, telemetryId))
      .limit(1);

    const sessionRecord = existing[0];
    if (!sessionRecord || sessionRecord.endTime) return; // Already ended

    const endTime = new Date();
    const durationSeconds = Math.max(0, Math.floor((endTime.getTime() - sessionRecord.startTime.getTime()) / 1000));
    
    // Threshold: >= 1.5 hours (5400 seconds)
    const countedTowardsQuota = durationSeconds >= 5400;

    await db
      .update(streamTelemetry)
      .set({
        endTime,
        durationSeconds,
        countedTowardsQuota,
      })
      .where(eq(streamTelemetry.id, telemetryId));

    console.log(
      `[Telemetry] Session ${telemetryId} ended. Duration: ${durationSeconds}s (${(durationSeconds / 60).toFixed(
        1
      )}m). Counted towards 30-stream quota: ${countedTowardsQuota}`
    );
  }

  /**
   * Get all telemetry logs for admin inspector.
   */
  static async getAdminTelemetryLogs() {
    return await db
      .select({
        id: streamTelemetry.id,
        userId: streamTelemetry.userId,
        userName: user.name,
        userEmail: user.email,
        streamKey: streamTelemetry.streamKey,
        startTime: streamTelemetry.startTime,
        endTime: streamTelemetry.endTime,
        durationSeconds: streamTelemetry.durationSeconds,
        countedTowardsQuota: streamTelemetry.countedTowardsQuota,
      })
      .from(streamTelemetry)
      .innerJoin(user, eq(streamTelemetry.userId, user.id));
  }

  /**
   * Get usage stats per user.
   */
  static async getUserUsageStats(userId: string) {
    const countedResult = await db
      .select({ value: count() })
      .from(streamTelemetry)
      .where(and(eq(streamTelemetry.userId, userId), eq(streamTelemetry.countedTowardsQuota, true)));

    const totalSessions = await db
      .select({ value: count() })
      .from(streamTelemetry)
      .where(eq(streamTelemetry.userId, userId));

    return {
      countedStreams: countedResult[0]?.value || 0,
      totalSessions: totalSessions[0]?.value || 0,
    };
  }

  /**
   * Reset quota usage for a user.
   */
  static async resetUserQuota(userId: string) {
    await db
      .update(streamTelemetry)
      .set({ countedTowardsQuota: false })
      .where(eq(streamTelemetry.userId, userId));
  }
}
