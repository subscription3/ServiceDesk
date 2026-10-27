(function () {
"use strict";
const STATUSES = ["Open", "In progress", "On hold", "Escalated", "Closed"];
const PRIORITIES = ["Urgent", "High", "Medium", "Low"];
const DESK_CHANNELS = ["Email", "Phone", "Web form", "Chat", "WhatsApp", "Walk-in"];
const ALL_CHANNELS = [...DESK_CHANNELS, "Self-service portal"];
const SCOPES = ["openid", "profile", "email"];

const S = {
  cfg: null, user: null, settings: { agents: [], departments: ["General"], sla: { Urgent: 4, High: 8, Medium: 24, Low: 72 } },
  tickets: [], details: {}, loaded: false,
  page: "tickets", view: "open", selected: null, search: "", sort: "newest", checked: new Set(), contact: null,
  cmode: "reply", dtab: "conversation", drafts: {}, sending: false,
  my: [], myEvents: [], myDetails: {}, ptab: "new", psel: null, pconfirm: null, bellOpen: false,
  pform: {}, preply: {}, perr: "", psending: false, seen: loadSeen(),
};
let pca = null, account = null;

/* ---------- helpers ---------- */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
function loadSeen() { try { return JSON.parse(lsGet("sd-seen") || "{}"); } catch (e) { return {}; } }
function saveSeen() { lsSet("sd-seen", JSON.stringify(S.seen)); }
function sk(s) { return "s-" + String(s).replace(/\s+/g, "-").replace(/^./, c => c.toUpperCase()); }
function opt(list, sel, blank) { return (blank != null ? `<option value="">${esc(blank)}</option>` : "") + list.map(x => `<option${x === sel ? " selected" : ""}>${esc(x)}</option>`).join(""); }
function agentOpts(sel, blank) { return (blank != null ? `<option value="">${esc(blank)}</option>` : "") + S.settings.agents.map(a => `<option value="${esc(a.email)}"${a.email === sel ? " selected" : ""}>${esc(a.name)}</option>`).join(""); }
let toastT;
function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 3500); }
function dur(ms) { const m = Math.round(Math.abs(ms) / 60000); if (m < 60) return m + "m"; const h = Math.round(m / 60); if (h < 48) return h + "h"; return Math.round(h / 24) + "d"; }
function ago(t) { if (!t) return ""; const d = Date.now() - t; return d < 60000 ? "just now" : dur(d) + " ago"; }
function fmt(t) { if (!t) return ""; const d = new Date(t); return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
function toLocalInput(ts) { if (!ts) return ""; const d = new Date(ts); const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function slaInfo(t) {
  if (t.status === "Closed") return { cls: "", txt: "Resolved" + (t.closedAt ? " " + ago(t.closedAt) : ""), pct: 100, done: true };
  if (t.status === "On hold") return { cls: "", txt: "Paused while on hold", pct: 0, paused: true };
  if (!t.dueAt) return { cls: "", txt: "No target set", pct: 0, paused: true };
  const span = Math.max(1, t.dueAt - t.createdAt), left = t.dueAt - Date.now();
  const pct = Math.max(0, Math.min(100, (left / span) * 100));
  if (left < 0) return { cls: "late", txt: "Overdue by " + dur(left), pct: 100 };
  return { cls: pct < 25 ? "warn" : "", txt: "Due in " + dur(left), pct };
}
function isOverdue(t) { return t.status !== "Closed" && t.status !== "On hold" && t.dueAt && t.dueAt < Date.now(); }
function contactKey(t) { return (t.requesterEmail || t.requesterName || "").trim().toLowerCase(); }

/* ---------- sign-in & API ---------- */
async function idToken(force) {
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account, forceRefresh: !!force });
    return r.idToken;
  } catch (e) {
    await pca.loginRedirect({ scopes: SCOPES });
    throw e;
  }
}
async function api(method, path, body, retry = true) {
  const tok = await idToken(false);
  let r;
  try {
    r = await fetch("/api" + path, { method, headers: { Authorization: "Bearer " + tok, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { toast("Can’t reach the server. Check your connection."); throw e; }
  if (r.status === 401 && retry) { await idToken(true); return api(method, path, body, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || "Something went wrong."); toast(e.message); throw e; }
  return j;
}
function signOut() { pca.logoutRedirect({ account, postLogoutRedirectUri: location.origin + "/" }); }

/* ---------- loading ---------- */
async function loadAgent() {
  const [settings, tickets] = await Promise.all([api("GET", "/settings"), api("GET", "/tickets")]);
  S.settings = { ...S.settings, ...settings };
  S.tickets = tickets; S.loaded = true;
  if (S.selected && !S.tickets.some(t => t.id === S.selected)) S.selected = null;
}
async function loadMine() {
  const r = await api("GET", "/my/tickets");
  const before = new Set(S.myEvents.map(e => e.id));
  const fresh = S.myEvents.length ? r.events.filter(e => !before.has(e.id)) : [];
  S.my = r.tickets; S.myEvents = r.events;
  if (fresh.length) toast(fresh[0].text);
}
async function loadDetail(id) {
  try { S.details[id] = await api("GET", "/tickets/" + id); mergeTicket(S.details[id].ticket); render(); } catch (e) { }
}
async function loadMyDetail(id) {
  try { S.myDetails[id] = await api("GET", "/tickets/" + id); render(); } catch (e) { }
}
function mergeTicket(t) {
  const i = S.tickets.findIndex(x => x.id === t.id);
  if (i < 0) S.tickets.unshift(t); else S.tickets[i] = t;
}

/* ---------- agent actions ---------- */
async function setField(id, field, value) {
  try { const d = await api("PATCH", "/tickets/" + id, { [field]: value }); S.details[id] = d; mergeTicket(d.ticket); render(); return true; }
  catch (e) { render(); return false; }
}
async function sendMessage(type, closeAfter) {
  const id = S.selected; const body = (S.drafts[id] || "").trim();
  if (!body) { toast("Write a message first."); return; }
  S.sending = true; render();
  try {
    const d = await api("POST", `/tickets/${id}/messages`, { type, body, closeAfter });
    S.details[id] = d; mergeTicket(d.ticket); S.drafts[id] = ""; S._scrollThread = true;
    toast(type === "note" ? "Note added" : closeAfter ? "Reply emailed and ticket closed" : "Reply sent. The requester has been emailed.");
  } catch (e) { }
  S.sending = false; render();
}

/* ---------- requester actions ---------- */
async function submitRequest() {
  const f = S.pform; const g = k => String(f[k] || "").trim();
  const missing = [!g("subject") && "a subject", !g("description") && "a description of the issue"].filter(Boolean);
  if (missing.length) { S.perr = "Add " + missing.join(" and ") + " to send your request."; render(); return; }
  S.perr = ""; S.psending = true; render();
  try {
    const d = await api("POST", "/tickets", { subject: g("subject"), description: g("description"), name: g("name") || S.user.name, phone: g("phone"), department: g("department"), priority: g("priority") || "Medium" });
    S.myDetails[d.ticket.id] = d; S.my.unshift(d.ticket); S.pconfirm = d.ticket.id;
    S.pform = { name: f.name, phone: f.phone, department: f.department };
    loadMine().then(render).catch(() => { });
  } catch (e) { }
  S.psending = false; render();
}
async function requesterReply(id) {
  const body = String(S.preply[id] || "").trim();
  if (!body) { toast("Write a message first."); return; }
  try { S.myDetails[id] = await api("POST", `/tickets/${id}/messages`, { type: "customer", body }); S.preply[id] = ""; toast("Reply sent to the support team"); loadMine().then(render).catch(() => { }); }
  catch (e) { }
  render();
}
function unreadFor(id) { const seen = S.seen[id] || 0; return S.myEvents.filter(e => e.ticketId === id && e.at > seen).length; }
function markSeen(ids) { const now = Date.now(); ids.forEach(id => { S.seen[id] = now; }); saveSeen(); }

/* ---------- views ---------- */
const VIEWS = [
  ["open", "Open tickets", t => t.status !== "Closed"],
  ["mine", "My tickets", t => t.assigneeEmail === S.user.email && t.status !== "Closed"],
  ["unassigned", "Unassigned", t => !t.assigneeEmail && t.status !== "Closed"],
  ["fromportal", "From portal", t => t.channel === "Self-service portal" && t.status !== "Closed"],
  ["fromemail", "From email", t => t.channel === "Email" && t.status !== "Closed"],
  ["overdue", "Overdue", isOverdue],
  ["onhold", "On hold", t => t.status === "On hold"],
  ["escalated", "Escalated", t => t.status === "Escalated"],
  ["closed", "Closed", t => t.status === "Closed"],
  ["all", "All tickets", () => true],
];
const PR = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
function visible() {
  const v = VIEWS.find(v => v[0] === S.view) || VIEWS[0];
  let list = S.tickets.filter(v[2]);
  if (S.contact) list = list.filter(t => contactKey(t) === S.contact);
  const q = S.search.trim().toLowerCase().replace(/^#/, "");
  if (q) list = list.filter(t => [t.number, t.subject, t.requesterName, t.requesterEmail, t.assigneeName, t.description, t.tags.join(" ")].join(" ").toLowerCase().includes(q));
  const sorts = { newest: (a, b) => b.createdAt - a.createdAt, oldest: (a, b) => a.createdAt - b.createdAt, due: (a, b) => (a.dueAt || 9e15) - (b.dueAt || 9e15), priority: (a, b) => (PR[a.priority] - PR[b.priority]) || ((a.dueAt || 0) - (b.dueAt || 0)), updated: (a, b) => b.updatedAt - a.updatedAt };
  return list.sort(sorts[S.sort] || sorts.newest);
}

/* ---------- render ---------- */
const root = document.getElementById("root");
function render() {
  if (!S.user) return;
  const active = document.activeElement; const keepId = active && active.id; let selStart = null;
  try { selStart = active && active.selectionStart; } catch (e) { }
  if (!S.user.isAgent) {
    root.innerHTML = `<div class="portal"><header class="p-top"><div class="brand"><div class="brand-mark" aria-hidden="true">✦</div><span>${esc(S.cfg.orgName)} Service Desk</span></div>
      <button class="linkbtn" data-act="signout">Sign out</button></header><main class="p-wrap">${renderPortal(false)}</main></div>`;
  } else {
    const counts = Object.fromEntries(VIEWS.map(v => [v[0], S.tickets.filter(v[2]).length]));
    const tp = S.page === "tickets";
    const sel = tp && S.selected && S.tickets.find(t => t.id === S.selected);
    root.innerHTML = `<div class="app ${tp ? "" : "wide-main"} ${sel ? "has-sel" : ""}">
      <nav class="rail" aria-label="Service desk">
        <div class="brand"><div class="brand-mark" aria-hidden="true">✦</div><span>Service Desk</span></div>
        <button class="new-btn" data-act="new">+ New ticket</button>
        <button class="nav" data-page="dashboard" aria-current="${S.page === "dashboard"}"><span>Dashboard</span></button>
        <h2>Tickets</h2>
        ${VIEWS.map(v => `<button class="nav" data-view="${v[0]}" aria-current="${tp && S.view === v[0]}"><span>${v[1]}</span><span class="n ${v[0] === "overdue" && counts.overdue ? "hot" : ""}">${counts[v[0]]}</span></button>`).join("")}
        <h2>Directory</h2>
        <button class="nav" data-page="contacts" aria-current="${S.page === "contacts"}"><span>Requesters</span></button>
        <button class="nav" data-page="portal" aria-current="${S.page === "portal"}"><span>Request portal</span></button>
        <button class="nav" data-act="settings"><span>Settings</span></button>
        <div class="rail-foot">
          <div class="user-chip">Signed in as <b>${esc(S.user.name)}</b><br>${esc(S.user.email)}</div>
          <button class="linkbtn" data-act="signout">Sign out</button>
        </div>
      </nav>
      ${!S.loaded ? `<div class="spinner">Loading tickets…</div>` : tp ? renderList() + renderDetail(sel) : S.page === "dashboard" ? renderDash(counts) : S.page === "portal" ? `<main class="page">${renderPortal(true)}</main>` : renderContacts()}
    </div>`;
  }
  if (keepId) { const el = document.getElementById(keepId); if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch (e) { } } }
  const th = document.querySelector(".thread"); if (th && S._scrollThread) { th.scrollTop = th.scrollHeight; S._scrollThread = false; }
}

function renderList() {
  const list = visible(); const v = VIEWS.find(v => v[0] === S.view) || VIEWS[0];
  const cName = S.contact && (S.tickets.find(t => contactKey(t) === S.contact) || {}).requesterName;
  return `<section class="listpane" aria-label="Ticket list">
    <div class="list-head"><h1>${esc(v[1])}</h1>
      <div class="search"><label class="sr" for="q">Search tickets</label><input id="q" type="search" placeholder="Search by #, subject, requester…" value="${esc(S.search)}">
      <label class="sr" for="sortSel">Sort</label><select id="sortSel">${[["newest", "Newest"], ["oldest", "Oldest"], ["due", "Due soonest"], ["priority", "Priority"], ["updated", "Recently updated"]].map(o => `<option value="${o[0]}"${S.sort === o[0] ? " selected" : ""}>${o[1]}</option>`).join("")}</select></div>
      ${S.contact ? `<div class="chipline">Requester: <button data-act="clear-contact">${esc(cName || S.contact)} ×</button></div>` : ""}
    </div>
    ${S.checked.size ? `<div class="bulk"><b>${S.checked.size} selected</b>
      <label class="sr" for="bAssign">Assign selected</label><select id="bAssign"><option value="__">Assign to…</option>${agentOpts(null, "Unassigned")}</select>
      <label class="sr" for="bStatus">Set status</label><select id="bStatus"><option value="">Set status…</option>${opt(STATUSES)}</select>
      <button data-act="bulk-clear">Clear</button></div>` : ""}
    <div class="tlist" role="listbox" aria-label="Tickets">
      ${list.length ? list.map(rowHTML).join("") : `<div class="empty">${S.tickets.length ? `<h3>Nothing here</h3><p>No tickets match this view${S.search ? " and search" : ""}.</p>` : `<h3>No tickets yet</h3><p>Tickets arrive from the portal and the support mailbox, or you can log one yourself.</p><button class="btn primary" data-act="new">Create a ticket</button>`}</div>`}
    </div></section>`;
}
function rowHTML(t) {
  const s = slaInfo(t);
  return `<div class="trow" role="option" tabindex="0" data-open="${t.id}" aria-selected="${S.selected === t.id}">
    <input type="checkbox" data-check="${t.id}" ${S.checked.has(t.id) ? "checked" : ""} aria-label="Select ticket #${t.number}">
    <div style="min-width:0">
      <div class="t-top"><span class="t-num">#${t.number} · ${esc(t.requesterName || t.requesterEmail)} · ${esc(t.channel)}</span><span>${ago(t.updatedAt)}</span></div>
      <div class="t-subj">${esc(t.subject)}</div>
      <div class="t-meta"><span class="pill ${sk(t.status)}">${esc(t.status)}</span><span><i class="p-dot p-${esc(t.priority)}"></i>${esc(t.priority)}</span><span>${t.assigneeName ? esc(t.assigneeName) : "Unassigned"}</span><span class="sla-txt ${s.cls}">${esc(s.txt)}</span></div>
      ${s.done || s.paused ? "" : `<div class="sla ${s.cls}" aria-hidden="true"><i style="width:${s.pct}%"></i></div>`}
    </div></div>`;
}
function renderDetail(t) {
  if (!t) return `<section class="detail"><div class="empty"><h3>Pick a ticket</h3><p>Select a ticket from the list to read the conversation and reply.</p></div></section>`;
  const d = S.details[t.id]; const s = slaInfo(t); const cm = S.cmode; const dis = S.sending ? "disabled" : "";
  const msgs = d ? d.messages : [];
  const thread = [{ id: "desc", type: "customer", author: t.requesterName || t.requesterEmail, body: t.description, at: t.createdAt }, ...msgs];
  return `<section class="detail" aria-label="Ticket #${t.number}">
    <div class="conv">
      <div class="d-head">
        <button class="back" data-act="back">‹ Back to tickets</button>
        <div class="d-crumb"><span>#${t.number}</span><span class="pill ${sk(t.status)}">${esc(t.status)}</span><span><i class="p-dot p-${esc(t.priority)}"></i>${esc(t.priority)}</span><span>via ${esc(t.channel)}</span></div>
        <h2>${esc(t.subject)}</h2>
        <div class="d-who"><b>${esc(t.requesterName)}</b>${t.requesterEmail ? " · " + esc(t.requesterEmail) : ""} · opened ${fmt(t.createdAt)}</div>
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="conversation" aria-selected="${S.dtab === "conversation"}">Conversation (${thread.length})</button>
          <button role="tab" data-tab="activity" aria-selected="${S.dtab === "activity"}">Activity</button>
        </div>
      </div>
      ${!d ? `<div class="thread"><p class="spinner">Loading conversation…</p></div>` : S.dtab === "conversation" ? `<div class="thread">${thread.map(m => `<article class="msg ${m.type === "reply" ? "agent" : m.type === "note" ? "note" : ""}">
          <div class="msg-h"><span><b>${esc(m.author)}</b> ${m.type === "note" ? "added a private note" : m.id === "desc" ? "opened the ticket" : "replied"}${m.source === "email" ? " by email" : m.source === "portal" ? " in the portal" : ""}</span><time>${fmt(m.at)}</time></div>
          <div class="msg-b">${esc(m.body)}</div></article>`).join("")}</div>
        <div class="composer ${cm === "note" ? "note" : ""}">
          <div class="c-modes" role="group" aria-label="Message type">
            <button data-cmode="reply" aria-pressed="${cm === "reply"}">Reply</button>
            <button data-cmode="note" aria-pressed="${cm === "note"}">Private note</button>
          </div>
          <label class="sr" for="cBody">Message</label>
          <textarea id="cBody" placeholder="${cm === "reply" ? (t.requesterEmail ? "Your reply is emailed to " + esc(t.requesterEmail) + "…" : "This requester has no email address, so the reply is only saved on the ticket…") : "Only your team will see this note…"}">${esc(S.drafts[t.id] || "")}</textarea>
          <div class="c-actions">
            ${cm === "reply" ? `<button class="btn" data-send="close" ${dis}>Send and close</button><button class="btn primary" data-send="reply" ${dis}>${S.sending ? "Sending…" : "Send reply"}</button>` : `<button class="btn primary" data-send="note" ${dis}>Add note</button>`}
          </div>
        </div>`
      : `<div class="thread"><ul class="log">${[...d.events].reverse().map(h => `<li><time>${fmt(h.at)}</time><span>${esc(h.text)} <span style="color:var(--muted)">· ${esc(h.by)}${h.public ? " · shown to requester" : ""}</span></span></li>`).join("")}</ul></div>`}
    </div>
    <aside class="props" aria-label="Ticket properties">
      ${t.requesterEmail ? `<div class="portal-flag">The requester is emailed when you reply or change the status.</div>` : ""}
      <div class="due-box ${s.cls}"><div class="big">${esc(s.txt)}</div><small>${t.status === "Closed" ? "Closed " + fmt(t.closedAt) : t.dueAt ? "Target " + fmt(t.dueAt) : ""}</small>
        ${t.firstResponseAt ? `<small>First response after ${dur(t.firstResponseAt - t.createdAt)}</small>` : t.status !== "Closed" ? "<small>Awaiting first response</small>" : ""}</div>
      <h3>Properties</h3>
      <div class="field"><label for="pStatus">Status</label><select id="pStatus" data-field="status">${opt(STATUSES, t.status)}</select></div>
      <div class="field"><label for="pPriority">Priority</label><select id="pPriority" data-field="priority">${opt(PRIORITIES, t.priority)}</select></div>
      <div class="field"><label for="pAssignee">Assignee</label><select id="pAssignee" data-field="assigneeEmail">${agentOpts(t.assigneeEmail, "Unassigned")}${t.assigneeEmail && !S.settings.agents.some(a => a.email === t.assigneeEmail) ? `<option value="${esc(t.assigneeEmail)}" selected>${esc(t.assigneeName)}</option>` : ""}</select></div>
      <div class="field"><label for="pDept">Department</label><select id="pDept" data-field="department">${opt(t.department && !S.settings.departments.includes(t.department) ? [...S.settings.departments, t.department] : S.settings.departments, t.department)}</select></div>
      <div class="field"><label for="pChannel">Channel</label><select id="pChannel" data-field="channel">${opt(ALL_CHANNELS, t.channel)}</select></div>
      <div class="field"><label for="pDue">Due by</label><input id="pDue" type="datetime-local" data-field="dueAt" value="${toLocalInput(t.dueAt)}"></div>
      <div class="field"><label for="pTags">Tags</label><input id="pTags" data-field="tags" value="${esc(t.tags.join(", "))}" placeholder="Comma separated"></div>
      <div class="contact-card"><h3>Requester</h3>
        <div><b>${esc(t.requesterName)}</b></div>
        ${t.requesterEmail ? `<div><a href="mailto:${esc(t.requesterEmail)}">${esc(t.requesterEmail)}</a></div>` : ""}
        ${t.requesterPhone ? `<div>${esc(t.requesterPhone)}</div>` : ""}
        <div style="margin-top:6px"><button class="btn" data-contact="${esc(contactKey(t))}">All tickets from this requester (${S.tickets.filter(x => contactKey(x) === contactKey(t)).length})</button></div>
      </div>
      <div style="margin-top:18px"><button class="btn danger" data-act="delete">Delete ticket</button></div>
    </aside></section>`;
}
function bars(map) {
  const e = Object.entries(map).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  if (!e.length) return `<p style="color:var(--muted);margin:0">No tickets yet.</p>`;
  const max = Math.max(...e.map(x => x[1]));
  return e.map(([k, v]) => `<div class="bar"><span title="${esc(k)}">${esc(k)}</span><span class="track"><i style="width:${(v / max) * 100}%"></i></span><b>${v}</b></div>`).join("");
}
function renderDash(counts) {
  const open = S.tickets.filter(t => t.status !== "Closed"); const now = Date.now();
  const closedWeek = S.tickets.filter(t => t.status === "Closed" && t.closedAt >= now - 7 * 864e5).length;
  const dueSoon = open.filter(t => t.status !== "On hold" && t.dueAt >= now && t.dueAt < now + 864e5).length;
  const resp = S.tickets.filter(t => t.firstResponseAt).map(t => t.firstResponseAt - t.createdAt);
  const avg = resp.length ? dur(resp.reduce((a, b) => a + b, 0) / resp.length) : "—";
  const bs = {}, ba = {}, bc = {}, bp = {};
  open.forEach(t => { bs[t.status] = (bs[t.status] || 0) + 1; ba[t.assigneeName || "Unassigned"] = (ba[t.assigneeName || "Unassigned"] || 0) + 1; bp[t.priority] = (bp[t.priority] || 0) + 1; });
  S.tickets.forEach(t => { bc[t.channel] = (bc[t.channel] || 0) + 1; });
  return `<main class="page"><h1>Dashboard</h1><p class="sub">How the queue looks right now.</p>
    <div class="kpis">
      <button class="kpi" data-view="open"><div class="v">${counts.open}</div><div class="l">Open tickets</div></button>
      <button class="kpi ${counts.overdue ? "late" : ""}" data-view="overdue"><div class="v">${counts.overdue}</div><div class="l">Overdue</div></button>
      <button class="kpi" data-view="open" data-sort="due"><div class="v">${dueSoon}</div><div class="l">Due in the next 24h</div></button>
      <button class="kpi" data-view="unassigned"><div class="v">${counts.unassigned}</div><div class="l">Unassigned</div></button>
      <button class="kpi" data-view="fromportal"><div class="v">${counts.fromportal}</div><div class="l">Open from portal</div></button>
      <button class="kpi" data-view="fromemail"><div class="v">${counts.fromemail}</div><div class="l">Open from email</div></button>
      <button class="kpi" data-view="closed"><div class="v">${closedWeek}</div><div class="l">Closed this week</div></button>
      <div class="kpi"><div class="v">${avg}</div><div class="l">Avg first response</div></div>
    </div>
    <div class="grid2">
      <section class="panel"><h2>Open tickets by status</h2>${bars(bs)}</section>
      <section class="panel"><h2>Open tickets by agent</h2>${bars(ba)}</section>
      <section class="panel"><h2>Open tickets by priority</h2>${bars(bp)}</section>
      <section class="panel"><h2>All tickets by channel</h2>${bars(bc)}</section>
    </div></main>`;
}
function renderContacts() {
  const m = new Map();
  S.tickets.forEach(t => { const k = contactKey(t); if (!k) return; const c = m.get(k) || { k, name: t.requesterName, email: t.requesterEmail, phone: t.requesterPhone, total: 0, open: 0, last: 0 }; c.total++; if (t.status !== "Closed") c.open++; if (t.createdAt > c.last) { c.last = t.createdAt; c.name = t.requesterName || c.name; c.phone = t.requesterPhone || c.phone; } m.set(k, c); });
  const q = S.search.trim().toLowerCase();
  const list = [...m.values()].filter(c => !q || (c.name + " " + c.email).toLowerCase().includes(q)).sort((a, b) => b.last - a.last);
  return `<main class="page"><h1>Requesters</h1><p class="sub">Everyone who has raised a ticket. Select someone to see their tickets.</p>
    <div class="search" style="max-width:420px;margin-bottom:16px"><label class="sr" for="q">Search requesters</label><input id="q" type="search" placeholder="Search requesters…" value="${esc(S.search)}"></div>
    ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Open</th><th>Total</th><th>Last ticket</th></tr></thead><tbody>
    ${list.map(c => `<tr data-contact="${esc(c.k)}" tabindex="0"><td><b>${esc(c.name)}</b></td><td>${esc(c.email || "—")}</td><td>${esc(c.phone || "—")}</td><td>${c.open}</td><td>${c.total}</td><td>${ago(c.last)}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty"><h3>No requesters yet</h3><p>People appear here once they have a ticket.</p></div>`}</main>`;
}

/* ---------- portal ---------- */
function renderPortal(preview) {
  const items = S.my; const total = items.reduce((n, t) => n + unreadFor(t.id), 0);
  const bell = `<button class="bell" data-act="bell" aria-expanded="${S.bellOpen}">Updates${total ? `<span class="badge">${total}</span>` : ""}</button>`;
  let panel = "";
  if (S.bellOpen) {
    const byId = Object.fromEntries(items.map(t => [t.id, t]));
    const evs = S.myEvents.filter(e => byId[e.ticketId]).slice(0, 30);
    panel = `<section class="bellpanel" aria-label="Updates"><div class="bellpanel-h"><span>Updates on your requests</span>${total ? `<button data-act="seen-all">Mark all as read</button>` : ""}</div>
      ${evs.length ? evs.map(e => `<button class="notif ${e.at > (S.seen[e.ticketId] || 0) ? "unread" : ""}" data-popen="${e.ticketId}">${esc(e.text)}<small>${esc(byId[e.ticketId].subject)} · ${ago(e.at)}</small></button>`).join("") : `<p style="padding:12px 14px;margin:0;color:var(--muted)">No updates yet.</p>`}</section>`;
  }
  let body;
  if (S.ptab === "mine") body = S.psel ? portalDetail(S.psel) : portalList(items);
  else body = S.pconfirm ? portalConfirm(items.find(t => t.id === S.pconfirm) || (S.myDetails[S.pconfirm] && S.myDetails[S.pconfirm].ticket)) : portalForm();
  return `${preview ? `<div class="preview-note">This is the page staff see when they sign in without the Service Desk Agent role. Requests you raise here are real tickets.</div>` : ""}
    <div class="p-head"><div><h1>How can we help?</h1><p class="sub">Raise a request and track it here. We’ll email ${esc(S.user.email)} whenever an agent replies or the status changes. You can also email ${esc(S.cfg.supportEmail)} directly.</p></div>${bell}</div>
    ${panel}
    <div class="p-tabs" role="tablist"><button role="tab" data-ptab="new" aria-selected="${S.ptab === "new"}">New request</button><button role="tab" data-ptab="mine" aria-selected="${S.ptab === "mine"}">My requests (${items.length})</button></div>
    ${body}`;
}
function pv(k) { return esc(S.pform[k] || ""); }
function portalForm() {
  const pr = S.pform.priority || "Medium", dep = S.pform.department || S.settings.departments[0];
  return `<form class="card" id="portalForm" novalidate>
    ${S.perr ? `<p class="err">${esc(S.perr)}</p>` : ""}
    <div class="cols">
      <div class="field"><label for="pf-name">Your name</label><input id="pf-name" data-pf="name" value="${esc(S.pform.name ?? S.user.name)}" maxlength="120"></div>
      <div class="field"><label for="pf-phone">Phone</label><input id="pf-phone" data-pf="phone" type="tel" value="${pv("phone")}" maxlength="40"></div>
      <div class="field"><label for="pf-dept">Which team should handle it?</label><select id="pf-dept" data-pf="department">${opt(S.settings.departments, dep)}</select></div>
      <div class="field"><label for="pf-pri">How urgent is it?</label><select id="pf-pri" data-pf="priority">${[["Low", "Low — whenever you can"], ["Medium", "Medium — affects my work"], ["High", "High — blocking my work"], ["Urgent", "Urgent — affects many people"]].map(o => `<option value="${o[0]}"${pr === o[0] ? " selected" : ""}>${o[1]}</option>`).join("")}</select></div>
      <div class="field full"><label for="pf-subject">Subject <span class="req">*</span></label><input id="pf-subject" data-pf="subject" value="${pv("subject")}" maxlength="200" placeholder="e.g. Can’t connect to the office VPN"></div>
      <div class="field full"><label for="pf-desc">Describe the issue <span class="req">*</span></label><textarea id="pf-desc" data-pf="description" rows="6" placeholder="What happened, when it started and anything you’ve already tried">${pv("description")}</textarea></div>
    </div>
    <div class="c-actions"><button type="submit" class="btn primary" ${S.psending ? "disabled" : ""}>${S.psending ? "Sending…" : "Send request"}</button></div></form>`;
}
function portalConfirm(t) {
  if (!t) return portalForm();
  return `<section class="card confirm" aria-live="polite"><h2>Request received</h2>
    <p style="margin:0">Your ticket has been created:</p><div class="ref">Ticket #${t.number}</div>
    <p style="margin:0 0 14px;color:var(--muted)">We’ve emailed a confirmation to ${esc(S.user.email)}. You’ll get an email every time an agent replies or the status changes.</p>
    <div class="c-actions" style="justify-content:flex-start"><button class="btn primary" data-popen="${t.id}">Track this request</button><button class="btn" data-act="pnew">Raise another request</button></div></section>`;
}
function portalList(items) {
  if (!items.length) return `<div class="empty"><h3>No requests yet</h3><p>When you raise a request, by email or here, you can follow its progress on this page.</p><button class="btn primary" data-ptab="new">Raise a request</button></div>`;
  return `<div class="req-list">${items.map(t => { const u = unreadFor(t.id); return `<button class="req" data-popen="${t.id}">
    <span class="r-sub">${u ? `<i class="dot" aria-label="${u} new updates"></i>` : ""}${esc(t.subject)}</span><span class="pill ${sk(t.status)}">${esc(t.status)}</span>
    <span class="r-meta">Ticket #${t.number} · ${esc(t.department)} · raised ${ago(t.createdAt)} · updated ${ago(t.updatedAt)}</span></button>`; }).join("")}</div>`;
}
function portalDetail(id) {
  const d = S.myDetails[id]; const t = (d && d.ticket) || S.my.find(x => x.id === id);
  if (!t) return `<p class="spinner">Loading…</p>`;
  const st = t.status; const idx = st === "Open" ? 1 : st === "Closed" ? 3 : 2;
  const steps = ["Received", "Open", idx === 2 ? st : "In progress", "Resolved"];
  const msgs = [{ id: "d", type: "customer", author: "You", body: t.description, at: t.createdAt }, ...((d && d.messages) || [])];
  return `<article class="p-detail">
    <button class="btn" data-act="pback">‹ All my requests</button>
    <div class="d-crumb" style="margin-top:16px"><span>Ticket #${t.number}</span><span class="pill ${sk(st)}">${esc(st)}</span><span>${esc(t.department)}</span></div>
    <h2>${esc(t.subject)}</h2><div class="d-who">Raised ${fmt(t.createdAt)} via ${esc(t.channel)}</div>
    <div class="tracker" aria-label="Progress">${steps.map((s, i) => `<div class="step ${i <= idx ? "done" : ""} ${i === idx ? "cur" : ""}">${esc(s)}</div>`).join("")}</div>
    <section class="p-section"><h3>Conversation</h3><div class="p-thread">
      ${!d ? `<p class="spinner">Loading conversation…</p>` : msgs.map(m => { const mine = m.type === "customer"; return `<article class="msg ${mine ? "" : "agent"}" style="${mine ? "" : "align-self:stretch"}"><div class="msg-h"><b>${esc(mine ? (m.author === "You" ? "You" : m.author) : m.author + " (Support)")}</b><time>${fmt(m.at)}</time></div><div class="msg-b">${esc(m.body)}</div></article>`; }).join("")}
    </div>
    <div class="composer" style="border:1px solid var(--line);border-radius:10px;margin-top:14px">
      <label for="pr-${id}" style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px">${st === "Closed" ? "Still having the problem? Reply and we’ll reopen your ticket." : "Add more information for the support team"}</label>
      <textarea id="pr-${id}" data-preply="${id}">${esc(S.preply[id] || "")}</textarea>
      <div class="c-actions"><button class="btn primary" data-act="preply" data-id="${id}">Send reply</button></div>
    </div></section>
    <section class="p-section"><h3>Updates</h3><ul class="timeline">${d ? [...d.events].reverse().map(e => `<li><time>${fmt(e.at)}</time>${esc(e.text)}</li>`).join("") : ""}</ul></section>
  </article>`;
}

/* ---------- events ---------- */
root.addEventListener("click", async e => {
  const el = e.target.closest("[data-act],[data-view],[data-page],[data-open],[data-tab],[data-cmode],[data-send],[data-contact],[data-check],[data-ptab],[data-popen]");
  if (!el) return;
  if (el.dataset.check != null) { e.stopPropagation(); const id = Number(el.dataset.check); el.checked ? S.checked.add(id) : S.checked.delete(id); render(); return; }
  if (el.dataset.ptab) { S.ptab = el.dataset.ptab; S.psel = null; S.pconfirm = null; render(); return; }
  if (el.dataset.popen) { const id = Number(el.dataset.popen); S.ptab = "mine"; S.psel = id; S.pconfirm = null; S.bellOpen = false; markSeen([id]); render(); window.scrollTo(0, 0); loadMyDetail(id); return; }
  if (el.dataset.view) { S.page = "tickets"; S.view = el.dataset.view; if (el.dataset.sort) S.sort = el.dataset.sort; S.contact = null; S.checked.clear(); S.selected = null; S.search = ""; render(); return; }
  if (el.dataset.page) { S.page = el.dataset.page; S.search = ""; S.selected = null; render(); if (S.page === "portal") loadMine().then(render).catch(() => { }); return; }
  if (el.dataset.open) { S.selected = Number(el.dataset.open); S.dtab = "conversation"; S._scrollThread = true; render(); loadDetail(S.selected).then(() => { S._scrollThread = true; render(); }); return; }
  if (el.dataset.tab) { S.dtab = el.dataset.tab; S._scrollThread = true; render(); return; }
  if (el.dataset.cmode) { S.cmode = el.dataset.cmode; render(); document.getElementById("cBody")?.focus(); return; }
  if (el.dataset.contact != null) { S.page = "tickets"; S.view = "all"; S.contact = el.dataset.contact; S.search = ""; S.selected = null; render(); return; }
  if (el.dataset.send) { await sendMessage(el.dataset.send === "close" ? "reply" : el.dataset.send, el.dataset.send === "close"); return; }
  const a = el.dataset.act;
  if (a === "new") openNew();
  else if (a === "settings") openSettings();
  else if (a === "signout") signOut();
  else if (a === "back") { S.selected = null; render(); }
  else if (a === "clear-contact") { S.contact = null; render(); }
  else if (a === "bulk-clear") { S.checked.clear(); render(); }
  else if (a === "bell") { S.bellOpen = !S.bellOpen; render(); }
  else if (a === "seen-all") { markSeen(S.my.map(t => t.id)); render(); }
  else if (a === "pnew") { S.pconfirm = null; render(); document.getElementById("pf-subject")?.focus(); }
  else if (a === "pback") { S.psel = null; render(); }
  else if (a === "preply") { el.disabled = true; await requesterReply(Number(el.dataset.id)); }
  else if (a === "delete") {
    const t = S.tickets.find(x => x.id === S.selected);
    if (t && confirm(`Delete ticket #${t.number}? This removes it and its conversation from SharePoint and can’t be undone.`)) {
      try { await api("DELETE", "/tickets/" + t.id); S.tickets = S.tickets.filter(x => x.id !== t.id); S.selected = null; toast(`Ticket #${t.number} deleted`); render(); } catch (e) { }
    }
  }
});
root.addEventListener("submit", e => { if (e.target.id === "portalForm") { e.preventDefault(); if (!S.psending) submitRequest(); } });
root.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-open],tr[data-contact]")) { e.preventDefault(); e.target.click(); }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.id === "cBody") sendMessage(S.cmode, false);
});
root.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "q") { S.search = t.value; render(); }
  if (t.id === "cBody" && S.selected) S.drafts[S.selected] = t.value;
  if (t.dataset.pf) S.pform[t.dataset.pf] = t.value;
  if (t.dataset.preply) S.preply[t.dataset.preply] = t.value;
});
root.addEventListener("change", async e => {
  const el = e.target;
  if (el.dataset.pf) { S.pform[el.dataset.pf] = el.value; return; }
  if (el.id === "sortSel") { S.sort = el.value; render(); return; }
  if (el.id === "bAssign" && el.value !== "__") { const v = el.value, ids = [...S.checked]; for (const id of ids) await setField(id, "assigneeEmail", v); toast(`${ids.length} tickets updated`); S.checked.clear(); render(); return; }
  if (el.id === "bStatus" && el.value) { const v = el.value, ids = [...S.checked]; for (const id of ids) await setField(id, "status", v); toast(`${ids.length} tickets set to ${v}`); S.checked.clear(); render(); return; }
  if (el.dataset.field && S.selected) {
    let v = el.value; const f = el.dataset.field;
    if (f === "dueAt") { v = new Date(v).getTime(); if (!v) return; }
    if (f === "tags") v = v.split(",").map(s => s.trim()).filter(Boolean);
    const ok = await setField(S.selected, f, v);
    if (ok && f === "status") toast(S.tickets.find(t => t.id === S.selected)?.requesterEmail ? `Status set to ${v}. The requester has been emailed.` : `Status set to ${v}`);
  }
});

