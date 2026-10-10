import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../config/firebase.js";
import { HttpError } from "../lib/errors.js";

// Payment received from a customer; reduces their outstanding balance (paise).
const paymentSchema = z.object({
  customerId: z.string().min(1),
  amount: z.number().int().positive(),
  method: z.enum(["cash", "upi", "bank", "other"]).default("cash"),
  note: z.string().optional(),
});

const router = Router();

router.get("/", async (req, res) => {
  let q: FirebaseFirestore.Query = db.collection("payments");
  if (typeof req.query.customerId === "string") q = q.where("customerId", "==", req.query.customerId);
  const snap = await q.orderBy("createdAt", "desc").limit(500).get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});

router.post("/", async (req, res) => {
  const input = paymentSchema.parse(req.body);
  const customerRef = db.collection("customers").doc(input.customerId);
  const paymentRef = db.collection("payments").doc();

  await db.runTransaction(async (tx) => {
    const customer = await tx.get(customerRef);
    if (!customer.exists) throw new HttpError(400, "Customer not found");
    const outstanding = (customer.get("outstandingBalance") as number) ?? 0;
    if (input.amount > outstanding) throw new HttpError(400, "Payment exceeds outstanding balance");

    tx.set(paymentRef, {
      ...input,
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
