import { z } from "zod";
import { crudRouter } from "../lib/crud.js";

export const supplierSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export default crudRouter("suppliers", supplierSchema);
