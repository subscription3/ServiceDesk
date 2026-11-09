// Change management: requests, two-stage approval with segregation of duties, implementation and UAT.
import { createItem, updateItem, getItem, queryItems } from "./lists.mjs";
import { getSettings } from "./tickets.mjs";
import { httpError } from "./errors.mjs";
import { safeSend, changeEmail } from "./mail.mjs";
import { listAttachments } from "./attachments.mjs";

export const CHANGE_TYPES = ["Standard", "Normal", "Emergency"];
export const RISK_LEVELS = ["Low", "Medium", "High"];
export const PRIORITIES = ["Low", "Medium", "High", "Critical"];
export const ROLES = ["Raise", "ViewAll", "HeadOfIT", "ChangeManager"];
export const ST = {
  DRAFT: "Draft", TECH: "Awaiting technical owner", SYS: "Awaiting system owner", APPROVED: "Approved", IMPL: "In implementation",
  UAT: "Awaiting UAT", UATFAIL: "UAT failed", DONE: "Completed", ROLLED: "Rolled back", REJECTED: "Rejected", CANCELLED: "Cancelled",
};
const ms = (x) => (x ? Date.parse(x) : null);
const iso = (t) => (t ? new Date(t).toISOString() : undefined);
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const lower = (s) => clip(s, 200).toLowerCase();

/* ---------- permissions ---------- */
export function changePerms(user, s) {
  const person = s.changeAccess.people.find((p) => p.email === user.email);
  const roles = new Set(person ? person.roles : []);
  const ownedSystems = s.systems.filter((x) => x.owners.some((o) => o.email === user.email)).map((x) => x.name);
  const p = {
    canRaise: s.changeAccess.raise === "all" || roles.has("Raise") || user.isAdmin,
    canViewAll: roles.has("ViewAll") || roles.has("HeadOfIT") || roles.has("ChangeManager") || !!user.isAdmin,
    isHeadOfIT: roles.has("HeadOfIT"),
    isChangeManager: roles.has("ChangeManager"),
    ownedSystems,
  };
  p.any = p.canRaise || p.canViewAll || p.isHeadOfIT || p.isChangeManager || ownedSystems.length > 0;
  return p;
}
const isOwner = (s, c, email) => !!s.systems.find((x) => x.name === c.system)?.owners.some((o) => o.email === email);
function canSee(c, user, p) {
  return c.requesterEmail === user.email || p.canViewAll || p.ownedSystems.includes(c.system);
}
export function allowedActions(c, user, p, s) {
  const a = new Set();
  const mine = c.requesterEmail === user.email;
  if (mine) {
    if (c.status === ST.DRAFT) ["edit", "submit", "cancel"].forEach((x) => a.add(x));
    if (c.status === ST.TECH || c.status === ST.SYS) a.add("cancel");
    if (c.status === ST.UAT) { a.add("uat_pass"); a.add("uat_fail"); }
  }
  // Segregation of duties: never approve your own change, and never give both approvals.
  // Order: technical owner (Head of IT) first, then the system owner.
  if (c.status === ST.TECH && !mine && p.isHeadOfIT && c.businessApproverEmail !== user.email) ["approve", "sendback", "reject"].forEach((x) => a.add(x));
  if (c.status === ST.SYS && !mine && isOwner(s, c, user.email) && c.itApproverEmail !== user.email) ["approve", "sendback", "reject"].forEach((x) => a.add(x));
  if (c.status === ST.UAT && !mine && isOwner(s, c, user.email)) { a.add("uat_pass"); a.add("uat_fail"); }
  if (p.isChangeManager) {
    if (c.status === ST.APPROVED) { a.add("start"); a.add("cancel"); }
    if (c.status === ST.IMPL) { a.add("implemented"); a.add("rollback"); }
    if (c.status === ST.UATFAIL) { a.add("reimplement"); a.add("rollback"); }
  }
  return [...a];
}

