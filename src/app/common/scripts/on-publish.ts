import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { StreamService } from "../../module/stream/stream.service.js";

// Load environment variables
dotenv.config();

const HLS_SEGMENT_SECONDS = 4;
const STREAM_RETENTION_SECONDS = 600;
const DEFAULT_FPS = 30;
const X264_PRESET = process.env.X264_PRESET || "superfast";
const X264_TUNE = process.env.X264_TUNE || "film";

const RESOLUTION_CONFIG = {
  "480p": { height: 480, maxBitrate: 3000, bufSize: 4500 },
  "720p": { height: 720, maxBitrate: 6000, bufSize: 9000 },
  "1080p": { height: 1080, maxBitrate: 12000, bufSize: 18000 },
} as const;

type StreamResolution = keyof typeof RESOLUTION_CONFIG;

async function main() {
  const rawPath = process.env.MTX_PATH;

  if (!rawPath) {
    console.error("[on-publish] No MTX_PATH environment variable provided.");
    process.exit(1);
  }

  // Extract streamKey (e.g. "whip/live_1234abcd" -> "live_1234abcd")
  const streamKey = rawPath.split("/").pop() || "";
  console.log(`[on-publish] Starting streaming process for stream: ${streamKey}`);

  // 1. Verify Stream Key in database
  const streamInfo = await StreamService.getStreamByKey(streamKey);
  if (!streamInfo) {
    console.error(`[on-publish] Stream key not found in database: ${streamKey}`);
    process.exit(1);
  }

  const isRaw = !!streamInfo.isRaw;
  const resolutionsStr = streamInfo.resolutions || "480p,1080p";

  // 2. Prepare media folder for this stream
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, "../../../../");
  const mediaDir = path.resolve(projectRoot, "media", streamKey);
  try {
    if (fs.existsSync(mediaDir)) {
      fs.rmSync(mediaDir, { recursive: true, force: true });
    }
    fs.mkdirSync(mediaDir, { recursive: true });
  } catch (err) {
    console.error("[on-publish] Failed to prepare media directory:", err);
    process.exit(1);
  }

  // 3. Mark stream active in database
  await StreamService.setStreamActive(streamKey, true);
  console.log(`[on-publish] Set stream "${streamInfo.title}" active in database.`);

  const inputRtspUrl = `rtsp://localhost:8554/${rawPath}`;

  // 4. Run ffprobe to detect if stream contains audio
  let hasAudio = false;
  try {
    const { execSync } = await import("child_process");
    const probeCmd = `ffprobe -rtsp_transport tcp -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${inputRtspUrl}"`;
    const probeResult = execSync(probeCmd).toString().trim();
    hasAudio = probeResult.includes("audio");
    console.log(`[on-publish] ffprobe audio detection result: hasAudio=${hasAudio}`);
  } catch (probeErr: any) {
    console.warn(`[on-publish] ffprobe failed to detect audio, defaulting to true:`, probeErr.message);
    hasAudio = true;
  }

  // Parse resolutions array
  let resolutions: string[] = [];
  if (isRaw) {
    resolutions = ["raw"];
  } else {
    resolutions = resolutionsStr
      .split(",")
      .filter((r): r is StreamResolution => r in RESOLUTION_CONFIG);
    if (resolutions.length === 0) {
      resolutions.push("480p");
    }
  }

  let ffmpegArgs: string[] = [];

  if (isRaw) {
    console.log(`[on-publish] Raw streaming mode enabled. Enabling ZERO-TRANSCODE direct copy mode.`);
    ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "warning",
      "-stats_period", "5",
      "-progress", "pipe:2",
      "-fflags", "+genpts+discardcorrupt",
      "-err_detect", "ignore_err",
      "-thread_queue_size", "1024",
      "-rtsp_transport", "tcp",
      "-i", inputRtspUrl, // Read input from RTSP
      "-y",
      "-map", "0:v:0"
    ];
    if (hasAudio) {
      ffmpegArgs.push("-map", "0:a?");
    }
    ffmpegArgs.push("-c:v:0", "copy");
    if (hasAudio) {
      ffmpegArgs.push("-c:a:0", "copy");
    }
    fs.mkdirSync(path.join(mediaDir, "0"), { recursive: true });
  } else {
    console.log(`[on-publish] Transcoding stream (resolutions: ${resolutions.join(",")}) using software transcoder.`);
    const fpsParam = DEFAULT_FPS;
    let filterComplex = "";
    if (resolutions.length > 1) {
      const splits = resolutions.map((_, idx) => `[v${idx + 1}]`).join("");
      filterComplex += `[0:v]split=${resolutions.length}${splits};`;
      resolutions.forEach((res, idx) => {
        filterComplex += `[v${idx + 1}]scale=w=-2:h=${RESOLUTION_CONFIG[res as StreamResolution].height}:flags=lanczos[v${idx + 1}out];`;
      });
    } else {
      filterComplex += `[0:v]scale=w=-2:h=${RESOLUTION_CONFIG[resolutions[0] as StreamResolution].height}:flags=lanczos[v1out]`;
    }

    // Strip trailing semicolon to prevent FFmpeg "No such filter: ''" crash
    if (filterComplex.endsWith(";")) {
      filterComplex = filterComplex.slice(0, -1);
    }

    ffmpegArgs = [
      "-hide_banner",
      "-loglevel", "warning",
      "-stats_period", "5",
      "-progress", "pipe:2",
      "-fflags", "+genpts+discardcorrupt",
      "-err_detect", "ignore_err",
      "-thread_queue_size", "2048",
      "-rtsp_transport", "tcp",
      "-i", inputRtspUrl, // Read input from RTSP
      "-y",
      "-filter_complex", filterComplex
    ];

    // Map video profiles and configurations for each resolution
    resolutions.forEach((res, idx) => {
      const config = RESOLUTION_CONFIG[res as StreamResolution];
      const keyInterval = fpsParam * HLS_SEGMENT_SECONDS;
 
      ffmpegArgs.push("-map", `[v${idx + 1}out]`);
      if (hasAudio) {
        ffmpegArgs.push("-map", "0:a?");
      }
 
      ffmpegArgs.push(
        `-c:v:${idx}`, "libx264",
        `-r:v:${idx}`, fpsParam.toString(),
        `-crf:v:${idx}`, "18",
        `-maxrate:v:${idx}`, `${config.maxBitrate}k`,
        `-bufsize:v:${idx}`, `${config.bufSize}k`,
        `-g:v:${idx}`, keyInterval.toString(),
        `-keyint_min:v:${idx}`, keyInterval.toString(),
        `-force_key_frames:v:${idx}`, `expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
        `-sc_threshold:v:${idx}`, "0",
        `-preset:v:${idx}`, X264_PRESET,
        `-tune:v:${idx}`, X264_TUNE,
        `-profile:v:${idx}`, "high",
        `-pix_fmt:v:${idx}`, "yuv420p"
      );
 
      fs.mkdirSync(path.join(mediaDir, idx.toString()), { recursive: true });
    });
  }

  if (hasAudio) {
    ffmpegArgs.push(
      "-c:a", "aac",
      "-b:a", "320k",
      "-ac", "2",
      "-ar", "48000",
      "-af", "aresample=async=1:first_pts=0"
    );
  }

  const varStreamMap = resolutions.map((_, idx) => hasAudio ? `v:${idx},a:${idx}` : `v:${idx}`).join(" ");
  ffmpegArgs.push(
    "-vsync", "cfr",
    "-async", "1",
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

  // Monitor FFmpeg CPU usage
  let lastCpuTicks = 0;
  let lastSampleTime = Date.now();

  const getCpuTicks = (pid: number): Promise<number | null> => {
    return new Promise((resolve) => {
      fs.readFile(`/proc/${pid}/stat`, "utf8", (err, data) => {
        if (err) return resolve(null);
        const parts = data.trim().split(/\s+/);
        if (parts.length < 15) return resolve(null);
        const utime = parseInt(parts[13], 10);
        const stime = parseInt(parts[14], 10);
        resolve(utime + stime);
      });
    });
  };

  const cpuMonitorInterval = setInterval(async () => {
    if (!ffmpegProcess.pid) return;
    const ticks = await getCpuTicks(ffmpegProcess.pid);
    if (ticks === null) return;

    const now = Date.now();
    if (lastCpuTicks > 0) {
      const elapsedSeconds = (now - lastSampleTime) / 1000;
      const deltaTicks = ticks - lastCpuTicks;
      const cpuPercentage = ((deltaTicks / 100) / elapsedSeconds) * 100;
      console.log(`[on-publish] [cpu status] FFmpeg (PID ${ffmpegProcess.pid}) CPU usage: ${cpuPercentage.toFixed(1)}%`);
    }
    lastCpuTicks = ticks;
    lastSampleTime = now;
  }, 5000);

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

      // Parse speed from ffmpeg stats line
      const match = line.match(/^speed=\s*([\d\.]+)x/);
      if (match) {
        const speed = parseFloat(match[1]);
        if (speed < 1.0) {
          console.warn(`[on-publish] [speed warning] FFmpeg transcoding speed is below real-time: ${speed}x (transcoding is lagging behind!)`);
        } else {
          console.log(`[on-publish] [speed status] FFmpeg transcoding speed is healthy: ${speed}x`);
        }
      }
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
    clearInterval(cpuMonitorInterval);

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
    setTimeout(async () => {
      try {
        // Query database to check if the stream has restarted in the meantime
        const currentStream = await StreamService.getStreamByKey(streamKey);
        if (currentStream && currentStream.isActive) {
          console.log(`[on-publish] [cleanup bypass] Stream ${streamKey} has restarted and is active. Skipping media directory deletion.`);
          return;
        }

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
