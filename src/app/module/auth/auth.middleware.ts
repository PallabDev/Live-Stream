import { Request, Response, NextFunction } from "express";
import { auth } from "../../../../lib/auth.js";

export interface AuthenticatedRequest extends Request {
  user?: any;
  session?: any;
}

export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    if (!session) {
      return res.redirect("/login");
    }

    req.user = session.user;
    req.session = session.session;
    next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    res.redirect("/login");
  }
};

export const redirectIfAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    if (session) {
      return res.redirect("/dashboard");
    }

    next();
  } catch (error) {
    next();
  }
};

export const requireAccess = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (req.user && (req.user.role === "admin" || req.user.hasAccess)) {
    return next();
  }

  res.status(403).render("error", {
    message: "You do not have stream creation access. Please contact your admin.",
    user: req.user || null,
    title: "Access Denied",
  });
};
