import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../config/firebase.js";
import { syncCustomerAccount } from "../lib/customerAccount.js";
import { HttpError } from "../lib/errors.js";
import { visibleTo } from "../middleware/auth.js";
import { ownerId, scopeIdFromReq, scopedDocs } from "../lib/scope.js";

// Money is integer paise; date is YYYY-MM-DD, time is HH:mm.
export const salesOrderSchema = z.object({
  customerName: z.string().min(1),
  customerId: z.string().min(1, "Select a customer from the list (or add a new one)"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        unit: z.string().optional(),
        quantity: z.number().positive(),
        rate: z.number().int().nonnegative(),
        amount: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  total: z.number().int().nonnegative(),
  status: z.enum(["Pending", "Delivered", "Paid"]).default("Pending"),
});

const router = Router();
const col = db.collection("salesOrders");

router.get("/", async (req, res) => {
  let rows = await scopedDocs("salesOrders", scopeIdFromReq(req));
  if (typeof req.query.customerId === "string") {
    rows = rows.filter((r) => r.customerId === req.query.customerId);
  }
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const doc = await col.doc(String(req.params.id)).get();
  if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");
  res.json({ id: doc.id, ...doc.data() });
});

router.post("/", async (req, res) => {
  const data = salesOrderSchema.parse(req.body);
  const customer = await db.collection("customers").doc(data.customerId).get();
  if (!customer.exists || !visibleTo(req.user!, customer.get("vendorId"))) {
    throw new HttpError(400, "Customer not found");
  }
  const vendorId = ownerId(req.user!);
  const ref = await col.add({
    ...data,
    customerName: (customer.get("name") as string) || data.customerName,
    vendorId,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: req.user!.uid,
  });
  const summary = await syncCustomerAccount(data.customerId);
  res.status(201).json({ id: ref.id, ...data, vendorId, account: summary });
});

router.patch("/:id", async (req, res) => {
  const partial = salesOrderSchema.partial().parse(req.body);
  const doc = await col.doc(String(req.params.id)).get();
  if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");
  if (req.user!.role !== "admin" && doc.get("vendorId") !== req.user!.vendorId) {
    throw new HttpError(403, "Not allowed");
  }

  const customerId = (partial.customerId as string | undefined) || (doc.get("customerId") as string);
  if (partial.customerId) {
    const customer = await db.collection("customers").doc(partial.customerId).get();
    if (!customer.exists || !visibleTo(req.user!, customer.get("vendorId"))) {
      throw new HttpError(400, "Customer not found");
    }
    partial.customerName = (customer.get("name") as string) || partial.customerName || doc.get("customerName");
  }

  await doc.ref.update({ ...partial, updatedAt: FieldValue.serverTimestamp() });

  const prevCustomerId = doc.get("customerId") as string | undefined;
  const summary = customerId ? await syncCustomerAccount(customerId) : null;
  if (prevCustomerId && prevCustomerId !== customerId) await syncCustomerAccount(prevCustomerId);

  res.json({ id: doc.id, ...partial, account: summary });
});

router.delete("/:id", async (req, res) => {
  if (req.user!.role !== "admin" && req.user!.role !== "vendor" && req.user!.role !== "staff") {
    throw new HttpError(403, "Not allowed");
  }
  const doc = await col.doc(String(req.params.id)).get();
  if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");
  if (req.user!.role !== "admin" && doc.get("vendorId") !== req.user!.vendorId) {
    throw new HttpError(403, "Not allowed");
  }
  const customerId = doc.get("customerId") as string | undefined;
  // Keep payment history intact; only remove the sale and resync balances.
  await doc.ref.delete();
  if (customerId) await syncCustomerAccount(customerId);
  res.status(204).end();
});

export default router;
