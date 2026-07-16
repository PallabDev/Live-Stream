import { Request, Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware.js";
import { StreamService } from "./stream.service.js";
import { createStreamDto } from "./stream.dto.js";
import fs from "fs";
import path from "path";

export class StreamController {
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
    try {
      const { ip, action, path: rawPath } = req.body;
      console.log(`[MediaMTX Auth] IP=${ip} action=${action} path=${rawPath}`);

      // Bypass auth for internal requests (loopback IP)
      if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
        return res.sendStatus(200);
      }

      // If the action is not publishing, allow it (for HLS/WHEP reading)
      if (action !== "publish") {
        return res.sendStatus(200);
      }

      // Extract the stream key from the path
      const streamKey = rawPath.split("/").pop();

      if (!streamKey) {
        console.warn(`[MediaMTX Auth] Rejected: No stream key in path "${rawPath}"`);
        return res.sendStatus(401);
      }

      // Verify the stream key in database and ensure stream has been toggled to Go Live
      const streamInfo = await StreamService.getStreamByKey(streamKey);
      if (!streamInfo || !streamInfo.isLive) {
        console.warn(`[MediaMTX Auth] Rejected: Invalid or inactive stream key "${streamKey}"`);
        return res.sendStatus(401);
      }

      console.log(`[MediaMTX Auth] Approved: Stream key "${streamKey}" for title "${streamInfo.title}"`);
      return res.sendStatus(200);
    } catch (err: any) {
      console.error("[MediaMTX Auth] Error during authentication:", err);
      return res.sendStatus(500);
    }
  }

  static async goLive(req: AuthenticatedRequest, res: Response) {
    try {
      const { key } = req.params;
      const streamInfo = await StreamService.getStreamByKey(key);
      if (!streamInfo) {
        return res.status(404).json({ success: false, error: "Stream not found." });
      }
      if (streamInfo.userId !== req.user.id && req.user.role !== "admin") {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }

      await StreamService.setStreamLive(key, true);
      return res.json({ success: true, message: "Stream is now active and ready for OBS connection." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
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

      await StreamService.setStreamLive(key, false);

      // Kick session in MediaMTX Control API
      try {
        const listRes = await fetch("http://127.0.0.1:9997/v3/rtmpsessions/list");
        if (listRes.ok) {
          const data: any = await listRes.json();
          const sessions = data.items || [];
          const sessionToKick = sessions.find((s: any) => {
            const pathKey = s.path.split("/").pop();
            return pathKey === key;
          });

          if (sessionToKick) {
            console.log(`[MediaMTX Kick] Kicking active RTMP session ID ${sessionToKick.id} for key ${key}`);
            await fetch(`http://127.0.0.1:9997/v3/rtmpsessions/kick/${sessionToKick.id}`, {
              method: "POST"
            });
          }
        }
      } catch (err: any) {
        console.error("[MediaMTX Kick Error]", err.message);
      }

      return res.json({ success: true, message: "Stream stopped successfully." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async updateSettings(req: AuthenticatedRequest, res: Response) {
    try {
      const { key } = req.params;
      const { isRaw, resolutions } = req.body;
      const streamInfo = await StreamService.getStreamByKey(key);
      if (!streamInfo) {
        return res.status(404).json({ success: false, error: "Stream not found." });
      }
      if (streamInfo.userId !== req.user.id && req.user.role !== "admin") {
        return res.status(403).json({ success: false, error: "Unauthorized." });
      }

      // Convert isRaw to boolean and ensure resolutions default correctly
      await StreamService.updateStreamSettings(key, !!isRaw, resolutions || "480p,1080p");
      return res.json({ success: true, message: "Stream settings updated successfully." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
}
