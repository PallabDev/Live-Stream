import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { db } from "../src/app/common/database/db.js";
import * as schema from "../src/app/common/database/schema.js";
import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema: schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
      },
      hasAccess: {
        type: "boolean",
        defaultValue: false,
      },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        try {
          await resend.emails.send({
            from: process.env.RESEND_FROM || "CoWatch <no-reply@luqe.in>",
            to: email,
            subject: "Sign in to CoWatch",
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff; color: #1a202c;">
                <h2 style="color: #4f46e5; text-align: center;">Welcome to CoWatch</h2>
                <p>Hello,</p>
                <p>We received a request to sign in to your CoWatch account. Click the button below to log in instantly:</p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${url}" style="background-color: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Sign In to CoWatch</a>
                </div>
                <p style="font-size: 14px; color: #718096;">If the button above doesn't work, you can copy and paste this link into your browser:</p>
                <p style="font-size: 14px; color: #4f46e5; word-break: break-all;">${url}</p>
                <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0;" />
                <p style="font-size: 12px; color: #a0aec0; text-align: center;">If you did not request this login link, you can safely ignore this email.</p>
              </div>
            `,
          });
        } catch (error) {
          console.error("Failed to send magic link email:", error);
          throw new Error("Could not send magic link email.");
        }
      },
    }),
  ],
});
