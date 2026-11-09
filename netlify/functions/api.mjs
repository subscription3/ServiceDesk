// All /api/* requests from the browser. Every change is recorded in the activity log.
import { env } from "../../lib/graph.mjs";
import { healthCheck } from "../../lib/health.mjs";
import { authenticate, requireAgent, requireAdmin, httpError } from "../../lib/auth.mjs";
import {
  getSettings, saveSettings, publicSettings, logoUrl, listTickets, listMine, getDetail, getTicket,
  createTicket, updateTicket, addMessage, deleteTicket, addTicketEvent, afterFeedback,
} from "../../lib/tickets.mjs";
import { decodeLogo, uploadLogo, downloadLogo, deleteLogoFiles, searchDirectory } from "../../lib/brand.mjs";
import { pollInbox } from "../../lib/inbox.mjs";
import { audit, listAudit, requestInfo } from "../../lib/audit.mjs";
import { verifyFeedbackToken, saveFeedback, getFeedback, listFeedback, RATINGS } from "../../lib/feedback.mjs";
import { decodeFile, saveAttachment, getAttachment, readAttachment, removeAttachment } from "../../lib/attachments.mjs";
import { changeContext, listChanges, getChange, createChange, updateChange, changeAction, CHANGE_TYPES, RISK_LEVELS, PRIORITIES as CHANGE_PRIORITIES } from "../../lib/changes.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readBody(req) {
  try { return await req.json(); } catch { throw httpError(400, "The request body wasn’t valid JSON."); }
}

