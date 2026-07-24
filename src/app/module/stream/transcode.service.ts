import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import path from "path";
import { MonitorService } from "../../common/monitor/monitor.service.js";
import { SFTPService } from "../../common/sftp/sftp.service.js";
import { StreamService } from "./stream.service.js";

type PipelineStatus = "idle" | "waiting_for_obs" | "starting" | "active" | "failed" | "stopped";

interface ProbeResult {
  ready: boolean;
  hasAudio: boolean;
  inputUrl?: string;
  error?: string;
}

interface PipelineState {
  streamKey: string;
  status: PipelineStatus;
  process?: ChildProcessWithoutNullStreams;
  wantsRun: boolean;
  attemptInFlight: boolean;
  hasAudio: boolean;
  inputUrl?: string;
  startedAt?: number;
  lastReadyAt?: number;
  lastExitCode?: number | null;
  lastError?: string;
  retryTimer?: NodeJS.Timeout;
  playlistTimer?: NodeJS.Timeout;
  sftpUploadedMap?: Map<string, number>;
}

const SAFE_STREAM_KEY_RE = /^[a-zA-Z0-9_-]+$/;
const RETRY_DELAY_MS = 5000;
const PLAYLIST_CHECK_MS = 1000;
const DEFAULT_PLAYLIST_STALE_MS = 15000;

function log(streamKey: string, message: string) {
  const line = `[Transcode:${streamKey}] ${message}`;
  console.log(line);
  MonitorService.addLog(line);
}

function getMediaRoot() {
  return path.resolve(process.cwd(), "media");
}

function getStreamMediaDir(streamKey: string) {
  return path.join(getMediaRoot(), streamKey);
}

function getMasterPlaylistPath(streamKey: string) {
  return path.join(getStreamMediaDir(streamKey), "master.m3u8");
}

function getVariantPlaylistPath(streamKey: string) {
  return path.join(getStreamMediaDir(streamKey), "480p", "index.m3u8");
}

function expandInputTemplate(template: string, streamKey: string) {
  return template.replaceAll("{streamKey}", streamKey);
}

function getInputCandidates(streamKey: string) {
  const configured =
    process.env.STREAM_INTERNAL_SOURCES ||
    process.env.STREAM_INTERNAL_SOURCE ||
    process.env.RTMP_INTERNAL_SOURCE ||
    [
      "rtsp://host.docker.internal:8554/live/{streamKey}",
      "rtsp://host.docker.internal:8554/{streamKey}",
      "rtmp://host.docker.internal:1935/live/{streamKey}",
    ].join(",");

  return configured
    .split(",")
    .map((template) => expandInputTemplate(template.trim(), streamKey))
    .filter(Boolean);
}

function isRtspInput(inputUrl: string) {
  return inputUrl.toLowerCase().startsWith("rtsp://");
}

function buildRtmpPublicUrl(hostname: string) {
  const configured = process.env.RTMP_PUBLIC_SERVER;
  if (configured) return configured.replace(/\/$/, "");
  return `rtmp://${hostname}:1935/live`;
}

function cleanMediaDir(streamKey: string) {
  const mediaDir = getStreamMediaDir(streamKey);
  if (fs.existsSync(mediaDir)) {
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(mediaDir, "480p"), { recursive: true });
  SFTPService.clearRemoteStreamDir(streamKey).catch(() => {});
}

function writeMasterPlaylist(streamKey: string) {
  const masterPath = getMasterPlaylistPath(streamKey);
  const cdnUrl = SFTPService.getPublicCdnUrl(streamKey);
  const content = `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=912000,RESOLUTION=854x480,CODECS="avc1.42e01f,mp4a.40.2"\n${cdnUrl}\n`;
  try {
    fs.writeFileSync(masterPath, content, "utf8");
  } catch (_) {}
}