/* ---------- mapping ---------- */
// Changes submitted under the earlier order (business owner first) continue under the new order.
function legacyStatus(f) {
  const st = f.Status || ST.DRAFT;
  if (st === "Awaiting business owner" || st === "Awaiting Head of IT") return f.ItApprover ? ST.SYS : ST.TECH;
  return st;
}
function toChange(f) {
  const id = Number(f.id);
  const [bName, bEmail] = String(f.BusinessApprover || "").split("|");
  const [iName, iEmail] = String(f.ItApprover || "").split("|");
  return {
    id, number: Number(f.ChangeNumber) || 1000 + id, ref: `CHG-${Number(f.ChangeNumber) || 1000 + id}`,
    title: f.Title || "", system: f.SystemName || "", plannedStart: ms(f.PlannedStart), plannedEnd: ms(f.PlannedEnd), initiator: f.Initiator || "",
    changeType: f.ChangeType || "Normal", description: f.Description || "", reason: f.Reason || "", riskLevel: f.RiskLevel || "", riskMitigation: f.RiskMitigation || "",
    implementationPlan: f.ImplementationPlan || "", rollbackPlan: f.RollbackPlan || "", priority: f.Priority || "Medium", requiresUat: !!f.RequiresUat,
    requesterName: f.RequesterName || "", requesterEmail: f.RequesterEmail || "", status: legacyStatus(f),
    businessApprover: bName || "", businessApproverEmail: bEmail || "", businessApprovedAt: ms(f.BusinessApprovedAt),
    itApprover: iName || "", itApproverEmail: iEmail || "", itApprovedAt: ms(f.ItApprovedAt),
    implementationNotes: f.ImplementationNotes || "", uatNotes: f.UatNotes || "",
    createdAt: ms(f.OpenedAt) || ms(f.Created), submittedAt: ms(f.SubmittedAt), completedAt: ms(f.CompletedAt), updatedAt: ms(f.LastActivityAt) || ms(f.Modified),
  };
}
const toHistory = (f) => ({ id: Number(f.id), stage: f.Stage || "", action: f.Title || "", comment: f.Comment || "", by: f.ActorName || "", byEmail: f.ActorEmail || "", at: ms(f.OccurredAt) || ms(f.Created) });
async function addHistory(c, stage, action, comment, user) {
  await createItem("changeHistory", { Title: clip(action, 250), ChangeId: c.id, Stage: stage, Comment: clip(comment, 8000) || undefined, ActorName: user.name, ActorEmail: user.email || undefined, OccurredAt: new Date().toISOString() });
}

/* ---------- reads ---------- */
export async function changeContext(user) {
  const s = await getSettings();
  return { s, p: changePerms(user, s) };
}
export async function listChanges(user) {
  const { s, p } = await changeContext(user);
  const rows = (await queryItems("changes", null, { top: 999 })).map(toChange);
  return rows.filter((c) => canSee(c, user, p)).map((c) => ({ ...c, actions: allowedActions(c, user, p, s) })).sort((a, b) => b.createdAt - a.createdAt);
}
export async function getChange(id, user) {
  const { s, p } = await changeContext(user);
  const f = await getItem("changes", id);
  if (!f) throw httpError(404, "That change request doesn’t exist.");
  const c = toChange(f);
  if (!canSee(c, user, p)) throw httpError(404, "That change request doesn’t exist.");
  const [hist, files] = await Promise.all([queryItems("changeHistory", `fields/ChangeId eq ${c.id}`), listAttachments("Change", c.id)]);
  return { change: c, history: hist.map(toHistory).sort((a, b) => a.at - b.at), attachments: files, actions: allowedActions(c, user, p, s) };
}

/* ---------- writes ---------- */
function fieldsFrom(input, s, { strict }) {
  const f = {};
  const set = (k, v) => { if (v !== undefined) f[k] = v; };
  set("Title", input.title !== undefined ? clip(input.title, 200) : undefined);
  if (input.system !== undefined) {
    if (input.system && !s.systems.some((x) => x.name === input.system)) throw httpError(400, "Choose a system from the list. Admins add systems in Settings → Systems.");
    f.SystemName = clip(input.system, 120);
  }
  if (input.plannedStart !== undefined) set("PlannedStart", Number(input.plannedStart) ? iso(Number(input.plannedStart)) : undefined);
  if (input.plannedEnd !== undefined) set("PlannedEnd", Number(input.plannedEnd) ? iso(Number(input.plannedEnd)) : undefined);
  set("Initiator", input.initiator !== undefined ? clip(input.initiator, 120) : undefined);
  if (input.changeType !== undefined) f.ChangeType = CHANGE_TYPES.includes(input.changeType) ? input.changeType : "Normal";
  set("Description", input.description !== undefined ? clip(input.description, 20000) : undefined);
  set("Reason", input.reason !== undefined ? clip(input.reason, 10000) : undefined);
  if (input.riskLevel !== undefined) f.RiskLevel = RISK_LEVELS.includes(input.riskLevel) ? input.riskLevel : "";
  set("RiskMitigation", input.riskMitigation !== undefined ? clip(input.riskMitigation, 10000) : undefined);
  set("ImplementationPlan", input.implementationPlan !== undefined ? clip(input.implementationPlan, 20000) : undefined);
  set("RollbackPlan", input.rollbackPlan !== undefined ? clip(input.rollbackPlan, 20000) : undefined);
  if (input.priority !== undefined) f.Priority = PRIORITIES.includes(input.priority) ? input.priority : "Medium";
  if (input.requiresUat !== undefined) f.RequiresUat = !!input.requiresUat;
  if (strict && !f.Title) throw httpError(400, "Give the change a short title.");
  return f;
}
function missingForSubmit(c) {
  const need = [["title", "a title"], ["system", "the system"], ["plannedStart", "the planned date"], ["initiator", "the change initiator"], ["description", "the change description"],
    ["reason", "the reason for the change"], ["riskLevel", "the risk level"], ["riskMitigation", "the risk mitigation"], ["implementationPlan", "the implementation plan"], ["rollbackPlan", "the rollback plan"]];
  return need.filter(([k]) => !c[k]).map(([, l]) => l);
}

