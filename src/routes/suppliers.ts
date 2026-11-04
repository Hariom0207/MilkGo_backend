import { z } from "zod";
import { crudRouter } from "../lib/crud.js";

export const supplierSchema = z.object({
  name: z.string().min(1),
  /** Human-facing supplier id (e.g. SP-A1B2C3). */
  code: z.string().min(1).max(32).optional(),
  phone: z.union([z.literal(""), z.string().regex(/^[6-9]\d{9}$/, "Phone must be a valid 10-digit mobile number")]).optional(),
  address: z.string().optional(),
  email: z.union([z.literal(""), z.string().email()]).optional(),
  status: z.enum(["pending", "active"]).optional(),
});

// Staff may create a supplier while adding a purchase.
export default crudRouter("suppliers", supplierSchema, { status: "active" }, true);
