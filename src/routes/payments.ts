import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../config/firebase.js";
import { syncCustomerAccount, unpaidOrders } from "../lib/customerAccount.js";
import { HttpError } from "../lib/errors.js";
import { requireRole, visibleTo, type AuthUser } from "../middleware/auth.js";
import { ownerId, scopeIdFromReq, scopedDocs } from "../lib/scope.js";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^\d{2}:\d{2}$/);
const methodEnum = z.enum(["cash", "upi", "bank", "cheque"]);

const quoteSchema = z.object({
  customerId: z.string().min(1),
  /** Sale period the customer says they are paying for (inclusive). */
  periodFrom: dateStr,
  periodTo: dateStr,
});

const settleSchema = z.object({
  customerId: z.string().min(1),
  /** Confirmed amount in paise (must match quote unless allowAdvance / partial). */
  amount: z.number().int().positive(),
  method: methodEnum,
  date: dateStr.optional(),
  time: timeStr.optional(),
  periodFrom: dateStr.optional(),
  periodTo: dateStr.optional(),
  /** Explicit orders; if omitted, unpaid orders in periodFrom–periodTo are used. */
  orderIds: z.array(z.string().min(1)).optional(),
  /** Allow amount above selected dues → remaining counted as advance. */
  allowAdvance: z.boolean().optional(),
  note: z.string().max(500).optional(),
  chequeNo: z.string().max(64).optional(),
  referenceNo: z.string().max(64).optional(),
});

const kolkataNow = () => {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
  return { date, time };
};

