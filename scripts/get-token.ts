// Usage: FIREBASE_WEB_API_KEY=... npm run get-token -- user@example.com
// Password is read from TEST_PASSWORD or prompted. Prints a Firebase ID token for curl testing.
import "dotenv/config";
import { createInterface } from "node:readline/promises";

const [email] = process.argv.slice(2);
const apiKey = process.env.FIREBASE_WEB_API_KEY;
if (!email || !apiKey) {
  console.error("Usage: FIREBASE_WEB_API_KEY=... npm run get-token -- <email>");
  process.exit(1);
}
let password = process.env.TEST_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  password = await rl.question("Password: ");
  rl.close();
}
const res = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  },
);
const data = (await res.json()) as { idToken?: string; error?: { message: string } };
if (!res.ok || !data.idToken) {
  console.error("Sign-in failed:", data.error?.message ?? res.status);
  process.exit(1);
}
console.log(data.idToken);
