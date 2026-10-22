import type { NextFunction, Request, Response } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, db } from "../config/firebase.js";
import { env } from "../config/env.js";
import { HttpError } from "../lib/errors.js";

export type Role = "admin" | "vendor" | "staff"; // hierarchy: admin > vendor > staff
export type Status = "pending" | "approved" | "rejected" | "suspended";

export interface AuthUser {
  uid: string;
  email?: string;
  role: Role;
  status: Status;
  vendorId: string | null; // vendor: own uid, staff: owner's uid, admin: null
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

const normalizeRole = (r: unknown): Role =>
  r === "admin" || r === "owner" ? "admin" : r === "staff" ? "staff" : "vendor";

/** Loads users/{uid} profile (creates vendor/pending on first login; ADMIN_EMAILS -> admin). */
export async function loadProfile(uid: string, email?: string, name?: string) {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const isAdmin = !!email && env.adminEmails.includes(email.toLowerCase());
  if (!snap.exists) {
    const profile = {
      name: name ?? "", email: email ?? "", phone: "",
      role: isAdmin ? "admin" : "vendor", status: isAdmin ? "approved" : "pending",
      vendorId: isAdmin ? null : uid, createdAt: FieldValue.serverTimestamp(),
      lastLoginAt: FieldValue.serverTimestamp(), loginCount: 1,
    };
    await ref.set(profile);
    return { id: uid, ...profile };
  }
  const p = snap.data()!;
  if (isAdmin && (p.role !== "admin" || p.status !== "approved")) {
    await ref.update({ role: "admin", status: "approved", vendorId: null });
    p.role = "admin"; p.status = "approved"; p.vendorId = null;
  }
  return { id: uid, ...p, role: normalizeRole(p.role) };
}

/** Verifies Firebase ID token + approved RBAC profile. `/me` is allowed while pending. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw new HttpError(401, "Missing auth token");
    const decoded = await adminAuth.verifyIdToken(token).catch(() => {
      throw new HttpError(401, "Invalid or expired token");
    });
    const p: any = await loadProfile(decoded.uid, decoded.email, decoded.name);
    req.user = { uid: decoded.uid, email: decoded.email, role: p.role, status: p.status, vendorId: p.vendorId ?? (p.role === "vendor" ? decoded.uid : null) };
    if (p.status !== "approved" && !req.path.startsWith("/me")) {
      throw new HttpError(403, `Account ${p.status}: waiting for admin approval`);
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, "Not allowed"));
    next();
  };
}

/** Admin sees every doc. Everyone else sees only their vendor's docs. */
export const visibleTo = (u: AuthUser, docVendorId: unknown) =>
  u.role === "admin" || docVendorId === u.vendorId;
