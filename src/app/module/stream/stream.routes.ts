import express, { Router } from "express";
import { StreamController } from "./stream.controller.js";
import { requireAuth, requireAccess } from "../auth/auth.middleware.js";

const router = Router();

// Create stream (requires auth and stream access permission)
router.post("/api/stream", requireAuth, requireAccess, StreamController.createStream);

// Delete stream (requires auth)
router.delete("/api/stream/:id", requireAuth, StreamController.deleteStream);



// MediaMTX external authentication endpoint (public, validated internally)
router.post("/api/stream/auth", StreamController.mediaMtxAuth);

// OBS ingest details and preview transcode pipeline
router.get("/api/stream/:key/ingest", requireAuth, requireAccess, StreamController.getIngestDetails);
router.post("/api/stream/:key/transcoder/start", requireAuth, requireAccess, StreamController.startTranscoder);
router.get("/api/stream/:key/transcoder/status", requireAuth, requireAccess, StreamController.getTranscoderStatus);
router.get("/api/stream/:key/playback/status", StreamController.getPublicPlaybackStatus);

// Stream control endpoints (require auth)
router.post("/api/stream/:key/golive", requireAuth, requireAccess, StreamController.goLive);
router.post(
  "/api/stream/:key/video",
  requireAuth,
  express.raw({
    type: "*/*",
    limit: "50mb"
  }),
  StreamController.receiveVideo
);
router.post("/api/stream/:key/stop", requireAuth, StreamController.stopLive);
router.post("/api/stream/:key/settings", requireAuth, StreamController.updateSettings);

export default router;
