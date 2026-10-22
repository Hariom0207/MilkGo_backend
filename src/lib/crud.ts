import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import type { ZodObject, ZodRawShape } from "zod";
import { db } from "../config/firebase.js";
import { HttpError } from "./errors.js";
import { requireRole, visibleTo } from "../middleware/auth.js";
import { ownerId, scopeIdFromReq, scopedDocs } from "./scope.js";

/**
 * CRUD scoped by vendorId. Admin sees all (or `?vendorId=`). Vendor and staff see that vendor only.
 * `staffCreate`: staff may POST (purchase and sales records) but never edit or delete.
 */
export function crudRouter(
  collection: string,
  schema: ZodObject<ZodRawShape>,
  initial: Record<string, unknown> = {},
  staffCreate = false,
) {
  const router = Router();
  const col = db.collection(collection);
  const staffBlocked = (req: { user?: { role: string } }) => {
    if (req.user?.role === "staff") throw new HttpError(403, "Staff can only add purchase and sales records");
  };

  router.get("/", async (req, res) => {
    res.json(await scopedDocs(collection, scopeIdFromReq(req)));
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
    if (req.user!.role === "staff" && !staffCreate) staffBlocked(req);
    const data = schema.parse(req.body);
    const vendorId = ownerId(req.user!);
    const ref = await col.add({
      ...initial, ...data, vendorId,
      createdAt: FieldValue.serverTimestamp(), createdBy: req.user!.uid,
    });
    res.status(201).json({ id: ref.id, ...initial, ...data, vendorId });
  });

  router.patch("/:id", async (req, res) => {
    const staffStatusOnly = req.user!.role === "staff" && staffCreate && Object.keys(req.body ?? {}).every((k) => k === "status");
    if (req.user!.role === "staff" && !staffStatusOnly) staffBlocked(req);
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
