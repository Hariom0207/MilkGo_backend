import type { NextFunction, Request, Response } from "express";
import { adminAuth } from "../config/firebase.js";
import { HttpError } from "../lib/errors.js";

export type Role = "owner" | "staff";

export interface AuthUser {
  uid: string;
  email?: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

/** Verifies the Firebase ID token sent as `Authorization: Bearer <token>`. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new HttpError(401, "Missing auth token");

    const decoded = await adminAuth.verifyIdToken(token).catch(() => {
      throw new HttpError(401, "Invalid or expired token");
    });

    // Role comes from a custom claim; see `npm run set-role`.
    const role: Role = decoded.role === "owner" ? "owner" : "staff";
    req.user = { uid: decoded.uid, email: decoded.email, role };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new HttpError(403, "Not allowed"));
    }
    next();
  };
}
