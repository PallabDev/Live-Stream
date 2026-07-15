import { Request, Response } from "express";
import { AuthService } from "./auth.service.js";

export class AuthController {
  static async listUsers(req: Request, res: Response) {
    try {
      const users = await AuthService.getAllUsers();
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
}
