import { z } from "zod";
import { crudRouter } from "../lib/crud.js";

export const supplierSchema = z.object({
  name: z.string().min(1),
  phone: z.union([z.literal(""), z.string().regex(/^[6-9]\d{9}$/, "Phone must be a valid 10-digit mobile number")]).optional(),
  address: z.string().optional(),
});

export default crudRouter("suppliers", supplierSchema);
