import { Router } from "express";
import { auth } from "../../../../lib/auth.js";
import { toNodeHandler } from "better-auth/node";
import { AuthController } from "./auth.controller.js";
import { requireAuth } from "./auth.middleware.js";

const router = Router();

// Better Auth API routes (sign-in, sign-up, magic-link, etc.)
router.all("/api/auth/*", (req, res) => {
  return toNodeHandler(auth)(req, res);
});

// Admin endpoints for user permission management
router.get("/api/users", requireAuth, (req: any, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Only admins can perform this action." });
  }
  return AuthController.listUsers(req, res);
});

router.post("/api/users/toggle-access", requireAuth, (req: any, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Only admins can perform this action." });
  }
  return AuthController.toggleAccess(req, res);
});

router.post("/api/users/change-role", requireAuth, (req: any, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Only admins can perform this action." });
  }
  return AuthController.changeRole(req, res);
});

router.post("/api/users/update-quota", requireAuth, (req: any, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Only admins can perform this action." });
  }
  return AuthController.updateQuota(req, res);
});

router.post("/api/users/toggle-block", requireAuth, (req: any, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Only admins can perform this action." });
  }
  return AuthController.toggleBlock(req, res);
});

router.post("/api/users/reset-quota", requireAuth, (req: any, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Only admins can perform this action." });
  }
  return AuthController.resetQuota(req, res);
});

router.get("/api/admin/telemetry", requireAuth, (req: any, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ success: false, error: "Only admins can perform this action." });
  }
  return AuthController.getTelemetry(req, res);
});

export default router;
