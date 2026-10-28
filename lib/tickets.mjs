// Ticket business rules: creation, updates, replies, SLA and notifications.
import { createItem, updateItem, deleteItem, getItem, queryItems, q } from "./lists.mjs";
import { safeSend, templates, setBrand } from "./mail.mjs";
import { httpError } from "./errors.mjs";
import { PRIORITIES, normalizeSla, addBusinessTime } from "./sla.mjs";
import { getFeedback, listFeedback, signFeedbackToken, RATINGS } from "./feedback.mjs";

export const STATUSES = ["Open", "In progress", "On hold", "Escalated", "Closed"];
export { PRIORITIES };
export const CHANNELS = ["Email", "Phone", "Web form", "Chat", "WhatsApp", "Walk-in", "Self-service portal"];
const DEFAULT_DEPARTMENTS = ["General", "IT support", "Finance", "Admin"];
export const ROLES = ["Admin", "Agent"];
const STATUS_TEXT = {
  "Open": (n) => `Ticket #${n} has been reopened.`,
  "In progress": (n) => `An agent is now working on ticket #${n}.`,
  "On hold": (n) => `Ticket #${n} is on hold while we wait on something before we can continue.`,
  "Escalated": (n) => `Ticket #${n} has been escalated to a specialist.`,
  "Closed": (n) => `Ticket #${n} has been resolved and closed.`,
};

const HOUR = 3_600_000;
const ms = (x) => (x ? Date.parse(x) : null);
const iso = (t) => (t ? new Date(t).toISOString() : undefined);
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const lower = (s) => clip(s, 200).toLowerCase();

/* ---------- settings ---------- */
let settingsCache = { at: 0, value: null };