/* ---------- dialogs ---------- */
document.querySelectorAll("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));
const dlgNew = document.getElementById("dlgNew");
function openNew() {
  document.getElementById("newForm").reset();
  document.getElementById("newErr").hidden = true;
  document.getElementById("nChannel").innerHTML = opt(DESK_CHANNELS, "Phone");
  document.getElementById("nPriority").innerHTML = opt(PRIORITIES, "Medium");
  document.getElementById("nDept").innerHTML = opt(S.settings.departments, S.settings.departments[0]);
  document.getElementById("nAssignee").innerHTML = agentOpts(S.view === "mine" ? S.user.email : "", "Unassigned");
  dlgNew.showModal(); document.getElementById("nSubject").focus();
}
document.getElementById("newForm").addEventListener("submit", async e => {
  e.preventDefault();
  const g = id => document.getElementById(id).value.trim();
  const f = { mode: "agent", subject: g("nSubject"), name: g("nName"), email: g("nEmail"), phone: g("nPhone"), channel: g("nChannel"), priority: g("nPriority"), department: g("nDept"), assigneeEmail: g("nAssignee"), tags: g("nTags").split(",").map(s => s.trim()).filter(Boolean), description: g("nDesc") };
  const err = document.getElementById("newErr");
  const missing = [!f.subject && "a subject", !f.name && "the requester’s name", !f.description && "a description"].filter(Boolean);
  if (missing.length) { err.textContent = "Add " + missing.join(", ") + " to create the ticket."; err.hidden = false; return; }
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { err.textContent = "Check the email address — it looks incomplete."; err.hidden = false; return; }
  const btn = document.getElementById("nSubmit"); btn.disabled = true; btn.textContent = "Creating…";
  try {
    const d = await api("POST", "/tickets", f);
    S.details[d.ticket.id] = d; mergeTicket(d.ticket); dlgNew.close();
    S.page = "tickets"; if (!["open", "mine", "unassigned", "all"].includes(S.view)) S.view = "open"; S.contact = null; S.selected = d.ticket.id; S.dtab = "conversation";
    render(); toast(`Ticket #${d.ticket.number} created${f.email ? " and the requester has been emailed" : ""}`);
  } catch (e2) { }
  btn.disabled = false; btn.textContent = "Create ticket";
});
const dlgSet = document.getElementById("dlgSettings");
function openSettings() { renderSettings(); dlgSet.showModal(); }
function renderSettings() {
  const chip = (label, kind, i) => `<span>${esc(label)}<button data-rm="${kind}" data-i="${i}" aria-label="Remove ${esc(label)}">×</button></span>`;
  document.getElementById("agentChips").innerHTML = S.settings.agents.length ? S.settings.agents.map((a, i) => chip(`${a.name} · ${a.email}`, "agents", i)).join("") : `<span style="padding:2px 10px;color:var(--muted)">None yet</span>`;
  document.getElementById("deptChips").innerHTML = S.settings.departments.map((d, i) => chip(d, "departments", i)).join("");
  document.getElementById("slaFields").innerHTML = PRIORITIES.map(p => `<div class="field"><label for="sla-${p}">${p}</label><input id="sla-${p}" type="number" min="1" max="720" value="${S.settings.sla[p]}" data-sla="${p}"></div>`).join("");
  document.getElementById("mailInfo").textContent = `Notifications are sent from ${S.cfg.supportEmail}, and new emails to it become tickets every 5 minutes.`;
}
async function saveSettings(next) {
  try { S.settings = { ...S.settings, ...(await api("PUT", "/settings", next)) }; renderSettings(); render(); toast("Settings saved"); } catch (e) { }
}
document.getElementById("agentAdd").onclick = () => {
  const n = document.getElementById("agentName"), m = document.getElementById("agentEmail");
  const name = n.value.trim(), email = m.value.trim().toLowerCase();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Add the agent’s name and a valid work email."); return; }
  if (S.settings.agents.some(a => a.email === email)) { toast("That agent is already on the list."); return; }
  n.value = ""; m.value = "";
  saveSettings({ ...S.settings, agents: [...S.settings.agents, { name, email }] });
};
document.getElementById("deptAdd").onclick = () => {
  const i = document.getElementById("deptIn"); const v = i.value.trim(); if (!v) return;
  if (S.settings.departments.some(d => d.toLowerCase() === v.toLowerCase())) { toast("That department already exists."); return; }
  i.value = ""; saveSettings({ ...S.settings, departments: [...S.settings.departments, v] });
};
document.getElementById("deptIn").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); document.getElementById("deptAdd").click(); } };
dlgSet.addEventListener("click", e => {
  const b = e.target.closest("[data-rm]"); if (!b) return;
  const k = b.dataset.rm; const arr = [...S.settings[k]]; arr.splice(Number(b.dataset.i), 1);
  saveSettings({ ...S.settings, [k]: arr });
});
dlgSet.addEventListener("change", e => {
  const p = e.target.dataset.sla; if (!p) return;
  const n = Math.max(1, Math.min(720, Number(e.target.value) || 0)); if (!n) return;
  saveSettings({ ...S.settings, sla: { ...S.settings.sla, [p]: n } });
});
document.getElementById("mailCheck").onclick = async e => {
  const b = e.target; b.disabled = true; b.textContent = "Checking…";
  try { const r = await api("POST", "/mail/check"); toast(`Mailbox checked: ${r.created} new tickets, ${r.replies} replies added.`); await loadAgent(); render(); } catch (e2) { }
  b.disabled = false; b.textContent = "Check mailbox now";
};

