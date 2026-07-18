import fs from "fs";
import path from "path";
import os from "os";
import { db } from "../database/db.js";
import { streamLog } from "../database/schema.js";
import { desc } from "drizzle-orm";

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
    // Write system/telemetry logs to DB
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
      const startMeasure = this.cpuAverage();
      setTimeout(() => {
        const endMeasure = this.cpuAverage();
        const idleDifference = endMeasure.idle - startMeasure.idle;
        const totalDifference = endMeasure.total - startMeasure.total;
        if (totalDifference === 0) {
          resolve(0);
          return;
        }
        const percentageCpu = 100 - Math.round((100 * idleDifference) / totalDifference);
        resolve(percentageCpu);
      }, 1000);
    });
  }

  private static cpuAverage() {
    const cpus = os.cpus();
    let idleMs = 0;
    let totalMs = 0;
    
    cpus.forEach((core) => {
      for (const type in core.times) {
        totalMs += (core.times as any)[type];
      }
      idleMs += core.times.idle;
    });

    return {
      idle: idleMs / cpus.length,
      total: totalMs / cpus.length,
    };
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
