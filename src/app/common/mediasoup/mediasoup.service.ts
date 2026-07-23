import * as mediasoup from "mediasoup";
import os from "os";

let cachedPublicIp: string | null = null;

/**
 * Auto-detect true public IPv4 address for WebRTC candidates
 */
async function getAnnouncedIp(): Promise<string> {
  if (process.env.ANNOUNCED_IP && process.env.ANNOUNCED_IP !== "127.0.0.1") {
    return process.env.ANNOUNCED_IP;
  }
  if (cachedPublicIp) return cachedPublicIp;

  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data: any = await res.json();
    if (data && data.ip) {
      cachedPublicIp = data.ip;
      console.log(`[Mediasoup SFU] Auto-detected Public Server IPv4: ${cachedPublicIp}`);
      return data.ip as string;
    }
  } catch (err: any) {
    console.warn("[Mediasoup SFU] Could not fetch public IP from ipify, falling back to network interfaces:", err.message);
  }

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

// Audio & Video Media Codec Definitions for High Quality WebRTC Streaming
const MEDIA_CODECS: mediasoup.types.RtpCodecCapability[] = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 111,
    parameters: {
      "sprop-stereo": 1,
      "stereo": 1,
      "maxaveragebitrate": 510000,
      "opusStereo": 1,
      "usedtx": 0,
      "useinbandfec": 1,
      "maxplaybackrate": 48000,
    },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    preferredPayloadType: 127,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "64002a", // H264 High Profile Level 4.2 (Crisp 1080p60)
      "level-asymmetry-allowed": 1,
      "x-google-min-bitrate": 5000,
      "x-google-start-bitrate": 8000,
      "x-google-max-bitrate": 12000,
    },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    preferredPayloadType: 126,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "4d001f", // H264 Main Profile
      "level-asymmetry-allowed": 1,
      "x-google-min-bitrate": 5000,
      "x-google-start-bitrate": 8000,
      "x-google-max-bitrate": 12000,
    },
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    preferredPayloadType: 96,
    parameters: {
      "x-google-min-bitrate": 5000,
      "x-google-start-bitrate": 8000,
      "x-google-max-bitrate": 12000,
    },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    preferredPayloadType: 102,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-min-bitrate": 5000,
      "x-google-start-bitrate": 8000,
      "x-google-max-bitrate": 12000,
    },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    preferredPayloadType: 125,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42001f",
      "level-asymmetry-allowed": 1,
      "x-google-min-bitrate": 5000,
      "x-google-start-bitrate": 8000,
      "x-google-max-bitrate": 12000,
    },
  },
];

interface StreamRoom {
  streamKey: string;
  router: mediasoup.types.Router;
  broadcasterTransport?: mediasoup.types.WebRtcTransport;
  audioProducer?: mediasoup.types.Producer;
  videoProducer?: mediasoup.types.Producer;
  viewers: Map<string, {
    transport?: mediasoup.types.WebRtcTransport;
    audioConsumer?: mediasoup.types.Consumer;
    videoConsumer?: mediasoup.types.Consumer;
  }>;
}

export class MediasoupService {
  private static worker: mediasoup.types.Worker | null = null;
  private static rooms = new Map<string, StreamRoom>();
  public static MAX_VIEWERS_PER_ROOM = 5; // Strict requirement: 5 user room limit

  /**
   * Initialize Mediasoup C++ Worker process singleton
   */
  public static async initWorker(): Promise<mediasoup.types.Worker> {
    if (this.worker) return this.worker;

    console.log("[Mediasoup SFU] Initializing Mediasoup Worker process...");
    this.worker = await mediasoup.createWorker({
      logLevel: "warn",
      rtcMinPort: 40000,
      rtcMaxPort: 40100,
    });

    this.worker.on("died", () => {
      console.error("[Mediasoup SFU] Worker process died unexpectedly! Exiting process...");
      setTimeout(() => process.exit(1), 2000);
    });

    // Warm up public IP detection
    getAnnouncedIp().catch(() => {});

    return this.worker;
  }

