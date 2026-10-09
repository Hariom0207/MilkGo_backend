import { z } from "zod";
import { crudRouter } from "../lib/crud.js";

// outstandingBalance/totalPurchased are server-managed (updated by sales/payments).
// Money is always stored as integer paise; quantities in litres/units.
export const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  address: z.string().optional(),
  gstin: z.string().optional(),
  type: z.enum(["retailer", "walkin"]),
});

export default crudRouter("customers", customerSchema, { outstandingBalance: 0, totalPurchased: 0 });