function playlistExists(streamKey: string) {
  const variant = getVariantPlaylistPath(streamKey);
  const master = getMasterPlaylistPath(streamKey);
  const target = fs.existsSync(variant) ? variant : master;
  if (!fs.existsSync(target)) return false;
  try {
    const stats = fs.statSync(target);
    const staleMs = Number(process.env.HLS_PLAYLIST_STALE_MS || DEFAULT_PLAYLIST_STALE_MS);
    if (Date.now() - stats.mtimeMs > staleMs) return false;
    const content = fs.readFileSync(target, "utf8");
    return content.includes("#EXTINF") || content.includes("#EXT-X-STREAM-INF");
  } catch (_) {
    return false;
  }
}

function getScaleFilter(hasAudio: boolean) {
  return "[0:v:0]scale=w=854:h=-2:flags=fast_bilinear[v480]";
}

function buildFfmpegArgs(streamKey: string, inputUrl: string, hasAudio: boolean): string[] {
  const mediaDir = getStreamMediaDir(streamKey);
  const segmentPattern = path.join(mediaDir, "%v", "seg_%06d.ts");
  const variantPattern = path.join(mediaDir, "%v", "index.m3u8");
  const keyframeSeconds = Number(process.env.HLS_KEYFRAME_SECONDS || "2");
  const fps = Number(process.env.HLS_OUTPUT_FPS || "30");
  const keyframeInterval = Math.max(1, Math.round(fps * keyframeSeconds));
  const preset = process.env.X264_PRESET_480 || process.env.X264_PRESET || "superfast";

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-stats_period", "5",
    "-analyzeduration", "2000000",
    "-probesize", "2000000",
    "-fflags", "+genpts+discardcorrupt+nobuffer",
    "-err_detect", "ignore_err",
    "-thread_queue_size", "4096",
  ];

  if (isRtspInput(inputUrl)) {
    args.push(
      "-rtsp_transport", "tcp",
      "-stimeout", process.env.STREAM_INPUT_TIMEOUT_US || "15000000",
    );
  } else if (inputUrl.toLowerCase().startsWith("rtmp://")) {
    args.push(
      "-rtmp_live", "live",
      "-rw_timeout", process.env.STREAM_INPUT_TIMEOUT_US || "15000000",
    );
  }

  args.push(
    "-i", inputUrl,
    "-filter_complex", getScaleFilter(hasAudio),
  );

  if (hasAudio) {
    args.push(
      "-map", "[v480]",
      "-map", "0:a:0",
      "-c:v:0", "libx264",
      "-preset:v:0", preset,
      "-tune:v:0", "zerolatency",
      "-r:v:0", fps.toString(),
      "-g:v:0", keyframeInterval.toString(),
      "-keyint_min:v:0", keyframeInterval.toString(),
      "-sc_threshold:v:0", "0",
      "-b:v:0", process.env.HLS_480_VIDEO_BITRATE || "800k",
      "-maxrate:v:0", process.env.HLS_480_VIDEO_MAXRATE || "1000k",
      "-bufsize:v:0", process.env.HLS_480_VIDEO_BUFSIZE || "1600k",
      "-pix_fmt:v:0", "yuv420p",
      "-c:a:0", "aac",
      "-b:a:0", "112k",
      "-ac:a:0", "2",
      "-ar:a:0", "48000",
      "-var_stream_map", "v:0,a:0,name:480p",
    );
  } else {
    args.push(
      "-map", "[v480]",
      "-c:v:0", "libx264",
      "-preset:v:0", preset,
      "-tune:v:0", "zerolatency",
      "-r:v:0", fps.toString(),
      "-g:v:0", keyframeInterval.toString(),
      "-keyint_min:v:0", keyframeInterval.toString(),
      "-sc_threshold:v:0", "0",
      "-b:v:0", process.env.HLS_480_VIDEO_BITRATE || "800k",
      "-maxrate:v:0", process.env.HLS_480_VIDEO_MAXRATE || "1000k",
      "-bufsize:v:0", process.env.HLS_480_VIDEO_BUFSIZE || "1600k",
      "-pix_fmt:v:0", "yuv420p",
      "-var_stream_map", "v:0,name:480p",
    );
  }

  args.push(
    "-max_muxing_queue_size", "2048",
    "-f", "hls",
    "-hls_time", keyframeSeconds.toString(),
    "-hls_list_size", process.env.HLS_LIST_SIZE || "12",
    "-hls_delete_threshold", "4",
    "-hls_flags", "delete_segments+independent_segments+program_date_time+temp_file",
    "-master_pl_name", "master.m3u8",
    "-master_pl_publish_rate", "3",
    "-hls_segment_filename", segmentPattern,
    variantPattern,
  );

  return args;
}

