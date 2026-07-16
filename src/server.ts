import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import fs from "fs";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
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

const HLS_SEGMENT_SECONDS = 2;
const STREAM_RETENTION_SECONDS = 600;
const MAX_FPS = 30;
const MIN_VIDEO_BITRATE_KBPS = 400;
const MAX_VIDEO_BITRATE_KBPS = 2200;
const AUDIO_BITRATE_KBPS = 96;
const RESOLUTION_CONFIG = {
    "480p": { height: 480, defaultBitrate: 500, maxBitrate: 500 },
    "720p": { height: 720, defaultBitrate: 900, maxBitrate: 900 },
    "1080p": { height: 1080, defaultBitrate: 2200, maxBitrate: 2200 },
} as const;

type StreamResolution = keyof typeof RESOLUTION_CONFIG;
type ActiveIngest = {
    ws: WebSocket;
    ffmpegProcess: ChildProcessWithoutNullStreams;
    rollingInterval: NodeJS.Timeout;
    healthInterval: NodeJS.Timeout;
};

function clampNumber(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function getSegmentNumber(fileName: string) {
    const match = fileName.match(/^file(\d+)\.ts$/);
    return match ? parseInt(match[1], 10) : null;
}

function stopActiveIngest(streamKey: string, reason: string) {
    const active = activeIngests.get(streamKey);
    if (!active) return;

    console.log(`Stopping existing ingest for ${streamKey}: ${reason}`);
    activeIngests.delete(streamKey);
    activeRollingCleanups.delete(streamKey);
    clearInterval(active.rollingInterval);
    clearInterval(active.healthInterval);

    try {
        if (active.ws.readyState === WebSocket.OPEN || active.ws.readyState === WebSocket.CONNECTING) {
            active.ws.close(1012, reason);
        }
    } catch (_) {
        // Already closed.
    }

    try {
        if (active.ffmpegProcess.stdin.writable) {
            active.ffmpegProcess.stdin.end();
        }
        active.ffmpegProcess.kill("SIGTERM");
    } catch (_) {
        // Already stopped.
    }
}

// Track active media cleanup timers to prevent race conditions on quick reconnection
const activeCleanups = new Map<string, NodeJS.Timeout>();
// Track per-stream rolling cleanup intervals (delete segments older than 10 min)
const activeRollingCleanups = new Map<string, NodeJS.Timeout>();
const activeIngests = new Map<string, ActiveIngest>();

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
// etag:false + lastModified:false prevents browsers from sending If-None-Match / If-Modified-Since
// which would cause a 304 "Not Modified" response and serve a stale cached playlist to the player.
app.use("/media", express.static(path.join(process.cwd(), "media"), {
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        // Playlists must never be cached; segments can use short cache.
        if (filePath.endsWith(".m3u8")) {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
        } else {
            // .ts segments: allow brief caching since content is immutable once written
            res.setHeader("Cache-Control", "public, max-age=60");
        }
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
    const requestedFps = parseInt(parsedUrl.searchParams.get("fps") || "30", 10);
    const fpsParam = clampNumber(Number.isFinite(requestedFps) ? requestedFps : 30, 24, MAX_FPS);
    const requestedBitrate = parseInt(parsedUrl.searchParams.get("bitrate") || "900", 10);
    const bitrateParam = clampNumber(
        Number.isFinite(requestedBitrate) ? requestedBitrate : 900,
        MIN_VIDEO_BITRATE_KBPS,
        MAX_VIDEO_BITRATE_KBPS
    );
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

    // Cancel any pending media cleanup timer for this stream key if the broadcaster reconnected quickly
    const existingTimer = activeCleanups.get(streamKey);
    if (existingTimer) {
        clearTimeout(existingTimer);
        activeCleanups.delete(streamKey);
        console.log(`Cancelled pending media cleanup timer for stream ${streamKey} due to reconnection.`);
    }

    stopActiveIngest(streamKey, "New broadcaster connection replaced the previous ingest.");

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
    let resolutions = resolutionsParam
        .split(",")
        .filter((r): r is StreamResolution => r in RESOLUTION_CONFIG);
    if (resolutions.length === 0) {
        resolutions.push("720p");
    }

    // 3. Mark stream active in database
    await StreamService.setStreamActive(streamKey, true);

    // 4. Build dynamic ffmpeg process arguments
    // Filter complex to scale video to multiple variants
    let filterComplex = "";
    if (resolutions.length > 1) {
        const splits = resolutions.map((_, idx) => `[v${idx + 1}]`).join("");
        filterComplex += `[0:v]fps=fps=${fpsParam}:round=down,setpts=N/(${fpsParam}*TB)[vfps];[vfps]split=${resolutions.length}${splits};`;
        resolutions.forEach((res, idx) => {
            filterComplex += `[v${idx + 1}]scale=w=-2:h=${RESOLUTION_CONFIG[res].height}:flags=fast_bilinear[v${idx + 1}out];`;
        });
    } else {
        filterComplex += `[0:v]fps=fps=${fpsParam}:round=down,setpts=N/(${fpsParam}*TB),scale=w=-2:h=${RESOLUTION_CONFIG[resolutions[0]].height}:flags=fast_bilinear[v1out]`;
    }

    // Strip trailing semicolon to prevent FFmpeg "No such filter: ''" syntax error
    if (filterComplex.endsWith(";")) {
        filterComplex = filterComplex.slice(0, -1);
    }

    const ffmpegArgs = [
        "-hide_banner",
        "-loglevel", "warning",
        "-stats_period", "5",
        "-progress", "pipe:2",
        "-fflags", "+genpts+discardcorrupt",
        "-err_detect", "ignore_err",
        "-thread_queue_size", "1024",
        "-probesize", "2M",
        "-analyzeduration", "2M",
        "-f", "matroska", // Explicitly define input format as Matroska (WebM) to prevent probing errors
        "-i", "pipe:0", // Read input from standard input (WebSocket packets)
        "-y", // Overwrite output files
        "-filter_complex", filterComplex
    ];

    // Map video profiles and configurations for each resolution
    resolutions.forEach((res, idx) => {
        const config = RESOLUTION_CONFIG[res];
        const bitrateKbps = config.defaultBitrate;
        const videoBitrate = `${bitrateKbps}k`;

        const keyInterval = fpsParam * HLS_SEGMENT_SECONDS;

        ffmpegArgs.push("-map", `[v${idx + 1}out]`);
        if (hasAudio) {
            ffmpegArgs.push("-map", "0:a?");
        }

        ffmpegArgs.push(
            `-c:v:${idx}`, "libx264",
            `-b:v:${idx}`, videoBitrate,
            `-maxrate:v:${idx}`, videoBitrate,
            `-bufsize:v:${idx}`, `${Math.round(bitrateKbps * 1.5)}k`,
            `-g:v:${idx}`, keyInterval.toString(),
            `-keyint_min:v:${idx}`, keyInterval.toString(),
            `-force_key_frames:v:${idx}`, `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
            `-sc_threshold:v:${idx}`, "0",
            `-preset:v:${idx}`, "fast",
            `-tune:v:${idx}`, "film",
            `-profile:v:${idx}`, "main",
            `-pix_fmt:v:${idx}`, "yuv420p"
        );

        // Create subdirectories for variant playlists
        fs.mkdirSync(path.join(mediaDir, idx.toString()), { recursive: true });
    });

    // Audio parameters: high quality AAC stereo (only if source contains audio)
    if (hasAudio) {
        ffmpegArgs.push(
            "-c:a", "aac",
            "-b:a", `${AUDIO_BITRATE_KBPS}k`,
            "-ac", "2",
            "-ar", "44100",
            "-af", "aresample=async=1:first_pts=0"
        );
    }

    // HLS packing configuration
    // hls_list_size keeps the last 10 minutes in the playlist.
    // omit_endlist keeps the stream marked as live.
    // NO delete_segments; we manage deletion ourselves with a rolling 10-minute window.
    const varStreamMap = resolutions.map((_, idx) => hasAudio ? `v:${idx},a:${idx}` : `v:${idx}`).join(" ");
    ffmpegArgs.push(
        "-max_muxing_queue_size", "1024",
        "-f", "hls",
        "-hls_time", HLS_SEGMENT_SECONDS.toString(),
        "-hls_list_size", Math.ceil(STREAM_RETENTION_SECONDS / HLS_SEGMENT_SECONDS).toString(),
        "-hls_flags", "omit_endlist+independent_segments+temp_file",
        "-hls_segment_filename", path.join(mediaDir, "%v", "file%06d.ts"),
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

    const ffmpegProgress: Record<string, string> = {};
    let stderrBuffer = "";

    ffmpegProcess.stderr.on("data", (data) => {
        stderrBuffer += data.toString();
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() || "";

        for (const line of lines) {
            if (!line.trim()) continue;

            const progressMatch = line.match(/^([a-zA-Z_]+)=(.*)$/);
            if (progressMatch) {
                ffmpegProgress[progressMatch[1]] = progressMatch[2];

                if (progressMatch[1] === "progress") {
                    console.log(
                        `[ffmpeg progress] stream=${streamKey} fps=${ffmpegProgress.fps || "?"} ` +
                        `out=${ffmpegProgress.out_time || "?"} speed=${ffmpegProgress.speed || "?"} ` +
                        `frame=${ffmpegProgress.frame || "?"}`
                    );
                }
                continue;
            }

            console.error(`[ffmpeg stderr]: ${line}`);
        }
    });

    ffmpegProcess.on("close", (code) => {
        console.log(`ffmpeg process for stream ${streamKey} exited with code ${code}`);
    });

    ffmpegProcess.on("error", (err) => {
        console.error(`ffmpeg process error for stream ${streamKey}:`, err);
    });

    // Rolling 10-minute segment retention: every 60 seconds delete .ts files
    // older than 600 seconds so disk doesn't fill up during long streams.
    const rollingInterval = setInterval(() => {
        const now = Date.now();
        try {
            // Iterate each resolution variant subdirectory (0/, 1/, 2/ ...)
            const variantDirs = fs.readdirSync(mediaDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => path.join(mediaDir, d.name));

            for (const varDir of variantDirs) {
                const files = fs.readdirSync(varDir).filter(f => f.endsWith(".ts"));
                for (const file of files) {
                    const filePath = path.join(varDir, file);
                    try {
                        const stat = fs.statSync(filePath);
                        const ageSeconds = (now - stat.mtimeMs) / 1000;
                        if (ageSeconds > STREAM_RETENTION_SECONDS) {
                            fs.unlinkSync(filePath);
                            console.log(`[cleanup] Deleted old segment: ${file} (age: ${Math.round(ageSeconds)}s)`);
                        }
                    } catch (_) { /* file may have been deleted already */ }
                }
            }
        } catch (err) {
            console.error(`[cleanup] Rolling cleanup error for ${streamKey}:`, err);
        }
    }, 60_000); // run every 60 seconds

    activeRollingCleanups.set(streamKey, rollingInterval);

    const lastPublishedByVariant = new Map<number, { segment: number; at: number }>();
    const healthInterval = setInterval(() => {
        const now = Date.now();

        resolutions.forEach((res, idx) => {
            const variantDir = path.join(mediaDir, idx.toString());
            try {
                const segmentFiles = fs.readdirSync(variantDir)
                    .map((file) => ({ file, segment: getSegmentNumber(file) }))
                    .filter((item): item is { file: string; segment: number } => item.segment !== null)
                    .sort((a, b) => a.segment - b.segment);

                if (segmentFiles.length === 0) {
                    console.log(`[segment health] stream=${streamKey} variant=${idx}:${res} no_segments_yet`);
                    return;
                }

                const latest = segmentFiles[segmentFiles.length - 1];
                const latestPath = path.join(variantDir, latest.file);
                const latestStat = fs.statSync(latestPath);
                const previous = lastPublishedByVariant.get(idx);
                let publishGapSec: number | null = null;

                if (!previous || previous.segment !== latest.segment) {
                    publishGapSec = previous ? (now - previous.at) / 1000 : null;
                    lastPublishedByVariant.set(idx, { segment: latest.segment, at: now });
                }

                console.log(
                    `[segment health] stream=${streamKey} variant=${idx}:${res} ` +
                    `latest=${latest.segment} count=${segmentFiles.length} ` +
                    `latestAgeSec=${((now - latestStat.mtimeMs) / 1000).toFixed(2)} ` +
                    `publishGapSec=${publishGapSec === null ? "n/a" : publishGapSec.toFixed(2)}`
                );
            } catch (err: any) {
                console.warn(`[segment health] stream=${streamKey} variant=${idx}:${res} error=${err.message}`);
            }
        });
    }, 5_000);

    activeIngests.set(streamKey, { ws, ffmpegProcess, rollingInterval, healthInterval });

    ws.on("message", (message: Buffer) => {
        if (ffmpegProcess.stdin.writable) {
            ffmpegProcess.stdin.write(message);
        }
    });

    ws.on("close", async () => {
        console.log(`Broadcaster disconnected. Stopping stream ${streamKey}`);
        const currentIngest = activeIngests.get(streamKey);
        const isCurrentIngest = currentIngest?.ws === ws;

        if (!isCurrentIngest) {
            clearInterval(rollingInterval);
            clearInterval(healthInterval);
            try {
                if (ffmpegProcess.stdin.writable) {
                    ffmpegProcess.stdin.end();
                }
                ffmpegProcess.kill("SIGTERM");
            } catch (_) {
                // Already stopped.
            }
            console.log(`Ignored stale disconnect for replaced stream ${streamKey}`);
            return;
        }

        activeIngests.delete(streamKey);

        // Stop rolling cleanup interval for this stream
        const rollingCleanup = activeRollingCleanups.get(streamKey);
        if (rollingCleanup) {
            clearInterval(rollingCleanup);
            activeRollingCleanups.delete(streamKey);
        }
        clearInterval(healthInterval);

        // Set stream inactive
        await StreamService.setStreamActive(streamKey, false);

        // Stop ffmpeg process
        try {
            ffmpegProcess.stdin.end();
            ffmpegProcess.kill("SIGTERM");
        } catch (e) {
            // already stopped
        }

        // Keep media for 30s so viewer buffers can drain, then wipe everything
        const cleanupTimeout = setTimeout(() => {
            try {
                if (fs.existsSync(mediaDir)) {
                    fs.rmSync(mediaDir, { recursive: true, force: true });
                    console.log(`Cleaned up all media files for ${streamKey}`);
                }
            } catch (err) {
                console.error("Cleanup error:", err);
            } finally {
                activeCleanups.delete(streamKey);
            }
        }, 30000);

        activeCleanups.set(streamKey, cleanupTimeout);
    });
});

// Run migrations on start, then listen
server.listen(port, () => {
    console.log(`CoWatch streaming server running at http://localhost:${port}`);
});
