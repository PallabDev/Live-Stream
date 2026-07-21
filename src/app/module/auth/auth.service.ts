import { db } from "../../common/database/db.js";
import { user, streamTelemetry } from "../../common/database/schema.js";
import { eq, and, count } from "drizzle-orm";

export class AuthService {
  static async getUserById(id: string) {
    const users = await db.select().from(user).where(eq(user.id, id)).limit(1);
    return users[0] || null;
  }

  static async updateUserAccess(id: string, hasAccess: boolean) {
    return await db.update(user).set({ hasAccess }).where(eq(user.id, id));
  }

  static async updateUserRole(id: string, role: "admin" | "user") {
    return await db.update(user).set({ role }).where(eq(user.id, id));
  }

  static async updateUserQuota(id: string, maxAllowedStreams: number) {
    return await db.update(user).set({ maxAllowedStreams }).where(eq(user.id, id));
  }

  static async toggleUserBlock(id: string, isBlockedFromStreaming: boolean) {
    return await db.update(user).set({ isBlockedFromStreaming }).where(eq(user.id, id));
  }

  static async getAllUsersWithStats() {
    const usersList = await db.select().from(user);
    
    // Attach counted stream sessions per user
    const usersWithStats = await Promise.all(
      usersList.map(async (u) => {
        const counted = await db
          .select({ value: count() })
          .from(streamTelemetry)
          .where(and(eq(streamTelemetry.userId, u.id), eq(streamTelemetry.countedTowardsQuota, true)));
        
        const total = await db
          .select({ value: count() })
          .from(streamTelemetry)
          .where(eq(streamTelemetry.userId, u.id));

        return {
          ...u,
          usedCount: counted[0]?.value || 0,
          totalSessions: total[0]?.value || 0,
        };
      })
    );

    return usersWithStats;
  }
}
