import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./lib/errors.js";
import { requireAuth } from "./middleware/auth.js";
import customers from "./routes/customers.js";
import health from "./routes/health.js";
import payments from "./routes/payments.js";
import products from "./routes/products.js";
import purchases from "./routes/purchases.js";
import sales from "./routes/sales.js";
import salesOrders from "./routes/salesOrders.js";
import suppliers from "./routes/suppliers.js";

export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins }));
  app.use(express.json({ limit: "1mb" }));

  app.use("/health", health);

  // Everything under /api needs a valid Firebase ID token.
  const api = express.Router();
  api.use(requireAuth);
  api.use("/customers", customers);
  api.use("/products", products);
  api.use("/suppliers", suppliers);
  api.use("/purchases", purchases);
  api.use("/sales", sales);
  api.use("/sales-orders", salesOrders);
  api.use("/payments", payments);
  app.use("/api/v1", api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
