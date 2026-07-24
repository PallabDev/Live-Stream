import Client from "ssh2-sftp-client";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

export class SFTPService {
  private static htaccessUploaded = false;

  private static getSftpConfig() {
    return {
      host: process.env.SFTP_HOST || "82.112.232.103",
      port: Number(process.env.SFTP_PORT || "65002"),
      username: process.env.SFTP_USER || "u918904063",
      password: process.env.SFTP_PASSWORD || "SSHp@2026",
      readyTimeout: 10000,
    };
  }

  private static getBasePath(): string {
    const rawPath = process.env.SFTP_BASE_PATH || "/home/u918904063/domains/system-official.site/public_html/hls";
    return rawPath.replace(/\/$/, "");
  }

  public static getPublicCdnUrl(streamKey: string): string {
    return `https://system-official.site/hls/media/${streamKey}/480p/index.m3u8`;
  }

  private static getHtaccessContent(): string {
    return `<IfModule mod_headers.c>
    Header always set Access-Control-Allow-Origin "*"
    Header always set Access-Control-Allow-Methods "GET, HEAD, OPTIONS"
    Header always set Access-Control-Allow-Headers "Origin, X-Requested-With, Content-Type, Accept, Range"
    Header always set Access-Control-Expose-Headers "Content-Length, Content-Range"
</IfModule>

<FilesMatch "\\.(m3u8)$">
    <IfModule mod_headers.c>
        Header always set Cache-Control "no-cache, no-store, must-revalidate"
        Header always set Pragma "no-cache"
        Header always set Expires "0"
    </IfModule>
</FilesMatch>

<FilesMatch "\\.(ts)$">
    <IfModule mod_headers.c>
        Header always set Cache-Control "public, max-age=60"
    </IfModule>
</FilesMatch>
`;
  }

  public static async ensureHtaccess(sftp: Client): Promise<void> {
    if (this.htaccessUploaded) return;
    try {
      const basePath = this.getBasePath();
      await sftp.mkdir(basePath, true);
      const htaccessPath = `${basePath}/.htaccess`;
      const buffer = Buffer.from(this.getHtaccessContent(), "utf8");
      await sftp.put(buffer, htaccessPath);
      this.htaccessUploaded = true;
      console.log(`[SFTP] Configured remote .htaccess with CORS and no-cache headers at ${htaccessPath}`);
    } catch (err: any) {
      console.warn("[SFTP] .htaccess upload warning:", err?.message || err);
    }
  }

  public static async clearRemoteStreamDir(streamKey: string): Promise<void> {
    const sftp = new Client();
    const remoteStreamDir = `${this.getBasePath()}/media/${streamKey}`;
    try {
      await sftp.connect(this.getSftpConfig());
      await this.ensureHtaccess(sftp);
      const exists = await sftp.exists(remoteStreamDir);
      if (exists) {
        console.log(`[SFTP] Cleaning up old remote stream directory: ${remoteStreamDir}`);
        await sftp.rmdir(remoteStreamDir, true);
      }
    } catch (err: any) {
      console.warn(`[SFTP] Clear remote directory notice for ${streamKey}:`, err?.message || err);
    } finally {
      try { await sftp.end(); } catch (_) {}
    }
  }

  public static async uploadFile(localFilePath: string, remoteRelativePath: string): Promise<void> {
    if (!fs.existsSync(localFilePath)) return;
    const sftp = new Client();
    const fullRemotePath = `${this.getBasePath()}/${remoteRelativePath.replace(/^\//, "")}`;
    const remoteDir = path.dirname(fullRemotePath).replace(/\\/g, "/");

    try {
      await sftp.connect(this.getSftpConfig());
      await this.ensureHtaccess(sftp);
      await sftp.mkdir(remoteDir, true);
      await sftp.fastPut(localFilePath, fullRemotePath.replace(/\\/g, "/"));
    } catch (err: any) {
      console.warn(`[SFTP] Upload warning for ${remoteRelativePath}:`, err?.message || err);
    } finally {
      try { await sftp.end(); } catch (_) {}
    }
  }
}
