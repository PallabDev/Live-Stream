import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient({
  baseURL: process.env.BETTER_AUTH_URL || (typeof window !== "undefined" ? window.location.origin : undefined),
});
