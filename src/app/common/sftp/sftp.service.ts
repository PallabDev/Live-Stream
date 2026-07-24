import Client from "ssh2-sftp-client";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

export interface SftpUploadItem {
  localFilePath: string;
  remoteRelativePath: string;
}

export class SFTPService {
  private static clientInstance: Client | null = null;
  private static isConnecting = false;
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
        Header always set Cache-Control "no-cache, no-store, must-revalidate, max-age=0"
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

  private static async getConnectedClient(): Promise<Client> {
    if (this.clientInstance) {
      try {
        await this.clientInstance.cwd();
        return this.clientInstance;
      } catch (_) {
        this.clientInstance = null;
      }
    }

    if (this.isConnecting) {
      await new Promise((r) => setTimeout(r, 200));
      return this.getConnectedClient();
    }

    this.isConnecting = true;
    try {
      const client = new Client();
      await client.connect(this.getSftpConfig());
      this.clientInstance = client;
      await this.ensureHtaccess(client);
      return client;
    } finally {
      this.isConnecting = false;
    }
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
    const remoteStreamDir = `${this.getBasePath()}/media/${streamKey}`;
    try {
      const sftp = await this.getConnectedClient();
      const exists = await sftp.exists(remoteStreamDir);
      if (exists) {
        console.log(`[SFTP] Cleaning up old remote stream directory: ${remoteStreamDir}`);
        await sftp.rmdir(remoteStreamDir, true);
      }
    } catch (err: any) {
      console.warn(`[SFTP] Clear remote directory notice for ${streamKey}:`, err?.message || err);
      this.clientInstance = null;
    }
  }

  public static async uploadMultipleFilesOrdered(items: SftpUploadItem[]): Promise<void> {
    if (items.length === 0) return;
    try {
      const sftp = await this.getConnectedClient();
      for (const item of items) {
        if (!fs.existsSync(item.localFilePath)) continue;
        const fullRemotePath = `${this.getBasePath()}/${item.remoteRelativePath.replace(/^\//, "")}`;
        const remoteDir = path.dirname(fullRemotePath).replace(/\\/g, "/");
        await sftp.mkdir(remoteDir, true);
        await sftp.fastPut(item.localFilePath, fullRemotePath.replace(/\\/g, "/"));
      }
    } catch (err: any) {
      console.warn("[SFTP] Sequential upload notice:", err?.message || err);
      this.clientInstance = null;
    }
  }

  public static async uploadFile(localFilePath: string, remoteRelativePath: string): Promise<void> {
    await this.uploadMultipleFilesOrdered([{ localFilePath, remoteRelativePath }]);
  }
}
