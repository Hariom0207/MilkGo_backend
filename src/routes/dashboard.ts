import { Router } from "express";
import { db } from "../config/firebase.js";
import { deltaLabel, lastDates, paise, weekday, type MoneyRow } from "../lib/rollup.js";
import { kolkataDate, scopeIdFromReq, scopedDocs } from "../lib/scope.js";

const router = Router();

type Item = { name?: string; quantity?: number; unit?: string };
type Order = MoneyRow & {
  id?: string;
  time?: unknown;
  status?: unknown;
  customerName?: unknown;
  supplierName?: unknown;
  vendorId?: unknown;
  items?: Item[];
};

const asOrders = (rows: Record<string, unknown>[]) => rows as Order[];

router.get("/", async (req, res) => {
  const vendorId = scopeIdFromReq(req);
  const today = kolkataDate();
  const dates = lastDates(today, 7);
  const yesterday = dates[dates.length - 2];
  const [sales, purchases, customers, products, peopleSnap] = await Promise.all([
    scopedDocs("salesOrders", vendorId),
    scopedDocs("purchases", vendorId),
    scopedDocs("customers", vendorId),
    scopedDocs("products", vendorId),
    vendorId
      ? db.collection("users").where("vendorId", "==", vendorId).limit(500).get()
      : db.collection("users").limit(1000).get(),
  ]);
  const people = peopleSnap.docs.map((d) => ({ id: d.id, ...d.data() }) as { id: string; role?: string; name?: string; vendorId?: string });
  const names = new Map(people.filter((p) => p.role === "vendor").map((p) => [p.id, p.name || "Vendor"]));
  const orders = asOrders(sales);
  const buys = asOrders(purchases);
  const todaySales = paise(orders, today);
  const todayPurchases = paise(buys, today);
  const recent = [...orders].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.time).localeCompare(String(a.time))).slice(0, 8);
  const byName = new Map<string, { name: string; quantity: number; unit: string }>();
  for (const order of orders.filter((o) => o.date === today)) {
    for (const item of order.items ?? []) {
      const name = item.name || "Item";
      const cur = byName.get(name) ?? { name, quantity: 0, unit: item.unit || "" };
      cur.quantity += item.quantity || 0;
      byName.set(name, cur);
    }
  }
  const todayProducts = [...byName.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5);

  res.json({
    today,
    kpis: {
      todaySales,
      todayPurchases,
      salesDelta: deltaLabel(todaySales, paise(orders, yesterday)),
      purchaseDelta: deltaLabel(todayPurchases, paise(buys, yesterday)),
      customers: customers.length,
      products: products.length,
      staff: people.filter((p) => p.role === "staff").length,
      vendors: vendorId ? 0 : people.filter((p) => p.role === "vendor").length,
      pending: orders.filter((o) => o.status === "Pending").length,
    },
    week: {
      labels: dates.map(weekday),
      sales: dates.map((d) => paise(orders, d)),
      purchases: dates.map((d) => paise(buys, d)),
    },
    recent: recent.map((o) => {
      const items = o.items ?? [];
      return {
        id: o.id,
        party: String(o.customerName || "—"),
        product: items.length ? (items.length === 1 ? items[0].name : `${items[0].name} +${items.length - 1}`) : "—",
        qty: items.map((i) => `${i.quantity ?? 0} ${i.unit ?? ""}`.trim()).join(", ") || "—",
        status: String(o.status || "Pending"),
        vendorName: names.get(String(o.vendorId)) || "",
      };
    }),
    todayProducts,
  });
});

export default router;
