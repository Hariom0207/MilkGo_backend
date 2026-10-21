import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import type { ZodObject, ZodRawShape } from "zod";
import { db } from "../config/firebase.js";
import { HttpError } from "./errors.js";
import { requireRole, visibleTo } from "../middleware/auth.js";

/**
 * CRUD for a Firestore collection, scoped by vendorId:
 * admin sees all; vendor/staff see own vendor's docs + global (vendorId null) docs.
 * Reads: any approved user (scoped). Create/update: scoped. Delete: admin/vendor only.
 */
export function crudRouter(
  collection: string,
  schema: ZodObject<ZodRawShape>,
  initial: Record<string, unknown> = {},
) {
  const router = Router();
  const col = db.collection(collection);

  router.get("/", async (req, res) => {
    const u = req.user!;
    const snap = u.role === "admin"
      ? await col.orderBy("createdAt", "desc").limit(500).get()
      : await col.where("vendorId", "in", [u.vendorId, null]).limit(500).get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));
    if (u.role !== "admin") rows.sort((a, b) => ((b.createdAt as any)?.toMillis?.() ?? 0) - ((a.createdAt as any)?.toMillis?.() ?? 0));
    res.json(rows);
  });

  const getOwned = async (req: any) => {
    const doc = await col.doc(String(req.params.id)).get();
    if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");
    return doc;
  };

  router.get("/:id", async (req, res) => {
    const doc = await getOwned(req);
    res.json({ id: doc.id, ...doc.data() });
  });

  router.post("/", async (req, res) => {
    const data = schema.parse(req.body);
    const vendorId = req.user!.role === "admin" ? null : req.user!.vendorId;
    const ref = await col.add({
      ...initial, ...data, vendorId,
      createdAt: FieldValue.serverTimestamp(), createdBy: req.user!.uid,
    });
    res.status(201).json({ id: ref.id, ...initial, ...data, vendorId });
  });

  router.patch("/:id", async (req, res) => {
    const partial = schema.partial().parse(req.body);
    const doc = await getOwned(req);
    // Non-admins may only edit their own vendor's docs (not global ones).
    if (req.user!.role !== "admin" && doc.get("vendorId") !== req.user!.vendorId) throw new HttpError(403, "Not allowed");
    await doc.ref.update({ ...partial, updatedAt: FieldValue.serverTimestamp() });
    res.json({ id: doc.id, ...partial });
  });

  router.delete("/:id", requireRole("admin", "vendor"), async (req, res) => {
    const doc = await getOwned(req);
    if (req.user!.role !== "admin" && doc.get("vendorId") !== req.user!.vendorId) throw new HttpError(403, "Not allowed");
    await doc.ref.delete();
    res.status(204).end();
  });

  return router;
}
