// Ticket business rules: creation, updates, replies, SLA and notifications.
import { createItem, updateItem, deleteItem, getItem, queryItems, q } from "./lists.mjs";
import { safeSend, templates } from "./mail.mjs";
import { httpError } from "./auth.mjs";

export const STATUSES = ["Open", "In progress", "On hold", "Escalated", "Closed"];
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"];
export const CHANNELS = ["Email", "Phone", "Web form", "Chat", "WhatsApp", "Walk-in", "Self-service portal"];
const DEFAULTS = {
  departments: ["General", "IT support", "Finance", "Admin"],
  agents: [],
  sla: { Urgent: 4, High: 8, Medium: 24, Low: 72 },
};
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
export async function getSettings(fresh = false) {
  if (!fresh && settingsCache.value && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
  const rows = await queryItems("settings");
  const s = structuredClone(DEFAULTS);
  for (const r of rows) {
    try { if (r.Title in s) s[r.Title] = JSON.parse(r.Value); } catch { /* ignore bad rows */ }
  }
  s._rows = Object.fromEntries(rows.map((r) => [r.Title, r.id]));
  settingsCache = { at: Date.now(), value: s };
  return s;
}
export function publicSettings(s) {
  const { _rows, ...rest } = s;
  return rest;
}
export async function saveSettings(input) {
  const cur = await getSettings(true);
  const next = {
    departments: Array.isArray(input.departments) ? input.departments.map((d) => clip(d, 80)).filter(Boolean).slice(0, 50) : cur.departments,
    agents: Array.isArray(input.agents)
      ? input.agents.map((a) => ({ name: clip(a?.name, 80), email: lower(a?.email) })).filter((a) => a.name && /@/.test(a.email)).slice(0, 200)
      : cur.agents,
    sla: Object.fromEntries(PRIORITIES.map((p) => [p, Math.max(1, Math.min(720, Number(input.sla?.[p]) || cur.sla[p] || DEFAULTS.sla[p]))])),
  };
  for (const key of ["departments", "agents", "sla"]) {
    const value = JSON.stringify(next[key]);
    if (cur._rows[key]) await updateItem("settings", cur._rows[key], { Value: value });
    else await createItem("settings", { Title: key, Value: value });
  }
  settingsCache = { at: 0, value: null };
  return publicSettings(await getSettings(true));
}
const slaHours = (s, p) => Number(s.sla?.[p]) || DEFAULTS.sla[p] || 24;
const findAgent = (s, email) => (s.agents || []).find((a) => a.email === String(email || "").toLowerCase());

/* ---------- mapping ---------- */
function toTicket(f) {
  const id = Number(f.id);
  return {
    id,
    number: Number(f.TicketNumber) || 1000 + id,
    subject: f.Title || "",
    description: f.Description || "",
    status: f.Status || "Open",
    priority: f.Priority || "Medium",
    department: f.Department || "",
    channel: f.Channel || "",
    assigneeName: f.AssigneeName || "",
    assigneeEmail: f.AssigneeEmail || "",
    requesterName: f.RequesterName || "",
    requesterEmail: f.RequesterEmail || "",
    requesterPhone: f.RequesterPhone || "",
    tags: String(f.Tags || "").split(",").map((s) => s.trim()).filter(Boolean),
    createdAt: ms(f.Created),
    updatedAt: ms(f.LastActivityAt) || ms(f.Modified),
    dueAt: ms(f.DueAt),
    firstResponseAt: ms(f.FirstResponseAt),
    closedAt: ms(f.ClosedAt),
    holdAt: ms(f.HoldAt),
  };
}
const toMessage = (f) => ({ id: Number(f.id), type: f.MessageType, author: f.AuthorName || "", authorEmail: f.AuthorEmail || "", body: f.Body || "", at: ms(f.SentAt) || ms(f.Created), source: f.Source || "" });
const toEvent = (f) => ({ id: Number(f.id), ticketId: Number(f.TicketId), text: f.EventText || "", by: f.Actor || "", public: !!f.IsPublic, at: ms(f.OccurredAt) || ms(f.Created) });

async function addEvent(t, text, by, isPublic) {
  await createItem("events", {
    Title: `#${t.number}`, TicketId: t.id, EventText: clip(text, 255), Actor: clip(by, 120),
    IsPublic: !!isPublic, OccurredAt: iso(Date.now()), RequesterEmail: t.requesterEmail || undefined,
  });
}

/* ---------- reads ---------- */
export async function listTickets() {
  return (await queryItems("tickets")).map(toTicket).sort((a, b) => b.createdAt - a.createdAt);
}
export async function getTicket(id) {
  const f = await getItem("tickets", id);
  return f ? toTicket(f) : null;
}
export async function getTicketByNumber(number) {
  const id = Number(number) - 1000;
  if (!(id > 0)) return null;
  return getTicket(id);
}
export async function getDetail(id, user) {
  const t = await getTicket(id);
  if (!t) throw httpError(404, "That ticket no longer exists.");
  const mine = t.requesterEmail && t.requesterEmail === user.email;
  if (!user.isAgent && !mine) throw httpError(404, "That ticket no longer exists.");
  const [msgs, evs] = await Promise.all([queryItems("messages", `fields/TicketId eq ${t.id}`), queryItems("events", `fields/TicketId eq ${t.id}`)]);
  let messages = msgs.map(toMessage).sort((a, b) => a.at - b.at);
  let events = evs.map(toEvent).sort((a, b) => a.at - b.at);
  if (!user.isAgent) {
    messages = messages.filter((m) => m.type !== "note").map(({ authorEmail, ...m }) => m);
    events = events.filter((e) => e.public);
  }
  return { ticket: t, messages, events };
}
export async function listMine(email) {
  const [tickets, events] = await Promise.all([
    queryItems("tickets", `fields/RequesterEmail eq '${q(email)}'`),
    queryItems("events", `fields/RequesterEmail eq '${q(email)}'`),
  ]);
  return {
    tickets: tickets.map(toTicket).sort((a, b) => b.createdAt - a.createdAt),
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
    DueAt: iso(now + slaHours(s, priority) * HOUR), LastActivityAt: iso(now),
    SourceMessageId: input.sourceMessageId ? clip(input.sourceMessageId, 250) : undefined,
  };
  const agent = findAgent(s, input.assigneeEmail);
  if (agent) { fields.AssigneeEmail = agent.email; fields.AssigneeName = agent.name; }
  const item = await createItem("tickets", fields);
  const number = 1000 + Number(item.id);
  await updateItem("tickets", item.id, { TicketNumber: number });
  const t = toTicket({ ...item, TicketNumber: number, Created: item.Created || iso(now) });
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
    if (t.status === "Closed") f.DueAt = iso(now + slaHours(s, t.priority) * HOUR);
    priv.push(`Status changed from ${t.status} to ${patch.status}`);
    pub.push(STATUS_TEXT[patch.status](t.number));
  }
  if (patch.priority !== undefined && patch.priority !== t.priority) {
    if (!PRIORITIES.includes(patch.priority)) throw httpError(400, "Unknown priority.");
    f.Priority = patch.priority;
    if ((f.Status || t.status) !== "Closed") f.DueAt = iso(t.createdAt + slaHours(s, patch.priority) * HOUR);
    priv.push(`Priority changed from ${t.priority} to ${patch.priority}`);
  }
  let newAgent = null;
  if (patch.assigneeEmail !== undefined && String(patch.assigneeEmail).toLowerCase() !== t.assigneeEmail) {
    if (!patch.assigneeEmail) { f.AssigneeEmail = ""; f.AssigneeName = ""; priv.push("Unassigned"); }
    else {
      newAgent = findAgent(s, patch.assigneeEmail);
      if (!newAgent) throw httpError(400, "That agent isn’t in the agent list. Add them in Settings first.");
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
  if (f.Status && next.requesterEmail) await safeSend(templates.status(next, STATUS_TEXT[f.Status](next.number)));
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
      f.DueAt = iso(now + slaHours(s, t.priority) * HOUR);
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
    if (newStatus === "Closed") await safeSend(templates.status(next, STATUS_TEXT.Closed(next.number)));
  }
  if (type === "customer" && next.assigneeEmail) await safeSend(templates.requesterReplied(next, { author: actor.name, body: text }));
  return returnDetail ? getDetail(id, actor) : null;
}

export async function deleteTicket(id) {
  const t = await getTicket(id);
  if (!t) return;
  const [msgs, evs] = await Promise.all([queryItems("messages", `fields/TicketId eq ${t.id}`), queryItems("events", `fields/TicketId eq ${t.id}`)]);
  for (const m of msgs) await deleteItem("messages", m.id);
  for (const e of evs) await deleteItem("events", e.id);
  await deleteItem("tickets", t.id);
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
