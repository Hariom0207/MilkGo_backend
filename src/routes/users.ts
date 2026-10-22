import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminAuth, db } from "../config/firebase.js";
import { HttpError } from "../lib/errors.js";
import { paise } from "../lib/rollup.js";
import { kolkataDate, scopedDocs } from "../lib/scope.js";
import { loadProfile, requireRole } from "../middleware/auth.js";

const router = Router();
const users = () => db.collection("users");

// Current user's profile; also records the login (frontend calls this once per session).
router.get("/me", async (req, res) => {
  const ref = users().doc(req.user!.uid);
  await ref.update({ lastLoginAt: FieldValue.serverTimestamp(), loginCount: FieldValue.increment(1) });
  res.json(await loadProfile(req.user!.uid, req.user!.email));
});

// ---- Admin: all users, approve / suspend / role / delete ----
router.get("/admin/users", requireRole("admin"), async (_req, res) => {
  const snap = await users().limit(1000).get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});

const phone = z.string().regex(/^[6-9]\d{9}$/, "Phone must be a valid 10-digit mobile number");
const patchSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "suspended"]).optional(),
  role: z.enum(["admin", "vendor", "staff"]).optional(),
  name: z.string().min(1).optional(),
  phone: phone.optional(),
  email: z.string().email().optional(),
});
router.patch("/admin/users/:id", requireRole("admin"), async (req, res) => {
  const id = String(req.params.id);
  if (id === req.user!.uid && req.body?.status && req.body.status !== "approved") throw new HttpError(400, "Cannot change your own status");
  const data = patchSchema.parse(req.body);
  const ref = users().doc(id);
  if (!(await ref.get()).exists) throw new HttpError(404, "User not found");
  if (data.email) await adminAuth.updateUser(id, { email: data.email }).catch(() => { throw new HttpError(400, "Could not change email. It may already be in use."); });
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  // Keep Firebase Auth in sync: suspended/rejected users cannot sign in; role as custom claim.
  if (data.status) await adminAuth.updateUser(id, { disabled: data.status === "suspended" || data.status === "rejected" }).catch(() => {});
  if (data.name) await adminAuth.updateUser(id, { displayName: data.name }).catch(() => {});
  if (data.role) await adminAuth.setCustomUserClaims(id, { role: data.role }).catch(() => {});
  res.json({ id, ...data });
});

router.delete("/admin/users/:id", requireRole("admin"), async (req, res) => {
  const id = String(req.params.id);
  if (id === req.user!.uid) throw new HttpError(400, "Cannot delete yourself");
  await users().doc(id).delete();
  await adminAuth.deleteUser(id).catch(() => {});
  res.status(204).end();
});

// ---- Vendor/Admin: my staff ----
router.get("/team/staff", requireRole("admin", "vendor"), async (req, res) => {
  const snap = req.user!.role === "admin"
    ? await users().where("role", "==", "staff").limit(500).get()
    : await users().where("vendorId", "==", req.user!.uid).limit(500).get();
  const docs = req.user!.role === "admin" ? snap.docs : snap.docs.filter((d) => d.get("role") === "staff");
  res.json(docs.map((d) => ({ id: d.id, ...d.data() })));
});

const ownStaff = async (req: { user?: { role: string; uid: string }; params: { id?: string } }) => {
  const ref = users().doc(String(req.params.id));
  const snap = await ref.get();
  if (!snap.exists || snap.get("role") !== "staff" || (req.user!.role !== "admin" && snap.get("vendorId") !== req.user!.uid)) throw new HttpError(404, "Staff not found");
  return ref;
};

router.patch("/team/staff/:id", requireRole("admin", "vendor"), async (req, res) => {
  const data = patchSchema.pick({ status: true, name: true, phone: true, email: true }).parse(req.body);
  const ref = await ownStaff(req);
  const id = String(req.params.id);
  if (data.email) await adminAuth.updateUser(id, { email: data.email }).catch(() => { throw new HttpError(400, "Could not change email. It may already be in use."); });
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  if (data.status) await adminAuth.updateUser(id, { disabled: data.status === "suspended" || data.status === "rejected" }).catch(() => {});
  if (data.name) await adminAuth.updateUser(id, { displayName: data.name }).catch(() => {});
  res.json({ id, ...data });
});

router.delete("/team/staff/:id", requireRole("admin", "vendor"), async (req, res) => {
  const id = String(req.params.id);
  const ref = await ownStaff(req);
  await ref.delete();
  await adminAuth.deleteUser(id).catch(() => {});
  res.status(204).end();
});

const staffSchema = z.object({
  name: z.string().min(1), email: z.string().email(),
  phone: z.string().regex(/^[6-9]\d{9}$/, "Phone must be a valid 10-digit mobile number"),
  password: z.string().min(6),
});
router.post("/team/staff", requireRole("admin", "vendor"), async (req, res) => {
  const { name, email, phone, password } = staffSchema.parse(req.body);
  const cred = await adminAuth.createUser({ email, password, displayName: name });
  const profile = {
    name, email, phone: phone ?? "", role: "staff", status: "approved",
    vendorId: req.user!.role === "admin" ? null : req.user!.uid, createdAt: FieldValue.serverTimestamp(),
  };
  await users().doc(cred.uid).set(profile);
  await adminAuth.setCustomUserClaims(cred.uid, { role: "staff" });
  res.status(201).json({ id: cred.uid, ...profile });
});

router.get("/admin/vendors", requireRole("admin"), async (_req, res) => {
  const today = kolkataDate();
  const [userSnap, sales, purchases, customers, products] = await Promise.all([
    users().limit(1000).get(),
    scopedDocs("salesOrders", null),
    scopedDocs("purchases", null),
    scopedDocs("customers", null),
    scopedDocs("products", null),
  ]);
  const all = userSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as { id: string; role?: string; vendorId?: string; name?: string; email?: string; phone?: string; status?: string });
  res.json(all.filter((u) => u.role === "vendor").map((v) => {
    const mine = (rows: Record<string, unknown>[]) => rows.filter((r) => r.vendorId === v.id);
    const orders = mine(sales);
    return {
      id: v.id, name: v.name || "", email: v.email || "", phone: v.phone || "", status: v.status,
      staff: all.filter((u) => u.role === "staff" && u.vendorId === v.id).length,
      customers: mine(customers).length,
      products: mine(products).length,
      salesTotal: paise(orders),
      purchaseTotal: paise(mine(purchases)),
      todaySales: paise(orders, today),
    };
  }));
});

router.get("/admin/vendors/:id", requireRole("admin"), async (req, res) => {
  const id = String(req.params.id);
  const vendor = await users().doc(id).get();
  if (!vendor.exists || vendor.get("role") !== "vendor") throw new HttpError(404, "Vendor not found");
  const today = kolkataDate();
  const [staffSnap, customers, products, sales, purchases] = await Promise.all([
    users().where("vendorId", "==", id).limit(500).get(),
    scopedDocs("customers", id),
    scopedDocs("products", id),
    scopedDocs("salesOrders", id),
    scopedDocs("purchases", id),
  ]);
  res.json({
    vendor: { id, ...vendor.data() },
    staff: staffSnap.docs.filter((d) => d.get("role") === "staff").map((d) => ({ id: d.id, ...d.data() })),
    customers, products, sales, purchases,
    dailySales: sales.filter((s) => s.date === today),
    today,
  });
});

export default router;
