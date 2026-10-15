import { z } from "zod";
import { crudRouter } from "../lib/crud.js";

// Money is integer paise; date is YYYY-MM-DD, time is HH:mm.
export const salesOrderSchema = z.object({
  customerName: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        unit: z.string().optional(),
        quantity: z.number().positive(),
        rate: z.number().int().nonnegative(),
        amount: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  total: z.number().int().nonnegative(),
  status: z.enum(["Paid", "Pending"]).default("Pending"),
});

export default crudRouter("salesOrders", salesOrderSchema);
