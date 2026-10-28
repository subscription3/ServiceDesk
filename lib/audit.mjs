// System-wide activity log. Entries are only ever added, never edited or deleted by the app.
import { createItem, queryItems } from "./lists.mjs";

const clip = (s, n) => String(s ?? "").slice(0, n);

export function requestInfo(req, context) {
  return {
    ip: clip(context?.ip || req?.headers?.get("x-nf-client-connection-ip") || req?.headers?.get("x-forwarded-for")?.split(",")[0] || "", 60),
    ua: clip(req?.headers?.get("user-agent") || "", 250),
  };
}

// Never throws: a logging problem must not block the action itself, but it is reported in the function log.
export async function audit(actor, action, { category = "Ticket", targetType = "", targetId = "", details = null, info = {} } = {}) {
  try {
    await createItem("audit", {
      Title: clip(action, 250),
      Category: clip(category, 40),
      ActorName: clip(actor?.name || "System", 120),
      ActorEmail: clip(String(actor?.email || "").toLowerCase(), 200) || undefined,
      TargetType: clip(targetType, 40) || undefined,
      TargetId: clip(targetId, 60) || undefined,
      Details: details == null ? undefined : clip(typeof details === "string" ? details : JSON.stringify(details), 20000),
      IpAddress: info.ip || undefined,
      UserAgent: info.ua || undefined,
      OccurredAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("AUDIT LOG WRITE FAILED", action, e.message);
  }
}

const ms = (x) => (x ? Date.parse(x) : null);
export function toAudit(f) {
  return {
    id: Number(f.id), at: ms(f.OccurredAt) || ms(f.Created), action: f.Title || "", category: f.Category || "",
    actorName: f.ActorName || "", actorEmail: f.ActorEmail || "", targetType: f.TargetType || "", targetId: f.TargetId || "",
    details: f.Details || "", ip: f.IpAddress || "", ua: f.UserAgent || "",
  };
}

export async function listAudit({ from, to, category } = {}) {
  const f = Number(from) || Date.now() - 30 * 864e5;
  const t = Number(to) || Date.now();
  const rows = await queryItems("audit", `fields/OccurredAt ge '${new Date(f).toISOString()}' and fields/OccurredAt le '${new Date(t).toISOString()}'`, { top: 999 });
  let out = rows.map(toAudit);
  if (category) out = out.filter((r) => r.category === category);
  return out.sort((a, b) => b.at - a.at).slice(0, 5000);
}