function normalizeUsers(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map((u) => ({ name: clip(u?.name, 80), email: lower(u?.email), role: ROLES.includes(u?.role) ? u.role : "Agent" }))
    .filter((u) => u.name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email) && !seen.has(u.email) && seen.add(u.email))
    .slice(0, 300);
}
function normalize(raw) {
  return {
    departments: Array.isArray(raw.departments) ? raw.departments.map((d) => clip(d, 80)).filter(Boolean).slice(0, 50) : DEFAULT_DEPARTMENTS,
    // "agents" is the older name for the user list
    users: normalizeUsers(raw.users || raw.agents || []),
    sla: normalizeSla(raw.sla),
    branding: { logoVersion: Number(raw.branding?.logoVersion) || 0, logoExt: raw.branding?.logoExt === "jpg" ? "jpg" : "png" },
    feedback: normalizeFeedback(raw.feedback),
  };
}
function normalizeFeedback(f) {
  f = f && typeof f === "object" ? f : {};
  const n = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d; };
  return {
    enabled: f.enabled !== false,
    question: clip(f.question, 120) || "How did we do?",
    intro: clip(f.intro, 300) || "Rate the support you received. It takes one click.",
    linkDays: n(f.linkDays, 3, 90, 30),
    alertAt: n(f.alertAt, 0, 4, 2),
    alertEmails: (Array.isArray(f.alertEmails) ? f.alertEmails : []).map((e) => lower(e)).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 20),
  };
}
export async function getSettings(fresh = false) {
  if (!fresh && settingsCache.value && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
  const rows = await queryItems("settings");
  const raw = {};
  for (const r of rows) { try { raw[r.Title] = JSON.parse(r.Value); } catch { /* ignore bad rows */ } }
  const s = normalize(raw);
  s._rows = Object.fromEntries(rows.map((r) => [r.Title, r.id]));
  setBrand(s.branding);
  settingsCache = { at: Date.now(), value: s };
  return s;
}
export function logoUrl(s) {
  return s.branding.logoVersion ? `/api/brand/logo?v=${s.branding.logoVersion}` : "";
}
export function publicSettings(s) {
  const { _rows, ...rest } = s;
  return { ...rest, agents: rest.users, logoUrl: logoUrl(s) };
}
// Saves only the parts that were sent: departments, users, sla and/or branding.
export async function saveSettings(input) {
  const cur = await getSettings(true);
  const next = normalize({ ...cur, ...input, feedback: input.feedback ? { ...cur.feedback, ...input.feedback } : cur.feedback });
  for (const key of ["departments", "users", "sla", "branding", "feedback"]) {
    if (!(key in input)) continue;
    const value = JSON.stringify(next[key]);
    if (cur._rows[key]) await updateItem("settings", cur._rows[key], { Value: value });
    else await createItem("settings", { Title: key, Value: value });
  }
  settingsCache = { at: 0, value: null };
  return publicSettings(await getSettings(true));
}
const due = (s, p, from) => addBusinessTime(from, s.sla.resolution[p] ?? 24, s.sla);
const findAgent = (s, email) => (s.users || []).find((a) => a.email === String(email || "").toLowerCase());

/* ---------- mapping ---------- */
function toTicket(f, s) {
  const id = Number(f.id);
  const created = ms(f.OpenedAt) || ms(f.Created);
  const priority = f.Priority || "Medium";
  return {
    id,
    number: Number(f.TicketNumber) || 1000 + id,
    subject: f.Title || "",
    description: f.Description || "",
    status: f.Status || "Open",
    priority,
    department: f.Department || "",
    channel: f.Channel || "",
    assigneeName: f.AssigneeName || "",
    assigneeEmail: f.AssigneeEmail || "",
    requesterName: f.RequesterName || "",
    requesterEmail: f.RequesterEmail || "",
    requesterPhone: f.RequesterPhone || "",
    tags: String(f.Tags || "").split(",").map((s) => s.trim()).filter(Boolean),
    createdAt: created,
    firstResponseDueAt: s && created ? addBusinessTime(created, s.sla.response[priority] ?? 4, s.sla) : null,
    updatedAt: ms(f.LastActivityAt) || ms(f.Modified),
    dueAt: ms(f.DueAt),
    firstResponseAt: ms(f.FirstResponseAt),
    closedAt: ms(f.ClosedAt),
    holdAt: ms(f.HoldAt),
  };
}
const toMessage = (f) => ({ id: Number(f.id), type: f.MessageType, author: f.AuthorName || "", authorEmail: f.AuthorEmail || "", body: f.Body || "", at: ms(f.SentAt) || ms(f.Created), source: f.Source || "" });
const toEvent = (f) => ({ id: Number(f.id), ticketId: Number(f.TicketId), text: f.EventText || "", by: f.Actor || "", public: !!f.IsPublic, at: ms(f.OccurredAt) || ms(f.Created) });

export async function addTicketEvent(t, text, by, isPublic) { return addEvent(t, text, by, isPublic); }
async function addEvent(t, text, by, isPublic) {
  await createItem("events", {
    Title: `#${t.number}`, TicketId: t.id, EventText: clip(text, 255), Actor: clip(by, 120),
    IsPublic: !!isPublic, OccurredAt: iso(Date.now()), RequesterEmail: t.requesterEmail || undefined,
  });
}

/* ---------- reads ---------- */
function withRatings(tickets, feedback) {
  const by = new Map(feedback.map((x) => [x.ticketId, x]));
  return tickets.map((t) => { const f = by.get(t.id); return f ? { ...t, rating: f.rating } : t; });
}
export async function listTickets() {
  const s = await getSettings();
  const [rows, fb] = await Promise.all([queryItems("tickets"), listFeedback()]);
  return withRatings(rows.map((f) => toTicket(f, s)), fb).sort((a, b) => b.createdAt - a.createdAt);
}
export async function getTicket(id) {
  const [f, s] = await Promise.all([getItem("tickets", id), getSettings()]);
  return f ? toTicket(f, s) : null;
}
export async function getTicketByNumber(number) {
  const n = Number(number);
  if (!(n > 0)) return null;
  const [rows, s] = await Promise.all([queryItems("tickets", `fields/TicketNumber eq ${n}`), getSettings()]);
  return rows.length ? toTicket(rows[0], s) : null;
}
export async function getDetail(id, user) {
  const t = await getTicket(id);
  if (!t) throw httpError(404, "That ticket no longer exists.");
  const mine = t.requesterEmail && t.requesterEmail === user.email;
  if (!user.isAgent && !mine) throw httpError(404, "That ticket no longer exists.");
  const [msgs, evs, feedback] = await Promise.all([queryItems("messages", `fields/TicketId eq ${t.id}`), queryItems("events", `fields/TicketId eq ${t.id}`), getFeedback(t.id)]);
  let messages = msgs.map(toMessage).sort((a, b) => a.at - b.at);
  let events = evs.map(toEvent).sort((a, b) => a.at - b.at);
  if (!user.isAgent) {
    messages = messages.filter((m) => m.type !== "note").map(({ authorEmail, ...m }) => m);
    events = events.filter((e) => e.public);
  }
  return { ticket: feedback ? { ...t, rating: feedback.rating } : t, messages, events, feedback };
}
export async function listMine(email) {
  const s = await getSettings();
  const [tickets, events, fb] = await Promise.all([
    queryItems("tickets", `fields/RequesterEmail eq '${q(email)}'`),
    queryItems("events", `fields/RequesterEmail eq '${q(email)}'`),
    queryItems("feedback", `fields/RequesterEmail eq '${q(email)}'`),
  ]);
  return {
    tickets: withRatings(tickets.map((f) => toTicket(f, s)), fb.map((x) => ({ ticketId: Number(x.TicketId), rating: Number(x.Rating) }))).sort((a, b) => b.createdAt - a.createdAt),
    events: events.map(toEvent).filter((e) => e.public).sort((a, b) => b.at - a.at).slice(0, 100),
  };
}

/* ---------- writes ---------- */
export async function createTicket(input, actor, { channel, notify = true } = {}) {
  const s = await getSettings();
  const now = Date.now();
  const priority = PRIORITIES.includes(input.priority) ? input.priority : "Medium";
  const ch = CHANNELS.includes(channel) ? channel : "Web form";
  const subject = clip(input.subject, 250);
  const description = clip(input.description, 20000);
  if (!subject || !description) throw httpError(400, "A ticket needs a subject and a description.");
  const fields = {
    Title: subject, Description: description, Status: "Open", Priority: priority,
    Department: clip(input.department, 100) || s.departments[0] || "General", Channel: ch,
    RequesterName: clip(input.name, 120), RequesterEmail: lower(input.email) || undefined, RequesterPhone: clip(input.phone, 40) || undefined,
    Tags: (Array.isArray(input.tags) ? input.tags : []).map((x) => clip(x, 40)).filter(Boolean).join(", ").slice(0, 250) || undefined,
    DueAt: iso(due(s, priority, now)), LastActivityAt: iso(now), OpenedAt: iso(now),
    SourceMessageId: input.sourceMessageId ? clip(input.sourceMessageId, 250) : undefined,
  };
  const agent = findAgent(s, input.assigneeEmail);
  if (agent) { fields.AssigneeEmail = agent.email; fields.AssigneeName = agent.name; }
  const item = await createItem("tickets", fields);
  const number = 1000 + Number(item.id);
  await updateItem("tickets", item.id, { TicketNumber: number });
  const t = toTicket({ ...item, TicketNumber: number, Created: item.Created || iso(now) }, s);
  await addEvent(t, `Ticket created via ${ch}`, actor.name, false);
  await addEvent(t, `Ticket #${number} created. Our team will pick it up shortly.`, "Service Desk", true);
  if (agent) await addEvent(t, `Assigned to ${agent.name}`, actor.name, false);
  if (notify && t.requesterEmail) await safeSend(templates.created(t));
  if (agent && agent.email !== actor.email) await safeSend(templates.assigned(t, agent));
  return t;
}

export async function updateTicket(id, patch, actor) {
  const t = await getTicket(id);
  if (!t) throw httpError(404, "That ticket no longer exists.");
  const s = await getSettings();
  const now = Date.now();
  const f = {};
  const priv = [];
  const pub = [];
  let next = { ...t };

  if (patch.status !== undefined && patch.status !== t.status) {
    if (!STATUSES.includes(patch.status)) throw httpError(400, "Unknown status.");
    f.Status = patch.status;
    if (patch.status === "Closed") f.ClosedAt = iso(now);
    if (patch.status === "On hold") f.HoldAt = iso(now);
    if (t.status === "On hold" && t.holdAt && patch.status !== "Closed") f.DueAt = iso((t.dueAt || now) + (now - t.holdAt));
    if (t.status === "Closed") f.DueAt = iso(due(s, t.priority, now));
    priv.push(`Status changed from ${t.status} to ${patch.status}`);
    pub.push(STATUS_TEXT[patch.status](t.number));
  }
  if (patch.priority !== undefined && patch.priority !== t.priority) {
    if (!PRIORITIES.includes(patch.priority)) throw httpError(400, "Unknown priority.");
    f.Priority = patch.priority;
    if ((f.Status || t.status) !== "Closed") f.DueAt = iso(due(s, patch.priority, t.createdAt));
    priv.push(`Priority changed from ${t.priority} to ${patch.priority}`);
  }
  let newAgent = null;
  if (patch.assigneeEmail !== undefined && String(patch.assigneeEmail).toLowerCase() !== t.assigneeEmail) {
    if (!patch.assigneeEmail) { f.AssigneeEmail = ""; f.AssigneeName = ""; priv.push("Unassigned"); }
    else {
      newAgent = findAgent(s, patch.assigneeEmail);
      if (!newAgent) throw httpError(400, "That person isn’t a service desk user. Add them in Settings → Users first.");
      f.AssigneeEmail = newAgent.email; f.AssigneeName = newAgent.name;
      priv.push(`Assigned to ${newAgent.name}`);
      pub.push(`Ticket #${t.number} has been assigned to ${newAgent.name}.`);
    }
  }
  if (patch.department !== undefined && patch.department !== t.department) { f.Department = clip(patch.department, 100); priv.push(`Moved to ${f.Department}`); }
  if (patch.channel !== undefined && patch.channel !== t.channel && CHANNELS.includes(patch.channel)) { f.Channel = patch.channel; priv.push(`Channel set to ${patch.channel}`); }
  if (patch.dueAt !== undefined && Number(patch.dueAt) && Number(patch.dueAt) !== t.dueAt) { f.DueAt = iso(Number(patch.dueAt)); priv.push(`Due date set to ${new Date(Number(patch.dueAt)).toUTCString()}`); }
  if (Array.isArray(patch.tags)) {
    const tags = patch.tags.map((x) => clip(x, 40)).filter(Boolean).join(", ").slice(0, 250);
    if (tags !== t.tags.join(", ")) { f.Tags = tags; priv.push("Tags updated"); }
  }
  if (!Object.keys(f).length) return getDetail(id, actor);

  f.LastActivityAt = iso(now);
  await updateItem("tickets", id, f);
  next = (await getTicket(id)) || next;
  for (const text of priv) await addEvent(next, text, actor.name, false);
  for (const text of pub) await addEvent(next, text, actor.name, true);
  if (f.Status && next.requesterEmail) await safeSend(templates.status(next, STATUS_TEXT[f.Status](next.number), f.Status === "Closed" ? surveyFor(s, next) : null));
  if (newAgent && newAgent.email !== actor.email) await safeSend(templates.assigned(next, newAgent));
  return getDetail(id, actor);
}

export async function addMessage(id, { type, body, closeAfter }, actor, { source = "desk", internetMessageId, returnDetail = true } = {}) {
  const t = await getTicket(id);
  if (!t) throw httpError(404, "That ticket no longer exists.");
  const text = clip(body, 20000);
  if (!text) throw httpError(400, "Write a message first.");
  if (!["reply", "note", "customer"].includes(type)) throw httpError(400, "Unknown message type.");
  const s = await getSettings();
  const now = Date.now();
  await createItem("messages", {
    Title: `#${t.number}`, TicketId: t.id, MessageType: type, AuthorName: clip(actor.name, 120), AuthorEmail: actor.email || undefined,
    Body: text, SentAt: iso(now), Source: source, InternetMessageId: internetMessageId ? clip(internetMessageId, 250) : undefined,
  });
  const f = { LastActivityAt: iso(now) };
  const priv = [];
  const pub = [];
  let newStatus = null;
  if (type === "reply") {
    if (!t.firstResponseAt) f.FirstResponseAt = iso(now);
    priv.push(source === "email" ? `${actor.name} replied by email` : "Replied to requester");
    if (closeAfter && t.status !== "Closed") newStatus = "Closed";
    else if (t.status === "Open") newStatus = "In progress";
    pub.push(`New reply from support on ticket #${t.number}.`);
  } else if (type === "note") {
    priv.push("Added a private note");
  } else {
    priv.push(source === "email" ? "Requester replied by email" : source === "portal" ? "Requester replied through the portal" : "Requester reply logged");
    if (t.status === "Closed" || t.status === "On hold") {
      newStatus = "Open";
      f.DueAt = iso(due(s, t.priority, now));
      pub.push(`We received your reply and reopened ticket #${t.number}.`);
    } else pub.push(`We received your reply on ticket #${t.number}.`);
  }
  if (newStatus) {
    f.Status = newStatus;
    if (newStatus === "Closed") f.ClosedAt = iso(now);
    priv.push(`Status changed from ${t.status} to ${newStatus}`);
  }
  await updateItem("tickets", id, f);
  const next = { ...t, status: newStatus || t.status };
  for (const x of priv) await addEvent(next, x, actor.name, false);
  for (const x of pub) await addEvent(next, x, actor.name, true);
  if (type === "reply" && next.requesterEmail) {
    await safeSend(templates.reply(next, { author: actor.name, body: text }));
    if (newStatus === "Closed") await safeSend(templates.status(next, STATUS_TEXT.Closed(next.number), surveyFor(s, next)));
  }
  if (type === "customer" && next.assigneeEmail) await safeSend(templates.requesterReplied(next, { author: actor.name, body: text }));
  return returnDetail ? getDetail(id, actor) : null;
}

function surveyFor(s, t) {
  return s.feedback.enabled ? { token: signFeedbackToken(t, s.feedback.linkDays), question: s.feedback.question, intro: s.feedback.intro } : null;
}
// After a rating: alert the assignee and the chosen supervisors when it is at or below the alert level.
export async function afterFeedback(t, fb) {
  const s = await getSettings();
  const lvl = s.feedback.alertAt;
  if (!lvl || fb.rating > lvl) return [];
  const to = [...new Set([...s.feedback.alertEmails, t.assigneeEmail].filter(Boolean))];
  for (const addr of to) await safeSend(templates.lowRating(t, fb, addr));
  return to;
}

export async function deleteTicket(id) {
  const t = await getTicket(id);
  if (!t) return null;
  const [msgs, evs] = await Promise.all([queryItems("messages", `fields/TicketId eq ${t.id}`), queryItems("events", `fields/TicketId eq ${t.id}`)]);
  for (const m of msgs) await deleteItem("messages", m.id);
  for (const e of evs) await deleteItem("events", e.id);
  await deleteItem("tickets", t.id);
  return { ticket: t, messages: msgs.length, events: evs.length };
}

export async function messageExists(internetMessageId) {
  if (!internetMessageId) return false;
  const id = q(clip(internetMessageId, 250));
  const [a, b] = await Promise.all([
    queryItems("messages", `fields/InternetMessageId eq '${id}'`),
    queryItems("tickets", `fields/SourceMessageId eq '${id}'`),
  ]);
  return a.length > 0 || b.length > 0;
}
export { findAgent };
