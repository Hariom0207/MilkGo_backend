import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../config/firebase.js";
import { HttpError } from "../lib/errors.js";
import { visibleTo } from "../middleware/auth.js";
import { ownerId, scopeIdFromReq, scopedDocs } from "../lib/scope.js";

// Payment received from a customer; reduces their outstanding balance (paise).
const paymentSchema = z.object({
  customerId: z.string().min(1),
  amount: z.number().int().positive(),
  method: z.enum(["cash", "upi", "bank", "other"]).default("cash"),
  note: z.string().optional(),
});

const router = Router();

router.get("/", async (req, res) => {
  let rows = await scopedDocs("payments", scopeIdFromReq(req));
  if (typeof req.query.customerId === "string") rows = rows.filter((r) => r.customerId === req.query.customerId);
  res.json(rows);
});

router.post("/", async (req, res) => {
  const input = paymentSchema.parse(req.body);
  const customerRef = db.collection("customers").doc(input.customerId);
  const paymentRef = db.collection("payments").doc();

  await db.runTransaction(async (tx) => {
    const customer = await tx.get(customerRef);
    if (!customer.exists || !visibleTo(req.user!, customer.get("vendorId"))) throw new HttpError(400, "Customer not found");
    const outstanding = (customer.get("outstandingBalance") as number) ?? 0;
    if (input.amount > outstanding) throw new HttpError(400, "Payment exceeds outstanding balance");

    tx.set(paymentRef, {
      ...input,
      vendorId: ownerId(req.user!),
      customerName: customer.get("name") as string,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user!.uid,
    });
    tx.update(customerRef, {
      outstandingBalance: FieldValue.increment(-input.amount),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  res.status(201).json({ id: paymentRef.id, ...input });
});

export default router;
