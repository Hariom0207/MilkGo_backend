import { FieldValue } from "firebase-admin/firestore";
import { db } from "../config/firebase.js";
import { HttpError } from "./errors.js";

export type OrderMoney = {
  id: string;
  date?: string;
  time?: string;
  total: number;
  amountPaid: number;
  status?: string;
  due: number;
};

/** How much of an order is still unpaid (paise). */
export function orderDue(o: { total?: unknown; amountPaid?: unknown; status?: unknown }) {
  const total = Number(o.total) || 0;
  const paid = Number(o.amountPaid) || (o.status === "Paid" ? total : 0);
  return Math.max(0, total - paid);
}

export function asOrderMoney(id: string, data: FirebaseFirestore.DocumentData): OrderMoney {
  const total = Number(data.total) || 0;
  const amountPaid = Number(data.amountPaid) || (data.status === "Paid" ? total : 0);
  return {
    id,
    date: data.date,
    time: data.time,
    total,
    amountPaid,
    status: data.status,
    due: Math.max(0, total - amountPaid),
  };
}

/** Unpaid sales for a customer, optionally filtered by sale date range (inclusive). */
export async function unpaidOrders(customerId: string, from?: string, to?: string) {
  const snap = await db.collection("salesOrders").where("customerId", "==", customerId).get();
  return snap.docs
    .map((d) => asOrderMoney(d.id, d.data()))
    .filter((o) => {
      if (o.due <= 0) return false;
      if (from && (o.date || "") < from) return false;
      if (to && (o.date || "") > to) return false;
      return true;
    })
    .sort((a, b) => `${a.date ?? ""} ${a.time ?? ""}`.localeCompare(`${b.date ?? ""} ${b.time ?? ""}`));
}

/**
 * Recompute customer bought / paid / pending / advance from sales + payments.
 * Does not invent payment rows — settlements write real payments with codes.
 */
export async function syncCustomerAccount(customerId: string) {
  const customerRef = db.collection("customers").doc(customerId);
  const customer = await customerRef.get();
  if (!customer.exists) throw new HttpError(404, "Customer not found");

  const [ordersSnap, paymentsSnap] = await Promise.all([
    db.collection("salesOrders").where("customerId", "==", customerId).get(),
    db.collection("payments").where("customerId", "==", customerId).get(),
  ]);

  const orders = ordersSnap.docs.map((d) => asOrderMoney(d.id, d.data()));
  const payments = paymentsSnap.docs.filter((d) => !d.get("voided"));

  // Heal legacy "Paid" rows that never got amountPaid written.
  const batch = db.batch();
  let heals = 0;
  for (const doc of ordersSnap.docs) {
    const data = doc.data();
    if (data.status === "Paid" && data.amountPaid == null) {
      batch.update(doc.ref, { amountPaid: Number(data.total) || 0 });
      heals += 1;
    }
  }
  if (heals) await batch.commit();

  const bought = orders.reduce((sum, o) => sum + o.total, 0);
  const paid = payments.reduce((sum, d) => sum + (Number(d.get("amount")) || 0), 0);
  const pending = Math.max(0, bought - paid);
  const advance = Math.max(0, paid - bought);

  await customerRef.update({
    totalPurchased: bought,
    totalPaid: paid,
    outstandingBalance: pending,
    advanceBalance: advance,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return {
    customerId,
    bought,
    paid,
    pending,
    advance,
    orderCount: orders.length,
    paymentCount: payments.length,
  };
}
