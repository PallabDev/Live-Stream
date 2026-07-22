import { auth } from "../../../../lib/auth.js";
import { db } from "./db.js";
import { user } from "./schema.js";
import { eq } from "drizzle-orm";

async function main() {
  const email = "watch@pallabdev.in";
  
  console.log(`[Seed-Admin] Checking for existing user: ${email}...`);
  const existingUsers = await db.select().from(user).where(eq(user.email, email)).limit(1);
  
  if (existingUsers.length > 0) {
    const existing = existingUsers[0];
    if (existing.role === "admin" && existing.hasAccess) {
      console.log(`[Seed-Admin] Admin user ${email} already exists and is active.`);
      process.exit(0);
    }
    console.log(`[Seed-Admin] Found existing non-admin user with ID: ${existing.id}. Deleting to re-create admin...`);
    await db.delete(user).where(eq(user.id, existing.id));
    console.log(`[Seed-Admin] Existing user deleted.`);
  }

  console.log(`[Seed-Admin] Creating new account for ${email} using Better-Auth API...`);
  
  // Use Better-Auth's native API to sign up the email, ensuring correct password hashing
  const signupResult = await auth.api.signUpEmail({
    body: {
      email: email,
      password: "Watch12345",
      name: "Pallab Admin",
    }
  });

  if (!signupResult || !signupResult.user) {
    throw new Error("Better-Auth registration failed.");
  }

  const newUserId = signupResult.user.id;
  console.log(`[Seed-Admin] Account created with ID: ${newUserId}. Promoting to admin...`);

  // Promote to admin and verify access
  await db.update(user)
    .set({
      role: "admin",
      hasAccess: true,
      emailVerified: true
    })
    .where(eq(user.id, newUserId));

  console.log(`[Seed-Admin] Success! User ${email} has been created with password "Watch12345" and promoted to Admin.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[Seed-Admin] Fatal error:", err);
  process.exit(1);
});
