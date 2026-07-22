import { Request, Response } from "express";
import http from "http";

export class SFUController {
  private static getMediaMTXHost(): string {
    return process.env.MEDIAMTX_HOST || "127.0.0.1";
  }

  private static getMediaMTXPort(): number {
    return parseInt(process.env.MEDIAMTX_PORT || "8889", 10);
  }

  // Broadcaster WHIP Publisher proxy endpoint
  static async handleWhipPublish(req: Request, res: Response): Promise<void> {
    const { streamKey } = req.params;
    if (!streamKey) {
      res.status(400).send("Stream key is required");
      return;
    }

    const sdpOffer = typeof req.body === "string" ? req.body : req.body.toString("utf8");
    const mtxHost = SFUController.getMediaMTXHost();
    const mtxPort = SFUController.getMediaMTXPort();

    const options: http.RequestOptions = {
      hostname: mtxHost,
      port: mtxPort,
      path: `/${encodeURIComponent(streamKey)}/whip`,
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        "Content-Length": Buffer.byteLength(sdpOffer),
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      let data = "";
      proxyRes.on("data", (chunk) => (data += chunk));
      proxyRes.on("end", () => {
        const statusCode = proxyRes.statusCode || 500;
        if (proxyRes.headers.location) {
          res.setHeader("Location", proxyRes.headers.location);
        }
        res.setHeader("Content-Type", "application/sdp");
        res.status(statusCode).send(data);
      });
    });

    proxyReq.on("error", (err) => {
      console.error(`[SFU Controller WHIP Error] Failed to reach MediaMTX (${mtxHost}:${mtxPort}):`, err.message);
      res.status(502).send("MediaMTX SFU server unavailable");
    });

    proxyReq.write(sdpOffer);
    proxyReq.end();
  }

  // Viewer WHEP Subscriber proxy endpoint
  static async handleWhepSubscribe(req: Request, res: Response): Promise<void> {
    const { streamKey } = req.params;
    if (!streamKey) {
      res.status(400).send("Stream key is required");
      return;
    }

    const sdpOffer = typeof req.body === "string" ? req.body : req.body.toString("utf8");
    const mtxHost = SFUController.getMediaMTXHost();
    const mtxPort = SFUController.getMediaMTXPort();

    const options: http.RequestOptions = {
      hostname: mtxHost,
      port: mtxPort,
      path: `/${encodeURIComponent(streamKey)}/whep`,
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        "Content-Length": Buffer.byteLength(sdpOffer),
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      let data = "";
      proxyRes.on("data", (chunk) => (data += chunk));
      proxyRes.on("end", () => {
        const statusCode = proxyRes.statusCode || 500;
        if (proxyRes.headers.location) {
          res.setHeader("Location", proxyRes.headers.location);
        }
        res.setHeader("Content-Type", "application/sdp");
        res.status(statusCode).send(data);
      });
    });

    proxyReq.on("error", (err) => {
      console.error(`[SFU Controller WHEP Error] Failed to reach MediaMTX (${mtxHost}:${mtxPort}):`, err.message);
      res.status(502).send("MediaMTX SFU server unavailable");
    });

    proxyReq.write(sdpOffer);
    proxyReq.end();
  }

  // WHIP/WHEP Session termination proxy endpoint
  static async handleSessionDelete(req: Request, res: Response): Promise<void> {
    const { streamKey } = req.params;
    const mtxHost = SFUController.getMediaMTXHost();
    const mtxPort = SFUController.getMediaMTXPort();

    const options: http.RequestOptions = {
      hostname: mtxHost,
      port: mtxPort,
      path: `/${encodeURIComponent(streamKey)}/whip`,
      method: "DELETE",
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode || 200).send("Session closed");
    });

    proxyReq.on("error", () => {
      res.status(200).send("Session closed");
    });

    proxyReq.end();
  }
}
