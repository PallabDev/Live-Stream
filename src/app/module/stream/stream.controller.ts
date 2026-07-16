import { Request, Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware.js";
import { StreamService } from "./stream.service.js";
import { createStreamDto } from "./stream.dto.js";

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

  static async speedTest(req: AuthenticatedRequest, res: Response) {
    // Simply acknowledge receipt. The client measures elapsed time.
    return res.json({ success: true, receivedAt: Date.now() });
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
      // e.g., "whip/live_1234abcd" -> "live_1234abcd"
      const streamKey = rawPath.replace(/^whip\//, "");

      if (!streamKey) {
        console.warn(`[MediaMTX Auth] Rejected: No stream key in path "${rawPath}"`);
        return res.sendStatus(401);
      }

      // Verify the stream key in database
      const streamInfo = await StreamService.getStreamByKey(streamKey);
      if (!streamInfo) {
        console.warn(`[MediaMTX Auth] Rejected: Invalid stream key "${streamKey}"`);
        return res.sendStatus(401);
      }

      console.log(`[MediaMTX Auth] Approved: Stream key "${streamKey}" for title "${streamInfo.title}"`);
      return res.sendStatus(200);
    } catch (err: any) {
      console.error("[MediaMTX Auth] Error during authentication:", err);
      return res.sendStatus(500);
    }
  }
}
