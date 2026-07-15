import { Router } from "express";
import { requireAuth, redirectIfAuth, requireAccess, AuthenticatedRequest } from "../auth/auth.middleware.js";
import { StreamService } from "../stream/stream.service.js";

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

// Logout Route (GET request to clear cookies and redirect)
router.get("/logout", (req, res) => {
  res.clearCookie("better-auth.session_token");
  res.clearCookie("better-auth.session-token");
  res.clearCookie("__secure-better-auth.session_token");
  res.clearCookie("__secure-better-auth.session-token");
  res.redirect("/login");
});

export default router;
