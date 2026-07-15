import { Router } from "express";
import { StreamController } from "./stream.controller.js";
import { requireAuth, requireAccess } from "../auth/auth.middleware.js";

const router = Router();

// Create stream (requires auth and stream access permission)
router.post("/api/stream", requireAuth, requireAccess, StreamController.createStream);

// Delete stream (requires auth)
router.delete("/api/stream/:id", requireAuth, StreamController.deleteStream);

// Bandwidth test endpoint (requires auth)
router.post("/api/stream/speedtest", requireAuth, StreamController.speedTest);

export default router;
