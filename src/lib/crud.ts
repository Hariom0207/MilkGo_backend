import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import type { ZodObject, ZodRawShape } from "zod";
import { db } from "../config/firebase.js";
import { HttpError } from "./errors.js";
import { requireRole } from "../middleware/auth.js";

/**
 * Builds list/get/create/update/delete routes for a simple Firestore collection.
 * `initial` holds server-managed fields set on create only (never client-editable).
 * Reads/writes: any signed-in user; delete: owner only.
 */
export function crudRouter(
  collection: string,
  schema: ZodObject<ZodRawShape>,
  initial: Record<string, unknown> = {},
) {
  const router = Router();
  const col = db.collection(collection);

  router.get("/", async (_req, res) => {
    const snap = await col.orderBy("createdAt", "desc").limit(500).get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });

  router.get("/:id", async (req, res) => {
    const doc = await col.doc(String(req.params.id)).get();
    if (!doc.exists) throw new HttpError(404, "Not found");
    res.json({ id: doc.id, ...doc.data() });
  });

  router.post("/", async (req, res) => {
    const data = schema.parse(req.body);
    const ref = await col.add({
      ...initial,
      ...data,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user!.uid,
    });
    res.status(201).json({ id: ref.id, ...initial, ...data });
  });

  router.patch("/:id", async (req, res) => {
    const partial = schema.partial().parse(req.body);
    const ref = col.doc(String(req.params.id));
    if (!(await ref.get()).exists) throw new HttpError(404, "Not found");
    await ref.update({ ...partial, updatedAt: FieldValue.serverTimestamp() });
    res.json({ id: ref.id, ...partial });
  });

  router.delete("/:id", requireRole("owner"), async (req, res) => {
    await col.doc(String(req.params.id)).delete();
    res.status(204).end();
  });

  return router;
}
