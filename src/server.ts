import express from "express";
import http from "http";
import path from "path";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import url from "url";
import { WebSocketServer } from "ws";
import { StreamController } from "./app/module/stream/stream.controller.js";
import { MonitorService } from "./app/common/monitor/monitor.service.js";

// Import routes
import authRoutes from "./app/module/auth/auth.routes.js";
import streamRoutes from "./app/module/stream/stream.routes.js";
import dashboardRoutes from "./app/module/dashboard/dashboard.routes.js";
import liveRoutes from "./app/module/live/live.routes.js";

dotenv.config();

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3000;

// Setup EJS views
app.set("view engine", "ejs");
app.set("views", path.join(process.cwd(), "src", "views"));

let activeEgressBytes = 0;
let lastEgressCheck = Date.now();
export let currentEgressKbps = 0;

// Middleware to track egress bandwidth
app.use((req, res, next) => {
  const oldWrite = res.write;
  const oldEnd = res.end;
  let bytesSent = 0;

  (res as any).write = function (chunk: any, ...args: any[]) {
    if (chunk) {
      if (typeof chunk === "string") {
        bytesSent += Buffer.byteLength(chunk);
      } else if (chunk.length) {
        bytesSent += chunk.length;
      }
    }
    return oldWrite.apply(res, arguments as any);
  };

  (res as any).end = function (chunk: any, ...args: any[]) {
    if (chunk) {
      if (typeof chunk === "string") {
        bytesSent += Buffer.byteLength(chunk);
      } else if (chunk.length) {
        bytesSent += chunk.length;
      }
    }
    activeEgressBytes += bytesSent;
    return oldEnd.apply(res, arguments as any);
  };

  next();
});

// Periodic bandwidth calculator
setInterval(() => {
  const now = Date.now();
  const elapsedSec = (now - lastEgressCheck) / 1000;
  if (elapsedSec > 0) {
    const bitsSent = activeEgressBytes * 8;
    currentEgressKbps = (bitsSent / 1024) / elapsedSec; // Kbps
    activeEgressBytes = 0;
    lastEgressCheck = now;
  }
}, 1000);

// Middlewares
app.use(express.json({ limit: "50mb" }));
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

// Prevent page caching for dynamic pages
app.use((req, res, next) => {
  if (!req.path.startsWith("/media") && !req.path.startsWith("/public")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

// Setup routes
app.use(authRoutes);
app.use(streamRoutes);
app.use(dashboardRoutes);
app.use(liveRoutes);

// Setup WebSocket Server for stream broadcaster
const broadcasterWss = new WebSocketServer({ noServer: true });
const viewerWss = new WebSocketServer({ noServer: true });
const monitorWss = new WebSocketServer({ noServer: true });

// Setup Ping-Pong Heartbeat to keep connections alive indefinitely (for long 4-6h sessions)
function heartbeat(this: any) {
  this.isAlive = true;
}

const pingInterval = setInterval(() => {
  broadcasterWss.clients.forEach((ws: any) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });

  viewerWss.clients.forEach((ws: any) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });

  monitorWss.clients.forEach((ws: any) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

pingInterval.unref();

// Capture uncaught crashes and write them to the telemetry logs/DB
process.on("uncaughtException", (error) => {
  const msg = `[CRITICAL ERROR] Uncaught Exception: ${error.message}\nStack: ${error.stack}`;
  console.error(msg);
  MonitorService.addLog(msg);
});

process.on("unhandledRejection", (reason: any) => {
  const msg = `[CRITICAL ERROR] Unhandled Rejection: ${reason?.message || reason}\nStack: ${reason?.stack || ""}`;
  console.error(msg);
  MonitorService.addLog(msg);
});

// Preload database logs at start
MonitorService.preloadLogs().then(() => {
  console.log("[Studio Server] DB logs preloaded successfully.");
}).catch(err => {
  console.error("[Studio Server] Failed to preload DB logs:", err);
});

broadcasterWss.on("connection", (ws: any, request: any, key: any) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  StreamController.handleWebSocket(ws, key as string);
});

viewerWss.on("connection", (ws: any, request: any, key: any) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  StreamController.handleViewerWebSocket(ws, key as string);
});

monitorWss.on("connection", (ws: any) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  console.log("[WS Monitor] Telemetry client connected");

  const sendUpdate = async () => {
    if (ws.readyState !== 1) return; // OPEN
    try {
      const cpu = await MonitorService.getCpuUsage();
      const sysMetrics = MonitorService.getSystemMetrics();
      const monthlyStats = await MonitorService.getMonthlyStats();
      const realEgressKbps = MonitorService.getRealEgressKbps(StreamController.activeSessions);
      const data = {
        cpu,
        memory: {
          systemUsedMB: sysMetrics.memory.usedMB,
          systemTotalMB: sysMetrics.memory.totalMB,
          systemUsedPercent: sysMetrics.memory.usedPercent,
        },
        loadAvg: sysMetrics.loadAvg,
        uptimeFormatted: sysMetrics.uptimeFormatted,
        monthlyStats,
        egressKbps: realEgressKbps,
        mediaFiles: MonitorService.getMediaFiles(),
        ffmpegLogs: MonitorService.getLogs(),
        activeStreams: Array.from(StreamController.activeSessions.values()).map(session => ({
          key: session.streamKey,
          viewersCount: session.viewers ? session.viewers.size : 0,
        })),
      };
      ws.send(JSON.stringify(data));
    } catch (_) {}
  };

  sendUpdate();
  const interval = setInterval(sendUpdate, 2000);

  ws.on("close", () => {
    clearInterval(interval);
    console.log("[WS Monitor] Telemetry client disconnected");
  });

  ws.on("error", () => {
    clearInterval(interval);
  });
});

server.on("upgrade", (request, socket, head) => {
  // Use simple URL parsing to guarantee robust path extraction in all network topologies
  const parsedUrl = url.parse(request.url || "");
  const pathname = parsedUrl.pathname || "";

  const match = pathname.match(/^\/api\/stream\/([^\/]+)\/ws\/?$/);
  const viewerMatch = pathname.match(/^\/api\/stream\/([^\/]+)\/viewer\/?$/);
  const monitorMatch = pathname.match(/^\/api\/monitor\/ws\/?$/);

  if (match) {
    const key = match[1];
    broadcasterWss.handleUpgrade(request, socket, head, (ws) => {
      broadcasterWss.emit("connection", ws, request, key);
    });
  } else if (viewerMatch) {
    const key = viewerMatch[1];
    viewerWss.handleUpgrade(request, socket, head, (ws) => {
      viewerWss.emit("connection", ws, request, key);
    });
  } else if (monitorMatch) {
    monitorWss.handleUpgrade(request, socket, head, (ws) => {
      monitorWss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// General fallback page for 404s
app.use((req, res) => {
  res.status(404).render("error", {
    title: "Page Not Found",
    message: "The page you are looking for does not exist.",
    user: null,
  });
});

// Run server
server.listen(Number(port), "0.0.0.0", () => {
  console.log(`CoWatch streaming server running at http://0.0.0.0:${port}`);
});
