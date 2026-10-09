import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./lib/errors.js";
import { requireAuth } from "./middleware/auth.js";
import customers from "./routes/customers.js";
import health from "./routes/health.js";
import products from "./routes/products.js";
import suppliers from "./routes/suppliers.js";

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins }));
  app.use(express.json());

  app.use("/health", health);

  // Everything under /api needs a valid Firebase ID token.
  const api = express.Router();
  api.use(requireAuth);
  api.use("/customers", customers);
  api.use("/products", products);
  api.use("/suppliers", suppliers);
  app.use("/api/v1", api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
