import { z } from "zod";
import { crudRouter } from "../lib/crud.js";

export const productSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  defaultRate: z.number().int().nonnegative(), // paise per unit
});

export default crudRouter("products", productSchema);
