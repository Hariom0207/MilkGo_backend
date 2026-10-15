import { z } from "zod";
import { crudRouter } from "../lib/crud.js";

export const productSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  defaultRate: z.number().int().nonnegative(), // paise per unit
  sellRate: z.number().int().nonnegative().optional(), // paise per unit
  category: z.string().optional(),
  pack: z.string().optional(),
  image: z.string().max(400_000).optional(), // resized JPEG data URL
});

export default crudRouter("products", productSchema);
