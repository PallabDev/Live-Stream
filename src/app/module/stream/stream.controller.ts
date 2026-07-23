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

  private static async getOwnedStream(req: AuthenticatedRequest, key: string) {
    const streamInfo = await StreamService.getStreamByKey(key);
    if (!streamInfo) {
      throw new Error("Stream not found.");
    }
    if (streamInfo.userId !== req.user.id && req.user.role !== "admin") {
      const error = new Error("Unauthorized.");
      (error as any).statusCode = 403;
      throw error;
    }
    return streamInfo;
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

      // Check quota & block status before allowing live stream
      const canStart = await TelemetryService.canUserStartStream(streamInfo.userId);
      if (!canStart.allowed) {
        console.warn(`[WS Signaling] Broadcaster rejected for ${key}: ${canStart.reason}`);
        ws.send(JSON.stringify({ event: "error", error: canStart.reason }));
        ws.close(4003, canStart.reason || "Quota limit reached or account blocked.");
        return;
      }

      // Check for existing session (reconnection path)
      let session = StreamController.activeSessions.get(key);
      let isReconnecting = false;

      if (session) {
        console.log(`[WS Signaling] Broadcaster reconnected for key: ${key}. Resuming existing session.`);
        MonitorService.addLog(`[Signaling] Broadcaster reconnected for key: ${key}. Resuming session.`);
        isReconnecting = true;
        session.ws = ws;
      } else {
        // Initialize new session and start telemetry tracking
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

      // Listen for broadcaster signaling & binary WebCodecs frame chunks
      ws.on("message", (data: any, isBinary: boolean) => {
        if (isBinary) {
          if (session && session.viewers && session.viewers.size > 0) {
            for (const viewerWs of session.viewers.values()) {
              if (viewerWs.readyState === 1) { // OPEN
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
            if (viewerWs && viewerWs.readyState === 1) { // OPEN
              viewerWs.send(JSON.stringify(msg));
            }
          }
        } catch (err) {
          console.error(`[Broadcaster WS - ${key}] Message error:`, err);
        }
      });

      ws.on("close", () => {
        console.log(`[WS Signaling] Broadcaster disconnected temporarily: ${key}. Starting 90s grace period.`);
        MonitorService.addLog(`[Signaling] Broadcaster disconnected: ${key}. Waiting 90s for reconnect.`);
        
        setTimeout(async () => {
          const currentSession = StreamController.activeSessions.get(key);
          if (currentSession && currentSession.ws === ws) {
            console.log(`[WS Signaling] Broadcaster grace period expired for: ${key}. Stopping session.`);
            await StreamController.stopStreamSession(key);
          }
        }, 90000);
      });

      ws.on("error", (err: any) => {
        console.error(`[WS Signaling] Broadcaster error on key ${key}:`, err);
      });

      // Update DB state
      await StreamService.setStreamLive(key, true);

      // Reconnect/re-notify viewers
      if (isReconnecting) {
        for (const [viewerId, viewerWs] of session.viewers) {
          if (viewerWs.readyState === 1) {
            viewerWs.send(JSON.stringify({ event: "status", status: "live", viewerId }));
          }
        }
      } else {
        // Notify and connect any waiting viewers
        const waiting = StreamController.waitingViewers.get(key);
        if (waiting && waiting.size > 0) {
          console.log(`[WS Signaling] Upgrading ${waiting.size} waiting viewers for key: ${key}`);
          const waitingList = Array.from(waiting);
          for (const viewerWs of waitingList) {
            if (viewerWs.readyState === 1) { // OPEN
              if (session.viewers.size >= 50) break; // Enforce 50 viewers max
              const viewerId = Math.random().toString(36).substring(2, 15);
              session.viewers.set(viewerId, viewerWs);

              // Bind events for this viewer
              StreamController.setupViewerSocket(viewerWs, viewerId, key);

              // Send live signal
              viewerWs.send(JSON.stringify({ event: "status", status: "live", viewerId }));
            }
          }
          StreamController.waitingViewers.delete(key);
        }
      }

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

      if (session) {
        // Clean stale/closed sockets before checking capacity
        for (const [vId, vWs] of session.viewers.entries()) {
          if (vWs.readyState !== 1) { // 1 = OPEN
            session.viewers.delete(vId);
          }
        }

        // Capacity check (50 viewers limit)
        if (session.viewers.size >= 50) {
          console.warn(`[WS Signaling] Viewer ${viewerId} rejected: Stream key ${key} reached maximum capacity of 50 viewers.`);
          ws.send(JSON.stringify({ 
            event: "status", 
            status: "capacity_reached", 
            message: "Stream is at maximum capacity (50 viewers max allowed)." 
          }));
          try { ws.close(1008, "Capacity reached"); } catch (_) {}
          return;
        }

        // Broadcaster is live, add to session
        session.viewers.set(viewerId, ws);
        StreamController.setupViewerSocket(ws, viewerId, key);

        // Notify client
        ws.send(JSON.stringify({ event: "status", status: "live", viewerId }));
      } else {
        // Broadcaster is offline, put viewer in waiting queue
        ws.send(JSON.stringify({ event: "status", status: "offline" }));
        if (!StreamController.waitingViewers.has(key)) {
          StreamController.waitingViewers.set(key, new Set());
        }
        StreamController.waitingViewers.get(key)!.add(ws);
        StreamController.setupWaitingViewerSocket(ws, key);
      }
    } catch (err) {
      console.error("[WS Viewer Upgrade Error]:", err);
      ws.close(1011, "Internal server error.");
    }
  }

  private static notifyBroadcasterViewerCount(session: StreamSession) {
    if (session && session.ws && session.ws.readyState === 1) { // OPEN
      session.ws.send(JSON.stringify({
        event: "viewer-count",
        count: session.viewers.size
      }));
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
          const session = StreamController.activeSessions.get(streamKey);
          if (session) {
            const waiting = StreamController.waitingViewers.get(streamKey);
            if (waiting) waiting.delete(viewerWs);

            if (session.viewers.size < 50) {
              const viewerId = Math.random().toString(36).substring(2, 15);
              session.viewers.set(viewerId, viewerWs);
              StreamController.setupViewerSocket(viewerWs, viewerId, streamKey);
              viewerWs.send(JSON.stringify({ event: "status", status: "live", viewerId }));
            } else {
              viewerWs.send(JSON.stringify({ event: "status", status: "capacity_reached" }));
            }
          } else {
            viewerWs.send(JSON.stringify({ event: "status", status: "offline" }));
          }
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
        if (msg.event === "viewer-ready" || msg.event === "check_status") {
          if (currentSession) {
            viewerWs.send(JSON.stringify({ event: "status", status: "live", viewerId }));
          } else {
            viewerWs.send(JSON.stringify({ event: "status", status: "offline" }));
          }
          return;
        }

        if (currentSession) {
          msg.viewerId = viewerId; // Attach viewer identification
          if (currentSession.ws && currentSession.ws.readyState === 1) { // OPEN
            currentSession.ws.send(JSON.stringify(msg));
          }
        }
      } catch (err) {
        console.error(`[Viewer WS - ${viewerId}] Message error:`, err);
      }
    });

    viewerWs.on("close", () => {
      console.log(`[WS Signaling] Viewer ${viewerId} closed connection.`);
      MonitorService.addLog(`[Signaling] Viewer ${viewerId} disconnected`);
      
      const currentSession = StreamController.activeSessions.get(streamKey);
      if (currentSession) {
        currentSession.viewers.delete(viewerId);
        if (currentSession.ws && currentSession.ws.readyState === 1) {
          currentSession.ws.send(JSON.stringify({ event: "viewer-disconnected", viewerId }));
        }
        StreamController.notifyBroadcasterViewerCount(currentSession);
      }

      const waiting = StreamController.waitingViewers.get(streamKey);
      if (waiting) {
        waiting.delete(viewerWs);
      }
    });

    viewerWs.on("error", () => {
      viewerWs.close();
    });
  }

  private static async stopStreamSession(streamKey: string) {
    const session = StreamController.activeSessions.get(streamKey);
    if (!session) return;

    console.log(`[WS Signaling] Stopping stream session for key: ${streamKey}`);
    MonitorService.addLog(`[Signaling] Broadcaster disconnected for key: ${streamKey}`);

    // Record session end in telemetry (only sessions >= 1.5h count)
    if (session.telemetryId) {
      await TelemetryService.endSession(session.telemetryId);
    }

    // Update DB status to offline
    try {
      await StreamService.setStreamLive(streamKey, false);
    } catch (err) {
      console.error(`Error updating DB status for ${streamKey}:`, err);
    }

    // Move connected viewers back to waiting status queue
    if (session.viewers) {
      for (const [viewerId, viewerWs] of session.viewers) {
        if (viewerWs.readyState === 1) {
          try {
            viewerWs.send(JSON.stringify({ event: "status", status: "offline" }));
            
            if (!StreamController.waitingViewers.has(streamKey)) {
              StreamController.waitingViewers.set(streamKey, new Set());
            }
            StreamController.waitingViewers.get(streamKey)!.add(viewerWs);
            StreamController.setupWaitingViewerSocket(viewerWs, streamKey);
          } catch (_) {}
        }
      }
    }

    // Terminate broadcaster WS if still open
    if (session.ws && session.ws.readyState === 1) {
      try {
        session.ws.close(1000, "Broadcaster session ended.");
      } catch (_) {}
    }

    StreamController.activeSessions.delete(streamKey);
  }

  static async createStream(req: AuthenticatedRequest, res: Response) {
    try {
      const { error, value } = createStreamDto.validate(req.body);
      if (error) {
        return res.status(400).json({ success: false, error: error.details[0].message });
      }

      const userId = req.user.id;
      const stream = await StreamService.createStream(userId, value.title);
      
      return res.status(201).json({ success: true, data: stream });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async deleteStream(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
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
      const { key } = req.params;
      const streamInfo = await StreamController.getOwnedStream(req, key);
      const hostname = StreamController.getRequestHostname(req);
      const ingest = TranscodeService.getPublicIngestDetails(streamInfo.streamKey, hostname);

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

  static async startTranscoder(req: AuthenticatedRequest, res: Response) {
    try {
      const { key } = req.params;
      const streamInfo = await StreamController.getOwnedStream(req, key);
      const status = await TranscodeService.ensurePipeline(streamInfo.streamKey);

      return res.json({ success: true, data: status });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  static async getTranscoderStatus(req: AuthenticatedRequest, res: Response) {
    try {
      const { key } = req.params;
      const streamInfo = await StreamController.getOwnedStream(req, key);
      const status = TranscodeService.getPipelineStatus(streamInfo.streamKey);
      const freshStream = await StreamService.getStreamByKey(streamInfo.streamKey);

      return res.json({
        success: true,
        data: {
          ...status,
          isActive: !!freshStream?.isActive,
          isLive: !!freshStream?.isLive,
        },
      });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  static async getPublicPlaybackStatus(req: Request, res: Response) {
    try {
      const { key } = req.params;
      const streamInfo = await StreamService.getStreamByKey(key);
      if (!streamInfo) {
        return res.status(404).json({ success: false, error: "Stream not found." });
      }

      const pipeline = TranscodeService.getPipelineStatus(streamInfo.streamKey);
      const canPlay = !!streamInfo.isLive && pipeline.isReady;

      return res.json({
        success: true,
        data: {
          isLive: !!streamInfo.isLive,
          isActive: !!streamInfo.isActive,
          canPlay,
          hlsUrl: canPlay ? pipeline.previewUrl : null,
        },
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async goLive(req: AuthenticatedRequest, res: Response) {
    try {
      const { key } = req.params;
      const streamInfo = await StreamController.getOwnedStream(req, key);
      await TranscodeService.publish(streamInfo.streamKey);
      return res.json({ success: true, message: "Public live playback enabled." });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  static async receiveVideo(req: Request, res: Response) {
    return res.status(400).json({ error: "Chunk post ingestion is deprecated. Use WebRTC." });
  }

  static async stopLive(req: AuthenticatedRequest, res: Response) {
    try {
      const { key } = req.params;
      const streamInfo = await StreamController.getOwnedStream(req, key);

      await TranscodeService.unpublish(streamInfo.streamKey);
      return res.json({ success: true, message: "Public live playback disabled." });
    } catch (error: any) {
      return res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  }

  static async updateSettings(req: AuthenticatedRequest, res: Response) {
    try {
      const { key } = req.params;
      const streamInfo = await StreamService.getStreamByKey(key);
      if (!streamInfo) {
        return res.status(404).json({ success: false, error: "Stream not found." });
      }
      return res.json({ success: true, message: "Settings are deprecated under WebRTC mode." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}
