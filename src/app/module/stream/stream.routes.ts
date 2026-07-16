import { Router } from "express";
import { StreamController } from "./stream.controller.js";
import { requireAuth, requireAccess } from "../auth/auth.middleware.js";

const router = Router();

// Create stream (requires auth and stream access permission)
router.post("/api/stream", requireAuth, requireAccess, StreamController.createStream);

// Delete stream (requires auth)
router.delete("/api/stream/:id", requireAuth, StreamController.deleteStream);



// MediaMTX external authentication endpoint (public, validated internally)
router.post("/api/stream/auth", StreamController.mediaMtxAuth);

// Stream control endpoints (require auth)
router.post("/api/stream/:key/golive", requireAuth, StreamController.goLive);
router.post("/api/stream/:key/stop", requireAuth, StreamController.stopLive);
router.post("/api/stream/:key/settings", requireAuth, StreamController.updateSettings);

export default router;
