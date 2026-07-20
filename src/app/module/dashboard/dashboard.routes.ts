import { Router } from "express";
import { requireAuth, redirectIfAuth, requireAccess, AuthenticatedRequest } from "../auth/auth.middleware.js";
import { StreamService } from "../stream/stream.service.js";
import { MonitorService } from "../../common/monitor/monitor.service.js";
import { currentEgressKbps } from "../../../server.js";
import { StreamController } from "../stream/stream.controller.js";
import { auth } from "../../../../lib/auth.js";

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

// Logout Route (clears better-auth session server-side & client-side cookies)
router.all("/logout", async (req, res) => {
  try {
    await auth.api.signOut({
      headers: new Headers(req.headers as any),
    });
  } catch (err) {
    console.error("[Logout] Better-auth signOut error:", err);
  }

  const cookieOptions = { path: "/" };
  res.clearCookie("better-auth.session_token", cookieOptions);
  res.clearCookie("better-auth.session-token", cookieOptions);
  res.clearCookie("__secure-better-auth.session_token", cookieOptions);
  res.clearCookie("__secure-better-auth.session-token", cookieOptions);

  // Fallback clearance without explicit path
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

export default router;
