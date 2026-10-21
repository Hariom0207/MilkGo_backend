import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../config/firebase.js";
import { HttpError } from "../lib/errors.js";
import { visibleTo } from "../middleware/auth.js";

// Money is integer paise; quantity may be fractional (litres).
const saleSchema = z.object({
  customerId: z.string().min(1),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().positive(),
        rate: z.number().int().nonnegative().optional(), // paise per unit; defaults to product.defaultRate
      }),
    )
    .min(1),
  amountPaid: z.number().int().nonnegative().default(0),
  note: z.string().optional(),
});

const router = Router();

router.get("/", async (req, res) => {
  let q: FirebaseFirestore.Query = db.collection("sales");
  if (req.user!.role !== "admin") q = q.where("vendorId", "in", [req.user!.vendorId, null]);
  if (typeof req.query.customerId === "string") q = q.where("customerId", "==", req.query.customerId);
  const snap = await q.limit(500).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>));
  rows.sort((a, b) => ((b.createdAt as any)?.toMillis?.() ?? 0) - ((a.createdAt as any)?.toMillis?.() ?? 0));
  res.json(rows);
});

router.get("/:id", async (req, res) => {
  const doc = await db.collection("sales").doc(String(req.params.id)).get();
  if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");
  res.json({ id: doc.id, ...doc.data() });
});

router.post("/", async (req, res) => {
  const input = saleSchema.parse(req.body);
  const customerRef = db.collection("customers").doc(input.customerId);
  const saleRef = db.collection("sales").doc();

  const sale = await db.runTransaction(async (tx) => {
    // All reads first, then writes.
    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const [customerDoc, ...productDocs] = await tx.getAll(
      customerRef,
      ...productIds.map((id) => db.collection("products").doc(id)),
    );
    if (!customerDoc.exists || !visibleTo(req.user!, customerDoc.get("vendorId"))) throw new HttpError(400, "Customer not found");
    const products = new Map(productDocs.map((d) => [d.id, d]));

    const items = input.items.map((i) => {
      const product = products.get(i.productId);
      if (!product?.exists) throw new HttpError(400, `Product not found: ${i.productId}`);
      const rate = i.rate ?? (product.get("defaultRate") as number);
      return {
        productId: i.productId,
        name: product.get("name") as string,
        unit: product.get("unit") as string,
        quantity: i.quantity,
        rate,
        amount: Math.round(i.quantity * rate),
      };
    });

    const total = items.reduce((sum, i) => sum + i.amount, 0);
    if (input.amountPaid > total) throw new HttpError(400, "amountPaid exceeds sale total");
    const due = total - input.amountPaid;

    const doc = {
      customerId: input.customerId,
      customerName: customerDoc.get("name") as string,
      items,
      total,
      amountPaid: input.amountPaid,
      due,
      ...(input.note ? { note: input.note } : {}),
      vendorId: req.user!.role === "admin" ? null : req.user!.vendorId,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user!.uid,
    };
    tx.set(saleRef, doc);
    tx.update(customerRef, {
      totalPurchased: FieldValue.increment(total),
      outstandingBalance: FieldValue.increment(due),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { id: saleRef.id, ...doc, createdAt: undefined };
  });

  res.status(201).json(sale);
});

export default router;