/* ---------- start ---------- */
function fatal(msg) { root.innerHTML = `<div class="signin"><div class="card"><div class="brand-mark" aria-hidden="true">✦</div><h1>Service Desk</h1><p>${esc(msg)}</p></div></div>`; }
function renderSignIn() {
  root.innerHTML = `<div class="signin"><div class="card"><div class="brand-mark" aria-hidden="true">✦</div>
    <h1>${esc(S.cfg.orgName)} Service Desk</h1><p>Sign in with your work Microsoft account to raise a request or work on tickets.</p>
    <button class="btn primary" id="signInBtn">Sign in with Microsoft</button></div></div>`;
  document.getElementById("signInBtn").onclick = () => pca.loginRedirect({ scopes: SCOPES });
}
async function boot() {
  try { S.cfg = await (await fetch("/api/config")).json(); } catch (e) { fatal("Couldn’t reach the server. Try again in a moment."); return; }
  if (!S.cfg || !S.cfg.clientId) { fatal((S.cfg && S.cfg.error) || "The server isn’t configured yet. Check the Netlify environment variables."); return; }
  if (!window.msal) { fatal("The sign-in library didn’t load. Check that the build step ran."); return; }
  pca = new window.msal.PublicClientApplication({
    auth: { clientId: S.cfg.clientId, authority: `https://login.microsoftonline.com/${S.cfg.tenantId}`, redirectUri: location.origin + "/" },
    cache: { cacheLocation: "localStorage" },
  });
  await pca.initialize();
  const res = await pca.handleRedirectPromise().catch(e => { console.error(e); return null; });
  account = (res && res.account) || pca.getAllAccounts()[0];
  if (!account) { renderSignIn(); return; }
  pca.setActiveAccount(account);
  try { S.user = await api("GET", "/me"); } catch (e) { fatal("We couldn’t confirm your sign-in. Reload the page to try again."); return; }
  const h = (location.hash || "").slice(1);
  if (["dashboard", "contacts", "portal"].includes(h)) S.page = h;
  if (VIEWS.some(v => v[0] === h)) { S.page = "tickets"; S.view = h; }
  if (!S.user.isAgent && h === "portal") S.ptab = "mine";
  render();
  try {
    if (S.user.isAgent) { await loadAgent(); if (S.page === "portal") await loadMine(); }
    else { const s = await api("GET", "/settings"); S.settings = { ...S.settings, ...s }; await loadMine(); }
  } catch (e) { }
  render();
  setInterval(async () => {
    if (document.hidden) return;
    try {
      if (S.user.isAgent) { await loadAgent(); if (S.selected) S.details[S.selected] = await api("GET", "/tickets/" + S.selected); }
      if (!S.user.isAgent || S.page === "portal") { await loadMine(); if (S.psel) S.myDetails[S.psel] = await api("GET", "/tickets/" + S.psel); }
      const a = document.activeElement;
      if (!(a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.tagName === "SELECT")) && !dlgNew.open && !dlgSet.open) render();
    } catch (e) { }
  }, 30000);
}
boot();
})();
