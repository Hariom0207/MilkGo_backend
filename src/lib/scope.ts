import type { Request } from "express";
import { db } from "../config/firebase.js";
import { HttpError } from "./errors.js";
import type { AuthUser } from "../middleware/auth.js";

/** Admin with no query sees every vendor. A `vendorId` query, or any other role, is one vendor. */
export function scopeId(user: AuthUser, vendorIdQuery: unknown): string | null {
  if (user.role === "admin") return typeof vendorIdQuery === "string" && vendorIdQuery ? vendorIdQuery : null;
  if (!user.vendorId) throw new HttpError(403, "No vendor scope");
  return user.vendorId;
}

export const scopeIdFromReq = (req: Request) => scopeId(req.user!, req.query.vendorId);

/** Stored on new docs. Admin rows stay unassigned unless a vendor id is passed. */
export const ownerId = (user: AuthUser) => (user.role === "admin" ? null : user.vendorId);

export async function scopedDocs(collection: string, vendorId: string | null) {
  const col = db.collection(collection);
  const snap = vendorId
    ? await col.where("vendorId", "==", vendorId).limit(500).get()
    : await col.orderBy("createdAt", "desc").limit(500).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);
  if (vendorId) {
    rows.sort((a, b) => ((b.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0) - ((a.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0));
  }
  return rows;
}

export const kolkataDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
