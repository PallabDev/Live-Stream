import { Request, Response } from "express";
import { AuthService } from "./auth.service.js";
import { TelemetryService } from "../stream/telemetry.service.js";

export class AuthController {
  static async listUsers(req: Request, res: Response) {
    try {
      const users = await AuthService.getAllUsersWithStats();
      res.json(users);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async toggleAccess(req: Request, res: Response) {
    try {
      const { userId, hasAccess } = req.body;
      if (!userId) {
        return res.status(400).json({ success: false, error: "UserId is required." });
      }
      await AuthService.updateUserAccess(userId, !!hasAccess);
      res.json({ success: true, message: "User streaming access updated successfully." });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async changeRole(req: Request, res: Response) {
    try {
      const { userId, role } = req.body;
      if (!userId || !role || (role !== "admin" && role !== "user")) {
        return res.status(400).json({ success: false, error: "Invalid userId or role." });
      }
      await AuthService.updateUserRole(userId, role);
      res.json({ success: true, message: `User role updated to ${role} successfully.` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async updateQuota(req: Request, res: Response) {
    try {
      const { userId, maxAllowedStreams } = req.body;
      if (!userId || typeof maxAllowedStreams !== "number" || maxAllowedStreams < 0) {
        return res.status(400).json({ success: false, error: "Invalid userId or maxAllowedStreams." });
      }
      await AuthService.updateUserQuota(userId, maxAllowedStreams);
      res.json({ success: true, message: `Stream quota updated to ${maxAllowedStreams} live broadcasts.` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async toggleBlock(req: Request, res: Response) {
    try {
      const { userId, isBlockedFromStreaming } = req.body;
      if (!userId) {
        return res.status(400).json({ success: false, error: "UserId is required." });
      }
      await AuthService.toggleUserBlock(userId, !!isBlockedFromStreaming);
      res.json({ 
        success: true, 
        message: isBlockedFromStreaming ? "User has been blocked from streaming." : "User streaming block removed." 
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async resetQuota(req: Request, res: Response) {
    try {
      const { userId } = req.body;
      if (!userId) {
        return res.status(400).json({ success: false, error: "UserId is required." });
      }
      await TelemetryService.resetUserQuota(userId);
      res.json({ success: true, message: "User quota usage reset successfully." });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  static async getTelemetry(req: Request, res: Response) {
    try {
      const logs = await TelemetryService.getAdminTelemetryLogs();
      res.json({ success: true, logs });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
}