function settingsDiff(before, after) {
  const d = {};
  if (after.users) {
    const b = new Map(before.users.map((u) => [u.email, u])), a = new Map(after.users.map((u) => [u.email, u]));
    const added = [...a.values()].filter((u) => !b.has(u.email)).map((u) => `${u.name} <${u.email}> as ${u.role}`);
    const removed = [...b.values()].filter((u) => !a.has(u.email)).map((u) => `${u.name} <${u.email}>`);
    const changed = [...a.values()].filter((u) => b.has(u.email) && b.get(u.email).role !== u.role).map((u) => `${u.name}: ${b.get(u.email).role} → ${u.role}`);
    if (added.length) d.usersAdded = added;
    if (removed.length) d.usersRemoved = removed;
    if (changed.length) d.roleChanges = changed;
  }
  if (after.departments) {
    const added = after.departments.filter((x) => !before.departments.includes(x));
    const removed = before.departments.filter((x) => !after.departments.includes(x));
    if (added.length) d.departmentsAdded = added;
    if (removed.length) d.departmentsRemoved = removed;
  }
  if (after.sla && JSON.stringify(after.sla) !== JSON.stringify(before.sla)) d.sla = { before: before.sla, after: after.sla };
  if (after.feedback && JSON.stringify(after.feedback) !== JSON.stringify(before.feedback)) d.feedback = { before: before.feedback, after: after.feedback };
  if (after.email && JSON.stringify(after.email) !== JSON.stringify(before.email)) d.email = { before: before.email, after: after.email };
  if (after.systems && JSON.stringify(after.systems) !== JSON.stringify(before.systems)) d.systems = { before: before.systems, after: after.systems };
  if (after.changeAccess && JSON.stringify(after.changeAccess) !== JSON.stringify(before.changeAccess)) d.changeAccess = { before: before.changeAccess, after: after.changeAccess };
  return d;
}
function summarise(d) {
  const parts = [];
  if (d.usersAdded) parts.push(`added ${d.usersAdded.length} user${d.usersAdded.length > 1 ? "s" : ""}`);
  if (d.usersRemoved) parts.push(`removed ${d.usersRemoved.length} user${d.usersRemoved.length > 1 ? "s" : ""}`);
  if (d.roleChanges) parts.push("changed user roles");
  if (d.departmentsAdded || d.departmentsRemoved) parts.push("changed departments");
  if (d.sla) parts.push("changed the SLA policy");
  if (d.feedback) parts.push("changed feedback settings");
  if (d.email) parts.push("changed email settings");
  if (d.systems) parts.push("changed the systems register");
  if (d.changeAccess) parts.push("changed change-management access");
  return parts.length ? parts.join(", ") : "saved settings without changes";
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method;
  const info = requestInfo(req, context);
  try {
    /* ---------- public ---------- */
    if (path === "/config" && method === "GET") {
      let logo = "";
      try { logo = logoUrl(await getSettings()); } catch { /* lists may not exist yet */ }
      return json({
        clientId: env("AZURE_CLIENT_ID"), tenantId: env("AZURE_TENANT_ID"),
        orgName: process.env.ORG_NAME || "InfraCredit", supportEmail: env("SUPPORT_MAILBOX"), logoUrl: logo,
      });
    }
    if (path === "/health" && method === "GET") {
      const r = await healthCheck();
      return json(r, r.ok ? 200 : 500);
    }
    if (path === "/brand/logo" && method === "GET") {
      const s = await getSettings();
      const buf = s.branding.logoVersion ? await downloadLogo(s.branding.logoExt) : null;
      if (!buf) return new Response("Not found", { status: 404 });
      return new Response(buf, {
        headers: {
          "Content-Type": s.branding.logoExt === "jpg" ? "image/jpeg" : "image/png",
          "Cache-Control": url.searchParams.get("v") ? "public, max-age=31536000, immutable" : "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    // Feedback links in emails work without signing in; the signed link proves who it's for.
    if (path === "/feedback" && method === "GET") {
      const p = verifyFeedbackToken(url.searchParams.get("t"));
      const t = await getTicket(p.id);
      if (!t || t.number !== p.n) throw httpError(404, "This ticket no longer exists.");
      const fb = await getFeedback(t.id);
      return json({ number: t.number, subject: t.subject, status: t.status, name: (t.requesterName || "").split(" ")[0], rating: fb?.rating || null, comment: fb?.comment || "", ratings: RATINGS, orgName: process.env.ORG_NAME || "InfraCredit", logoUrl: logoUrl(await getSettings()) });
    }
    if (path === "/feedback" && method === "POST") {
      const b = await readBody(req);
      const p = verifyFeedbackToken(b.t);
      const t = await getTicket(p.id);
      if (!t || t.number !== p.n) throw httpError(404, "This ticket no longer exists.");
      const fb = await saveFeedback(t, { rating: b.rating, comment: b.comment, via: "Email link" });
      await addTicketEvent(t, `Requester rated the support ${fb.rating}/5 (${fb.label})${fb.comment ? " with a comment" : ""}`, t.requesterName || p.e, false);
      const alerted = await afterFeedback(t, fb);
      await audit({ name: t.requesterName, email: p.e }, `${fb.updated ? "Updated" : "Submitted"} feedback for ticket #${t.number}: ${fb.rating}/5`, { category: "Feedback", targetType: "Ticket", targetId: t.number, details: { rating: fb.rating, comment: fb.comment, via: "Email link", lowRatingAlertSentTo: alerted }, info });
      return json({ ok: true, rating: fb.rating });
    }

    /* ---------- signed in ---------- */
    const user = await authenticate(req);

    if (path === "/me" && method === "GET") {
      await audit(user, "Signed in to the service desk", { category: "Access", details: { role: user.isAdmin ? "Admin" : user.isAgent ? "Agent" : "Staff" }, info });
      return json(user);
    }

    if (path === "/settings" && method === "GET") {
      const pub = publicSettings(await getSettings());
      return json(user.isAgent ? pub : { departments: pub.departments, logoUrl: pub.logoUrl });
    }
    if (path === "/settings" && method === "PUT") {
      requireAdmin(user);
      const b = await readBody(req);
      const input = {};
      for (const k of ["departments", "users", "sla", "feedback", "email", "systems", "changeAccess"]) if (k in b) input[k] = b[k];
      const before = await getSettings(true);
      const after = await saveSettings(input);
      const diff = settingsDiff(before, Object.fromEntries(Object.keys(input).map((k) => [k, after[k]])));
      await audit(user, `Settings: ${summarise(diff)}`, { category: "Settings", targetType: "Settings", targetId: Object.keys(input).join(","), details: diff, info });
      return json(after);
    }
    if (path === "/brand/logo" && method === "PUT") {
      requireAdmin(user);
      const logo = decodeLogo((await readBody(req)).dataUrl);
      await uploadLogo(logo);
      const r = await saveSettings({ branding: { logoVersion: Date.now(), logoExt: logo.ext } });
      await audit(user, "Uploaded a new logo", { category: "Settings", targetType: "Branding", details: { type: logo.type, bytes: logo.buf.length }, info });
      return json(r);
    }
    if (path === "/brand/logo" && method === "DELETE") {
      requireAdmin(user);
      await deleteLogoFiles();
      const r = await saveSettings({ branding: { logoVersion: 0, logoExt: "png" } });
      await audit(user, "Removed the logo", { category: "Settings", targetType: "Branding", info });
      return json(r);
    }
    if (path === "/directory" && method === "GET") {
      requireAdmin(user);
      return json(await searchDirectory(url.searchParams.get("q")));
    }

    if (path === "/tickets" && method === "GET") {
      requireAgent(user);
      return json(await listTickets());
    }
    if (path === "/tickets" && method === "POST") {
      const b = await readBody(req);
      let t;
      if (user.isAgent && b.mode === "agent") {
        t = await createTicket(b, user, { channel: b.channel });
      } else {
        t = await createTicket(
          { subject: b.subject, description: b.description, name: b.name || user.name, email: user.email, phone: b.phone, department: b.department, priority: b.priority },
          user, { channel: "Self-service portal" },
        );
      }
      await audit(user, `Created ticket #${t.number}`, { category: "Ticket", targetType: "Ticket", targetId: t.number, details: { subject: t.subject, channel: t.channel, priority: t.priority, requester: t.requesterEmail || t.requesterName, assignee: t.assigneeEmail || null }, info });
      return json(await getDetail(t.id, user.isAgent && b.mode === "agent" ? user : { ...user, isAgent: false }), 201);
    }

    if (path === "/my/tickets" && method === "GET") return json(await listMine(user.email));

    const m = path.match(/^\/tickets\/(\d+)(\/messages|\/feedback)?$/);
    if (m) {
      const id = Number(m[1]);
      if (!m[2] && method === "GET") return json(await getDetail(id, user));
      if (!m[2] && method === "PATCH") {
        requireAgent(user);
        const before = await getTicket(id);
        if (!before) throw httpError(404, "That ticket no longer exists.");
        const { silent, ...patch } = await readBody(req);
        if (silent) requireAdmin(user);
        const d = await updateTicket(id, patch, user, { silent: !!silent });
        const changes = {};
        for (const [k, v] of Object.entries(patch)) {
          const old = before[k];
          if (JSON.stringify(old) !== JSON.stringify(v)) changes[k] = { from: old ?? null, to: v };
        }
        if (silent) changes.notifications = "not sent (closed without emailing)";
        if (Object.keys(changes).length) await audit(user, `Updated ticket #${before.number}${silent ? " without emailing" : ""}: ${Object.keys(changes).filter((k) => k !== "notifications").join(", ")}`, { category: "Ticket", targetType: "Ticket", targetId: before.number, details: changes, info });
        return json(d);
      }
      if (!m[2] && method === "DELETE") {
        requireAgent(user);
        const r = await deleteTicket(id);
        if (r) await audit(user, `Deleted ticket #${r.ticket.number}`, { category: "Ticket", targetType: "Ticket", targetId: r.ticket.number, details: { subject: r.ticket.subject, requester: r.ticket.requesterEmail, status: r.ticket.status, messagesDeleted: r.messages, eventsDeleted: r.events }, info });
        return json({ ok: true });
      }
      if (m[2] === "/messages" && method === "POST") {
        const b = await readBody(req);
        if (b.type === "customer") {
          const pre = await getDetail(id, { ...user, isAgent: false }); // the requester can only reply to their own ticket
          const d = await addMessage(id, { type: "customer", body: b.body }, { ...user, isAgent: false }, { source: "portal" });
          await audit(user, `Replied to their ticket #${pre.ticket.number} in the portal`, { category: "Ticket", targetType: "Ticket", targetId: pre.ticket.number, details: { characters: String(b.body || "").length }, info });
          return json(d);
        }
        requireAgent(user);
        const d = await addMessage(id, { type: b.type, body: b.body, closeAfter: !!b.closeAfter }, user);
        await audit(user, `${b.type === "note" ? "Added an internal note to" : b.closeAfter ? "Replied to and closed" : "Replied to"} ticket #${d.ticket.number}`, { category: "Ticket", targetType: "Ticket", targetId: d.ticket.number, details: { type: b.type, characters: String(b.body || "").length, emailedTo: b.type === "reply" ? d.ticket.requesterEmail || null : null }, info });
        return json(d);
      }
      if (m[2] === "/feedback" && method === "POST") {
        const pre = await getDetail(id, { ...user, isAgent: false });
        const b = await readBody(req);
        const fb = await saveFeedback(pre.ticket, { rating: b.rating, comment: b.comment, via: "Portal" });
        await addTicketEvent(pre.ticket, `Requester rated the support ${fb.rating}/5 (${fb.label})${fb.comment ? " with a comment" : ""}`, user.name, false);
        const alerted = await afterFeedback(pre.ticket, fb);
        await audit(user, `${fb.updated ? "Updated" : "Submitted"} feedback for ticket #${pre.ticket.number}: ${fb.rating}/5`, { category: "Feedback", targetType: "Ticket", targetId: pre.ticket.number, details: { rating: fb.rating, comment: fb.comment, via: "Portal", lowRatingAlertSentTo: alerted }, info });
        return json(await getDetail(id, { ...user, isAgent: false }));
      }
    }

    /* ---------- attachments ---------- */
    if (path === "/attachments" && method === "POST") {
      const b = await readBody(req);
      let parentNumber, internal = false;
      if (b.parentType === "Ticket") {
        const d = await getDetail(Number(b.parentId), user); // checks the person may see the ticket
        if (!user.isAgent && d.ticket.requesterEmail !== user.email) throw httpError(404, "That ticket no longer exists.");
        parentNumber = d.ticket.number; internal = !!b.internal && user.isAgent;
      } else if (b.parentType === "Change") {
        const d = await getChange(Number(b.parentId), user);
        parentNumber = d.change.ref;
      } else throw httpError(400, "Unknown attachment target.");
      const file = decodeFile(b.fileName, b.dataUrl);
      const a = await saveAttachment({ parentType: b.parentType, parentId: Number(b.parentId), parentNumber, internal, user }, file);
      await audit(user, `Attached “${a.name}” to ${b.parentType === "Ticket" ? "ticket #" : ""}${parentNumber}${internal ? " (internal)" : ""}`, { category: b.parentType === "Ticket" ? "Ticket" : "Change", targetType: b.parentType, targetId: parentNumber, details: { file: a.name, bytes: a.size, type: a.type, internal }, info });
      return json(a, 201);
    }
    const am = path.match(/^\/attachments\/(\d+)$/);
    if (am) {
      const a = await getAttachment(Number(am[1]));
      if (!a) throw httpError(404, "That file no longer exists.");
      let label;
      if (a.parentType === "Ticket") {
        const d = await getDetail(a.parentId, user);
        if (!user.isAgent && (a.internal || d.ticket.requesterEmail !== user.email)) throw httpError(404, "That file no longer exists.");
        label = `ticket #${d.ticket.number}`;
      } else { const d = await getChange(a.parentId, user); label = d.change.ref; }
      if (method === "GET") {
        const buf = await readAttachment(a);
        await audit(user, `Downloaded “${a.name}” from ${label}`, { category: a.parentType === "Ticket" ? "Ticket" : "Change", targetType: a.parentType, targetId: label, details: { file: a.name }, info });
        return new Response(buf, { headers: { "Content-Type": a.type || "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" } });
      }
      if (method === "DELETE") {
        if (a.byEmail !== user.email && !user.isAdmin) throw httpError(403, "Only the person who uploaded a file, or an admin, can remove it.");
        await removeAttachment(a);
        await audit(user, `Removed “${a.name}” from ${label}`, { category: a.parentType === "Ticket" ? "Ticket" : "Change", targetType: a.parentType, targetId: label, details: { file: a.name, uploadedBy: a.by }, info });
        return json({ ok: true });
      }
    }

    /* ---------- change management ---------- */
    if (path === "/changes/me" && method === "GET") {
      const { s, p } = await changeContext(user);
      return json({ perms: p, systems: s.systems.map((x) => ({ name: x.name, description: x.description, owners: x.owners.map((o) => o.name) })), types: CHANGE_TYPES, risks: RISK_LEVELS, priorities: CHANGE_PRIORITIES });
    }
    if (path === "/changes" && method === "GET") return json(await listChanges(user));
    if (path === "/changes" && method === "POST") {
      const c = await createChange(await readBody(req), user);
      await audit(user, `Created change ${c.ref} (draft)`, { category: "Change", targetType: "Change", targetId: c.ref, details: { title: c.title, system: c.system }, info });
      return json(await getChange(c.id, user), 201);
    }
    const cm = path.match(/^\/changes\/(\d+)(\/action)?$/);
    if (cm) {
      const id = Number(cm[1]);
      if (!cm[2] && method === "GET") return json(await getChange(id, user));
      if (!cm[2] && method === "PATCH") {
        const b = await readBody(req);
        const c = await updateChange(id, b, user);
        await audit(user, `Edited change ${c.ref}`, { category: "Change", targetType: "Change", targetId: c.ref, details: { fields: Object.keys(b) }, info });
        return json(await getChange(id, user));
      }
      if (cm[2] && method === "POST") {
        const b = await readBody(req);
        const before = (await getChange(id, user)).change;
        const r = await changeAction(id, String(b.action || ""), b.comment, user);
        await audit(user, `${before.ref}: ${r.label}`, { category: "Change", targetType: "Change", targetId: before.ref, details: { action: b.action, from: r.before, to: r.after, comment: b.comment || "" }, info });
        return json(await getChange(id, user));
      }
    }

    if (path === "/feedback/all" && method === "GET") {
      requireAgent(user);
      return json((await listFeedback()).sort((a, b) => b.at - a.at));
    }
    if (path === "/reports/export" && method === "POST") {
      requireAgent(user);
      const b = await readBody(req);
      await audit(user, `Exported the ${String(b.report || "tickets").slice(0, 60)} report (${Number(b.rows) || 0} rows)`, { category: "Audit", details: { report: b.report, from: b.from, to: b.to, filters: b.filters, rows: b.rows }, info });
      return json({ ok: true });
    }
    if (path === "/feedback/recent" && method === "GET") {
      requireAgent(user);
      return json((await listFeedback()).sort((a, b) => b.at - a.at).slice(0, 200));
    }
    if (path === "/mail/check" && method === "POST") {
      requireAgent(user);
      const r = await pollInbox({ max: 8 });
      await audit(user, r.disabled ? `Checked the support mailbox: intake is off (${r.disabled})` : `Checked the support mailbox: ${r.created} new tickets, ${r.replies} replies`, { category: "Email", details: r, info });
      return json(r);
    }
    if (path === "/audit" && method === "GET") {
      requireAdmin(user);
      return json(await listAudit({ from: url.searchParams.get("from"), to: url.searchParams.get("to"), category: url.searchParams.get("category") || "" }));
    }
    if (path === "/audit/export" && method === "POST") {
      requireAdmin(user);
      const b = await readBody(req);
      await audit(user, `Exported the activity log (${Number(b.rows) || 0} entries)`, { category: "Audit", details: { from: b.from, to: b.to, filter: b.filter || "", rows: b.rows }, info });
      return json({ ok: true });
    }
    if (path === "/backups" && method === "GET") {
      requireAdmin(user);
      return json(await listAudit({ from: Date.now() - 400 * 864e5, category: "Backup" }));
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    const status = e.status && e.status < 500 && !e.expose ? e.status : 500;
    console.error(`${method} ${path} failed:`, e.message);
    const message = e.expose || status < 500 ? e.message : "Something went wrong on the server. Open /api/health on this site to see which connection is failing.";
    return json({ error: message }, status);
  }
};

export const config = { path: "/api/*" };
