import { Router } from "express";
import { StreamService } from "../stream/stream.service.js";
import { auth } from "../../../../lib/auth.js";

const router = Router();

// Live feed playback page
router.get("/live/:key", async (req, res) => {
  try {
    const { key } = req.params;
    const stream = await StreamService.getStreamByKey(key);

    if (!stream) {
      return res.status(404).render("error", {
        title: "Stream Not Found",
        message: "This live feed does not exist or has been deleted.",
        user: null,
      });
    }

    // Attempt to get user session to display UI headers
    let user = null;
    try {
      const session = await auth.api.getSession({
        headers: new Headers(req.headers as any),
      });
      if (session) {
        user = session.user;
      }
    } catch (_) {
      // Allow viewing even if session retrieval fails
    }

    res.render("live", {
      title: `Live: ${stream.title} - CoWatch`,
      user,
      stream,
    });
  } catch (error: any) {
    res.status(500).render("error", {
      title: "Playback Error",
      message: error.message,
      user: null,
    });
  }
});

export default router;
