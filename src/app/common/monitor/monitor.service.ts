import fs from "fs";
import path from "path";
import os from "os";
import { db } from "../database/db.js";
import { streamLog, streamTelemetry } from "../database/schema.js";
import { desc, gte } from "drizzle-orm";

export class MonitorService {
  static async addStreamLog(streamKey: string, message: string, level: string = "info") {
    try {
      await db.insert(streamLog).values({
        streamKey,
        message,
        level,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error("[MonitorService] Failed to save stream log to DB:", err);
    }
  }

  private static ffmpegLogs: string[] = [];
  private static transcodeSpeeds = new Map<string, string>();
  private static MAX_LOGS = 150;

  static async preloadLogs() {
    try {
      const records = await db
        .select()
        .from(streamLog)
        .orderBy(desc(streamLog.id))
        .limit(this.MAX_LOGS);
      const loaded = records.reverse().map(r => r.message);
      this.ffmpegLogs = loaded;
      console.log(`[MonitorService] Preloaded ${loaded.length} historical logs from database.`);
    } catch (err) {
      console.error("[MonitorService] Failed to preload database logs:", err);
    }
  }

  static addLog(line: string) {
    this.ffmpegLogs.push(line);
    if (this.ffmpegLogs.length > this.MAX_LOGS) {
      this.ffmpegLogs.shift();
    }
    this.addStreamLog("system", line, "info").catch(() => {});
  }

  static getLogs(): string[] {
    return this.ffmpegLogs;
  }

  static updateSpeed(key: string, speed: string) {
    this.transcodeSpeeds.set(key, speed);
  }

  static getSpeed(key: string): string {
    return this.transcodeSpeeds.get(key) || "N/A";
  }

  static removeSpeed(key: string) {
    this.transcodeSpeeds.delete(key);
  }

  static async getCpuUsage(): Promise<number> {
    return new Promise((resolve) => {
      const cpus1 = os.cpus();
      setTimeout(() => {
        const cpus2 = os.cpus();
        let idle1 = 0, total1 = 0, idle2 = 0, total2 = 0;
        for (let i = 0; i < cpus1.length; i++) {
          const t1 = cpus1[i].times;
          const t2 = cpus2[i].times;
          idle1 += t1.idle;
          idle2 += t2.idle;
          total1 += t1.user + t1.nice + t1.sys + t1.idle + t1.irq;
          total2 += t2.user + t2.nice + t2.sys + t2.idle + t2.irq;
        }
        const idleDiff = idle2 - idle1;
        const totalDiff = total2 - total1;
        if (totalDiff <= 0) {
          resolve(1);
          return;
        }
        const cpuPercent = Math.min(100, Math.max(1, Math.round((1 - idleDiff / totalDiff) * 100)));
        resolve(cpuPercent);
      }, 500);
    });
  }

  static getSystemMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = os.loadavg().map(l => l.toFixed(2));
    const uptimeSec = os.uptime();

    return {
      memory: {
        totalMB: Math.round(totalMem / (1024 * 1024)),
        usedMB: Math.round(usedMem / (1024 * 1024)),
        freeMB: Math.round(freeMem / (1024 * 1024)),
        usedPercent: Math.round((usedMem / totalMem) * 100),
      },
      loadAvg: `${loadAvg[0]}, ${loadAvg[1]}, ${loadAvg[2]}`,
      uptimeFormatted: this.formatUptime(uptimeSec),
    };
  }

  private static formatUptime(seconds: number): string {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    return `${h}h ${m}m`;
  }

  static async getMonthlyStats() {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const records = await db
        .select()
        .from(streamTelemetry)
        .where(gte(streamTelemetry.startTime, startOfMonth));

      let totalDurationSeconds = 0;
      let countedSessionsCount = 0;

      for (const r of records) {
        totalDurationSeconds += r.durationSeconds || 0;
        if (r.countedTowardsQuota) {
          countedSessionsCount++;
        }
      }

      // Estimate bandwidth consumed: average stream bitrate ~ 5.0 Mbps (0.625 MB/sec)
      const bytesConsumed = totalDurationSeconds * (5 * 1000 * 1000 / 8);
      const gbConsumed = (bytesConsumed / (1024 * 1024 * 1024)).toFixed(2);

      return {
        totalSessionsThisMonth: records.length,
        countedSessionsThisMonth: countedSessionsCount,
        totalHoursThisMonth: (totalDurationSeconds / 3600).toFixed(1),
        monthlyGbConsumed: gbConsumed,
      };
    } catch (err) {
      return {
        totalSessionsThisMonth: 0,
        countedSessionsThisMonth: 0,
        totalHoursThisMonth: "0.0",
        monthlyGbConsumed: "0.00",
      };
    }
  }

  static getRealEgressKbps(activeSessions: Map<string, any>): number {
    let totalBps = 0;
    for (const session of activeSessions.values()) {
      const count = session.viewers ? session.viewers.size : 0;
      if (count > 0) {
        let bpsPerViewer = 6000000;
        if (count === 1) bpsPerViewer = 8000000;
        else if (count <= 3) bpsPerViewer = 6000000;
        else if (count <= 5) bpsPerViewer = 3500000;
        else bpsPerViewer = 2000000;
        totalBps += (count * bpsPerViewer);
      }
    }
    return Math.round(totalBps / 1024);
  }

  static getMediaFiles() {
    const mediaPath = path.join(process.cwd(), "media");
    if (!fs.existsSync(mediaPath)) return [];

    const results: any[] = [];
    try {
      const items = fs.readdirSync(mediaPath, { withFileTypes: true });

      for (const item of items) {
        const itemPath = path.join(mediaPath, item.name);
        if (item.isDirectory()) {
          const files = fs.readdirSync(itemPath);
          for (const file of files) {
            const filePath = path.join(itemPath, file);
            try {
              const stat = fs.statSync(filePath);
              results.push({
                stream: item.name,
                file: file,
                size: stat.size,
                modifiedAgo: Math.round((Date.now() - stat.mtimeMs) / 1000) + "s",
              });
            } catch (_) {}
          }
        } else {
          try {
            const stat = fs.statSync(itemPath);
            results.push({
              stream: "root",
              file: item.name,
              size: stat.size,
              modifiedAgo: Math.round((Date.now() - stat.mtimeMs) / 1000) + "s",
            });
          } catch (_) {}
        }
      }
    } catch (_) {}
    
    return results;
  }
}
