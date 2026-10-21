import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 8080),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  projectId: process.env.FIREBASE_PROJECT_ID,
  adminEmails: (process.env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
};
