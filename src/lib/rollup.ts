export type MoneyRow = { total?: unknown; date?: unknown };

export const paise = (rows: MoneyRow[], date?: string) =>
  rows.reduce((sum, row) => (date && row.date !== date ? sum : sum + (typeof row.total === "number" ? row.total : 0)), 0);

export function deltaLabel(today: number, prev: number) {
  if (prev === 0) return today === 0 ? "0%" : "+100%";
  const pct = ((today - prev) / prev) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Last `n` calendar dates ending at `today` (YYYY-MM-DD), oldest first. */
export function lastDates(today: string, n = 7) {
  const [y, m, d] = today.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  return Array.from({ length: n }, (_, i) => {
    const dt = new Date(start);
    dt.setUTCDate(start.getUTCDate() - (n - 1 - i));
    return dt.toISOString().slice(0, 10);
  });
}

export const weekday = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};

if (process.env.ROLLUP_CHECK) {
  const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
  const rows = [{ total: 100, date: "2026-10-22" }, { total: 50, date: "2026-10-21" }, { total: "nope", date: "2026-10-22" }];
  assert(paise(rows) === 150, "sum");
  assert(paise(rows, "2026-10-22") === 100, "day");
  assert(deltaLabel(110, 100) === "+10.0%", "up");
  assert(deltaLabel(0, 0) === "0%", "flat");
  assert(lastDates("2026-10-22", 3).join() === "2026-10-20,2026-10-21,2026-10-22", "dates");
  assert(weekday("2026-10-22") === "Thu", "weekday");
  console.log("rollup ok");
}