function runProbe(inputUrl: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
    ];

    if (isRtspInput(inputUrl)) {
      args.push(
        "-rtsp_transport", "tcp",
        "-timeout", process.env.STREAM_INPUT_TIMEOUT_US || "15000000",
      );
    }

    args.push(
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      inputUrl,
    );
    const probe = spawn("ffprobe", args);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { probe.kill("SIGKILL"); } catch (_) {}
      resolve({ ready: false, hasAudio: false, error: "Timed out waiting for OBS feed." });
    }, Number(process.env.STREAM_PROBE_TIMEOUT_MS || "8000"));

    probe.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    probe.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    probe.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({ ready: false, hasAudio: false, error: stderr.trim() || `ffprobe exited with code ${code}` });
        return;
      }
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const hasVideo = lines.includes("video");
      const hasAudio = lines.includes("audio");

      if (!hasVideo) {
        resolve({ ready: false, hasAudio: false, error: "Input found, but no video stream detected." });
        return;
      }

      resolve({ ready: true, hasAudio, inputUrl });
    });

    probe.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ready: false, hasAudio: false, error: err.message });
    });
  });
}

async function findReadyInput(streamKey: string): Promise<ProbeResult> {
  const candidates = getInputCandidates(streamKey);
  const errors: string[] = [];

  for (const candidate of candidates) {
    const probe = await runProbe(candidate);
    if (probe.ready) return probe;
    if (probe.error) errors.push(`${candidate}: ${probe.error}`);
  }

  return { ready: false, hasAudio: false, error: errors.join("\n") || "No internal input available." };
}

async function syncLocalToRemoteSftp(streamKey: string, uploadedMap: Map<string, number>) {
  const variantDir = path.join(getStreamMediaDir(streamKey), "480p");
  if (!fs.existsSync(variantDir)) return;

  try {
    const files = fs.readdirSync(variantDir);
    const tsFiles: string[] = [];
    let m3u8File: string | null = null;

    for (const fileName of files) {
      if (fileName.endsWith(".ts")) {
        tsFiles.push(fileName);
      } else if (fileName.endsWith(".m3u8")) {
        m3u8File = fileName;
      }
    }

    tsFiles.sort();

    const queue: { localFilePath: string; remoteRelativePath: string }[] = [];

    for (const fileName of tsFiles) {
      const localFilePath = path.join(variantDir, fileName);
      const stats = fs.statSync(localFilePath);
      const lastUploaded = uploadedMap.get(fileName) || 0;
      if (stats.mtimeMs > lastUploaded) {
        uploadedMap.set(fileName, stats.mtimeMs);
        queue.push({
          localFilePath,
          remoteRelativePath: `media/${streamKey}/480p/${fileName}`,
        });
      }
    }

    if (m3u8File) {
      const localFilePath = path.join(variantDir, m3u8File);
      const stats = fs.statSync(localFilePath);
      const lastUploaded = uploadedMap.get(m3u8File) || 0;
      if (stats.mtimeMs > lastUploaded) {
        uploadedMap.set(m3u8File, stats.mtimeMs);
        queue.push({
          localFilePath,
          remoteRelativePath: `media/${streamKey}/480p/${m3u8File}`,
        });
      }
    }

    if (queue.length > 0) {
      SFTPService.uploadMultipleFilesOrdered(queue).catch(() => {});
    }
  } catch (_) {}
}

