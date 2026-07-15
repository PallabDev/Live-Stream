import { db } from "../../common/database/db.js";
import { user } from "../../common/database/schema.js";
import { eq } from "drizzle-orm";

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

  static async getAllUsers() {
    return await db.select().from(user);
  }
}