export async function createChange(input, user) {
  const { s, p } = await changeContext(user);
  if (!p.canRaise) throw httpError(403, "You don’t have permission to raise change requests. Ask a service desk admin.");
  const now = Date.now();
  const f = fieldsFrom(input, s, { strict: true });
  const item = await createItem("changes", { ...f, Status: ST.DRAFT, RequesterName: user.name, RequesterEmail: user.email, OpenedAt: iso(now), LastActivityAt: iso(now), ChangeType: f.ChangeType || "Normal", Priority: f.Priority || "Medium" });
  const number = 1000 + Number(item.id);
  await updateItem("changes", item.id, { ChangeNumber: number });
  const c = toChange({ ...item, ChangeNumber: number });
  await addHistory(c, "Draft", "Change request created", "", user);
  return c;
}

export async function updateChange(id, input, user) {
  const d = await getChange(id, user);
  if (!d.actions.includes("edit")) throw httpError(403, "Only the requester can edit a change, and only while it’s a draft.");
  const { s } = await changeContext(user);
  const f = fieldsFrom(input, s, { strict: false });
  if ("Title" in f && !f.Title) throw httpError(400, "Give the change a short title.");
  await updateItem("changes", id, { ...f, LastActivityAt: iso(Date.now()) });
  return d.change;
}

const people = (list) => [...new Map(list.filter((x) => x && x.email).map((x) => [x.email, x])).values()];

