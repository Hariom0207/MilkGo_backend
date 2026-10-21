import { Router } from "express";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminAuth, db } from "../config/firebase.js";
import { HttpError } from "../lib/errors.js";
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

const patchSchema = z.object({
  status: z.enum(["pending", "approved", "rejected", "suspended"]).optional(),
  role: z.enum(["admin", "vendor", "staff"]).optional(),
});
router.patch("/admin/users/:id", requireRole("admin"), async (req, res) => {
  const id = String(req.params.id);
  if (id === req.user!.uid && req.body?.status && req.body.status !== "approved") throw new HttpError(400, "Cannot change your own status");
  const data = patchSchema.parse(req.body);
  const ref = users().doc(id);
  if (!(await ref.get()).exists) throw new HttpError(404, "User not found");
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  // Keep Firebase Auth in sync: suspended/rejected users cannot sign in; role as custom claim.
  await adminAuth.updateUser(id, { disabled: data.status === "suspended" || data.status === "rejected" }).catch(() => {});
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
  const q = req.user!.role === "admin" ? users().where("role", "==", "staff") : users().where("vendorId", "==", req.user!.uid);
  const snap = await q.limit(500).get();
  res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
});

router.patch("/team/staff/:id", requireRole("admin", "vendor"), async (req, res) => {
  const data = patchSchema.pick({ status: true }).parse(req.body);
  const ref = users().doc(String(req.params.id));
  const snap = await ref.get();
  if (!snap.exists || snap.get("role") !== "staff" || (req.user!.role !== "admin" && snap.get("vendorId") !== req.user!.uid)) throw new HttpError(404, "Staff not found");
  await ref.update({ ...data, updatedAt: FieldValue.serverTimestamp() });
  await adminAuth.updateUser(String(req.params.id), { disabled: data.status === "suspended" || data.status === "rejected" }).catch(() => {});
  res.json({ id: String(req.params.id), ...data });
});

const staffSchema = z.object({
  name: z.string().min(1), email: z.string().email(), phone: z.string().optional(), password: z.string().min(6),
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

export default router;
