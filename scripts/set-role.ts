// Usage: npm run set-role -- user@example.com owner
import "../src/config/firebase.js";
import { adminAuth } from "../src/config/firebase.js";

const [email, role] = process.argv.slice(2);
if (!email || !["owner", "staff"].includes(role)) {
  console.error("Usage: npm run set-role -- <email> <owner|staff>");
  process.exit(1);
}
const user = await adminAuth.getUserByEmail(email);
await adminAuth.setCustomUserClaims(user.uid, { role });
console.log(`Set role "${role}" for ${email}. User must sign in again to refresh the token.`);
