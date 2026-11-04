import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { syncCustomerAccount } from "../lib/customerAccount.js";
import { crudRouter } from "../lib/crud.js";
import { db } from "../config/firebase.js";
import { HttpError } from "../lib/errors.js";
import { visibleTo } from "../middleware/auth.js";
import { scopeIdFromReq, scopedDocs } from "../lib/scope.js";

// outstandingBalance/totalPurchased/totalPaid are server-managed via syncCustomerAccount.
// Money is always stored as integer paise; quantities in litres/units.
export const customerSchema = z.object({
  name: z.string().min(1),
  /** Human-facing customer id shown in lists (e.g. MG-A1B2C3). */
  code: z.string().min(1).max(32).optional(),
  phone: z.union([z.literal(""), z.string().regex(/^[6-9]\d{9}$/, "Phone must be a valid 10-digit mobile number")]).optional(),
  address: z.string().optional(),
  email: z.union([z.literal(""), z.string().email()]).optional(),
  gstin: z.string().optional(),
  type: z.enum(["retailer", "walkin"]),
  status: z.enum(["pending", "active"]).optional(),
});

// Staff may create a customer while adding a sale; they still cannot edit/delete.
const base = crudRouter("customers", customerSchema, { outstandingBalance: 0, totalPurchased: 0, totalPaid: 0, advanceBalance: 0, status: "active" }, true);
const router = Router();

/** List customers; ?sync=1 recomputes bought/paid/pending from orders + payments. */
router.get("/", async (req, res) => {
  const vendorId = scopeIdFromReq(req);
  let rows = await scopedDocs("customers", vendorId);
  if (req.query.sync === "1" || req.query.sync === "true") {
    await Promise.all(rows.map((r) => syncCustomerAccount(String(r.id)).catch(() => null)));
    rows = await scopedDocs("customers", vendorId);
  }
  res.json(rows);
});

async function customerAccountPayload(req: Parameters<typeof scopeIdFromReq>[0], id: string) {
  const doc = await db.collection("customers").doc(id).get();
  if (!doc.exists || !visibleTo(req.user!, doc.get("vendorId"))) throw new HttpError(404, "Not found");

  let summary = {
    customerId: id,
    bought: Number(doc.get("totalPurchased") || 0),
    paid: Number(doc.get("totalPaid") || 0),
    pending: Number(doc.get("outstandingBalance") || 0),
    advance: Number(doc.get("advanceBalance") || 0),
    orderCount: 0,
    paymentCount: 0,
  };
  try {
    summary = await syncCustomerAccount(id);
  } catch (err) {
    console.error("syncCustomerAccount failed", id, err);
  }

  const refreshed = await db.collection("customers").doc(id).get();
  const vendorScope = scopeIdFromReq(req);
  const [orders, payments] = await Promise.all([
    scopedDocs("salesOrders", vendorScope).then((rows) =>
      rows
        .filter((r) => r.customerId === id)
        .sort((a, b) => `${b.date ?? ""} ${b.time ?? ""}`.localeCompare(`${a.date ?? ""} ${a.time ?? ""}`)),
    ),
    scopedDocs("payments", vendorScope).then((rows) =>
      rows
        .filter((r) => r.customerId === id && !r.voided)
        .sort((a, b) => `${b.date ?? ""} ${b.time ?? ""}`.localeCompare(`${a.date ?? ""} ${a.time ?? ""}`)),
    ),
  ]);

  if (!summary.orderCount && orders.length) {
    const bought = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    summary = {
      customerId: id,
      bought,
      paid,
      pending: Math.max(0, bought - paid),
      advance: Math.max(0, paid - bought),
      orderCount: orders.length,
      paymentCount: payments.length,
    };
  }

  return {
    customer: { id: refreshed.id, ...refreshed.data() },
    summary,
    orders,
    payments,
  };
}

/** Full ledger for one customer. Always keyed by customerId (never by name). */
router.get("/:id/account", async (req, res) => {
  res.json(await customerAccountPayload(req, String(req.params.id)));
});
/** Alias — some clients/bookmarks use /ledger. */
router.get("/:id/ledger", async (req, res) => {
  res.json(await customerAccountPayload(req, String(req.params.id)));
});

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
