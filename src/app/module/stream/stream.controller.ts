import { Request, Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware.js";
import { StreamService } from "./stream.service.js";
import { createStreamDto } from "./stream.dto.js";
import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { WebSocket } from "ws";

interface StreamSession {
  ffmpegProcess: ChildProcess;
  inactivityTimeout: NodeJS.Timeout;
  streamKey: string;
  ws?: WebSocket;
}

export class StreamController {
  private static activeSessions = new Map<string, StreamSession>();

  static async handleWebSocket(ws: WebSocket, key: string) {
    try {
      console.log(`WebSocket connection opened for stream key: ${key}`);
      
      const streamInfo = await StreamService.getStreamByKey(key);
      if (!streamInfo) {
        console.warn(`[WS] Rejected: Stream key "${key}" not found in database.`);
        ws.close(4004, "Stream not found.");
        return;
      }

      // Stop any existing session for this key first
      if (StreamController.activeSessions.has(key)) {
        await StreamController.stopStreamSession(key);
      }
      
      // Set up dedicated stream output directory and subdirectories for ABR variants '0' (480p) and '1' (1080p)
      const mediaDir = path.join(process.cwd(), "media");
      const streamDir = path.join(mediaDir, key);
      
      if (fs.existsSync(streamDir)) {
        try {
          fs.rmSync(streamDir, { recursive: true, force: true });
        } catch (err) {}
      }
      fs.mkdirSync(path.join(streamDir, "0"), { recursive: true });
      fs.mkdirSync(path.join(streamDir, "1"), { recursive: true });

      console.log(`Spawning ABR FFmpeg for stream key: ${key}`);

      // Spawn FFmpeg to transcode incoming WebM stream into two H.264 variants in parallel (480p @ 600kbps & 1080p @ 2.5Mbps)
      const ffmpegProcess = spawn("ffmpeg", [
        "-f", "webm",
        "-i", "pipe:0",

        // Map first video and optional first audio streams for Variant 0 (480p)
        "-map", "0:v:0",
        "-map", "0:a:0?",

        // Map first video and optional first audio streams for Variant 1 (1080p)
        "-map", "0:v:0",
        "-map", "0:a:0?",

        // Force keyframe interval of 60 frames (2 seconds at 30 fps) to align segment boundaries across quality variants
        "-keyint_min", "60",
        "-g", "60",
        "-sc_threshold", "0",

        // Global video encoding properties
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",

        // Global audio encoding properties
        "-c:a", "aac",
        "-ar", "44100",
        "-ac", "2",

        // Video configuration for Variant 0 (480p - Low Bandwidth optimization for 1 Mbps connections)
        "-filter:v:0", "scale=-2:480",
        "-crf:v:0", "28",
        "-maxrate:v:0", "600k",
        "-bufsize:v:0", "1.2M",

        // Video configuration for Variant 1 (1080p - High Quality profile for fast connections)
        "-filter:v:1", "scale=-2:1080",
        "-crf:v:1", "24",
        "-maxrate:v:1", "2.5M",
        "-bufsize:v:1", "5M",

        // Audio bitrate configuration per variant
        "-b:a:0", "64k",
        "-b:a:1", "128k",

        // HLS Multiplexer settings
        "-f", "hls",
        "-hls_time", "2", // Short segment size for responsive streaming
        "-hls_list_size", "6", // Keep playlist small for low latency
        "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
        
        // Define variant stream map linking video/audio indexes
        "-var_stream_map", "v:0,a:0 v:1,a:1",

        // Output configuration with automatic master playlist generation
        "-hls_segment_filename", path.join(streamDir, "%v", "segment_%05d.ts"),
        "-master_pl_name", "master.m3u8",
        path.join(streamDir, "%v", "index.m3u8"),
      ]);

      ffmpegProcess.stderr.on("data", (data) => {
        console.log(`[FFmpeg - ${key}]:`, data.toString().trim());
      });

      ffmpegProcess.on("close", (code) => {
        console.log(`FFmpeg exited for stream ${key} with code: ${code}`);
        if (StreamController.activeSessions.has(key)) {
          StreamController.stopStreamSession(key);
        }
      });

      // Setup 30 seconds inactivity timeout
      let inactivityTimeout = setTimeout(() => {
        console.log(`Inactivity detected on stream ${key}. Cleaning up.`);
        try {
          ws.close(4008, "Stream inactivity timeout.");
        } catch (err) {}
        StreamController.stopStreamSession(key);
      }, 30000);

      // Save active session
      StreamController.activeSessions.set(key, {
        ffmpegProcess,
        inactivityTimeout,
        streamKey: key,
        ws,
      });

      await StreamService.setStreamLive(key, true);

      // Listen for incoming chunks
      ws.on("message", (message: Buffer, isBinary) => {
        if (!isBinary) return;

        // Reset inactivity timeout
        clearTimeout(inactivityTimeout);
        inactivityTimeout = setTimeout(() => {
          console.log(`Inactivity detected on stream ${key}. Cleaning up.`);
          try {
            ws.close(4008, "Stream inactivity timeout.");
          } catch (err) {}
          StreamController.stopStreamSession(key);
        }, 30000);

        const session = StreamController.activeSessions.get(key);
        if (session) {
          session.ffmpegProcess.stdin?.write(message);
        }
      });

      ws.on("close", () => {
        console.log(`WebSocket closed for stream key: ${key}`);
        clearTimeout(inactivityTimeout);
        StreamController.stopStreamSession(key);
      });

      ws.on("error", (err) => {
        console.error(`WebSocket error for stream key ${key}:`, err);
        clearTimeout(inactivityTimeout);
        StreamController.stopStreamSession(key);
      });

    } catch (err: any) {
      console.error(`Error establishing WebSocket stream for key ${key}:`, err);
      try {
        ws.close(4500, "Internal server error.");
      } catch (e) {}
    }
  }

  private static async stopStreamSession(streamKey: string) {
    const session = StreamController.activeSessions.get(streamKey);
    if (!session) return;

    console.log(`Stopping stream session for key: ${streamKey}`);

    // Clear timeout
    clearTimeout(session.inactivityTimeout);

    // Terminate FFmpeg process
    try {
      session.ffmpegProcess.stdin?.end();
      session.ffmpegProcess.kill("SIGTERM");
    } catch (err) {
      console.error(`Error terminating FFmpeg for stream ${streamKey}:`, err);
    }

    // Close WebSocket if still open
    if (session.ws && session.ws.readyState === 1) { // 1 === OPEN
      try {
        session.ws.close(1000, "Stream stopped.");
      } catch (err) {}
    }

    // Remove from active map
    StreamController.activeSessions.delete(streamKey);

    // Update DB status to offline
    try {
      await StreamService.setStreamLive(streamKey, false);
      console.log(`Stream database status updated to offline for key: ${streamKey}`);
    } catch (err) {
      console.error(`Error updating DB for stream ${streamKey}:`, err);
    }
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

      // Stop any existing session for this key first
      if (StreamController.activeSessions.has(key)) {
        await StreamController.stopStreamSession(key);
      }

      // Set up dedicated stream output directory and variant subdirectory '0'
      const mediaDir = path.join(process.cwd(), "media");
      const streamDir = path.join(mediaDir, key);
      const variantDir = path.join(streamDir, "0");
      
      if (fs.existsSync(streamDir)) {
        try {
          fs.rmSync(streamDir, { recursive: true, force: true });
        } catch (err) {}
      }
      fs.mkdirSync(variantDir, { recursive: true });

      // Write a master playlist format that live.ejs expects (pointing to variant 0)
      fs.writeFileSync(
        path.join(streamDir, "master.m3u8"),
        `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\n0/index.m3u8\n`
      );

      console.log(`Spawning FFmpeg for stream key: ${key} inside ${variantDir}`);

      // Spawn FFmpeg with low latency settings + high quality output (CRF 20, 256k AAC audio)
      const ffmpegProcess = spawn("ffmpeg", [
        "-fflags", "+genpts",
        "-f", "webm",
        "-i", "pipe:0",

        // Map first video and optional first audio streams
        "-map", "0:v:0",
        "-map", "0:a:0?",

        // Video encoding settings: High quality libx264, zero-latency tune
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-crf", "20",
        "-pix_fmt", "yuv420p",

        // Audio encoding settings: High quality 256kbps stereo AAC
        "-c:a", "aac",
        "-b:a", "256k",
        "-ar", "48000",
        "-ac", "2",

        // HLS output configuration inside variant directory
        "-f", "hls",
        "-hls_time", "2", // Short segment size for responsive streaming
        "-hls_list_size", "6", // Keep playlist small for low latency
        "-hls_flags", "delete_segments+append_list+omit_endlist+independent_segments",
        "-hls_segment_filename", path.join(variantDir, "segment_%05d.ts"),
        path.join(variantDir, "index.m3u8"),
      ]);

      // Handle FFmpeg diagnostics
      ffmpegProcess.stderr.on("data", (data) => {
        console.log(`[FFmpeg - ${key}]:`, data.toString().trim());
      });

      ffmpegProcess.on("close", (code) => {
        console.log(`FFmpeg exited for stream ${key} with code: ${code}`);
        if (StreamController.activeSessions.has(key)) {
          StreamController.stopStreamSession(key);
        }
      });

      // Setup inactivity timeout (disconnect if no chunks received for 30 seconds)
      const inactivityTimeout = setTimeout(() => {
        console.log(`Inactivity detected on stream ${key}. Cleaning up.`);
        StreamController.stopStreamSession(key);
      }, 30000);

      // Save active session
      StreamController.activeSessions.set(key, {
        ffmpegProcess,
        inactivityTimeout,
        streamKey: key,
      });

      await StreamService.setStreamLive(key, true);
      return res.json({ success: true, message: "Stream started dynamically via FFmpeg." });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  static async receiveVideo(req: Request, res: Response) {
    const { key } = req.params;
    const session = StreamController.activeSessions.get(key);

    if (!session) {
      return res.status(404).json({ error: "No active stream session found for this key." });
    }

    try {
      // Write chunk to FFmpeg
      session.ffmpegProcess.stdin?.write(req.body);

      // Reset inactivity timeout
      clearTimeout(session.inactivityTimeout);
      session.inactivityTimeout = setTimeout(() => {
        console.log(`Inactivity detected on stream ${key}. Cleaning up.`);
        StreamController.stopStreamSession(key);
      }, 30000);

      return res.sendStatus(200);
    } catch (err) {
      console.error(`Error feeding video chunk to FFmpeg for ${key}:`, err);
      return res.status(500).send("Error feeding video stream.");
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

      await StreamController.stopStreamSession(key);
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