const nextPaymentCode = () => `PAY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

async function collectorName(uid: string) {
  const u = await db.collection("users").doc(uid).get();
  return (u.get("name") as string) || (u.get("email") as string) || uid.slice(0, 8);
}

async function loadCustomer(customerId: string, user: AuthUser) {
  const customer = await db.collection("customers").doc(customerId).get();
  if (!customer.exists || !visibleTo(user, customer.get("vendorId"))) {
    throw new HttpError(404, "Customer not found");
  }
  return customer;
}

const router = Router();

/** List payments (sensitive — vendor scope only). */
router.get("/", requireRole("admin", "vendor", "staff"), async (req, res) => {
  let rows = await scopedDocs("payments", scopeIdFromReq(req));
  rows = rows.filter((r) => !r.voided);
  if (typeof req.query.customerId === "string") {
    rows = rows.filter((r) => r.customerId === req.query.customerId);
  }
  res.json(rows);
});

/** Single payment receipt. */
router.get("/:id", requireRole("admin", "vendor", "staff"), async (req, res) => {
  const doc = await db.collection("payments").doc(String(req.params.id)).get();
  if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");
  res.json({ id: doc.id, ...doc.data() });
});

/**
 * Quote dues for a sale period — "customer pays for day 1–7, how much?"
 * Returns unpaid orders in range + total due so UI can confirm before collecting.
 */
router.post("/quote", requireRole("admin", "vendor", "staff"), async (req, res) => {
  const input = quoteSchema.parse(req.body);
  if (input.periodTo < input.periodFrom) throw new HttpError(400, "periodTo must be on or after periodFrom");
  await loadCustomer(input.customerId, req.user!);
  const orders = await unpaidOrders(input.customerId, input.periodFrom, input.periodTo);
  const due = orders.reduce((s, o) => s + o.due, 0);
  res.json({
    customerId: input.customerId,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    orderIds: orders.map((o) => o.id),
    orders,
    due,
    orderCount: orders.length,
  });
});

/**
 * Record a settlement / advance payment.
 * Allocates to unpaid orders FIFO (by date) within the selected period/orders.
 * Excess with allowAdvance=true is stored as advance on the customer account.
 */
router.post("/", requireRole("admin", "vendor", "staff"), async (req, res) => {
  const input = settleSchema.parse(req.body);
  const customer = await loadCustomer(input.customerId, req.user!);
  const { date: today, time: now } = kolkataNow();
  const date = input.date || today;
  const time = input.time || now;

  let targets = input.orderIds?.length
    ? (await unpaidOrders(input.customerId)).filter((o) => input.orderIds!.includes(o.id))
    : input.periodFrom && input.periodTo
      ? await unpaidOrders(input.customerId, input.periodFrom, input.periodTo)
      : await unpaidOrders(input.customerId);

  if (input.orderIds?.length) {
    const map = new Map(targets.map((o) => [o.id, o]));
    targets = input.orderIds.map((id) => map.get(id)).filter(Boolean) as typeof targets;
  }

  const due = targets.reduce((s, o) => s + o.due, 0);
  if (input.amount > due && !input.allowAdvance) {
    throw new HttpError(
      400,
      due === 0
        ? "No unpaid sales in this period. Enable advance to take advance payment."
        : `Amount exceeds period due (${due} paise). Confirm advance or lower the amount.`,
    );
  }
  if (input.method === "cheque" && !input.chequeNo?.trim()) {
    throw new HttpError(400, "Cheque number is required for cheque payments");
  }

  const applyToDues = Math.min(input.amount, due);
  const advancePart = Math.max(0, input.amount - due);
  const allocations: { orderId: string; amount: number }[] = [];

  const paymentRef = db.collection("payments").doc();
  const code = nextPaymentCode();
  const collectedByName = await collectorName(req.user!.uid);

  await db.runTransaction(async (tx) => {
    const fresh: { id: string; ref: FirebaseFirestore.DocumentReference; due: number; total: number; amountPaid: number; status?: string }[] = [];
    for (const t of targets) {
      const ref = db.collection("salesOrders").doc(t.id);
      const doc = await tx.get(ref);
      if (!doc.exists) continue;
      if (doc.get("customerId") !== input.customerId) continue;
      if (!visibleTo(req.user!, doc.get("vendorId"))) continue;
      const total = Number(doc.get("total")) || 0;
      const amountPaid = Number(doc.get("amountPaid")) || (doc.get("status") === "Paid" ? total : 0);
      const dueNow = Math.max(0, total - amountPaid);
      if (dueNow > 0) fresh.push({ id: doc.id, ref, due: dueNow, total, amountPaid, status: doc.get("status") });
    }

    let remaining = applyToDues;
    for (const o of fresh) {
      if (remaining <= 0) break;
      const take = Math.min(o.due, remaining);
      const newPaid = o.amountPaid + take;
      const status = newPaid >= o.total ? "Paid" : o.status === "Paid" ? "Delivered" : o.status || "Pending";
      tx.update(o.ref, {
        amountPaid: newPaid,
        status,
        updatedAt: FieldValue.serverTimestamp(),
      });
      allocations.push({ orderId: o.id, amount: take });
      remaining -= take;
    }

    tx.set(paymentRef, {
      code,
      customerId: input.customerId,
      customerName: customer.get("name") as string,
      amount: input.amount,
      appliedAmount: applyToDues,
      advanceAmount: advancePart,
      method: input.method,
      date,
      time,
      periodFrom: input.periodFrom || null,
      periodTo: input.periodTo || null,
      orderIds: allocations.map((a) => a.orderId),
      allocations,
      kind: advancePart > 0 && applyToDues === 0 ? "advance" : advancePart > 0 ? "settlement_advance" : "settlement",
      note: input.note || null,
      chequeNo: input.chequeNo || null,
      referenceNo: input.referenceNo || null,
      collectedBy: req.user!.uid,
      collectedByName,
      vendorId: ownerId(req.user!),
      voided: false,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user!.uid,
    });
  });

  const account = await syncCustomerAccount(input.customerId);
  const saved = await paymentRef.get();
  res.status(201).json({ id: paymentRef.id, ...saved.data(), account });
});

/** Soft-void a payment (vendor/admin only) and reverse allocations. */
router.post("/:id/void", requireRole("admin", "vendor"), async (req, res) => {
  const ref = db.collection("payments").doc(String(req.params.id));
  const doc = await ref.get();
  if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");
  if (doc.get("voided")) throw new HttpError(400, "Payment already voided");

  const allocations = (doc.get("allocations") as { orderId: string; amount: number }[] | undefined) || [];
  const customerId = doc.get("customerId") as string;

  await db.runTransaction(async (tx) => {
    for (const a of allocations) {
      const oref = db.collection("salesOrders").doc(a.orderId);
      const o = await tx.get(oref);
      if (!o.exists) continue;
      const total = Number(o.get("total")) || 0;
      const amountPaid = Math.max(0, (Number(o.get("amountPaid")) || 0) - (Number(a.amount) || 0));
      const status = amountPaid >= total ? "Paid" : o.get("status") === "Paid" ? "Delivered" : o.get("status") || "Pending";
      tx.update(oref, { amountPaid, status, updatedAt: FieldValue.serverTimestamp() });
    }
    tx.update(ref, {
      voided: true,
      voidedAt: FieldValue.serverTimestamp(),
      voidedBy: req.user!.uid,
    });
  });

  const account = await syncCustomerAccount(customerId);
  res.json({ id: doc.id, voided: true, account });
});

export default router;
