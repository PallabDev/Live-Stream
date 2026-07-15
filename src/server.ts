import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { URL } from "url";

// Import modules
import authRoutes from "./app/module/auth/auth.routes.js";
import streamRoutes from "./app/module/stream/stream.routes.js";
import dashboardRoutes from "./app/module/dashboard/dashboard.routes.js";
import liveRoutes from "./app/module/live/live.routes.js";
import { StreamService } from "./app/module/stream/stream.service.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// Setup EJS views
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src", "views"));

// Middlewares
app.use(express.json({ limit: "50mb" })); // Support large speedtest upload bodies
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

// Serve static directories
app.use(express.static(path.join(process.cwd(), "public")));
// Serve live streams media chunks
app.use("/media", express.static(path.join(process.cwd(), "media"), {
  setHeaders: (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
  }
}));

// Setup routes
app.use(authRoutes);
app.use(streamRoutes);
app.use(dashboardRoutes);
app.use(liveRoutes);

// General fallback page for 404s
app.use((req, res) => {
  res.status(404).render("error", {
    title: "Page Not Found",
    message: "The page you are looking for does not exist.",
    user: null,
  });
});

// Setup WebSocket server for streaming ingest
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const parsedUrl = new URL(request.url || "", `http://${request.headers.host}`);
  
  if (parsedUrl.pathname === "/stream/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (ws: WebSocket, request) => {
  const parsedUrl = new URL(request.url || "", `http://${request.headers.host}`);
  const streamKey = parsedUrl.searchParams.get("key");
  const resolutionsParam = parsedUrl.searchParams.get("resolutions") || "720p";
  const fpsParam = parseInt(parsedUrl.searchParams.get("fps") || "30");
  const bitrateParam = parseInt(parsedUrl.searchParams.get("bitrate") || "2500");
  const hasAudio = parsedUrl.searchParams.get("hasAudio") === "true";

  if (!streamKey) {
    ws.close(4001, "Stream key required.");
    return;
  }

  // 1. Verify Stream Key in database
  const streamInfo = await StreamService.getStreamByKey(streamKey);
  if (!streamInfo) {
    ws.close(4002, "Invalid stream key.");
    return;
  }

  console.log(`Broadcaster connected for stream: "${streamInfo.title}" (${streamKey})`);
  console.log(`Settings: Resolutions=[${resolutionsParam}], FPS=${fpsParam}, Bitrate=${bitrateParam}Kbps, HasAudio=${hasAudio}`);

  // 2. Prepare media folder for this stream
  const mediaDir = path.join(process.cwd(), "media", streamKey);
  try {
    if (fs.existsSync(mediaDir)) {
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
    fs.mkdirSync(mediaDir, { recursive: true });
  } catch (err) {
    console.error("Failed to prepare media directory:", err);
    ws.close(1011, "Server filesystem error.");
    return;
  }

  // Parse resolutions array
  const resolutions = resolutionsParam.split(",").filter(r => ["480p", "720p", "1080p"].includes(r));
  if (resolutions.length === 0) {
    resolutions.push("720p"); // Default fallback
  }

  // 3. Mark stream active in database
  await StreamService.setStreamActive(streamKey, true);

  // 4. Build dynamic ffmpeg process arguments
  // Filter complex to scale video to multiple variants
  let filterComplex = "";
  if (resolutions.length > 1) {
    const splits = resolutions.map((_, idx) => `[v${idx + 1}]`).join("");
    filterComplex += `[0:v]split=${resolutions.length}${splits};`;
    resolutions.forEach((res, idx) => {
      const height = res === "480p" ? 480 : res === "720p" ? 720 : 1080;
      filterComplex += `[v${idx + 1}]scale=w=-2:h=${height}[v${idx + 1}out];`;
    });
  } else {
    const height = resolutions[0] === "480p" ? 480 : resolutions[0] === "720p" ? 720 : 1080;
    filterComplex += `[0:v]scale=w=-2:h=${height}[v1out]`;
  }

  // Strip trailing semicolon to prevent FFmpeg "No such filter: ''" syntax error
  if (filterComplex.endsWith(";")) {
    filterComplex = filterComplex.slice(0, -1);
  }

  const ffmpegArgs = [
    "-f", "matroska", // Explicitly define input format as Matroska (WebM) to prevent probing errors
    "-i", "pipe:0", // Read input from standard input (WebSocket packets)
    "-y", // Overwrite output files
    "-filter_complex", filterComplex
  ];

  // Map video profiles and configurations for each resolution
  resolutions.forEach((res, idx) => {
    // Distribute bitrates as per quality levels
    let videoBitrate = "2200k";
    if (res === "480p") videoBitrate = "900k";
    if (res === "1080p") videoBitrate = "4800k";

    // If only one resolution, let user customize the target bitrate
    if (resolutions.length === 1) {
      videoBitrate = `${bitrateParam}k`;
    }

    const keyInterval = fpsParam * 2; // Keyframe every 2 seconds for perfect HLS splitting

    ffmpegArgs.push("-map", `[v${idx + 1}out]`);

    ffmpegArgs.push(
      `-c:v:${idx}`, "libx264",
      `-b:v:${idx}`, videoBitrate,
      `-maxrate:v:${idx}`, videoBitrate,
      `-bufsize:v:${idx}`, `${parseInt(videoBitrate) * 2}k`,
      `-r:v:${idx}`, fpsParam.toString(),
      `-g:v:${idx}`, keyInterval.toString(),
      `-keyint_min:v:${idx}`, keyInterval.toString(),
      `-sc_threshold:v:${idx}`, "0",
      `-preset:v:${idx}`, "veryfast",
      `-tune:v:${idx}`, "zerolatency"
    );

    // Create subdirectories for variant playlists
    fs.mkdirSync(path.join(mediaDir, idx.toString()), { recursive: true });
  });

  // Audio parameters: high quality AAC stereo (only if source contains audio)
  if (hasAudio) {
    ffmpegArgs.push(
      "-map", "0:a?",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ac", "2"
    );
  }

  // HLS packing configuration: map the single output audio stream `a:0` to all video variants
  const varStreamMap = resolutions.map((_, idx) => hasAudio ? `v:${idx},a:0` : `v:${idx}`).join(" ");
  ffmpegArgs.push(
    "-f", "hls",
    "-hls_time", "2", // 2 second chunks for ultra low latency
    "-hls_list_size", "5", // Keep last 5 chunks
    "-hls_flags", "delete_segments+omit_endlist", // Auto-delete older chunks, don't write EOF tag to keep playlist live
    "-hls_segment_filename", path.join(mediaDir, "%v", "file%03d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", varStreamMap,
    path.join(mediaDir, "%v", "index.m3u8")
  );

  // Spawn ffmpeg
  console.log("Spawning ffmpeg with arguments:", ffmpegArgs.join(" "));
  const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

  // Handle unhandled EPIPE write errors if the ffmpeg process crashes/exits
  ffmpegProcess.stdin.on("error", (err) => {
    console.error(`[ffmpeg stdin error] for stream ${streamKey}:`, err.message);
  });

  ffmpegProcess.stdout.on("data", (data) => {
    // console.log(`[ffmpeg stdout]: ${data}`);
  });

  ffmpegProcess.stderr.on("data", (data) => {
    // ffmpeg writes transcode statistics to stderr
    console.error(`[ffmpeg stderr]: ${data}`);
  });

  ffmpegProcess.on("close", (code) => {
    console.log(`ffmpeg process for stream ${streamKey} exited with code ${code}`);
  });

  ffmpegProcess.on("error", (err) => {
    console.error(`ffmpeg process error for stream ${streamKey}:`, err);
  });

  ws.on("message", (message: Buffer) => {
    if (ffmpegProcess.stdin.writable) {
      ffmpegProcess.stdin.write(message);
    }
  });

  ws.on("close", async () => {
    console.log(`Broadcaster disconnected. Stopping stream ${streamKey}`);
    
    // Set stream inactive
    await StreamService.setStreamActive(streamKey, false);

    // Stop ffmpeg process
    try {
      ffmpegProcess.stdin.end();
      ffmpegProcess.kill("SIGTERM");
    } catch (e) {
      // already stopped
    }

    // Optional: Keep media for a few seconds so viewer buffers can finish, then clean up
    setTimeout(() => {
      try {
        if (fs.existsSync(mediaDir)) {
          fs.rmSync(mediaDir, { recursive: true, force: true });
          console.log(`Cleaned up media files for ${streamKey}`);
        }
      } catch (err) {
        console.error("Cleanup error:", err);
      }
    }, 15000);
  });
});

// Run migrations on start, then listen
server.listen(port, () => {
  console.log(`CoWatch streaming server running at http://localhost:${port}`);
});
