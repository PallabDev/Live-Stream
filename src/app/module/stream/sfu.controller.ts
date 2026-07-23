import { WebSocket } from "ws";
import { MediasoupService } from "../../common/mediasoup/mediasoup.service.js";
import { StreamService } from "./stream.service.js";

interface RoomSockets {
  broadcaster?: WebSocket;
  viewers: Map<string, WebSocket>;
}

export class SFUController {
  private static roomSockets = new Map<string, RoomSockets>();

  private static getOrCreateRoomSockets(streamKey: string): RoomSockets {
    let room = this.roomSockets.get(streamKey);
    if (!room) {
      room = { viewers: new Map() };
      this.roomSockets.set(streamKey, room);
    }
    return room;
  }

  /**
   * Handle Mediasoup WebRTC SFU WebSocket Connection
   */
  public static handleConnection(ws: WebSocket, streamKey: string, isBroadcaster: boolean, viewerId: string) {
    console.log(`[SFU WebSocket] Connection opened for streamKey: ${streamKey} | Role: ${isBroadcaster ? "Broadcaster" : "Viewer"} | ViewerId: ${viewerId}`);

    const room = this.getOrCreateRoomSockets(streamKey);
    if (isBroadcaster) {
      room.broadcaster = ws;
    } else {
      room.viewers.set(viewerId, ws);
    }

    ws.on("message", async (rawMessage: string) => {
      try {
        const msg = JSON.parse(rawMessage);
        const { action, transportId, dtlsParameters, kind, rtpParameters, rtpCapabilities } = msg;

        switch (action) {
          case "getRouterRtpCapabilities": {
            const capabilities = await MediasoupService.getRouterRtpCapabilities(streamKey);
            ws.send(JSON.stringify({ action: "routerRtpCapabilities", rtpCapabilities: capabilities }));
            break;
          }

          case "createWebRtcTransport": {
            try {
              const data = await MediasoupService.createWebRtcTransport(streamKey, isBroadcaster, viewerId);
              ws.send(JSON.stringify({ action: "webRtcTransportCreated", data }));
            } catch (err: any) {
              ws.send(JSON.stringify({ action: "error", message: err.message }));
            }
            break;
          }

          case "connectTransport": {
            await MediasoupService.connectTransport(streamKey, transportId, dtlsParameters);
            ws.send(JSON.stringify({ action: "transportConnected" }));
            break;
          }

          case "produce": {
            if (!isBroadcaster) {
              return ws.send(JSON.stringify({ action: "error", message: "Only broadcaster can produce" }));
            }
            const { id } = await MediasoupService.produce(streamKey, transportId, kind, rtpParameters);
            ws.send(JSON.stringify({ action: "produced", id, kind }));
            
            // Update DB status to live
            await StreamService.setStreamLive(streamKey, true);

            // Broadcast newProducer signal to all viewers waiting in room
            for (const [vId, vWs] of room.viewers.entries()) {
              if (vWs.readyState === 1) { // OPEN
                vWs.send(JSON.stringify({ action: "newProducer", kind, producerId: id }));
              }
            }
            break;
          }

          case "consume": {
            try {
              const consumers = await MediasoupService.consume(streamKey, viewerId, transportId, rtpCapabilities);
              ws.send(JSON.stringify({ action: "consumed", consumers }));
            } catch (err: any) {
              ws.send(JSON.stringify({ action: "error", message: err.message }));
            }
            break;
          }

          default:
            console.warn(`[SFU WebSocket] Unknown action received: ${action}`);
        }
      } catch (err: any) {
        console.error(`[SFU WebSocket Error]:`, err.message);
        ws.send(JSON.stringify({ action: "error", message: err.message }));
      }
    });

    ws.on("close", () => {
      console.log(`[SFU WebSocket] Connection closed for key: ${streamKey} | Role: ${isBroadcaster ? "Broadcaster" : "Viewer"}`);
      if (isBroadcaster) {
        MediasoupService.closeRoom(streamKey);
        StreamService.setStreamLive(streamKey, false).catch(() => {});
        this.roomSockets.delete(streamKey);
      } else {
        MediasoupService.removeViewer(streamKey, viewerId);
        room.viewers.delete(viewerId);
      }
    });
  }
}