export async function changeAction(id, action, comment, user) {
  const d = await getChange(id, user);
  const c = d.change;
  const { s, p } = await changeContext(user);
  if (!d.actions.includes(action)) throw httpError(403, "You can’t do that on this change at its current stage.");
  const text = clip(comment, 8000);
  const needsComment = ["sendback", "reject", "rollback", "uat_fail", "cancel"].includes(action);
  if (needsComment && !text) throw httpError(400, "Add a comment explaining why.");
  const now = Date.now();
  const f = { LastActivityAt: iso(now) };
  const requester = { name: c.requesterName, email: c.requesterEmail };
  const owners = s.systems.find((x) => x.name === c.system)?.owners || [];
  const heads = s.changeAccess.people.filter((x) => x.roles.includes("HeadOfIT"));
  const managers = s.changeAccess.people.filter((x) => x.roles.includes("ChangeManager"));
  let stage = c.status, label = "", notify = [];

  switch (action) {
    case "submit": {
      const missing = missingForSubmit(c);
      if (missing.length) throw httpError(400, `Before submitting, add ${missing.join(", ")}.`);
      if (!heads.length) throw httpError(400, "No Head of IT (technical owner) is set. Ask an admin to add one in Settings → Change access.");
      if (!owners.length) throw httpError(400, `No system owner is set for ${c.system}. Ask an admin to add one in Settings → Systems.`);
      // Separation of duties needs someone other than the requester at each stage, or the change would wait forever.
      const otherHeads = heads.filter((h) => h.email !== c.requesterEmail);
      if (!otherHeads.length) throw httpError(400, "You’re the only Head of IT (technical owner), and nobody can approve their own change. Ask an admin to give a second person the technical owner role in Settings → Change access, for example a deputy.");
      const otherOwners = owners.filter((o) => o.email !== c.requesterEmail);
      if (!otherOwners.length) throw httpError(400, `You’re the only system owner of ${c.system}, and nobody can approve their own change. Ask an admin to add another system owner in Settings → Systems.`);
      if (otherHeads.length === 1 && otherOwners.length === 1 && otherHeads[0].email === otherOwners[0].email) throw httpError(400, `${otherOwners[0].name} is both the only technical owner and the only system owner available, and one person can’t give both approvals. Ask an admin to add another technical owner or system owner.`);
      f.Status = ST.TECH; f.SubmittedAt = iso(now); label = "Submitted for technical owner approval";
      notify = heads.filter((h) => h.email !== c.requesterEmail).map((h) => [h, "approval", "Technical owner approval needed"]);
      break;
    }
    case "approve":
      if (c.status === ST.TECH) {
        f.ItApprover = `${user.name}|${user.email}`; f.ItApprovedAt = iso(now); label = "Approved by technical owner (Head of IT)";
        if (c.businessApprovedAt) { // only for changes the system owner approved under the earlier order
          f.Status = ST.APPROVED;
          notify = [[requester, "update", "Fully approved"], ...managers.map((m) => [m, "action", "Approved and ready to implement"])];
        } else {
          f.Status = ST.SYS;
          notify = [...owners.filter((o) => o.email !== user.email && o.email !== c.requesterEmail).map((o) => [o, "approval", "System owner approval needed"]), [requester, "update", "Approved by the technical owner"]];
        }
      } else {
        f.Status = ST.APPROVED; f.BusinessApprover = `${user.name}|${user.email}`; f.BusinessApprovedAt = iso(now); label = "Approved by system owner";
        notify = [[requester, "update", "Fully approved"], ...managers.map((m) => [m, "action", "Approved and ready to implement"])];
      }
      break;
    case "sendback": f.Status = ST.DRAFT; label = `Sent back for more information (${c.status === ST.TECH ? "technical owner" : "system owner"})`; notify = [[requester, "update", "Sent back for more information"]]; break;
    case "reject": f.Status = ST.REJECTED; f.CompletedAt = iso(now); label = `Rejected (${c.status === ST.TECH ? "technical owner" : "system owner"})`; notify = [[requester, "update", "Rejected"]]; break;
    case "cancel": f.Status = ST.CANCELLED; f.CompletedAt = iso(now); label = "Cancelled"; notify = c.requesterEmail !== user.email ? [[requester, "update", "Cancelled"]] : []; break;
    case "start": f.Status = ST.IMPL; label = "Implementation started"; notify = [[requester, "update", "Implementation has started"]]; break;
    case "implemented":
      f.ImplementationNotes = text || undefined;
      if (c.requiresUat) { f.Status = ST.UAT; label = "Implemented, awaiting UAT sign-off"; notify = [[requester, "action", "Implemented: please complete UAT"], ...owners.map((o) => [o, "update", "Implemented and awaiting UAT"])]; }
      else { f.Status = ST.DONE; f.CompletedAt = iso(now); label = "Implemented and completed"; notify = [[requester, "update", "Completed"]]; }
      break;
    case "uat_pass": f.Status = ST.DONE; f.CompletedAt = iso(now); f.UatNotes = text || undefined; label = "UAT passed, change completed"; notify = [[requester, "update", "Completed"], ...managers.map((m) => [m, "update", "UAT passed, change completed"])]; break;
    case "uat_fail": f.Status = ST.UATFAIL; f.UatNotes = text; label = "UAT failed"; notify = managers.map((m) => [m, "action", "UAT failed: decide whether to fix or roll back"]); break;
    case "reimplement": f.Status = ST.IMPL; label = "Returned to implementation after failed UAT"; break;
    case "rollback": f.Status = ST.ROLLED; f.CompletedAt = iso(now); label = "Rolled back"; notify = [[requester, "update", "Rolled back"], ...owners.map((o) => [o, "update", "Rolled back"])]; break;
    default: throw httpError(400, "Unknown action.");
  }
  await updateItem("changes", c.id, f);
  await addHistory(c, stage, label, text, user);
  const updated = { ...c, status: f.Status || c.status };
  for (const [who, kind, heading] of people(notify.map((n) => ({ ...n[0], kind: n[1], heading: n[2] })))
    .filter((w) => w.email !== user.email).map((w) => [w, w.kind, w.heading])) {
    await safeSend(changeEmail(updated, who, kind, heading, label, text, user));
  }
  return { label, before: c.status, after: updated.status };
}
