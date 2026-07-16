import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { StreamService } from "../../module/stream/stream.service.js";

// Load environment variables
dotenv.config();

const HLS_SEGMENT_SECONDS = 2;
const STREAM_RETENTION_SECONDS = 600;
const DEFAULT_FPS = 20;
const X264_PRESET = process.env.X264_PRESET || "veryfast";
const X264_TUNE = process.env.X264_TUNE || "film";

const RESOLUTION_CONFIG = {
  "480p": { height: 480, defaultBitrate: 1000 },
  "720p": { height: 720, defaultBitrate: 900 },
  "1080p": { height: 1080, defaultBitrate: 2200 },
} as const;

type StreamResolution = keyof typeof RESOLUTION_CONFIG;

async function main() {
  const rawPath = process.env.MTX_PATH;
  const rawQuery = process.env.MTX_QUERY || "";

  if (!rawPath) {
    console.error("[on-publish] No MTX_PATH environment variable provided.");
    process.exit(1);
  }

  // Extract streamKey (e.g. "whip/live_1234abcd" -> "live_1234abcd")
  const streamKey = rawPath.replace(/^whip\//, "");
  console.log(`[on-publish] Starting transcode process for stream: ${streamKey}`);

  // Parse query params
  const queryParams = new URLSearchParams(rawQuery);
  const resolutionsParam = queryParams.get("resolutions") || "480p";
  const fpsParam = Math.min(Math.max(parseInt(queryParams.get("fps") || `${DEFAULT_FPS}`), 10), 30);
  const hasAudio = queryParams.get("hasAudio") === "true";

  // 1. Verify Stream Key in database
  const streamInfo = await StreamService.getStreamByKey(streamKey);
  if (!streamInfo) {
    console.error(`[on-publish] Stream key not found in database: ${streamKey}`);
    process.exit(1);
  }

  // 2. Prepare media folder for this stream
  const mediaDir = path.join(process.cwd(), "media", streamKey);
  try {
    if (fs.existsSync(mediaDir)) {
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
    fs.mkdirSync(mediaDir, { recursive: true });
  } catch (err) {
    console.error("[on-publish] Failed to prepare media directory:", err);
    process.exit(1);
  }

  // Parse resolutions array
  let resolutions = resolutionsParam
    .split(",")
    .filter((r): r is StreamResolution => r in RESOLUTION_CONFIG);
  if (resolutions.length === 0) {
    resolutions.push("480p");
  }

  // 3. Mark stream active in database
  await StreamService.setStreamActive(streamKey, true);
  console.log(`[on-publish] Set stream "${streamInfo.title}" active in database.`);

  // 4. Build dynamic ffmpeg process arguments
  // Input RTSP stream URL served by MediaMTX
  const inputRtspUrl = `rtsp://localhost:8554/${rawPath}`;
  
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

  // Strip trailing semicolon
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
    "-i", inputRtspUrl, // Read input from RTSP
    "-y",
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
      `-preset:v:${idx}`, X264_PRESET,
      `-tune:v:${idx}`, X264_TUNE,
      `-profile:v:${idx}`, "main",
      `-pix_fmt:v:${idx}`, "yuv420p"
    );

    fs.mkdirSync(path.join(mediaDir, idx.toString()), { recursive: true });
  });

  if (hasAudio) {
    ffmpegArgs.push(
      "-c:a", "aac",
      "-b:a", "96k",
      "-ac", "2",
      "-ar", "44100",
      "-af", "aresample=async=1:first_pts=0"
    );
  }

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

  console.log("[on-publish] Spawning FFmpeg with arguments:", ffmpegArgs.join(" "));
  const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

  ffmpegProcess.stdin.on("error", (err) => {
    console.error(`[on-publish] [ffmpeg stdin error]:`, err.message);
  });

  let stderrBuffer = "";
  ffmpegProcess.stderr.on("data", (data) => {
    stderrBuffer += data.toString();
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`[on-publish] [ffmpeg stderr]: ${line}`);
    }
  });

  // Handle rolling cleanup
  const rollingInterval = setInterval(() => {
    const now = Date.now();
    try {
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
              console.log(`[on-publish] [cleanup] Deleted old segment: ${file} (age: ${Math.round(ageSeconds)}s)`);
            }
          } catch (_) {}
        }
      }
    } catch (err) {
      console.error(`[on-publish] [cleanup] Rolling cleanup error:`, err);
    }
  }, 60_000);

  // Setup cleanup handler for exits
  let isCleanedUp = false;
  async function cleanup(reason: string) {
    if (isCleanedUp) return;
    isCleanedUp = true;

    console.log(`[on-publish] Cleaning up due to: ${reason}`);
    clearInterval(rollingInterval);

    // Terminate FFmpeg
    try {
      ffmpegProcess.kill("SIGTERM");
    } catch (_) {}

    // Set stream inactive
    try {
      await StreamService.setStreamActive(streamKey, false);
      console.log(`[on-publish] Set stream "${streamInfo.title}" inactive in database.`);
    } catch (err) {
      console.error(`[on-publish] Failed to set stream inactive:`, err);
    }

    // Wipe media files after 30s
    setTimeout(() => {
      try {
        if (fs.existsSync(mediaDir)) {
          fs.rmSync(mediaDir, { recursive: true, force: true });
          console.log(`[on-publish] Cleaned up media files for ${streamKey}`);
        }
      } catch (err) {
        console.error("[on-publish] Error cleaning up media files:", err);
      } finally {
        process.exit(0);
      }
    }, 30_000);
  }

  // Capture termination signals from MediaMTX
  process.on("SIGINT", () => cleanup("SIGINT from MediaMTX"));
  process.on("SIGTERM", () => cleanup("SIGTERM from MediaMTX"));
  
  ffmpegProcess.on("close", (code) => {
    cleanup(`FFmpeg process exited with code ${code}`);
  });
}

main().catch((err) => {
  console.error("[on-publish] Fatal error in main:", err);
  process.exit(1);
});
