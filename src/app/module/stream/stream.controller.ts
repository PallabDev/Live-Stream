import { Request, Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware.js";
import { StreamService } from "./stream.service.js";
import { createStreamDto } from "./stream.dto.js";
import fs from "fs";
import path from "path";
import { WebSocket } from "ws";
import { MonitorService } from "../../common/monitor/monitor.service.js";

interface StreamSession {
  streamKey: string;
  ws: WebSocket; // Broadcaster
  viewers: Map<string, WebSocket>; // viewerId -> WebSocket
}

export class StreamController {
  public static activeSessions = new Map<string, StreamSession>();
  public static waitingViewers = new Map<string, Set<WebSocket>>();

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

      // Check for existing session (reconnection path)
      let session = StreamController.activeSessions.get(key);
      let isReconnecting = false;

      if (session) {
        console.log(`[WS Signaling] Broadcaster reconnected for key: ${key}. Resuming existing session.`);
        MonitorService.addLog(`[Signaling] Broadcaster reconnected for key: ${key}. Resuming session.`);
        isReconnecting = true;
        session.ws = ws;
      } else {
        // Initialize new session
        session = {
          streamKey: key,
          ws,
          viewers: new Map(),
        };
        StreamController.activeSessions.set(key, session);
      }

      // Listen for broadcaster signaling messages
      ws.on("message", (message: string) => {
        try {
          const msg = JSON.parse(message);
          const { event, viewerId } = msg;
          
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
        console.log(`[WS Signaling] Broadcaster disconnected temporarily: ${key}. Starting 10s grace period.`);
        MonitorService.addLog(`[Signaling] Broadcaster disconnected: ${key}. Waiting 10s for reconnect.`);
        
        setTimeout(async () => {
          const currentSession = StreamController.activeSessions.get(key);
          if (currentSession && currentSession.ws === ws) {
            console.log(`[WS Signaling] Broadcaster grace period expired for: ${key}. Stopping session.`);
            await StreamController.stopStreamSession(key);
          }
        }, 10000);
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
            ws.send(JSON.stringify({ event: "viewer-connected", viewerId }));
          }
        }
      } else {
        // Notify and connect any waiting viewers
        const waiting = StreamController.waitingViewers.get(key);
        if (waiting) {
          console.log(`[WS Signaling] Upgrading ${waiting.size} waiting viewers for key: ${key}`);
          for (const viewerWs of waiting) {
            if (viewerWs.readyState === 1) { // OPEN
              const viewerId = Math.random().toString(36).substring(2, 15);
              session.viewers.set(viewerId, viewerWs);

              // Bind events for this viewer
              StreamController.setupViewerSocket(viewerWs, viewerId, key);

              // Send live signal
              viewerWs.send(JSON.stringify({ event: "status", status: "live", viewerId }));
              // Send connection trigger to broadcaster
              ws.send(JSON.stringify({ event: "viewer-connected", viewerId }));
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
        // Broadcaster is live, add to session
        session.viewers.set(viewerId, ws);
        StreamController.setupViewerSocket(ws, viewerId, key);

        // Notify client and broadcaster
        ws.send(JSON.stringify({ event: "status", status: "live", viewerId }));
        if (session.ws && session.ws.readyState === 1) {
          session.ws.send(JSON.stringify({ event: "viewer-connected", viewerId }));
        }
      } else {
        // Broadcaster is offline, put viewer in waiting queue
        ws.send(JSON.stringify({ event: "status", status: "offline" }));
        if (!StreamController.waitingViewers.has(key)) {
          StreamController.waitingViewers.set(key, new Set());
        }
        StreamController.waitingViewers.get(key)!.add(ws);

        ws.on("close", () => {
          console.log(`[WS Signaling] Waiting viewer ${viewerId} disconnected`);
          const waiting = StreamController.waitingViewers.get(key);
          if (waiting) {
            waiting.delete(ws);
            if (waiting.size === 0) {
              StreamController.waitingViewers.delete(key);
            }
          }
        });

        ws.on("error", () => {
          ws.close();
        });
      }
    } catch (err) {
      console.error("[WS Viewer Upgrade Error]:", err);
      ws.close(1011, "Internal server error.");
    }
  }

  private static setupViewerSocket(viewerWs: WebSocket, viewerId: string, streamKey: string) {
    viewerWs.on("message", (message: string) => {
      try {
        const msg = JSON.parse(message);
        const session = StreamController.activeSessions.get(streamKey);
        if (session) {
          msg.viewerId = viewerId; // Attach viewer identification
          if (session.ws && session.ws.readyState === 1) { // OPEN
            session.ws.send(JSON.stringify(msg));
          }
        }
      } catch (err) {
        console.error(`[Viewer WS - ${viewerId}] Message error:`, err);
      }
    });

    viewerWs.on("close", () => {
      console.log(`[WS Signaling] Viewer ${viewerId} closed connection.`);
      MonitorService.addLog(`[Signaling] Viewer ${viewerId} disconnected`);
      
      const session = StreamController.activeSessions.get(streamKey);
      if (session) {
        session.viewers.delete(viewerId);
        if (session.ws && session.ws.readyState === 1) {
          session.ws.send(JSON.stringify({ event: "viewer-disconnected", viewerId }));
        }
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

            viewerWs.removeAllListeners("message");
            viewerWs.removeAllListeners("close");
            
            viewerWs.on("close", () => {
              const waiting = StreamController.waitingViewers.get(streamKey);
              if (waiting) {
                waiting.delete(viewerWs);
              }
            });
            viewerWs.on("error", () => {
              viewerWs.close();
            });
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

      await StreamService.deleteStream(userId, id, isAdmin);

      return res.json({ success: true, message: "Stream deleted successfully." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async mediaMtxAuth(req: Request, res: Response) {
    return res.sendStatus(200);
  }

  static async goLive(req: Request, res: Response) {
    return res.status(400).json({ success: false, error: "RTMP streaming is disabled. Please use the WebRTC studio streamer." });
  }

  static async receiveVideo(req: Request, res: Response) {
    return res.status(400).json({ error: "Chunk post ingestion is deprecated. Use WebRTC." });
  }

  static async stopLive(req: AuthenticatedRequest, res: Response) {
    try {
      const { key } = req.params;
      const streamInfo = await StreamService.getStreamByKey(key);
      if (!streamInfo) {
        return res.status(404).json({ success: false, error: "Stream not found." });
      }
      if (streamInfo.userId !== req.user.id && req.user.role !== "admin") {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }

      await StreamController.stopStreamSession(key);
      return res.json({ success: true, message: "Stream stopped successfully." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
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
