import { exec } from "child_process";
import util from "util";

const execPromise = util.promisify(exec);

export class DockerService {
  /**
   * Restarts the caddy-proxy docker container when network settings or proxies change.
   */
  static async restartCaddyProxy() {
    try {
      console.log("[Docker] Executing 'docker restart caddy-proxy'...");
      const { stdout, stderr } = await execPromise("docker restart caddy-proxy");
      console.log("[Docker] caddy-proxy restarted successfully:", stdout.trim());
      return { success: true, output: stdout.trim() };
    } catch (err: any) {
      console.warn("[Docker] Failed to restart caddy-proxy:", err.message);
      return { success: false, error: err.message };
    }
  }
}