export class TranscodeService {
  private static pipelines = new Map<string, PipelineState>();

  static getIngestDetails(streamKey: string, requestHostname: string) {
    this.assertSafeStreamKey(streamKey);
    return {
      rtmpServer: buildRtmpPublicUrl(requestHostname),
      streamKey,
      internalSources: getInputCandidates(streamKey),
    };
  }

  static async startPipeline(streamKey: string) {
    this.assertSafeStreamKey(streamKey);
    let state = this.pipelines.get(streamKey);

    if (state?.status === "active" && state.process && !state.process.killed) {
      state.wantsRun = true;
      return this.getPipelineStatus(streamKey);
    }

    if (state?.attemptInFlight) {
      state.wantsRun = true;
      return this.getPipelineStatus(streamKey);
    }

    if (!state) {
      state = {
        streamKey,
        status: "idle",
        wantsRun: true,
        attemptInFlight: false,
        hasAudio: false,
        sftpUploadedMap: new Map(),
      };
      this.pipelines.set(streamKey, state);
    }

    state.wantsRun = true;
    if (!state.retryTimer) {
      this.startAttempt(streamKey).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.markFailed(streamKey, message);
      });
    }

    return this.getPipelineStatus(streamKey);
  }

  static async stopPipeline(streamKey: string) {
    const state = this.pipelines.get(streamKey);
    if (!state) return;

    state.wantsRun = false;
    state.attemptInFlight = false;
    state.status = "stopped";
    state.lastError = undefined;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
    if (state.playlistTimer) {
      clearInterval(state.playlistTimer);
      state.playlistTimer = undefined;
    }
    if (state.process && !state.process.killed) {
      try { state.process.kill("SIGTERM"); } catch (_) {}
    }
    await StreamService.setStreamActive(streamKey, false).catch(() => {});
    await StreamService.setStreamLive(streamKey, false).catch(() => {});
    MonitorService.removeSpeed(streamKey);
    SFTPService.clearRemoteStreamDir(streamKey).catch(() => {});
  }

  static async publish(streamKey: string) {
    const streamInfo = await StreamService.getStreamByKey(streamKey);
    if (!streamInfo) throw new Error("Stream not found.");
    const status = this.getPipelineStatus(streamKey);
    if (!status.isReady) {
      throw new Error("OBS feed is not ready yet. Start streaming in OBS and wait for the preview first.");
    }
    await StreamService.setStreamLive(streamKey, true);
    log(streamKey, "Public live playback enabled.");
  }

  static async unpublish(streamKey: string) {
    await StreamService.setStreamLive(streamKey, false);
    log(streamKey, "Public live playback disabled.");
  }

  static getPipelineStatus(streamKey: string) {
    const state = this.pipelines.get(streamKey);
    const isReady = playlistExists(streamKey);
    return {
      status: state?.status || (isReady ? "active" : "idle"),
      isReady,
      hasAudio: state?.hasAudio || false,
      startedAt: state?.startedAt || null,
      lastReadyAt: state?.lastReadyAt || null,
      lastExitCode: state?.lastExitCode ?? null,
      lastError: state?.lastError || null,
      speed: MonitorService.getSpeed(streamKey),
      previewUrl: SFTPService.getPublicCdnUrl(streamKey),
      masterUrl: `/media/${streamKey}/master.m3u8`,
    };
  }

  private static async startAttempt(streamKey: string) {
    const state = this.pipelines.get(streamKey);
    if (!state || !state.wantsRun) return;

    state.retryTimer = undefined;
    state.status = "waiting_for_obs";
    state.lastError = undefined;
    state.attemptInFlight = true;

    const probe = await findReadyInput(streamKey);
    if (!probe.ready) {
      state.attemptInFlight = false;
      state.lastError = probe.error || "Waiting for OBS feed.";
      log(streamKey, `Waiting for OBS feed. Tried:\n${state.lastError}`);
      this.scheduleRetry(streamKey);
      return;
    }

    state.status = "starting";
    state.hasAudio = probe.hasAudio;
    state.inputUrl = probe.inputUrl;
    state.startedAt = Date.now();
    state.lastExitCode = undefined;
    state.sftpUploadedMap = new Map();
    cleanMediaDir(streamKey);
    await StreamService.setStreamActive(streamKey, false).catch(() => {});

    const args = buildFfmpegArgs(streamKey, probe.inputUrl!, probe.hasAudio);
    log(streamKey, `Starting HLS pipeline from ${probe.inputUrl} (${probe.hasAudio ? "video+audio" : "video-only"}).`);

    const ffmpeg = spawn("ffmpeg", args);
    state.process = ffmpeg;
    state.attemptInFlight = false;
    let stderrBuffer = "";

    state.playlistTimer = setInterval(() => {
      writeMasterPlaylist(streamKey);
      if (state.sftpUploadedMap) {
        syncLocalToRemoteSftp(streamKey, state.sftpUploadedMap);
      }

      if (!playlistExists(streamKey)) return;
      if (state.status !== "active") {
        state.status = "active";
        state.lastReadyAt = Date.now();
        StreamService.setStreamActive(streamKey, true).catch(() => {});
        log(streamKey, "Preview playlist is ready & synced via SFTP.");
      }
    }, PLAYLIST_CHECK_MS);

    ffmpeg.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const speedMatch = trimmed.match(/speed=\s*([0-9.]+x)/);
        if (speedMatch) {
          MonitorService.updateSpeed(streamKey, speedMatch[1]);
        }
        log(streamKey, trimmed);
      }
    });

    ffmpeg.on("error", (err) => {
      state.attemptInFlight = false;
      this.markFailed(streamKey, err.message);
    });

    ffmpeg.on("close", (code) => {
      const current = this.pipelines.get(streamKey);
      if (!current) return;
      current.process = undefined;
      current.lastExitCode = code;
      if (current.playlistTimer) {
        clearInterval(current.playlistTimer);
        current.playlistTimer = undefined;
      }
      StreamService.setStreamActive(streamKey, false).catch(() => {});
      StreamService.setStreamLive(streamKey, false).catch(() => {});
      MonitorService.removeSpeed(streamKey);

      if (!current.wantsRun) {
        current.status = "stopped";
        log(streamKey, `HLS pipeline stopped with code ${code}.`);
        SFTPService.clearRemoteStreamDir(streamKey).catch(() => {});
        return;
      }

      current.status = "waiting_for_obs";
      current.lastError = `FFmpeg exited with code ${code}.`;
      log(streamKey, `HLS pipeline exited with code ${code}; retrying.`);
      this.scheduleRetry(streamKey);
    });
  }

  private static markFailed(streamKey: string, error: string) {
    const state = this.pipelines.get(streamKey);
    if (!state) return;
    state.status = "failed";
    state.lastError = error;
    log(streamKey, `Pipeline error: ${error}`);
    if (state.wantsRun) {
      this.scheduleRetry(streamKey);
    }
  }

  private static scheduleRetry(streamKey: string) {
    const state = this.pipelines.get(streamKey);
    if (!state || !state.wantsRun || state.retryTimer) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      this.startAttempt(streamKey).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.markFailed(streamKey, message);
      });
    }, RETRY_DELAY_MS);
  }

  private static assertSafeStreamKey(streamKey: string) {
    if (!SAFE_STREAM_KEY_RE.test(streamKey)) {
      throw new Error("Invalid stream key.");
    }
  }
}
