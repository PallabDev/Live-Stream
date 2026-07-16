import express from "express";
import http from "http";
import path from "path";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

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

// Run server
server.listen(Number(port), "0.0.0.0", () => {
  console.log(`CoWatch streaming server running at http://0.0.0.0:${port}`);
});
