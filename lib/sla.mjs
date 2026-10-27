// SLA policy: targets per priority, optional business hours and holidays.
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"];
export const DEFAULT_SLA = {
  response: { Urgent: 1, High: 2, Medium: 4, Low: 8 },
  resolution: { Urgent: 4, High: 8, Medium: 24, Low: 72 },
  warnAt: 25,
  businessHours: { enabled: false, start: "08:00", end: "17:00", days: [1, 2, 3, 4, 5], utcOffset: 60 },
  holidays: [],
};
const HOUR = 3_600_000;
const num = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const hhmm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);

export function normalizeSla(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  // Older versions stored only resolution hours as { Urgent: 4, ... }
  const legacy = PRIORITIES.some((p) => typeof r[p] === "number");
  const res = legacy ? r : r.resolution || {};
  const rsp = r.response || {};
  const bh = r.businessHours || {};
  return {
    response: Object.fromEntries(PRIORITIES.map((p) => [p, num(rsp[p], 0.25, 720, DEFAULT_SLA.response[p])])),
    resolution: Object.fromEntries(PRIORITIES.map((p) => [p, num(res[p], 0.5, 2160, DEFAULT_SLA.resolution[p])])),
    warnAt: num(r.warnAt, 5, 90, DEFAULT_SLA.warnAt),
    businessHours: {
      enabled: !!bh.enabled,
      start: hhmm(bh.start, "08:00"),
      end: hhmm(bh.end, "17:00"),
      days: Array.isArray(bh.days) ? [...new Set(bh.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [1, 2, 3, 4, 5],
      utcOffset: num(bh.utcOffset, -720, 840, 60),
    },
    holidays: Array.isArray(r.holidays) ? [...new Set(r.holidays.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().slice(0, 100) : [],
  };
}

// Adds working hours to a start time, skipping nights, non-working days and holidays.
export function addBusinessTime(startMs, hours, sla) {
  const bh = sla?.businessHours;
  const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  if (!bh || !bh.enabled || !bh.days.length) return startMs + hours * HOUR;
  const startMin = toMin(bh.start), endMin = toMin(bh.end);
  if (endMin <= startMin) return startMs + hours * HOUR;
  const off = bh.utcOffset * 60_000;
  const days = new Set(bh.days);
  const hol = new Set(sla.holidays || []);
  let remaining = hours * 60;
  let t = startMs + off; // work in local wall-clock time
  for (let guard = 0; guard < 1000 && remaining > 0; guard++) {
    const d = new Date(t);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const ws = dayStart + startMin * 60_000, we = dayStart + endMin * 60_000;
    const working = days.has(d.getUTCDay()) && !hol.has(new Date(dayStart).toISOString().slice(0, 10));
    if (!working || t >= we) { t = dayStart + 86_400_000 + startMin * 60_000; continue; }
    if (t < ws) t = ws;
    const avail = (we - t) / 60_000;
    if (remaining <= avail) { t += remaining * 60_000; remaining = 0; }
    else { remaining -= avail; t = dayStart + 86_400_000 + startMin * 60_000; }
  }
  return t - off;
}
