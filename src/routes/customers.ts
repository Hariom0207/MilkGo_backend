import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { crudRouter } from "../lib/crud.js";
import { db } from "../config/firebase.js";
import { HttpError } from "../lib/errors.js";
import { visibleTo } from "../middleware/auth.js";

// outstandingBalance/totalPurchased are server-managed (updated by sales/payments).
// Money is always stored as integer paise; quantities in litres/units.
export const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.union([z.literal(""), z.string().regex(/^[6-9]\d{9}$/, "Phone must be a valid 10-digit mobile number")]).optional(),
  address: z.string().optional(),
  email: z.union([z.literal(""), z.string().email()]).optional(),
  gstin: z.string().optional(),
  type: z.enum(["retailer", "walkin"]),
  status: z.enum(["pending", "active"]).optional(),
});

const base = crudRouter("customers", customerSchema, { outstandingBalance: 0, totalPurchased: 0, status: "active" });
const router = Router();

/**
 * Rename propagation: sales/salesOrders store customerName as a snapshot,
 * so a customer rename must update those historical docs (scoped to this
 * customer's vendor) and backfill customerId on salesOrders.
 */
router.patch("/:id", async (req, res) => {
  if (req.user!.role === "staff") throw new HttpError(403, "Staff can only add purchase and sales records");
  const id = String(req.params.id);
  const partial = customerSchema.partial().parse(req.body);
  const ref = db.collection("customers").doc(id);
  const doc = await ref.get();
  if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");
  if (req.user!.role !== "admin" && doc.get("vendorId") !== req.user!.vendorId) throw new HttpError(403, "Not allowed");

  const oldName = doc.get("name") as string;
  await ref.update({ ...partial, updatedAt: FieldValue.serverTimestamp() });

  if (partial.name && partial.name !== oldName) {
    const custVendor = doc.get("vendorId") ?? null;
    const inScope = (d: FirebaseFirestore.DocumentSnapshot) => custVendor == null || d.get("vendorId") === custVendor || d.get("vendorId") == null;
    const updates: FirebaseFirestore.DocumentReference[] = [];

    const byName = await db.collection("salesOrders").where("customerName", "==", oldName).limit(500).get();
    byName.docs.filter(inScope).forEach((d) => updates.push(d.ref));
    const salesById = await db.collection("sales").where("customerId", "==", id).limit(500).get();
    salesById.docs.forEach((d) => { if (!updates.includes(d.ref)) updates.push(d.ref); });
    const salesByName = await db.collection("sales").where("customerName", "==", oldName).limit(500).get();
    salesByName.docs.filter(inScope).forEach((d) => { if (!updates.includes(d.ref)) updates.push(d.ref); });

    for (let i = 0; i < updates.length; i += 400) {
      const batch = db.batch();
      updates.slice(i, i + 400).forEach((r) => batch.update(r, { customerName: partial.name, ...(r.parent.id === "salesOrders" ? { customerId: id } : {}) }));
      await batch.commit();
    }
  }
  res.json({ id, ...partial });
});

router.use(base);
export default router;
