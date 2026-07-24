import { Request, Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware.js";
import { StreamService } from "./stream.service.js";
import { createStreamDto } from "./stream.dto.js";
import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import { MonitorService } from "../../common/monitor/monitor.service.js";
import { TelemetryService } from "./telemetry.service.js";
import { TranscodeService } from "./transcode.service.js";
import { SFTPService } from "../../common/sftp/sftp.service.js";

interface StreamSession {
  streamKey: string;
  userId: string;
  telemetryId?: string;
  ws: WebSocket; // Broadcaster
  viewers: Map<string, WebSocket>; // viewerId -> WebSocket
  reportedEgressKbps?: number;
  reportedIngressKbps?: number;
}

export class StreamController {
  public static activeSessions = new Map<string, StreamSession>();
  public static waitingViewers = new Map<string, Set<WebSocket>>();

  private static getRequestHostname(req: Request): string {
    const forwardedHost = req.headers["x-forwarded-host"];
    const rawHost = Array.isArray(forwardedHost)
      ? forwardedHost[0]
      : forwardedHost || req.get("host") || req.hostname;
    return rawHost.split(",")[0].trim().replace(/:\d+$/, "");
  }

  private static getParamKey(req: Request): string {
    const raw = req.params.key || req.params.streamKey || req.params.id || "";
    return String(raw).trim();
  }

  private static async getOwnedStream(req: AuthenticatedRequest, keyParam: string) {
    const key = keyParam || StreamController.getParamKey(req);
    let streamInfo = await StreamService.getStreamByKey(key);
    if (!streamInfo) {
      streamInfo = await StreamService.getStreamById(key);
    }
    if (!streamInfo) {
      const error = new Error("Stream not found.");
      (error as any).statusCode = 404;
      throw error;
    }
    if (streamInfo.userId !== req.user.id && req.user.role !== "admin") {
      const error = new Error("Unauthorized.");
      (error as any).statusCode = 403;
      throw error;
    }
    return streamInfo;
  }

  public static broadcastStreamState(streamKey: string) {
    if (!streamKey) return;
    const session = StreamController.activeSessions.get(streamKey);
    const status = TranscodeService.getPipelineStatus(streamKey);
    const viewersCount = session ? session.viewers.size : 0;
    const payload = JSON.stringify({
      event: "telemetry",
      status: status.status,
      isReady: status.isReady,
      isLive: status.isReady,
      speed: status.speed,
      lastError: status.lastError,
      viewersCount,
      hlsUrl: status.previewUrl,
    });

    if (session && session.ws && session.ws.readyState === 1) {
      try { session.ws.send(payload); } catch (_) {}
    }

    if (session && session.viewers) {
      for (const vWs of session.viewers.values()) {
        if (vWs.readyState === 1) {
          try { vWs.send(payload); } catch (_) {}
        }
      }
    }

    const waiting = StreamController.waitingViewers.get(streamKey);
    if (waiting) {
      for (const wWs of waiting) {
        if (wWs.readyState === 1) {
          try { wWs.send(payload); } catch (_) {}
        }
      }
    }
  }

  private static notifyBroadcasterViewerCount(session: StreamSession) {
    if (session && session.ws && session.ws.readyState === 1) {
      try {
        session.ws.send(JSON.stringify({
          event: "viewer-count",
          count: session.viewers.size
        }));
      } catch (_) {}
    }
    this.broadcastStreamState(session.streamKey);
  }

  static async createStream(req: AuthenticatedRequest, res: Response) {
    try {
      const { error, value } = createStreamDto.validate(req.body);
      if (error) {
        return res.status(400).json({ success: false, error: error.details[0].message });
      }

      const stream = await StreamService.createStream(req.user.id, value.title);
      return res.status(201).json({ success: true, data: stream });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async deleteStream(req: AuthenticatedRequest, res: Response) {
    try {
      const id = StreamController.getParamKey(req);
      if (!id) {
        return res.status(400).json({ success: false, error: "Stream ID is required." });
      }

      const userId = req.user.id;
      const isAdmin = req.user.role === "admin";
      const streamInfo = await StreamService.getStreamById(id);
      if (streamInfo && (isAdmin || streamInfo.userId === userId)) {
        await TranscodeService.stopPipeline(streamInfo.streamKey);
      }

      await StreamService.deleteStream(userId, id, isAdmin);
      return res.json({ success: true, message: "Stream deleted successfully." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async mediaMtxAuth(req: Request, res: Response) {
    return res.sendStatus(200);
  }

  static async getIngestDetails(req: AuthenticatedRequest, res: Response) {
    try {
      const paramKey = StreamController.getParamKey(req);
      const streamInfo = await StreamController.getOwnedStream(req, paramKey);
      const hostname = StreamController.getRequestHostname(req);
      const ingest = TranscodeService.getIngestDetails(streamInfo.streamKey, hostname);

      return res.json({
        success: true,
        data: {
          stream: streamInfo,
          ingest,
        },
      });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  static async receiveVideo(req: Request, res: Response) {
    return res.status(400).json({ error: "HTTP chunk post ingestion is deprecated. Use RTMP/OBS." });
  }

  static async updateSettings(req: AuthenticatedRequest, res: Response) {
    try {
      const paramKey = StreamController.getParamKey(req);
      const streamInfo = await StreamService.getStreamByKey(paramKey);
      if (!streamInfo) {
        return res.status(404).json({ success: false, error: "Stream not found." });
      }
      return res.json({ success: true, message: "Stream settings updated." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async handleWebSocket(ws: WebSocket, key: string) {
    try {
      console.log(`[WS Signaling] Broadcaster connection opened for stream key: ${key}`);
      MonitorService.addLog(`[Signaling] Broadcaster connected for key: ${key}`);

      const streamInfo = await StreamService.getStreamByKey(key);
      if (!streamInfo) {
        console.warn(`[WS Signaling] Broadcaster rejected: stream key ${key} not found.`);
        ws.close(4004, "Stream key not found.");
        return;
      }

      const canStart = await TelemetryService.canUserStartStream(streamInfo.userId);
      if (!canStart.allowed) {
        console.warn(`[WS Signaling] Broadcaster rejected for ${key}: ${canStart.reason}`);
        ws.send(JSON.stringify({ event: "error", error: canStart.reason }));
        ws.close(4003, canStart.reason || "Quota limit reached or account blocked.");
        return;
      }

      let session = StreamController.activeSessions.get(key);

      if (session) {
        console.log(`[WS Signaling] Broadcaster reconnected for key: ${key}. Resuming existing session.`);
        MonitorService.addLog(`[Signaling] Broadcaster reconnected for key: ${key}. Resuming session.`);
        session.ws = ws;
      } else {
        const telemetryId = await TelemetryService.startSession(streamInfo.userId, key);
        session = {
          streamKey: key,
          userId: streamInfo.userId,
          telemetryId,
          ws,
          viewers: new Map(),
          reportedEgressKbps: 0,
          reportedIngressKbps: 0,
        };
        StreamController.activeSessions.set(key, session);
      }

      ws.on("message", (data: any, isBinary: boolean) => {
        if (isBinary) {
          if (session && session.viewers && session.viewers.size > 0) {
            for (const viewerWs of session.viewers.values()) {
              if (viewerWs.readyState === 1) {
                viewerWs.send(data, { binary: true });
              }
            }
          }
          return;
        }

        try {
          const message = data.toString("utf8");
          const msg = JSON.parse(message);
          const { event, viewerId } = msg;

          if (event === "rtc_telemetry") {
            if (session) {
              session.reportedEgressKbps = msg.egressKbps || 0;
              session.reportedIngressKbps = msg.ingressKbps || 0;
            }
            return;
          }

          if (viewerId) {
            const viewerWs = session!.viewers.get(viewerId);
            if (viewerWs && viewerWs.readyState === 1) {
              viewerWs.send(JSON.stringify(msg));
            }
          }
        } catch (err) {
          console.error(`[Broadcaster WS - ${key}] Message error:`, err);
        }
      });

      ws.on("close", () => {
        console.log(`[WS Signaling] Broadcaster disconnected: ${key}.`);
        MonitorService.addLog(`[Signaling] Broadcaster disconnected: ${key}.`);
        setTimeout(async () => {
          const currentSession = StreamController.activeSessions.get(key);
          if (currentSession && currentSession.ws === ws) {
            await StreamController.stopStreamSession(key);
          }
        }, 90000);
      });

      ws.on("error", (err: any) => {
        console.error(`[WS Signaling] Broadcaster error on key ${key}:`, err);
      });

      await StreamService.setStreamLive(key, true);
      this.broadcastStreamState(key);
    } catch (err) {
      console.error("[WS Broadcaster Upgrade Error]:", err);
      ws.close(1011, "Internal server error.");
    }
  }

  static handleViewerWebSocket(ws: WebSocket, key: string) {
    try {
      const viewerId = Math.random().toString(36).substring(2, 15);
      console.log(`[WS Signaling] Viewer ${viewerId} connecting for key: ${key}`);
      MonitorService.addLog(`[Signaling] Viewer ${viewerId} connected`);

      const session = StreamController.activeSessions.get(key);
      const status = TranscodeService.getPipelineStatus(key);

      if (session) {
        for (const [vId, vWs] of session.viewers.entries()) {
          if (vWs.readyState !== 1) {
            session.viewers.delete(vId);
          }
        }

        if (session.viewers.size >= 50) {
          ws.send(JSON.stringify({
            event: "status",
            status: "capacity_reached",
            message: "Stream is at maximum capacity (50 viewers max allowed)."
          }));
          try { ws.close(1008, "Capacity reached"); } catch (_) {}
          return;
        }

        session.viewers.set(viewerId, ws);
        StreamController.setupViewerSocket(ws, viewerId, key);
        ws.send(JSON.stringify({
          event: "status",
          status: "live",
          viewerId,
          hlsUrl: status.previewUrl,
        }));
      } else {
        const cdnUrl = SFTPService.getPublicCdnUrl(key);
        ws.send(JSON.stringify({
          event: "status",
          status: status.isReady ? "live" : "offline",
          viewerId,
          hlsUrl: cdnUrl,
        }));

        if (!StreamController.waitingViewers.has(key)) {
          StreamController.waitingViewers.set(key, new Set());
        }
        StreamController.waitingViewers.get(key)!.add(ws);
        StreamController.setupWaitingViewerSocket(ws, key);
      }

      this.broadcastStreamState(key);
    } catch (err) {
      console.error("[WS Viewer Upgrade Error]:", err);
      try { ws.close(1011, "Internal server error."); } catch (_) {}
    }
  }

  private static setupWaitingViewerSocket(viewerWs: WebSocket, streamKey: string) {
    viewerWs.removeAllListeners("message");
    viewerWs.removeAllListeners("close");
    viewerWs.removeAllListeners("error");

    viewerWs.on("message", (data: any) => {
      try {
        const message = data.toString("utf8");
        const msg = JSON.parse(message);
        if (msg.event === "viewer-ready" || msg.event === "check_status") {
          const status = TranscodeService.getPipelineStatus(streamKey);
          const cdnUrl = SFTPService.getPublicCdnUrl(streamKey);
          viewerWs.send(JSON.stringify({
            event: "status",
            status: status.isReady ? "live" : "offline",
            hlsUrl: cdnUrl,
          }));
        }
      } catch (_) {}
    });

    viewerWs.on("close", () => {
      const waiting = StreamController.waitingViewers.get(streamKey);
      if (waiting) {
        waiting.delete(viewerWs);
        if (waiting.size === 0) {
          StreamController.waitingViewers.delete(streamKey);
        }
      }
      StreamController.broadcastStreamState(streamKey);
    });

    viewerWs.on("error", () => {
      viewerWs.close();
    });
  }

  private static setupViewerSocket(viewerWs: WebSocket, viewerId: string, streamKey: string) {
    const session = StreamController.activeSessions.get(streamKey);
    if (session) {
      StreamController.notifyBroadcasterViewerCount(session);
    }

    viewerWs.removeAllListeners("message");
    viewerWs.on("message", (data: any) => {
      try {
        const message = data.toString("utf8");
        const msg = JSON.parse(message);
        const currentSession = StreamController.activeSessions.get(streamKey);
        const status = TranscodeService.getPipelineStatus(streamKey);

        if (msg.event === "viewer-ready" || msg.event === "check_status") {
          viewerWs.send(JSON.stringify({
            event: "status",
            status: status.isReady ? "live" : "offline",
            viewerId,
            hlsUrl: status.previewUrl,
          }));
          return;
        }

        if (currentSession) {
          msg.viewerId = viewerId;
          if (currentSession.ws && currentSession.ws.readyState === 1) {
            currentSession.ws.send(JSON.stringify(msg));
          }
        }
      } catch (err) {
        console.error(`[Viewer WS - ${viewerId}] Message error:`, err);
      }
    });

    viewerWs.on("close", () => {
      console.log(`[WS Signaling] Viewer ${viewerId} closed connection.`);
      const currentSession = StreamController.activeSessions.get(streamKey);
      if (currentSession) {
        currentSession.viewers.delete(viewerId);
      }
      const waiting = StreamController.waitingViewers.get(streamKey);
      if (waiting) {
        waiting.delete(viewerWs);
      }
      StreamController.broadcastStreamState(streamKey);
    });

    viewerWs.on("error", () => {
      viewerWs.close();
    });
  }

  static async stopStreamSession(key: string) {
    console.log(`[WS Signaling] Stopping session for stream key: ${key}`);
    MonitorService.addLog(`[Signaling] Session stopped for key: ${key}`);

    const session = StreamController.activeSessions.get(key);
    if (session) {
      if (session.telemetryId) {
        await TelemetryService.endSession(session.telemetryId);
      }
      if (session.viewers) {
        for (const viewerWs of session.viewers.values()) {
          try {
            viewerWs.send(JSON.stringify({ event: "status", status: "offline", message: "Stream has ended." }));
            viewerWs.close(1000, "Stream ended");
          } catch (_) {}
        }
      }
      StreamController.activeSessions.delete(key);
    }

    const waiting = StreamController.waitingViewers.get(key);
    if (waiting) {
      for (const viewerWs of waiting) {
        try {
          viewerWs.send(JSON.stringify({ event: "status", status: "offline", message: "Stream has ended." }));
          viewerWs.close(1000, "Stream ended");
        } catch (_) {}
      }
      StreamController.waitingViewers.delete(key);
    }

    await TranscodeService.stopPipeline(key).catch(() => {});
    await StreamService.setStreamLive(key, false);
    await StreamService.setStreamActive(key, false);
    this.broadcastStreamState(key);
  }

  static async getPublicPlaybackStatus(req: Request, res: Response) {
    const key = StreamController.getParamKey(req);
    const status = TranscodeService.getPipelineStatus(key);
    const session = StreamController.activeSessions.get(key);
    const viewersCount = session ? session.viewers.size : 0;
    return res.json({
      success: true,
      data: {
        canPlay: status.isReady,
        hlsUrl: status.previewUrl,
        viewersCount,
        speed: status.speed,
      },
    });
  }

  static async getTranscoderStatus(req: Request, res: Response) {
    const key = StreamController.getParamKey(req);
    const status = TranscodeService.getPipelineStatus(key);
    const session = StreamController.activeSessions.get(key);
    const viewersCount = session ? session.viewers.size : 0;
    return res.json({
      success: true,
      data: {
        ...status,
        viewersCount,
      },
    });
  }

  static async startTranscoder(req: Request, res: Response) {
    try {
      const key = StreamController.getParamKey(req);
      const status = await TranscodeService.startPipeline(key);
      StreamController.broadcastStreamState(key);
      return res.json({ success: true, data: status });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async stopTranscoder(req: Request, res: Response) {
    try {
      const key = StreamController.getParamKey(req);
      await TranscodeService.stopPipeline(key);
      StreamController.broadcastStreamState(key);
      return res.json({ success: true, message: "Transcoder stopped." });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async goLive(req: Request, res: Response) {
    try {
      const key = StreamController.getParamKey(req);
      await TranscodeService.publish(key);
      StreamController.broadcastStreamState(key);
      return res.json({ success: true, message: "Public live streaming active." });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  static async stopLive(req: Request, res: Response) {
    try {
      const key = StreamController.getParamKey(req);
      await TranscodeService.unpublish(key);
      StreamController.broadcastStreamState(key);
      return res.json({ success: true, message: "Public live streaming stopped." });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  static async getIngest(req: Request, res: Response) {
    try {
      const key = StreamController.getParamKey(req);
      const hostname = StreamController.getRequestHostname(req);
      const ingest = TranscodeService.getIngestDetails(key, hostname);
      return res.json({ success: true, data: { ingest } });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
}