  /**
   * Get or Create a Mediasoup Room Router for a given stream key
   */
  public static async getOrCreateRoom(streamKey: string): Promise<StreamRoom> {
    const existing = this.rooms.get(streamKey);
    if (existing) return existing;

    const worker = await this.initWorker();
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });

    const newRoom: StreamRoom = {
      streamKey,
      router,
      viewers: new Map(),
    };

    this.rooms.set(streamKey, newRoom);
    console.log(`[Mediasoup SFU] Created new SFU Room Router for stream key: ${streamKey}`);
    return newRoom;
  }

  /**
   * Create a WebRTC Transport for Producer (Broadcaster) or Consumer (Viewer)
   */
  public static async createWebRtcTransport(streamKey: string, isBroadcaster: boolean, viewerId?: string) {
    const room = await this.getOrCreateRoom(streamKey);

    // Enforce 5 user viewer limit
    if (!isBroadcaster && viewerId) {
      if (room.viewers.size >= this.MAX_VIEWERS_PER_ROOM && !room.viewers.has(viewerId)) {
        throw new Error(`Room limit reached (${this.MAX_VIEWERS_PER_ROOM}/${this.MAX_VIEWERS_PER_ROOM} viewers). Please try again later.`);
      }
    }

    const announcedIp = await getAnnouncedIp();
    console.log(`[Mediasoup SFU] Creating WebRtcTransport for ${isBroadcaster ? "Broadcaster" : "Viewer"} with Announced IP: ${announcedIp}`);

    const transport = await room.router.createWebRtcTransport({
      listenIps: [
        {
          ip: "0.0.0.0",
          announcedIp: announcedIp,
        },
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 8000000, // 8.0 Mbps High Bitrate Ceiling
    });

    transport.on("dtlsstatechange", (dtlsState: mediasoup.types.DtlsState) => {
      console.log(`[Mediasoup SFU] Transport DTLS State: ${dtlsState} (${isBroadcaster ? "Broadcaster" : "Viewer"})`);
      if (dtlsState === "closed" || dtlsState === "failed") {
        transport.close();
      }
    });

    if (isBroadcaster) {
      room.broadcasterTransport = transport;
    } else if (viewerId) {
      const viewerState = room.viewers.get(viewerId) || {};
      viewerState.transport = transport;
      room.viewers.set(viewerId, viewerState);
    }

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  /**
   * Connect Transport with client DTLS parameters
   */
  public static async connectTransport(streamKey: string, transportId: string, dtlsParameters: any) {
    const room = this.rooms.get(streamKey);
    if (!room) throw new Error("Room not found");

    let transport: mediasoup.types.WebRtcTransport | undefined;
    if (room.broadcasterTransport?.id === transportId) {
      transport = room.broadcasterTransport;
    } else {
      for (const [vId, state] of room.viewers.entries()) {
        if (state.transport?.id === transportId) {
          transport = state.transport;
          break;
        }
      }
    }

    if (!transport) throw new Error("Transport not found");
    await transport.connect({ dtlsParameters });
  }

  /**
   * Produce Audio or Video track from Broadcaster
   */
  public static async produce(streamKey: string, transportId: string, kind: "audio" | "video", rtpParameters: any) {
    const room = this.rooms.get(streamKey);
    if (!room || room.broadcasterTransport?.id !== transportId) {
      throw new Error("Broadcaster transport not found");
    }

    const producer = await room.broadcasterTransport.produce({ kind, rtpParameters });

    if (kind === "audio") room.audioProducer = producer;
    if (kind === "video") room.videoProducer = producer;

    console.log(`[Mediasoup SFU] Broadcaster producing ${kind} track (id: ${producer.id}) for key: ${streamKey}`);

    producer.on("transportclose", () => {
      producer.close();
    });

    return { id: producer.id };
  }

  /**
   * Consume Audio or Video track for Viewer (Max 5 Users)
   */
  public static async consume(streamKey: string, viewerId: string, transportId: string, rtpCapabilities: any) {
    const room = this.rooms.get(streamKey);
    if (!room) throw new Error("Stream room not active");

    const viewerState = room.viewers.get(viewerId);
    if (!viewerState || viewerState.transport?.id !== transportId) {
      throw new Error("Viewer transport not found");
    }

    const results: any[] = [];

    // Consume Video Producer if available and can consume
    if (room.videoProducer && room.router.canConsume({ producerId: room.videoProducer.id, rtpCapabilities })) {
      const videoConsumer = await viewerState.transport.consume({
        producerId: room.videoProducer.id,
        rtpCapabilities,
        paused: false,
      });
      viewerState.videoConsumer = videoConsumer;

      results.push({
        id: videoConsumer.id,
        producerId: room.videoProducer.id,
        kind: "video",
        rtpParameters: videoConsumer.rtpParameters,
      });
    }

    // Consume Audio Producer if available and can consume
    if (room.audioProducer && room.router.canConsume({ producerId: room.audioProducer.id, rtpCapabilities })) {
      const audioConsumer = await viewerState.transport.consume({
        producerId: room.audioProducer.id,
        rtpCapabilities,
        paused: false,
      });
      viewerState.audioConsumer = audioConsumer;

      results.push({
        id: audioConsumer.id,
        producerId: room.audioProducer.id,
        kind: "audio",
        rtpParameters: audioConsumer.rtpParameters,
      });
    }

    return results;
  }

  /**
   * Get Router RTP Capabilities for client compatibility check
   */
  public static async getRouterRtpCapabilities(streamKey: string) {
    const room = await this.getOrCreateRoom(streamKey);
    return room.router.rtpCapabilities;
  }

  /**
   * Close a Viewer Session and free resources
   */
  public static removeViewer(streamKey: string, viewerId: string) {
    const room = this.rooms.get(streamKey);
    if (!room) return;

    const viewer = room.viewers.get(viewerId);
    if (viewer) {
      try { viewer.audioConsumer?.close(); } catch (_) {}
      try { viewer.videoConsumer?.close(); } catch (_) {}
      try { viewer.transport?.close(); } catch (_) {}
      room.viewers.delete(viewerId);
      console.log(`[Mediasoup SFU] Viewer ${viewerId} left stream ${streamKey}. Active viewers: ${room.viewers.size}/${this.MAX_VIEWERS_PER_ROOM}`);
    }
  }

  /**
   * Close Broadcaster Stream Session and wipe room
   */
  public static closeRoom(streamKey: string) {
    const room = this.rooms.get(streamKey);
    if (!room) return;

    console.log(`[Mediasoup SFU] Closing stream room for key: ${streamKey}`);

    try { room.audioProducer?.close(); } catch (_) {}
    try { room.videoProducer?.close(); } catch (_) {}
    try { room.broadcasterTransport?.close(); } catch (_) {}

    for (const [viewerId] of room.viewers) {
      this.removeViewer(streamKey, viewerId);
    }

    try { room.router.close(); } catch (_) {}
    this.rooms.delete(streamKey);
  }

  /**
   * Get current viewer count for a stream
   */
  public static getViewerCount(streamKey: string): number {
    return this.rooms.get(streamKey)?.viewers.size || 0;
  }
}
