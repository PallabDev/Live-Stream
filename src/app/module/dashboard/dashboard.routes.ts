import { Router } from "express";
import { requireAuth, redirectIfAuth, requireAccess, AuthenticatedRequest } from "../auth/auth.middleware.js";
import { StreamService } from "../stream/stream.service.js";
import { MonitorService } from "../../common/monitor/monitor.service.js";
import { currentEgressKbps } from "../../../server.js";
import { StreamController } from "../stream/stream.controller.js";

const router = Router();

// Redirect home page to dashboard or login
router.get("/", async (req: AuthenticatedRequest, res) => {
  res.redirect("/dashboard");
});

// Login Page
router.get("/login", redirectIfAuth, (req, res) => {
  res.render("login", { title: "Login - CoWatch" });
});

// Signin Page (alias of login)
router.get("/signin", redirectIfAuth, (req, res) => {
  res.render("login", { title: "Sign In - CoWatch" });
});

// Dashboard Page
router.get("/dashboard", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const streams = await StreamService.getStreamsByUser(req.user.id);
    res.render("dashboard", {
      title: "Dashboard - CoWatch",
      user: req.user,
      streams,
    });
  } catch (error: any) {
    res.status(500).render("error", {
      title: "Error",
      message: error.message,
      user: req.user || null,
    });
  }
});

// Stream Cockpit Page (where they broadcast from)
router.get("/stream/:key", requireAuth, requireAccess, async (req: AuthenticatedRequest, res) => {
  try {
    const { key } = req.params;
    const stream = await StreamService.getStreamByKey(key);

    if (!stream) {
      return res.status(404).render("error", {
        title: "Stream Not Found",
        message: "The requested stream does not exist.",
        user: req.user,
      });
    }

    // Ensure the stream belongs to the current user (unless admin)
    if (stream.userId !== req.user.id && req.user.role !== "admin") {
      return res.status(403).render("error", {
        title: "Access Denied",
        message: "You are not authorized to broadcast on this stream key.",
        user: req.user,
      });
    }

    res.render("stream", {
      title: `Broadcast: ${stream.title} - CoWatch`,
      user: req.user,
      stream,
    });
  } catch (error: any) {
    res.status(500).render("error", {
      title: "Error",
      message: error.message,
      user: req.user,
    });
  }
});

// Admin Panel Page (GET request to render admin.ejs)
router.get("/admin", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).render("error", {
        title: "Access Denied",
        message: "You are not authorized to view the Admin Panel.",
        user: req.user,
      });
    }
    res.render("admin", {
      title: "Admin Panel - CoWatch",
      user: req.user,
    });
  } catch (error: any) {
    res.status(500).render("error", {
      title: "Error",
      message: error.message,
      user: req.user,
    });
  }
});

// Logout Route (GET request to clear cookies and redirect)
router.get("/logout", (req, res) => {
  res.clearCookie("better-auth.session_token");
  res.clearCookie("better-auth.session-token");
  res.clearCookie("__secure-better-auth.session_token");
  res.clearCookie("__secure-better-auth.session-token");
  res.redirect("/login");
});

// Monitor Page
router.get("/monitor", requireAuth, async (req: AuthenticatedRequest, res) => {
  res.render("monitor", {
    title: "System Control Center - CoWatch",
    user: req.user,
  });
});

// SSE Monitor API Endpoint
router.get("/api/monitor/sse", requireAuth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendUpdate = async () => {
    try {
      const cpu = await MonitorService.getCpuUsage();
      const mem = process.memoryUsage();
      const data = {
        cpu,
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024) + " MB",
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + " MB",
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + " MB",
        },
        egressKbps: Math.round(currentEgressKbps),
        mediaFiles: MonitorService.getMediaFiles(),
        ffmpegLogs: MonitorService.getLogs(),
        activeStreams: Array.from(StreamController.activeSessions.keys()).map(key => ({
          key,
          speed: MonitorService.getSpeed(key),
        })),
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {}
  };

  sendUpdate();
  const interval = setInterval(sendUpdate, 2000);

  req.on("close", () => {
    clearInterval(interval);
    res.end();
  });
});

export default router;
