// Usage: npm run set-role -- user@example.com admin|vendor|staff
import "../src/config/firebase.js";
import { adminAuth, db } from "../src/config/firebase.js";

const [email, role] = process.argv.slice(2);
if (!email || !["admin", "vendor", "staff"].includes(role)) {
  console.error("Usage: npm run set-role -- <email> <admin|vendor|staff>");
  process.exit(1);
}
const user = await adminAuth.getUserByEmail(email);
await adminAuth.setCustomUserClaims(user.uid, { role });
await db.collection("users").doc(user.uid).set(
  { email, role, status: "approved", vendorId: role === "admin" ? null : role === "vendor" ? user.uid : null },
  { merge: true },
);
console.log(`Set role "${role}" for ${email}. User must sign in again to refresh the token.`);
