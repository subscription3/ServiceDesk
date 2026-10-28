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
  prate: {}, prComment: {}, prEdit: {}, recentFb: null, fbLoading: false, af: null, auditRows: null, auditLoading: false, backups: null, backupsLoading: false,
  rp: null, allFb: null, allFbLoading: false, fbDraft: null, loadError: "",
  stab: "users", uq: "", dir: [], dirAvailable: null, unew: { name: "", email: "", role: "Agent" }, slaDraft: null, uploading: false, mailChecking: false,
  logoOk: false, navOpen: false, searchOpen: false, userMenu: false,
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
function agentOpts(sel, blank) { return (blank != null ? `<option value="">${esc(blank)}</option>` : "") + (S.settings.users || []).map(a => `<option value="${esc(a.email)}"${a.email === sel ? " selected" : ""}>${esc(a.name)}</option>`).join(""); }
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
  return { cls: pct < ((S.settings.sla && S.settings.sla.warnAt) || 25) ? "warn" : "", txt: "Due in " + dur(left), pct };
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
  S.tickets = tickets; S.loaded = true; S.loadError = "";
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

/* ---------- icons (simple line icons) ---------- */
const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/>',
  unassigned: '<circle cx="12" cy="8" r="4" stroke-dasharray="3 2.5"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.9 3.5L20 15M20 20v-5h-5"/>',
};
function ico(n, cls) { return `<svg class="ico${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ""}</svg>`; }
function initials(name) { const p = String(name || "?").trim().split(/[\s@.]+/).filter(Boolean); return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase(); }
function logoSrc() { return (S.settings && S.settings.logoUrl) || (S.cfg && S.cfg.logoUrl) || (S.logoOk ? "/brand/logo.png" : ""); }
function logoHTML(product) {
  const org = (S.cfg && S.cfg.orgName) || "InfraCredit";
  const src = logoSrc();
  const mark = src ? `<img src="${esc(src)}" alt="${esc(org)}">` : `<span class="wordmark">${esc(org)}</span>`;
  return mark + (product === false ? "" : `<span class="product">Service Desk</span>`);
}
function stars(n) { n = Math.round(Number(n) || 0); return `<span class="stars" aria-label="${n} out of 5">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`; }
const RATING_LABELS = { 1: "Very dissatisfied", 2: "Dissatisfied", 3: "Neutral", 4: "Satisfied", 5: "Very satisfied" };
function badge(status) { return `<span class="badge ${sk(status)}">${esc(status)}</span>`; }
function prio(p) { return `<span class="prio p-${esc(p)}"><i></i>${esc(p)}</span>`; }
function slaCell(t) {
  const s = slaInfo(t);
  const cls = s.done || s.paused ? "idle" : s.cls;
  return `<div class="sla ${cls}"><div class="sla-txt">${esc(s.txt)}</div>${s.done || s.paused ? "" : `<div class="sla-bar" aria-hidden="true"><i style="width:${Math.max(4, s.pct)}%"></i></div>`}</div>`;
}

/* ---------- views ---------- */
const VIEWS = [
  ["open", "Open tickets", "inbox", t => t.status !== "Closed"],
  ["mine", "Assigned to me", "user", t => t.assigneeEmail === S.user.email && t.status !== "Closed"],
  ["unassigned", "Unassigned", "unassigned", t => !t.assigneeEmail && t.status !== "Closed"],
  ["overdue", "Overdue", "clock", isOverdue],
  ["escalated", "Escalated", "up", t => t.status === "Escalated"],
  ["onhold", "On hold", "pause", t => t.status === "On hold"],
  ["fromportal", "From portal", "globe", t => t.channel === "Self-service portal" && t.status !== "Closed"],
  ["fromemail", "From email", "mail", t => t.channel === "Email" && t.status !== "Closed"],
  ["closed", "Closed", "check", t => t.status === "Closed"],
  ["all", "All tickets", "list", () => true],
];
const PR = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
function visible() {
  const v = VIEWS.find(v => v[0] === S.view) || VIEWS[0];
  const q0 = S.search.trim();
  let list = q0 ? S.tickets.slice() : S.tickets.filter(v[3]);
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
  root.innerHTML = S.user.isAgent ? renderDesk() : renderPortalPage();
  if (keepId) { const el = document.getElementById(keepId); if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch (e) { } } }
  if (S._scrollThread) { const th = document.querySelector(".thread"); if (th) th.lastElementChild?.scrollIntoView({ block: "nearest" }); S._scrollThread = false; }
}
function userMenu() {
  return `<div class="usermenu">
    <button class="userbtn" data-act="usermenu" aria-expanded="${S.userMenu}" aria-haspopup="true"><span class="avatar">${esc(initials(S.user.name))}</span><span class="who"><b>${esc(S.user.name)}</b><span>${S.user.isAdmin ? "Service desk admin" : S.user.isAgent ? "Service desk agent" : "Staff"}</span></span></button>
    ${S.userMenu ? `<div class="dropdown" role="menu"><div class="dd-head"><b>${esc(S.user.name)}</b>${esc(S.user.email)}</div>
      ${S.user.isAdmin ? `<button role="menuitem" data-act="settings">${ico("gear")}Settings</button>` : ""}
      <button role="menuitem" data-act="signout">${ico("logout")}Sign out</button></div>` : ""}
  </div>`;
}
function renderDesk() {
  const counts = Object.fromEntries(VIEWS.map(v => [v[0], S.tickets.filter(v[3]).length]));
  const navItem = (attr, val, label, icon, count, hot) => `<button class="nav" ${attr}="${val}" aria-current="${(attr === "data-view" ? S.page === "tickets" && S.view === val : S.page === val)}">${ico(icon)}<span class="label">${label}</span>${count != null ? `<span class="count ${hot ? "hot" : ""}">${count}</span>` : ""}</button>`;
  let content;
  if (!S.loaded) content = S.loadError ? `<div class="page"><div class="card empty" role="alert"><h3>The tickets couldn’t be loaded</h3><p>${esc(S.loadError)}</p><button class="btn primary" data-act="retryload">${ico("refresh")}Try again</button><p class="c-muted" style="font-size:13px;margin-top:16px">If this keeps happening, open <a href="/api/health" target="_blank" rel="noopener">/api/health</a> to see which connection is failing.</p></div></div>` : `<div class="spinner">Loading tickets…</div>`;
  else if (S.page === "tickets") { const t = S.selected && S.tickets.find(x => x.id === S.selected); content = t ? renderDetail(t) : renderList(counts); }
  else if (S.page === "dashboard") content = renderDash(counts);
  else if (S.page === "portal") content = `<div class="page in-desk">${renderPortalBody(true)}</div>`;
  else if (S.page === "settings") content = renderSettingsPage();
  else if (S.page === "reports") content = renderReports();
  else content = renderContacts();
  return `<div class="shell">
    <header class="topbar">
      <button class="menu-btn" data-act="menu" aria-label="Open navigation" aria-expanded="${S.navOpen}">${ico("menu")}</button>
      <button class="logo" data-page="dashboard" aria-label="Service desk home">${logoHTML()}</button>
      <div class="gsearch ${S.searchOpen ? "open" : ""}" role="search">${ico("search")}<label class="sr" for="q">Search tickets</label><input id="q" type="search" placeholder="Search tickets by number, subject or requester" value="${esc(S.search)}" autocomplete="off"></div>
      <div class="top-actions">
        <button class="search-toggle" data-act="searchtoggle" aria-label="Search">${ico("search")}</button>
        <button class="btn primary" data-act="new">${ico("plus")}<span class="txt">New ticket</span></button>
        ${userMenu()}
      </div>
    </header>
    <nav class="sidenav ${S.navOpen ? "open" : ""}" aria-label="Main">
      <h2>Overview</h2>
      ${navItem("data-page", "dashboard", "Dashboard", "dash")}
      ${navItem("data-page", "reports", "Reports", "chart")}
      <h2>Tickets</h2>
      ${VIEWS.map(v => navItem("data-view", v[0], v[1], v[2], counts[v[0]], v[0] === "overdue" && counts.overdue > 0)).join("")}
      <h2>Directory</h2>
      ${navItem("data-page", "contacts", "Requesters", "users")}
      ${navItem("data-page", "portal", "Request portal", "globe")}
      ${S.user.isAdmin ? `<h2>Administration</h2>${navItem("data-page", "settings", "Settings", "gear")}` : ""}
      <div class="side-foot">Requests arrive from the portal and ${esc(S.cfg.supportEmail)}.</div>
    </nav>
    <main class="main" id="main">${content}</main>
  </div>`;
}

function renderList() {
  const list = visible(); const v = VIEWS.find(v => v[0] === S.view) || VIEWS[0];
  const cName = S.contact && (S.tickets.find(t => contactKey(t) === S.contact) || {}).requesterName;
  const allChecked = list.length && list.every(t => S.checked.has(t.id));
  return `<div class="page">
    <div class="page-head">
      <div><h1>${S.search.trim() ? "Search results" : esc(v[1])}</h1><p>${list.length} ${list.length === 1 ? "ticket" : "tickets"}${S.search.trim() ? ` matching “${esc(S.search.trim())}” across all tickets` : ""}</p></div>
      <div class="toolbar">
        ${S.contact ? `<button class="filterchip" data-act="clear-contact" aria-label="Remove requester filter">${esc(cName || S.contact)} ×</button>` : ""}
        <label class="sr" for="sortSel">Sort by</label>
        <select id="sortSel">${[["newest", "Newest first"], ["oldest", "Oldest first"], ["due", "Due soonest"], ["priority", "Priority"], ["updated", "Recently updated"]].map(o => `<option value="${o[0]}"${S.sort === o[0] ? " selected" : ""}>${o[1]}</option>`).join("")}</select>
      </div>
    </div>
    ${S.checked.size ? `<div class="bulkbar"><b>${S.checked.size} selected</b>
      <label class="sr" for="bAssign">Assign selected</label><select id="bAssign"><option value="__">Assign to…</option>${agentOpts(null, "Unassigned")}</select>
      <label class="sr" for="bStatus">Set status</label><select id="bStatus"><option value="">Change status…</option>${opt(STATUSES)}</select>
      <button class="btn sm ghost" data-act="bulk-clear">Clear selection</button></div>` : ""}
    <div class="card table-card">
      ${list.length ? `<table class="tickets">
        <thead><tr>
          <th style="width:36px"><input type="checkbox" data-checkall aria-label="Select all" ${allChecked ? "checked" : ""}></th>
          <th>Ticket</th><th>Subject</th><th class="hide-md">Requester</th><th>Status</th><th class="hide-sm">Priority</th><th class="hide-lg">Assignee</th><th class="hide-sm">Resolution due</th><th class="hide-lg">Updated</th>
        </tr></thead>
        <tbody>${list.map(rowHTML).join("")}</tbody></table>`
      : `<div class="empty">${S.tickets.length ? `<h3>No tickets here</h3><p>Nothing matches this view${S.search ? " and search" : ""}. Try another view or clear the search.</p>` : `<h3>No tickets yet</h3><p>Tickets arrive from the request portal and ${esc(S.cfg.supportEmail)}. You can also log one yourself.</p><button class="btn primary" data-act="new">${ico("plus")}New ticket</button>`}</div>`}
    </div></div>`;
}
function rowHTML(t) {
  return `<tr data-open="${t.id}" tabindex="0">
    <td><input type="checkbox" data-check="${t.id}" ${S.checked.has(t.id) ? "checked" : ""} aria-label="Select ticket ${t.number}"></td>
    <td class="c-num">#${t.number}</td>
    <td class="c-subj"><b>${esc(t.subject)}</b><span>${esc(t.department)}, via ${esc(t.channel)}</span></td>
    <td class="hide-md"><div class="c-who"><span class="avatar req-av">${esc(initials(t.requesterName || t.requesterEmail))}</span><span>${esc(t.requesterName || t.requesterEmail)}</span></div></td>
    <td>${badge(t.status)}</td>
    <td class="hide-sm">${prio(t.priority)}</td>
    <td class="hide-lg">${t.assigneeName ? `<div class="c-who"><span class="avatar">${esc(initials(t.assigneeName))}</span><span>${esc(t.assigneeName)}</span></div>` : `<span class="unassigned">Unassigned</span>`}</td>
    <td class="hide-sm">${slaCell(t)}</td>
    <td class="hide-lg c-muted">${ago(t.updatedAt)}</td>
  </tr>`;
}

function renderDetail(t) {
  const d = S.details[t.id]; const s = slaInfo(t); const cm = S.cmode; const dis = S.sending ? "disabled" : "";
  const thread = [{ id: "desc", type: "customer", author: t.requesterName || t.requesterEmail, body: t.description, at: t.createdAt, source: "" }, ...((d && d.messages) || [])];
  const me = (S.settings.users || []).find(a => a.email === S.user.email);
  const msgHTML = m => {
    const kind = m.type === "reply" ? "agent" : m.type === "note" ? "note" : "customer";
    const verb = m.id === "desc" ? "raised this ticket" : m.type === "note" ? "added an internal note" : "replied";
    const via = m.source === "email" ? "by email" : m.source === "portal" ? "in the portal" : "";
    return `<article class="msg ${kind}"><span class="avatar lg ${kind === "customer" ? "req-av" : kind === "note" ? "note-av" : ""}">${esc(initials(m.author))}</span>
      <div class="msg-card"><div class="msg-h"><span><b>${esc(m.author)}</b> ${verb} ${via}${m.type === "note" ? `<span class="tag">Internal</span>` : ""}</span><time datetime="${new Date(m.at).toISOString()}">${fmt(m.at)}</time></div>
      <div class="msg-b">${esc(m.body)}</div></div></article>`;
  };
  return `<div class="page">
    <nav class="crumbs" aria-label="Breadcrumb"><button data-act="back">${esc((VIEWS.find(v => v[0] === S.view) || VIEWS[0])[1])}</button><span aria-hidden="true">/</span><span>#${t.number}</span></nav>
    <div class="detail-head">
      <div>
        <div class="dh-meta"><b>#${t.number}</b><span>Opened ${fmt(t.createdAt)}</span><span>via ${esc(t.channel)}</span></div>
        <h1>${esc(t.subject)}</h1>
        <div class="dh-badges">${badge(t.status)}${prio(t.priority)}${slaCell(t)}</div>
      </div>
      <div class="dh-actions">
        ${me && t.assigneeEmail !== me.email && t.status !== "Closed" ? `<button class="btn" data-act="assign-me">${ico("user")}Assign to me</button>` : ""}
        ${t.status === "Closed" ? `<button class="btn" data-act="reopen">${ico("refresh")}Reopen</button>` : `<button class="btn success" data-act="close">${ico("check")}Close ticket</button>`}
      </div>
    </div>
    <div class="detail-grid">
      <section class="card conv" aria-label="Conversation">
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="conversation" aria-selected="${S.dtab === "conversation"}">Conversation (${thread.length})</button>
          <button role="tab" data-tab="activity" aria-selected="${S.dtab === "activity"}">Activity</button>
        </div>
        ${!d ? `<div class="spinner">Loading conversation…</div>` : S.dtab === "conversation" ? `<div class="thread">${thread.map(msgHTML).join("")}</div>
          <div class="composer ${cm === "note" ? "note" : ""}">
            <div class="seg" role="group" aria-label="Message type"><button data-cmode="reply" aria-pressed="${cm === "reply"}">Reply to requester</button><button data-cmode="note" aria-pressed="${cm === "note"}">Internal note</button></div>
            <label class="sr" for="cBody">Message</label>
            <textarea id="cBody" placeholder="${cm === "reply" ? "Write your reply…" : "Write a note for the team…"}">${esc(S.drafts[t.id] || "")}</textarea>
            <div class="c-hint">${cm === "reply" ? (t.requesterEmail ? `Your reply is emailed to ${esc(t.requesterEmail)} and shown in their portal.` : "This requester has no email address, so the reply is only saved on the ticket.") : "Internal notes are only visible to agents."}</div>
            <div class="c-actions">${cm === "reply" ? `<button class="btn" data-send="close" ${dis}>Send and close</button><button class="btn primary" data-send="reply" ${dis}>${S.sending ? "Sending…" : "Send reply"}</button>` : `<button class="btn primary" data-send="note" ${dis}>Add note</button>`}</div>
          </div>`
        : `<ul class="log">${[...d.events].reverse().map(h => `<li><time>${fmt(h.at)}</time><span>${esc(h.text)} <span class="by">by ${esc(h.by)}</span>${h.public ? `<span class="pub">Sent to requester</span>` : ""}</span></li>`).join("")}</ul>`}
      </section>
      <aside class="card props" aria-label="Ticket properties">
        <div class="sla-box ${s.cls}"><div class="big">${esc(s.txt)}</div>
          <small>${t.status === "Closed" ? "Closed " + fmt(t.closedAt) : t.dueAt ? "Resolution due " + fmt(t.dueAt) : ""}</small>
          <small>${frText(t)}</small>
          ${s.done || s.paused ? "" : `<div class="sla-bar"><i style="width:${Math.max(4, s.pct)}%"></i></div>`}</div>
        <section><h3>Properties</h3>
          <div class="field"><label for="pStatus">Status</label><select id="pStatus" data-field="status">${opt(STATUSES, t.status)}</select></div>
          <div class="field"><label for="pPriority">Priority</label><select id="pPriority" data-field="priority">${opt(PRIORITIES, t.priority)}</select></div>
          <div class="field"><label for="pAssignee">Assignee</label><select id="pAssignee" data-field="assigneeEmail">${agentOpts(t.assigneeEmail, "Unassigned")}${t.assigneeEmail && !(S.settings.users || []).some(a => a.email === t.assigneeEmail) ? `<option value="${esc(t.assigneeEmail)}" selected>${esc(t.assigneeName)}</option>` : ""}</select></div>
          <div class="field"><label for="pDept">Department</label><select id="pDept" data-field="department">${opt(t.department && !S.settings.departments.includes(t.department) ? [...S.settings.departments, t.department] : S.settings.departments, t.department)}</select></div>
          <div class="field"><label for="pChannel">Channel</label><select id="pChannel" data-field="channel">${opt(ALL_CHANNELS, t.channel)}</select></div>
          <div class="field"><label for="pDue">Resolution due</label><input id="pDue" type="datetime-local" data-field="dueAt" value="${toLocalInput(t.dueAt)}"></div>
          <div class="field"><label for="pTags">Tags</label><input id="pTags" data-field="tags" value="${esc(t.tags.join(", "))}" placeholder="Separate with commas"></div>
        </section>
        <section><h3>Requester</h3>
          <div class="c-who" style="margin-bottom:10px;max-width:none"><span class="avatar lg req-av">${esc(initials(t.requesterName || t.requesterEmail))}</span><b>${esc(t.requesterName)}</b></div>
          <dl class="kv">${t.requesterEmail ? `<dt>Email</dt><dd><a href="mailto:${esc(t.requesterEmail)}">${esc(t.requesterEmail)}</a></dd>` : ""}${t.requesterPhone ? `<dt>Phone</dt><dd>${esc(t.requesterPhone)}</dd>` : ""}<dt>Tickets</dt><dd><button class="btn sm" data-contact="${esc(contactKey(t))}">View all ${S.tickets.filter(x => contactKey(x) === contactKey(t)).length}</button></dd></dl>
          ${t.requesterEmail ? `<div class="notice" style="margin:14px 0 0">${ico("mail")}<span>The requester is emailed when you reply or change the status.</span></div>` : ""}
        </section>
        ${d && d.feedback ? `<section><h3>Requester feedback</h3><div class="csat-card"><div class="big">${stars(d.feedback.rating)} ${d.feedback.rating}/5</div><div class="c-muted" style="font-size:13px">${esc(d.feedback.label)}, ${fmt(d.feedback.at)} via ${esc(d.feedback.via.toLowerCase())}</div>${d.feedback.comment ? `<blockquote>${esc(d.feedback.comment)}</blockquote>` : ""}</div></section>` : t.status === "Closed" && t.requesterEmail ? `<section><h3>Requester feedback</h3><p class="c-muted" style="margin:0;font-size:13px">Not rated yet. The requester was sent a one-click rating in the closing email.</p></section>` : ""}
        <section><button class="btn danger sm" data-act="delete">Delete ticket</button></section>
      </aside>
    </div></div>`;
}

function frText(t) {
  if (t.firstResponseAt) { const ok = !t.firstResponseDueAt || t.firstResponseAt <= t.firstResponseDueAt; return `First response after ${dur(t.firstResponseAt - t.createdAt)}, ${ok ? "within target" : "missed target"}`; }
  if (t.status === "Closed") return "";
  if (!t.firstResponseDueAt) return "Awaiting first response";
  const left = t.firstResponseDueAt - Date.now();
  return left < 0 ? `First response overdue by ${dur(left)}` : `First response due in ${dur(left)}`;
}
function bars(map) {
  const e = Object.entries(map).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  if (!e.length) return `<p class="c-muted" style="margin:0">No tickets yet.</p>`;
  const max = Math.max(...e.map(x => x[1]));
  return e.map(([k, v]) => `<div class="bar"><span title="${esc(k)}">${esc(k)}</span><span class="track"><i style="width:${(v / max) * 100}%"></i></span><b>${v}</b></div>`).join("");
}
function renderDash(counts) {
  const open = S.tickets.filter(t => t.status !== "Closed"); const now = Date.now();
  const closedWeek = S.tickets.filter(t => t.status === "Closed" && t.closedAt >= now - 7 * 864e5).length;
  const dueSoon = open.filter(t => t.status !== "On hold" && t.dueAt >= now && t.dueAt < now + 864e5).length;
  const resp = S.tickets.filter(t => t.firstResponseAt).map(t => t.firstResponseAt - t.createdAt);
  const avg = resp.length ? dur(resp.reduce((a, b) => a + b, 0) / resp.length) : "—";
  const closedAll = S.tickets.filter(t => t.status === "Closed" && t.closedAt && t.dueAt);
  const met = closedAll.length ? Math.round(100 * closedAll.filter(t => t.closedAt <= t.dueAt).length / closedAll.length) + "%" : "—";
  const rated = S.tickets.filter(t => t.rating);
  const csat = rated.length ? Math.round(100 * rated.filter(t => t.rating >= 4).length / rated.length) + "%" : "—";
  const avgRating = rated.length ? (rated.reduce((a, t) => a + t.rating, 0) / rated.length).toFixed(1) : "—";
  if (!S.recentFb && !S.fbLoading) { S.fbLoading = true; api("GET", "/feedback/recent").then(r => { S.recentFb = r; S.fbLoading = false; render(); }).catch(() => { S.fbLoading = false; S.recentFb = []; }); }
  const fbItems = (S.recentFb || []).slice(0, 6);
  const fr = S.tickets.filter(t => t.firstResponseAt && t.firstResponseDueAt);
  const frMet = fr.length ? Math.round(100 * fr.filter(t => t.firstResponseAt <= t.firstResponseDueAt).length / fr.length) + "%" : "—";
  const bs = {}, ba = {}, bc = {}, bp = {};
  open.forEach(t => { bs[t.status] = (bs[t.status] || 0) + 1; ba[t.assigneeName || "Unassigned"] = (ba[t.assigneeName || "Unassigned"] || 0) + 1; bp[t.priority] = (bp[t.priority] || 0) + 1; });
  S.tickets.forEach(t => { bc[t.channel] = (bc[t.channel] || 0) + 1; });
  const hour = new Date().getHours();
  return `<div class="page">
    <div class="page-head"><div><h1>Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, ${esc(S.user.name.split(" ")[0])}</h1><p>Here’s how the service desk looks right now.</p></div></div>
    <div class="kpis">
      <button class="kpi" data-view="open"><div class="l">Open tickets</div><div class="v">${counts.open}</div></button>
      <button class="kpi ${counts.overdue ? "alert" : ""}" data-view="overdue"><div class="l">Overdue</div><div class="v">${counts.overdue}</div></button>
      <button class="kpi" data-view="open" data-sort="due"><div class="l">Due in the next 24 hours</div><div class="v">${dueSoon}</div></button>
      <button class="kpi" data-view="unassigned"><div class="l">Unassigned</div><div class="v">${counts.unassigned}</div></button>
      <button class="kpi" data-view="mine"><div class="l">Assigned to me</div><div class="v">${counts.mine}</div></button>
      <button class="kpi" data-view="closed"><div class="l">Closed this week</div><div class="v">${closedWeek}</div></button>
      <div class="kpi"><div class="l">First response within target</div><div class="v">${frMet}</div></div>
      <div class="kpi"><div class="l">Resolved within target</div><div class="v">${met}</div></div>
      <div class="kpi"><div class="l">Customer satisfaction (CSAT)</div><div class="v">${csat}</div><div class="c-muted" style="font-size:12.5px;margin-top:4px">${rated.length ? `${rated.length} ratings, average ${avgRating}/5` : "No ratings yet"}</div></div>
    </div>
    <div class="grid2">
      <section class="card panel"><h2>Open tickets by status</h2>${bars(bs)}</section>
      <section class="card panel"><h2>Open tickets by agent</h2>${bars(ba)}</section>
      <section class="card panel"><h2>Open tickets by priority</h2>${bars(bp)}</section>
      <section class="card panel"><h2>All tickets by channel</h2>${bars(bc)}</section>
      <section class="card panel"><h2>Latest feedback</h2>${fbItems.length ? `<ul class="fb-list">${fbItems.map(f => `<li><div>${stars(f.rating)} <b>${esc(RATING_LABELS[f.rating])}</b></div><div class="meta"><span>Ticket #${f.number}</span><span>${esc(f.assigneeName || "Unassigned")}</span><span>${ago(f.at)}</span></div>${f.comment ? `<blockquote>“${esc(f.comment)}”</blockquote>` : ""}</li>`).join("")}</ul>` : `<p class="c-muted" style="margin:0">Ratings appear here after requesters respond to the closing email.</p>`}</section>
    </div></div>`;
}
function renderContacts() {
  const m = new Map();
  S.tickets.forEach(t => { const k = contactKey(t); if (!k) return; const c = m.get(k) || { k, name: t.requesterName, email: t.requesterEmail, phone: t.requesterPhone, total: 0, open: 0, last: 0 }; c.total++; if (t.status !== "Closed") c.open++; if (t.createdAt > c.last) { c.last = t.createdAt; c.name = t.requesterName || c.name; c.phone = t.requesterPhone || c.phone; } m.set(k, c); });
  const q = S.search.trim().toLowerCase();
  const list = [...m.values()].filter(c => !q || (c.name + " " + c.email).toLowerCase().includes(q)).sort((a, b) => b.last - a.last);
  return `<div class="page"><div class="page-head"><div><h1>Requesters</h1><p>Everyone who has raised a ticket. Select a person to see their tickets.</p></div></div>
    <div class="card table-card">${list.length ? `<table class="dtable"><thead><tr><th>Name</th><th>Email</th><th class="hide-md">Phone</th><th>Open</th><th>Total</th><th class="hide-sm">Last ticket</th></tr></thead><tbody>
    ${list.map(c => `<tr data-contact="${esc(c.k)}" tabindex="0"><td><div class="c-who"><span class="avatar req-av">${esc(initials(c.name || c.email))}</span><b>${esc(c.name)}</b></div></td><td>${esc(c.email || "—")}</td><td class="hide-md">${esc(c.phone || "—")}</td><td>${c.open}</td><td>${c.total}</td><td class="hide-sm c-muted">${ago(c.last)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty"><h3>No requesters yet</h3><p>People appear here once they’ve raised a ticket.</p></div>`}</div></div>`;
}

/* ---------- portal ---------- */
function renderPortalPage() {
  const total = S.my.reduce((n, t) => n + unreadFor(t.id), 0);
  return `<div class="portal">
    <header class="topbar">
      <button class="logo" data-ptab="new" aria-label="Service desk home">${logoHTML()}</button>
      <nav class="portal-nav" aria-label="Portal">
        <button data-ptab="new" aria-current="${S.ptab === "new"}">${ico("plus")}<span class="txt"> New request</span></button>
        <button data-ptab="mine" aria-current="${S.ptab === "mine"}">${ico("list")}<span class="txt"> My requests</span></button>
        <button class="bell" data-act="bell" aria-label="Updates${total ? `, ${total} unread` : ""}" aria-expanded="${S.bellOpen}">${ico("bell")}${total ? `<span class="count">${total}</span>` : ""}</button>
        ${userMenu()}
      </nav>
    </header>
    <section class="hero"><div class="hero-inner"><h1>How can we help, ${esc(S.user.name.split(" ")[0])}?</h1><p>Raise a request with the support team and follow it from start to finish. We’ll email you at ${esc(S.user.email)} each time there’s an update.</p></div></section>
    <div class="p-wrap">${renderPortalBody(false)}</div>
    <footer class="portal-foot"><div><span>© ${new Date().getFullYear()} ${esc(S.cfg.orgName)}</span><span>Need help another way? Email <a href="mailto:${esc(S.cfg.supportEmail)}">${esc(S.cfg.supportEmail)}</a></span></div></footer>
  </div>`;
}
function renderPortalBody(inDesk) {
  const items = S.my; const total = items.reduce((n, t) => n + unreadFor(t.id), 0);
  let panel = "";
  if (S.bellOpen || (inDesk && total)) {
    const byId = Object.fromEntries(items.map(t => [t.id, t]));
    const evs = S.myEvents.filter(e => byId[e.ticketId]).slice(0, 20);
    if (S.bellOpen) panel = `<section class="card bellpanel" aria-label="Updates"><div class="bellpanel-h"><span>Updates on your requests</span>${total ? `<button data-act="seen-all">Mark all as read</button>` : ""}</div>
      ${evs.length ? evs.map(e => `<button class="notif ${e.at > (S.seen[e.ticketId] || 0) ? "unread" : ""}" data-popen="${e.ticketId}">${esc(e.text)}<small>${esc(byId[e.ticketId].subject)}, ${ago(e.at)}</small></button>`).join("") : `<p style="padding:14px 16px;margin:0" class="c-muted">No updates yet.</p>`}</section>`;
  }
  let body;
  if (S.ptab === "mine") body = S.psel ? portalDetail(S.psel) : portalList(items);
  else body = S.pconfirm ? portalConfirm(items.find(t => t.id === S.pconfirm) || (S.myDetails[S.pconfirm] && S.myDetails[S.pconfirm].ticket)) : portalForm();
  const open = items.filter(t => t.status !== "Closed").length;
  return `${inDesk ? `<div class="page-head"><div><h1>Request portal</h1><p>This is what staff see when they sign in without the agent role.</p></div></div><div class="preview-note">${ico("info")}<span>Requests you raise here are real tickets, logged under your own name.</span></div>` : ""}
    <div class="actions3">
      <button class="action" data-ptab="new" aria-current="${S.ptab === "new" && !S.psel}"><span class="ai">${ico("edit")}</span><span><b>Raise a request</b><span>Report a problem or ask for something you need</span></span></button>
      <button class="action" data-ptab="mine" aria-current="${S.ptab === "mine"}"><span class="ai">${ico("list")}</span><span><b>My requests</b><span>${items.length ? `${open} open, ${items.length} in total` : "Track progress and reply to the team"}</span></span></button>
      <a class="action" href="mailto:${esc(S.cfg.supportEmail)}"><span class="ai">${ico("mail")}</span><span><b>Email the service desk</b><span>${esc(S.cfg.supportEmail)}</span></span></a>
    </div>
    ${panel}${body}`;
}
function portalRating(id, fb) {
  const r = S.prate[id] ?? (fb ? fb.rating : 0);
  if (fb && !S.prEdit[id]) return `<section class="p-section"><h3>Your feedback</h3><div class="csat-card"><div class="big">${stars(fb.rating)} ${esc(RATING_LABELS[fb.rating])}</div>${fb.comment ? `<blockquote>${esc(fb.comment)}</blockquote>` : ""}<div style="margin-top:10px"><button class="btn sm" data-act="prchange" data-id="${id}">Change my rating</button></div></div></section>`;
  return `<section class="p-section card" style="padding:18px;box-shadow:none"><h3 style="margin-bottom:4px">How did we do?</h3><p class="c-muted" style="margin:0 0 12px">Rate the support you received on this request.</p>
    <fieldset class="rating"><legend class="sr">Your rating</legend><div class="rating-row">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="pr-${id}" value="${n}" data-prate="${id}" ${r === n ? "checked" : ""}><span><b>${n}</b>${RATING_LABELS[n]}</span></label>`).join("")}</div></fieldset>
    <div class="field"><label for="prc-${id}">Anything you’d like to add? (optional)</label><textarea id="prc-${id}" data-prcomment="${id}" rows="3" maxlength="4000">${esc(S.prComment[id] ?? (fb ? fb.comment : ""))}</textarea></div>
    <div class="c-actions"><button class="btn primary" data-act="prsend" data-id="${id}" ${r ? "" : "disabled"}>Send feedback</button></div></section>`;
}
function pv(k) { return esc(S.pform[k] || ""); }
function portalForm() {
  const pr = S.pform.priority || "Medium", dep = S.pform.department || S.settings.departments[0];
  return `<form class="card section-card" id="portalForm" novalidate>
    <h2>Raise a request</h2><p>Give us as much detail as you can so we can help quickly.</p>
    ${S.perr ? `<p class="err" role="alert">${esc(S.perr)}</p>` : ""}
    <div class="cols">
      <div class="field full"><label for="pf-subject">Subject <span class="req">*</span></label><input id="pf-subject" data-pf="subject" value="${pv("subject")}" maxlength="200" placeholder="For example: Can’t connect to the office VPN"></div>
      <div class="field"><label for="pf-dept">Which team should handle it?</label><select id="pf-dept" data-pf="department">${opt(S.settings.departments, dep)}</select></div>
      <div class="field"><label for="pf-pri">How urgent is it?</label><select id="pf-pri" data-pf="priority">${[["Low", "Low, whenever you can"], ["Medium", "Medium, it affects my work"], ["High", "High, it’s blocking my work"], ["Urgent", "Urgent, it affects many people"]].map(o => `<option value="${o[0]}"${pr === o[0] ? " selected" : ""}>${o[1]}</option>`).join("")}</select></div>
      <div class="field full"><label for="pf-desc">Describe the issue <span class="req">*</span></label><textarea id="pf-desc" data-pf="description" rows="6" placeholder="What happened, when it started and anything you’ve already tried">${pv("description")}</textarea></div>
      <div class="field"><label for="pf-name">Your name</label><input id="pf-name" data-pf="name" value="${esc(S.pform.name ?? S.user.name)}" maxlength="120" autocomplete="name"></div>
      <div class="field"><label for="pf-phone">Phone (optional)</label><input id="pf-phone" data-pf="phone" type="tel" value="${pv("phone")}" maxlength="40" autocomplete="tel"></div>
    </div>
    <div class="c-actions"><button type="submit" class="btn primary" ${S.psending ? "disabled" : ""}>${S.psending ? "Sending…" : "Submit request"}</button></div></form>`;
}
function portalConfirm(t) {
  if (!t) return portalForm();
  return `<section class="card confirm" aria-live="polite"><div class="okmark">${ico("check")}</div><h2>Request received</h2>
    <div class="ref">Ticket #${t.number}</div>
    <p>We’ve sent a confirmation to ${esc(S.user.email)}. You’ll get an email whenever an agent replies or the status changes.</p>
    <div class="c-actions" style="justify-content:center;margin-top:20px"><button class="btn primary" data-popen="${t.id}">Track this request</button><button class="btn" data-act="pnew">Raise another request</button></div></section>`;
}
function portalList(items) {
  if (!items.length) return `<div class="card empty"><h3>No requests yet</h3><p>Requests you raise here or by email will appear in this list.</p><button class="btn primary" data-ptab="new">Raise a request</button></div>`;
  return `<div class="card req-list">${items.map(t => { const u = unreadFor(t.id); return `<button class="req" data-popen="${t.id}">
    <b>${u ? `<i class="newdot" aria-label="${u} new updates"></i>` : ""}${esc(t.subject)}</b><span class="dh-badges">${t.status === "Closed" ? (t.rating ? stars(t.rating) : `<span class="badge s-On-hold" style="background:var(--amber-100)">Rate this</span>`) : ""}${badge(t.status)}</span>
    <span class="r-meta"><span>Ticket #${t.number}</span><span>${esc(t.department)}</span><span>Raised ${ago(t.createdAt)}</span><span>Updated ${ago(t.updatedAt)}</span></span></button>`; }).join("")}</div>`;
}
function portalDetail(id) {
  const d = S.myDetails[id]; const t = (d && d.ticket) || S.my.find(x => x.id === id);
  if (!t) return `<div class="spinner">Loading…</div>`;
  const st = t.status; const idx = st === "Open" ? 1 : st === "Closed" ? 3 : 2;
  const steps = ["Submitted", "Logged", idx === 2 ? st : "In progress", "Resolved"];
  const msgs = [{ id: "d", type: "customer", author: "You", body: t.description, at: t.createdAt }, ...((d && d.messages) || [])];
  return `<article class="card section-card">
    <nav class="crumbs" aria-label="Breadcrumb"><button data-act="pback">My requests</button><span aria-hidden="true">/</span><span>Ticket #${t.number}</span></nav>
    <div class="detail-head" style="margin-bottom:0"><div><h1 style="margin-top:0">${esc(t.subject)}</h1><div class="dh-meta"><span>Ticket #${t.number}</span><span>Raised ${fmt(t.createdAt)}</span><span>${esc(t.department)}</span></div></div>${badge(st)}</div>
    <div class="tracker" aria-label="Progress: ${esc(steps[idx])}">${steps.map((s, i) => `<div class="step ${i <= idx ? "done" : ""} ${i === idx ? "cur" : ""}">${esc(s)}</div>`).join("")}</div>
    <section class="p-section"><h3>Conversation</h3><div class="thread" style="padding:0">
      ${!d ? `<div class="spinner">Loading conversation…</div>` : msgs.map(m => { const mine = m.type === "customer"; const who = mine ? (m.author === "You" || m.author === S.user.name ? "You" : m.author) : m.author; return `<article class="msg ${mine ? "customer" : "agent"}"><span class="avatar lg ${mine ? "req-av" : ""}">${esc(initials(mine ? S.user.name : m.author))}</span><div class="msg-card"><div class="msg-h"><span><b>${esc(who)}</b>${mine ? "" : `<span class="tag">Service desk</span>`}</span><time>${fmt(m.at)}</time></div><div class="msg-b">${esc(m.body)}</div></div></article>`; }).join("")}
    </div>
    <div class="composer" style="border:1px solid var(--line);border-radius:var(--radius-l);margin-top:16px">
      <label class="flabel" for="pr-${id}">${st === "Closed" ? "Still having the problem? Reply and we’ll reopen your ticket." : "Add more information for the service desk"}</label>
      <textarea id="pr-${id}" data-preply="${id}">${esc(S.preply[id] || "")}</textarea>
      <div class="c-actions"><button class="btn primary" data-act="preply" data-id="${id}">Send reply</button></div>
    </div></section>
    ${st === "Closed" && d ? portalRating(id, d.feedback) : ""}
    <section class="p-section"><h3>Updates</h3><ul class="timeline">${d ? [...d.events].reverse().map(e => `<li><time>${fmt(e.at)}</time>${esc(e.text)}</li>`).join("") : ""}</ul></section>
  </article>`;
}

/* ---------- events ---------- */
root.addEventListener("click", async e => {
  const el = e.target.closest("[data-act],[data-view],[data-page],[data-open],[data-tab],[data-cmode],[data-send],[data-contact],[data-check],[data-checkall],[data-ptab],[data-popen]");
  const closing = S.userMenu && !(el && el.dataset.act === "usermenu");
  if (closing) { S.userMenu = false; if (!el) { render(); return; } }
  if (!el) return;
  if (el.dataset.checkall != null) { e.stopPropagation(); const ids = visible().map(t => t.id); if (el.checked) ids.forEach(id => S.checked.add(id)); else S.checked.clear(); render(); return; }
  if (el.dataset.view || el.dataset.page || el.dataset.contact != null) S.navOpen = false;
  if (el.dataset.check != null) { e.stopPropagation(); const id = Number(el.dataset.check); el.checked ? S.checked.add(id) : S.checked.delete(id); render(); return; }
  if (el.dataset.ptab) { S.ptab = el.dataset.ptab; S.psel = null; S.pconfirm = null; S.bellOpen = false; render(); return; }
  if (el.dataset.popen) { const id = Number(el.dataset.popen); S.ptab = "mine"; S.psel = id; S.pconfirm = null; S.bellOpen = false; markSeen([id]); render(); window.scrollTo(0, 0); loadMyDetail(id); return; }
  if (el.dataset.view) { S.page = "tickets"; S.view = el.dataset.view; S.search = ""; if (el.dataset.sort) S.sort = el.dataset.sort; S.contact = null; S.checked.clear(); S.selected = null; S.search = ""; render(); return; }
  if (el.dataset.page) { S.page = el.dataset.page; S.selected = null; render(); document.getElementById("main")?.scrollTo(0, 0); if (S.page === "portal") loadMine().then(render).catch(() => { }); return; }
  if (el.dataset.open) { if (e.target.closest("input")) return; S.page = "tickets"; S.selected = Number(el.dataset.open); S.dtab = "conversation"; render(); document.getElementById("main")?.scrollTo(0, 0); loadDetail(S.selected); return; }
  if (el.dataset.tab) { S.dtab = el.dataset.tab; S._scrollThread = true; render(); return; }
  if (el.dataset.cmode) { S.cmode = el.dataset.cmode; render(); document.getElementById("cBody")?.focus(); return; }
  if (el.dataset.contact != null) { S.page = "tickets"; S.view = "all"; S.contact = el.dataset.contact; S.search = ""; S.selected = null; render(); return; }
  if (el.dataset.send) { await sendMessage(el.dataset.send === "close" ? "reply" : el.dataset.send, el.dataset.send === "close"); return; }
  const a = el.dataset.act;
  if (a === "usermenu") { S.userMenu = !S.userMenu; render(); return; }
  if (a === "menu") { S.navOpen = !S.navOpen; render(); return; }
  if (a === "searchtoggle") { S.searchOpen = !S.searchOpen; render(); if (S.searchOpen) document.getElementById("q")?.focus(); return; }
  if (a === "assign-me") { await setField(S.selected, "assigneeEmail", S.user.email); toast("Assigned to you"); return; }
  if (a === "close") { if (await setField(S.selected, "status", "Closed")) toast("Ticket closed. The requester has been emailed."); return; }
  if (a === "reopen") { if (await setField(S.selected, "status", "Open")) toast("Ticket reopened"); return; }
  if (a === "new") openNew();
  else if (a === "settings") { S.page = "settings"; S.selected = null; S.userMenu = false; S.navOpen = false; render(); document.getElementById("main")?.scrollTo(0, 0); }
  else if (a === "signout") signOut();
  else if (a === "back") { S.selected = null; render(); }
  else if (a === "retryload") { S.loadError = ""; render(); try { await loadAgent(); } catch (e2) { S.loadError = e2.message || "Something went wrong."; } render(); }
  else if (a === "clear-contact") { S.contact = null; render(); }
  else if (a === "bulk-clear") { S.checked.clear(); render(); }
  else if (a === "bell") { S.bellOpen = !S.bellOpen; render(); }
  else if (a === "seen-all") { markSeen(S.my.map(t => t.id)); render(); }
  else if (a === "pnew") { S.pconfirm = null; render(); document.getElementById("pf-subject")?.focus(); }
  else if (a === "pback") { S.psel = null; render(); }
  else if (a === "preply") { el.disabled = true; await requesterReply(Number(el.dataset.id)); }
  else if (a === "prchange") { S.prEdit[Number(el.dataset.id)] = true; render(); }
  else if (a === "prsend") {
    const id = Number(el.dataset.id); el.disabled = true;
    try { S.myDetails[id] = await api("POST", `/tickets/${id}/feedback`, { rating: S.prate[id] ?? S.myDetails[id]?.feedback?.rating, comment: S.prComment[id] ?? S.myDetails[id]?.feedback?.comment ?? "" }); S.prEdit[id] = false; delete S.prate[id]; delete S.prComment[id]; toast("Thank you for your feedback"); loadMine().then(render).catch(() => { }); } catch (e2) { }
    render();
  }
  else if (a === "delete") {
    const t = S.tickets.find(x => x.id === S.selected);
    if (t && confirm(`Delete ticket #${t.number}? This removes it and its conversation from SharePoint and can’t be undone.`)) {
      try { await api("DELETE", "/tickets/" + t.id); S.tickets = S.tickets.filter(x => x.id !== t.id); S.selected = null; toast(`Ticket #${t.number} deleted`); render(); } catch (e) { }
    }
  }
});
root.addEventListener("submit", e => { if (e.target.id === "portalForm") { e.preventDefault(); if (!S.psending) submitRequest(); } });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && (S.userMenu || S.navOpen || S.searchOpen || S.bellOpen)) { S.userMenu = S.navOpen = S.searchOpen = S.bellOpen = false; render(); return; }
  if (e.key === "/" && S.user && S.user.isAgent && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") && !dlgNew.open) { e.preventDefault(); const q = document.getElementById("q"); if (q) { if (getComputedStyle(q.parentElement).display === "none") { S.searchOpen = true; render(); } document.getElementById("q").focus(); } }
});
root.addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-open],tr[data-contact]")) { e.preventDefault(); e.target.click(); }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.id === "cBody") sendMessage(S.cmode, false);
});
root.addEventListener("input", e => {
  const t = e.target;
  if (t.id === "q") { S.search = t.value; if (S.user.isAgent && S.page !== "contacts" && (S.page !== "tickets" || S.selected)) { S.page = "tickets"; S.selected = null; } render(); }
  if (t.id === "cBody" && S.selected) S.drafts[S.selected] = t.value;
  if (t.dataset.pf) S.pform[t.dataset.pf] = t.value;
  if (t.dataset.preply) S.preply[t.dataset.preply] = t.value;
  if (t.dataset.prcomment) S.prComment[t.dataset.prcomment] = t.value;
});
root.addEventListener("change", async e => {
  const el = e.target;
  if (el.dataset.pf) { S.pform[el.dataset.pf] = el.value; return; }
  if (el.dataset.prate) { S.prate[Number(el.dataset.prate)] = Number(el.value); render(); return; }
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
/* ---------- settings (admin area) ---------- */
const DAYS = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["0", "Sun"]];
const OFFSETS = [-300, -240, 0, 60, 120, 180, 240, 330, 480];
function offLabel(m) { const sgn = m < 0 ? "−" : "+"; const a = Math.abs(m); return `UTC${sgn}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}${m === 60 ? " (Lagos, West Africa Time)" : m === 0 ? " (London winter, GMT)" : ""}`; }
function addBusinessTime(startMs, hours, sla) {
  const bh = sla && sla.businessHours; const toMin = s => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  if (!bh || !bh.enabled || !bh.days.length) return startMs + hours * 36e5;
  const sm = toMin(bh.start), em = toMin(bh.end); if (em <= sm) return startMs + hours * 36e5;
  const off = bh.utcOffset * 6e4, days = new Set(bh.days.map(Number)), hol = new Set(sla.holidays || []);
  let rem = hours * 60, t = startMs + off;
  for (let g = 0; g < 1000 && rem > 0; g++) {
    const d = new Date(t), ds = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), ws = ds + sm * 6e4, we = ds + em * 6e4;
    if (!days.has(d.getUTCDay()) || hol.has(new Date(ds).toISOString().slice(0, 10)) || t >= we) { t = ds + 864e5 + sm * 6e4; continue; }
    if (t < ws) t = ws; const av = (we - t) / 6e4;
    if (rem <= av) { t += rem * 6e4; rem = 0; } else { rem -= av; t = ds + 864e5 + sm * 6e4; }
  }
  return t - off;
}
function slaDraft() { if (!S.slaDraft) S.slaDraft = JSON.parse(JSON.stringify(S.settings.sla)); return S.slaDraft; }
function renderSettingsPage() {
  if (!S.user.isAdmin) return `<div class="page"><div class="card empty"><h3>Admins only</h3><p>Ask a service desk admin to change settings.</p></div></div>`;
  const tabs = [["users", "Users", "users"], ["sla", "SLA policy", "clock"], ["departments", "Departments", "list"], ["feedback", "Feedback", "star"], ["branding", "Branding", "edit"], ["email", "Email", "mail"], ["audit", "Activity log", "shield"], ["backups", "Backups", "refresh"]];
  const body = { users: setUsers, sla: setSla, departments: setDepartments, feedback: setFeedback, branding: setBranding, email: setEmail, audit: setAudit, backups: setBackups }[S.stab] || setUsers;
  return `<div class="page">
    <div class="page-head"><div><h1>Settings</h1><p>Manage who works on the desk, response targets and how the desk looks.</p></div></div>
    <div class="settings-layout">
      <nav class="card settings-tabs" aria-label="Settings sections">${tabs.map(t => `<button data-stab="${t[0]}" aria-current="${S.stab === t[0]}">${ico(t[2])}<span>${t[1]}</span></button>`).join("")}</nav>
      <div class="settings-body">${body()}</div>
    </div></div>`;
}
function setUsers() {
  const users = S.settings.users || []; const nu = S.unew;
  const sugg = S.dir && S.dir.length && S.uq.trim().length >= 2 ? `<div class="suggest" role="listbox">${S.dir.map((p, i) => `<button role="option" data-pick="${i}"><span class="avatar">${esc(initials(p.name))}</span><span><b>${esc(p.name)}</b><small>${esc(p.email)}${p.title ? `, ${esc(p.title)}` : ""}</small></span></button>`).join("")}</div>` : "";
  return `<section class="card section-card">
    <h2>Users</h2><p>People listed here can sign in to the agent desk. Everyone else in ${esc(S.cfg.orgName)} who signs in gets the request portal.</p>
    <div class="adduser">
      <div class="field typeahead"><label for="uSearch">Find someone in ${esc(S.cfg.orgName)}</label>
        <input id="uSearch" type="search" placeholder="Start typing a name or email" value="${esc(S.uq)}" autocomplete="off">${sugg}
        ${S.dirAvailable === false ? `<small>Directory search isn’t switched on, so enter the name and email below. To turn it on, add the User.Read.All application permission in Entra (see the README).</small>` : ""}
      </div>
      <div class="cols4">
        <div class="field"><label for="uName">Full name</label><input id="uName" data-unew="name" value="${esc(nu.name)}" maxlength="80"></div>
        <div class="field"><label for="uEmail">Work email</label><input id="uEmail" data-unew="email" type="email" value="${esc(nu.email)}" maxlength="160"></div>
        <div class="field"><label for="uRole">Role</label><select id="uRole" data-unew="role">${opt(["Agent", "Admin"], nu.role || "Agent")}</select></div>
        <div class="field"><span class="flabel" aria-hidden="true">&nbsp;</span><button class="btn primary" data-act="uadd">${ico("plus")}Add user</button></div>
      </div>
      <div class="role-help"><span><b>Agent</b> works on tickets.</span><span><b>Admin</b> works on tickets and manages these settings.</span></div>
    </div></section>
    <section class="card table-card" style="margin-top:16px">${users.length ? `<table class="dtable"><thead><tr><th>Name</th><th class="hide-sm">Email</th><th>Role</th><th class="hide-md">Open tickets</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
      ${users.map(u => `<tr style="cursor:default"><td><div class="c-who"><span class="avatar">${esc(initials(u.name))}</span><span><b>${esc(u.name)}</b>${u.email === S.user.email ? ` <span class="tag">You</span>` : ""}</span></div></td>
        <td class="hide-sm c-muted">${esc(u.email)}</td>
        <td><label class="sr" for="role-${esc(u.email)}">Role for ${esc(u.name)}</label><select class="role-select" id="role-${esc(u.email)}" data-urole="${esc(u.email)}">${opt(["Agent", "Admin"], u.role)}</select></td>
        <td class="hide-md">${S.tickets.filter(t => t.assigneeEmail === u.email && t.status !== "Closed").length}</td>
        <td style="text-align:right"><button class="btn sm danger" data-uremove="${esc(u.email)}">Remove</button></td></tr>`).join("")}
      </tbody></table>` : `<div class="empty"><h3>No users yet</h3><p>Add the people who work on tickets. Until there’s at least one admin here, anyone with the Service Desk Agent role in Entra can manage settings.</p></div>`}</section>`;
}
function setSla() {
  const d = slaDraft(); const bh = d.businessHours;
  const sample = addBusinessTime(Date.now(), d.resolution.High, d);
  const dirty = JSON.stringify(d) !== JSON.stringify(S.settings.sla);
  return `<section class="card section-card">
    <h2>Response and resolution targets</h2><p>How quickly the team should first respond to, and fully resolve, each priority. Times are in ${bh.enabled ? "working" : "calendar"} hours.</p>
    <div class="table-card sla-table"><table class="dtable"><thead><tr><th>Priority</th><th>First response</th><th>Resolution</th></tr></thead><tbody>
      ${PRIORITIES.map(p => `<tr style="cursor:default"><td>${prio(p)}</td>
        <td><div class="hours"><input type="number" min="0.25" max="720" step="0.25" id="rsp-${p}" data-sla="response.${p}" value="${d.response[p]}" aria-label="${p} first response hours"><span>hours</span></div></td>
        <td><div class="hours"><input type="number" min="0.5" max="2160" step="0.5" id="res-${p}" data-sla="resolution.${p}" value="${d.resolution[p]}" aria-label="${p} resolution hours"><span>hours</span></div></td></tr>`).join("")}
    </tbody></table></div>
    <div class="field" style="margin-top:16px;max-width:360px"><label for="warnAt">Show a warning when this much time is left</label><div class="hours"><input type="number" id="warnAt" min="5" max="90" step="5" data-sla="warnAt" value="${d.warnAt}"><span>% of the target</span></div><small>Tickets turn amber in the queue at this point, and red once they’re overdue.</small></div>
  </section>
  <section class="card section-card" style="margin-top:16px">
    <h2>Business hours</h2><p>When switched on, the SLA clock only runs during working hours, so a ticket raised on Friday evening isn’t overdue by Monday morning.</p>
    <label class="switch"><input type="checkbox" id="bhOn" data-sla="businessHours.enabled" ${bh.enabled ? "checked" : ""}><span>Count only business hours</span></label>
    <fieldset class="bh" ${bh.enabled ? "" : "disabled"}>
      <div class="cols4">
        <div class="field"><label for="bhStart">Day starts</label><input type="time" id="bhStart" data-sla="businessHours.start" value="${bh.start}"></div>
        <div class="field"><label for="bhEnd">Day ends</label><input type="time" id="bhEnd" data-sla="businessHours.end" value="${bh.end}"></div>
        <div class="field" style="grid-column:span 2"><label for="bhTz">Time zone</label><select id="bhTz" data-sla="businessHours.utcOffset">${(OFFSETS.includes(bh.utcOffset) ? OFFSETS : [...OFFSETS, bh.utcOffset]).map(o => `<option value="${o}"${o === bh.utcOffset ? " selected" : ""}>${offLabel(o)}</option>`).join("")}</select></div>
      </div>
      <span class="flabel">Working days</span>
      <div class="daypicks">${DAYS.map(([v, l]) => `<label><input type="checkbox" data-sladay="${v}" ${bh.days.map(String).includes(v) ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>
      <div class="field" style="margin-top:16px"><label for="holIn">Public holidays and office closures</label>
        <div class="addrow" style="max-width:360px"><input type="date" id="holIn"><button class="btn" data-act="holadd" type="button">Add date</button></div>
        <div class="chips">${d.holidays.length ? d.holidays.map(h => `<span>${new Date(h + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}<button data-holremove="${h}" aria-label="Remove ${h}">×</button></span>`).join("") : `<small class="c-muted">No holidays added.</small>`}</div>
      </div>
    </fieldset>
  </section>
  <div class="savebar card"><span>${dirty ? "You have unsaved changes." : "All changes saved."} With these settings, a High priority ticket raised now would be due by <b>${fmt(sample)}</b>.</span>
    <span class="savebar-actions"><button class="btn" data-act="slareset" ${dirty ? "" : "disabled"}>Discard</button><button class="btn primary" data-act="slasave" ${dirty ? "" : "disabled"}>Save SLA policy</button></span></div>
  <p class="c-muted" style="font-size:13px;margin-top:10px">New targets apply to tickets raised from now on, and when an existing ticket’s priority changes.</p>`;
}
function setDepartments() {
  const ds = S.settings.departments;
  return `<section class="card section-card"><h2>Departments</h2><p>Teams that requests can be routed to. They appear in the request form and on every ticket.</p>
    <div class="addrow" style="max-width:460px"><input id="deptIn" placeholder="Department name" maxlength="80" aria-label="Department name"><button class="btn primary" data-act="deptadd">${ico("plus")}Add</button></div>
    <div class="table-card" style="margin-top:16px;border:1px solid var(--line);border-radius:var(--radius-l)"><table class="dtable"><thead><tr><th>Department</th><th>Open tickets</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
    ${ds.map((d, i) => `<tr style="cursor:default"><td><b>${esc(d)}</b></td><td>${S.tickets.filter(t => t.department === d && t.status !== "Closed").length}</td><td style="text-align:right"><button class="btn sm danger" data-dremove="${i}" ${ds.length <= 1 ? "disabled" : ""}>Remove</button></td></tr>`).join("")}
    </tbody></table></div></section>`;
}
function setBranding() {
  const src = logoSrc();
  return `<section class="card section-card"><h2>Logo</h2><p>Shown in the top bar, on the sign-in page and at the top of every notification email.</p>
    <div class="logo-previews">
      <div><span class="flabel">Top bar</span><div class="lp lp-top">${src ? `<img src="${esc(src)}" alt="Current logo">` : `<span class="wordmark">${esc(S.cfg.orgName)}</span>`}<span class="product">Service Desk</span></div></div>
      <div><span class="flabel">Email header</span><div class="lp lp-mail">${src ? `<img src="${esc(src)}" alt="">` : `<span class="wordmark">${esc(S.cfg.orgName)}</span>`}<i></i></div></div>
    </div>
    <div class="upload">
      <label class="btn primary" for="logoFile">${ico("up")}${src ? "Replace logo" : "Upload logo"}</label>
      <input type="file" id="logoFile" accept="image/png,image/jpeg" class="sr">
      ${S.settings.logoUrl ? `<button class="btn danger" data-act="logoremove">Remove logo</button>` : ""}
      ${S.uploading ? `<span class="c-muted">Uploading…</span>` : ""}
    </div>
    <ul class="guidelines"><li>PNG with a transparent background works best. JPG is also accepted.</li><li>Use the horizontal version of the logo, around 400 × 100 pixels. It’s shown 32 pixels tall.</li><li>Maximum file size is 1 MB. The file is stored in your SharePoint site.</li></ul>
  </section>
  <section class="card section-card" style="margin-top:16px"><h2>Colours</h2><p>The desk uses ${esc(S.cfg.orgName)} navy for navigation and buttons, and green as the accent.</p>
    <div class="swatches"><span><i style="background:#0B2D5B"></i>Navy #0B2D5B</span><span><i style="background:#76B82A"></i>Green #76B82A</span></div></section>`;
}
function setEmail() {
  return `<section class="card section-card"><h2>Email</h2><p>Notifications are sent from, and requests are received at, the support mailbox.</p>
    <dl class="kv" style="max-width:560px"><dt>Mailbox</dt><dd><b>${esc(S.cfg.supportEmail)}</b></dd><dt>Checked</dt><dd>Every 5 minutes</dd><dt>Requesters get</dt><dd>Confirmation, replies, status changes and resolution</dd><dt>Agents get</dt><dd>New assignments and requester replies</dd></dl>
    <div style="margin-top:18px"><button class="btn" data-act="mailcheck" ${S.mailChecking ? "disabled" : ""}>${ico("refresh")}${S.mailChecking ? "Checking…" : "Check mailbox now"}</button></div></section>`;
}
/* ---------- activity log & backups (admin) ---------- */
const AUDIT_CATS = ["Access", "Ticket", "Email", "Feedback", "Settings", "Backup", "Audit"];
function dayStart(s) { return new Date(s + "T00:00:00").getTime(); }
function isoDay(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function auditFilters() { if (!S.af) S.af = { from: isoDay(Date.now() - 6 * 864e5), to: isoDay(Date.now()), cat: "", q: "" }; return S.af; }
async function loadAudit() {
  const f = auditFilters(); S.auditLoading = true; render();
  try { S.auditRows = await api("GET", `/audit?from=${dayStart(f.from)}&to=${dayStart(f.to) + 864e5 - 1}`); } catch (e) { S.auditRows = []; }
  S.auditLoading = false; render();
}
function auditVisible() {
  const f = auditFilters(); const q = f.q.trim().toLowerCase();
  return (S.auditRows || []).filter(r => (!f.cat || r.category === f.cat) && (!q || [r.action, r.actorName, r.actorEmail, r.targetId, r.details, r.ip].join(" ").toLowerCase().includes(q)));
}
function prettyDetails(d) { try { return JSON.stringify(JSON.parse(d), null, 2); } catch (e) { return d; } }
function setAudit() {
  const f = auditFilters(); const rows = auditVisible();
  if (!S.auditRows && !S.auditLoading) setTimeout(loadAudit, 0);
  return `<section class="card section-card"><h2>Activity log</h2><p>Every sign-in, ticket change, reply, rating, settings change and backup, with who did it, when and from where. Entries can’t be edited or deleted from the desk.</p>
    <div class="filters">
      <div class="field"><label for="afFrom">From</label><input type="date" id="afFrom" data-af="from" value="${f.from}"></div>
      <div class="field"><label for="afTo">To</label><input type="date" id="afTo" data-af="to" value="${f.to}"></div>
      <div class="field"><label for="afCat">Category</label><select id="afCat" data-af="cat"><option value="">All activity</option>${AUDIT_CATS.map(c => `<option${c === f.cat ? " selected" : ""}>${c}</option>`).join("")}</select></div>
      <div class="field"><label for="afQ">Search</label><input type="search" id="afQ" data-af="q" value="${esc(f.q)}" placeholder="Person, ticket number, action"></div>
      <button class="btn" data-act="logexport" ${rows.length ? "" : "disabled"}>${ico("up")}Export CSV</button>
    </div>
    <p class="c-muted" style="font-size:13px;margin:0 0 10px">${S.auditLoading ? "Loading…" : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}</p>
  </section>
  <section class="card table-card" style="margin-top:12px">${rows.length ? `<table class="dtable log-table"><thead><tr><th>When</th><th>Who</th><th>Activity</th><th class="hide-md">Category</th><th class="hide-lg">IP address</th></tr></thead><tbody>
    ${rows.slice(0, 1000).map(r => `<tr style="cursor:default"><td class="when">${fmt(r.at)}</td><td><b>${esc(r.actorName)}</b>${r.actorEmail ? `<br><span class="c-muted">${esc(r.actorEmail)}</span>` : ""}</td>
      <td>${esc(r.action)}${r.details ? `<details><summary>Details</summary><pre>${esc(prettyDetails(r.details))}</pre></details>` : ""}</td>
      <td class="hide-md"><span class="cat cat-${esc(r.category)}">${esc(r.category)}</span></td><td class="hide-lg c-muted">${esc(r.ip)}</td></tr>`).join("")}
  </tbody></table>${rows.length > 1000 ? `<p class="c-muted" style="padding:12px">Showing the latest 1,000. Export to see all ${rows.length}.</p>` : ""}` : `<div class="empty"><h3>${S.auditLoading ? "Loading…" : "No activity in this period"}</h3><p>Try a wider date range or a different category.</p></div>`}</section>`;
}
function exportAudit() {
  const rows = auditVisible(); const f = auditFilters();
  const cell = v => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [["Time (UTC)", "Local time", "Person", "Email", "Category", "Activity", "Target", "IP address", "Device", "Details"].join(",")];
  rows.forEach(r => lines.push([new Date(r.at).toISOString(), fmt(r.at), r.actorName, r.actorEmail, r.category, r.action, r.targetType ? `${r.targetType} ${r.targetId}` : "", r.ip, r.ua, r.details].map(cell).join(",")));
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `service-desk-activity-${f.from}-to-${f.to}.csv`; document.body.appendChild(a); a.click(); a.remove();
  api("POST", "/audit/export", { from: f.from, to: f.to, filter: [f.cat, f.q].filter(Boolean).join(" "), rows: rows.length }).catch(() => { });
  toast("Activity log exported. The export itself has been recorded in the log.");
}
async function loadBackups() { S.backupsLoading = true; render(); try { S.backups = await api("GET", "/backups"); } catch (e) { S.backups = []; } S.backupsLoading = false; render(); }
function setBackups() {
  if (!S.backups && !S.backupsLoading) setTimeout(loadBackups, 0);
  const runs = (S.backups || []).map(b => { let d = {}; try { d = JSON.parse(b.details || "{}"); } catch (e) { } return { ...b, d }; });
  const backupsOnly = runs.filter(r => r.targetType === "Backup");
  const lastOk = backupsOnly.find(r => r.d.verified);
  const age = lastOk ? Date.now() - lastOk.at : null;
  const healthy = age != null && age < 36 * 36e5;
  const restores = runs.filter(r => r.targetType === "Restore");
  return `<div class="status-strip">
      <div class="kpi ${healthy ? "" : "alert"}"><div class="l">Last verified backup</div><div class="v" style="font-size:20px">${lastOk ? ago(lastOk.at) : "None yet"}</div><div class="c-muted" style="font-size:13px;margin-top:4px">${lastOk ? fmt(lastOk.at) : "Set up the nightly backup (see below)"}</div></div>
      <div class="kpi"><div class="l">Records in last backup</div><div class="v" style="font-size:20px">${lastOk ? (lastOk.d.records || 0).toLocaleString() : "—"}</div></div>
      <div class="kpi"><div class="l">Backups in the last 30 days</div><div class="v" style="font-size:20px">${backupsOnly.filter(r => r.d.verified && Date.now() - r.at < 30 * 864e5).length}</div></div>
      <div class="kpi"><div class="l">Last restore test</div><div class="v" style="font-size:20px">${restores[0] ? ago(restores[0].at) : "Never"}</div></div>
    </div>
    ${!healthy ? `<div class="err" role="alert">${lastOk ? "The last verified backup is more than a day old. Check the “Nightly backup” workflow in GitHub Actions." : "No verified backup has been recorded yet."}</div>` : ""}
    <section class="card table-card">${runs.length ? `<table class="dtable log-table"><thead><tr><th>When</th><th>Result</th><th class="hide-sm">Records</th><th class="hide-md">Manifest SHA-256</th><th>Evidence</th></tr></thead><tbody>
      ${runs.map(r => `<tr style="cursor:default"><td class="when">${fmt(r.at)}</td>
        <td>${r.targetType === "Restore" ? `<span class="ok-txt">Restore test passed</span><br><span class="c-muted">Backup ${esc(r.targetId)}</span>` : r.d.verified ? `<span class="ok-txt">Completed and verified</span>` : `<span class="bad-txt">Failed</span>${r.d.error ? `<br><span class="c-muted">${esc(r.d.error)}</span>` : ""}`}<br><span class="c-muted">${esc(r.d.trigger || "")}</span></td>
        <td class="hide-sm">${r.d.records != null ? r.d.records.toLocaleString() : r.d.counts ? Object.values(r.d.counts).reduce((a, b) => a + b, 0).toLocaleString() : "—"}</td>
        <td class="hide-md"><span class="hash">${esc(r.d.manifestSha256 || r.d.backupManifestSha256 || "")}</span></td>
        <td>${r.d.folderUrl ? `<a href="${esc(r.d.folderUrl)}" target="_blank" rel="noopener">Backup files</a><br>` : ""}${r.d.runUrl ? `<a href="${esc(r.d.runUrl)}" target="_blank" rel="noopener">Run log</a>` : ""}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty"><h3>${S.backupsLoading ? "Loading…" : "No backups recorded yet"}</h3><p>Backup runs appear here once the nightly backup is set up.</p></div>`}</section>
    <section class="card section-card" style="margin-top:16px"><h2>How backups work</h2>
      <ul class="steps-list">
        <li>Every night at 02:00 (Lagos time), GitHub Actions copies every list (tickets, conversations, history, feedback, settings and this activity log) into the <b>ServiceDeskBackups</b> folder of your SharePoint site.</li>
        <li>Each file gets a SHA-256 fingerprint. The backup then reads every file back and checks the fingerprints match before it’s marked as verified.</li>
        <li>Each backup folder contains a <b>manifest</b> and an <b>evidence report</b> that auditors can check independently. GitHub keeps a second copy and an unchangeable run log.</li>
        <li>To back up on demand, open GitHub → Actions → <b>Nightly backup</b> → Run workflow. To prove a restore works, run <b>Restore test</b> into an empty test site.</li>
      </ul></section>`;
}
/* ---------- reports ---------- */
const RP_PERIODS = [["7d", "Last 7 days"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["month", "This month"], ["lastmonth", "Last month"], ["quarter", "This quarter"], ["year", "This year"], ["custom", "Custom range"]];
const RP_TABS = [["overview", "Overview"], ["sla", "SLA performance"], ["agents", "Agent performance"], ["csat", "Customer satisfaction"], ["breakdown", "Breakdown"]];
function rpState() { if (!S.rp) S.rp = { period: "30d", from: isoDay(Date.now() - 29 * 864e5), to: isoDay(Date.now()), dept: "", agent: "", tab: "overview", lowOnly: false }; return S.rp; }
function rpRange() {
  const r = rpState(), now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let from, to = Date.now();
  switch (r.period) {
    case "7d": from = sod(new Date(Date.now() - 6 * 864e5)); break;
    case "90d": from = sod(new Date(Date.now() - 89 * 864e5)); break;
    case "month": from = new Date(y, m, 1).getTime(); break;
    case "lastmonth": from = new Date(y, m - 1, 1).getTime(); to = new Date(y, m, 1).getTime() - 1; break;
    case "quarter": from = new Date(y, Math.floor(m / 3) * 3, 1).getTime(); break;
    case "year": from = new Date(y, 0, 1).getTime(); break;
    case "custom": from = dayStart(r.from); to = dayStart(r.to) + 864e5 - 1; break;
    default: from = sod(new Date(Date.now() - 29 * 864e5));
  }
  return { from, to };
}
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = (n, d) => d ? Math.round(100 * n / d) + "%" : "—";
const hrs = ms => ms == null ? "—" : dur(ms);
function rpData() {
  const r = rpState(), { from, to } = rpRange();
  const scope = S.tickets.filter(t => (!r.dept || t.department === r.dept) && (!r.agent || (r.agent === "__none" ? !t.assigneeEmail : t.assigneeEmail === r.agent)));
  const created = scope.filter(t => t.createdAt >= from && t.createdAt <= to);
  const resolved = scope.filter(t => t.status === "Closed" && t.closedAt >= from && t.closedAt <= to);
  const ids = new Set(scope.map(t => t.id));
  const fb = (S.allFb || []).filter(f => ids.has(f.ticketId) && f.at >= from && f.at <= to);
  return { from, to, scope, created, resolved, fb, open: scope.filter(t => t.status !== "Closed") };
}
function frStats(list) { const w = list.filter(t => t.firstResponseAt); const due = w.filter(t => t.firstResponseDueAt); return { avg: avg(w.map(t => t.firstResponseAt - t.createdAt)), met: due.filter(t => t.firstResponseAt <= t.firstResponseDueAt).length, of: due.length }; }
function resStats(list) { const c = list.filter(t => t.closedAt); const due = c.filter(t => t.dueAt); return { avg: avg(c.map(t => t.closedAt - t.createdAt)), met: due.filter(t => t.closedAt <= t.dueAt).length, of: due.length }; }
function csatStats(fb) { return { n: fb.length, sat: fb.filter(f => f.rating >= 4).length, avg: avg(fb.map(f => f.rating)) }; }
function buckets(from, to) {
  const days = (to - from) / 864e5, out = [];
  const unit = days <= 31 ? "day" : days <= 140 ? "week" : "month";
  let d = new Date(from); d.setHours(0, 0, 0, 0);
  if (unit === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (unit === "month") d.setDate(1);
  while (d.getTime() <= to && out.length < 400) {
    const s = d.getTime();
    if (unit === "day") d.setDate(d.getDate() + 1); else if (unit === "week") d.setDate(d.getDate() + 7); else d.setMonth(d.getMonth() + 1);
    out.push({ s, e: d.getTime() - 1, label: unit === "month" ? new Date(s).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : new Date(s).toLocaleDateString(undefined, { day: "numeric", month: "short" }) });
  }
  return { unit, list: out };
}
function lineChart(labels, series, opts) {
  opts = opts || {}; const W = 760, H = 240, L = 40, R = 12, T = 14, B = 34;
  const max = Math.max(opts.max || 0, 1, ...series.flatMap(s => s.values.filter(v => v != null)));
  const top = opts.max || Math.ceil(max / 4) * 4 || 4;
  const x = i => L + (labels.length < 2 ? (W - L - R) / 2 : i * (W - L - R) / (labels.length - 1));
  const y = v => T + (H - T - B) * (1 - v / top);
  const grid = [0, 1, 2, 3, 4].map(k => { const v = top * k / 4; return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${opts.suffix ? Math.round(v) + opts.suffix : Math.round(v * 10) / 10}</text>`; }).join("");
  const step = Math.max(1, Math.ceil(labels.length / 8));
  const xl = labels.map((l, i) => i % step === 0 || i === labels.length - 1 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" class="ax">${esc(l)}</text>` : "").join("");
  const lines = series.map(s => {
    const pts = s.values.map((v, i) => v == null ? null : [x(i), y(v), v, i]).filter(Boolean);
    return `<polyline fill="none" style="stroke:${s.color};stroke-width:2.5" points="${pts.map(p => p[0] + "," + p[1]).join(" ")}"/>` + pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" style="fill:${s.color}"><title>${esc(s.name)}, ${esc(labels[p[3]])}: ${opts.suffix ? Math.round(p[2]) + opts.suffix : p[2]}</title></circle>`).join("");
  }).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || "Chart")}">${grid}${xl}${lines}</svg>
    <div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div></div>`;
}
function rpTable(head, rows, empty) {
  return rows.length ? `<div class="table-card"><table class="dtable rp-table"><thead><tr>${head.map(h => `<th${h.n ? ' class="num"' : ""}>${h.t}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<p class="c-muted" style="margin:0">${empty}</p>`;
}
function renderReports() {
  const r = rpState(), D = rpData();
  if (!S.allFb && !S.allFbLoading) { S.allFbLoading = true; api("GET", "/feedback/all").then(x => { S.allFb = x; S.allFbLoading = false; render(); }).catch(() => { S.allFb = []; S.allFbLoading = false; }); }
  const tab = { overview: rpOverview, sla: rpSla, agents: rpAgents, csat: rpCsat, breakdown: rpBreakdown }[r.tab] || rpOverview;
  const label = (RP_PERIODS.find(p => p[0] === r.period) || [])[1];
  return `<div class="page reports">
    <div class="page-head"><div><h1>Reports</h1><p>${esc(label)}: ${new Date(D.from).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} to ${new Date(D.to).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}${r.dept ? `, ${esc(r.dept)}` : ""}${r.agent ? `, ${esc(r.agent === "__none" ? "Unassigned" : ((S.settings.users || []).find(u => u.email === r.agent) || {}).name || r.agent)}` : ""}</p></div>
      <div class="rp-actions"><button class="btn" data-act="rpexport">${ico("up")}Export to Excel</button><button class="btn" data-act="rpprint">Print or save as PDF</button></div></div>
    <div class="card rp-filters">
      <div class="field"><label for="rpPeriod">Period</label><select id="rpPeriod" data-rp="period">${RP_PERIODS.map(p => `<option value="${p[0]}"${r.period === p[0] ? " selected" : ""}>${p[1]}</option>`).join("")}</select></div>
      ${r.period === "custom" ? `<div class="field"><label for="rpFrom">From</label><input type="date" id="rpFrom" data-rp="from" value="${r.from}"></div><div class="field"><label for="rpTo">To</label><input type="date" id="rpTo" data-rp="to" value="${r.to}"></div>` : ""}
      <div class="field"><label for="rpDept">Department</label><select id="rpDept" data-rp="dept"><option value="">All departments</option>${opt(S.settings.departments, r.dept)}</select></div>
      <div class="field"><label for="rpAgent">Agent</label><select id="rpAgent" data-rp="agent"><option value="">All agents</option>${(S.settings.users || []).map(u => `<option value="${esc(u.email)}"${r.agent === u.email ? " selected" : ""}>${esc(u.name)}</option>`).join("")}<option value="__none"${r.agent === "__none" ? " selected" : ""}>Unassigned</option></select></div>
    </div>
    <nav class="rp-tabs" role="tablist">${RP_TABS.map(t => `<button role="tab" data-rptab="${t[0]}" aria-selected="${r.tab === t[0]}">${t[1]}</button>`).join("")}</nav>
    ${tab(D)}
    <p class="c-muted rp-note">Times are measured in calendar hours from when a ticket was opened. Volume counts tickets opened in the period, resolution figures count tickets closed in the period, and satisfaction counts ratings given in the period.</p>
  </div>`;
}
function rpOverview(D) {
  const fr = frStats(D.created), rs = resStats(D.resolved), cs = csatStats(D.fb);
  const B = buckets(D.from, D.to);
  const c = B.list.map(b => D.created.filter(t => t.createdAt >= b.s && t.createdAt <= b.e).length);
  const z = B.list.map(b => D.resolved.filter(t => t.closedAt >= b.s && t.closedAt <= b.e).length);
  return `<div class="kpis">
      <div class="kpi"><div class="l">Tickets opened</div><div class="v">${D.created.length}</div></div>
      <div class="kpi"><div class="l">Tickets resolved</div><div class="v">${D.resolved.length}</div></div>
      <div class="kpi"><div class="l">Open now</div><div class="v">${D.open.length}</div></div>
      <div class="kpi"><div class="l">Average first response</div><div class="v">${hrs(fr.avg)}</div></div>
      <div class="kpi"><div class="l">Average time to resolve</div><div class="v">${hrs(rs.avg)}</div></div>
      <div class="kpi"><div class="l">Resolved within target</div><div class="v">${pct(rs.met, rs.of)}</div></div>
      <div class="kpi"><div class="l">Customer satisfaction</div><div class="v">${pct(cs.sat, cs.n)}</div></div>
    </div>
    <section class="card panel"><h2>Opened and resolved, by ${B.unit}</h2>${lineChart(B.list.map(b => b.label), [{ name: "Opened", color: "var(--navy-chart)", values: c }, { name: "Resolved", color: "var(--green)", values: z }], { title: "Tickets opened and resolved" })}</section>`;
}
function rpSla(D) {
  const fr = frStats(D.created), rs = resStats(D.resolved);
  const rows = PRIORITIES.map(p => { const c = D.created.filter(t => t.priority === p), z = D.resolved.filter(t => t.priority === p), f = frStats(c), x = resStats(z);
    return `<tr style="cursor:default"><td>${prio(p)}</td><td class="num">${c.length}</td><td class="num">${S.settings.sla.response[p]}h</td><td class="num">${hrs(f.avg)}</td><td class="num">${pct(f.met, f.of)}</td><td class="num">${S.settings.sla.resolution[p]}h</td><td class="num">${hrs(x.avg)}</td><td class="num">${pct(x.met, x.of)}</td></tr>`; });
  const breached = [...D.resolved.filter(t => t.dueAt && t.closedAt > t.dueAt), ...D.open.filter(t => isOverdue(t))].sort((a, b) => b.createdAt - a.createdAt);
  const B = buckets(D.from, D.to);
  const trend = B.list.map(b => { const z = D.resolved.filter(t => t.closedAt >= b.s && t.closedAt <= b.e && t.dueAt); return z.length ? Math.round(100 * z.filter(t => t.closedAt <= t.dueAt).length / z.length) : null; });
  return `<div class="kpis">
      <div class="kpi"><div class="l">First response within target</div><div class="v">${pct(fr.met, fr.of)}</div><div class="c-muted kpi-sub">${fr.met} of ${fr.of} tickets</div></div>
      <div class="kpi"><div class="l">Resolved within target</div><div class="v">${pct(rs.met, rs.of)}</div><div class="c-muted kpi-sub">${rs.met} of ${rs.of} tickets</div></div>
      <div class="kpi ${breached.length ? "alert" : ""}"><div class="l">Breached or overdue</div><div class="v">${breached.length}</div></div>
    </div>
    <section class="card panel"><h2>Targets by priority</h2>${rpTable([{ t: "Priority" }, { t: "Opened", n: 1 }, { t: "Response target", n: 1 }, { t: "Avg first response", n: 1 }, { t: "Response met", n: 1 }, { t: "Resolution target", n: 1 }, { t: "Avg resolution", n: 1 }, { t: "Resolution met", n: 1 }], rows, "")}</section>
    <section class="card panel" style="margin-top:16px"><h2>Resolution within target, by ${B.unit}</h2>${lineChart(B.list.map(b => b.label), [{ name: "Resolved within target", color: "var(--green)", values: trend }], { max: 100, suffix: "%", title: "SLA trend" })}</section>
    <section class="card panel" style="margin-top:16px"><h2>Tickets that missed their target (${breached.length})</h2>${rpTable([{ t: "Ticket" }, { t: "Subject" }, { t: "Priority" }, { t: "Assignee" }, { t: "Target" }, { t: "Missed by", n: 1 }],
      breached.slice(0, 200).map(t => `<tr data-open="${t.id}" tabindex="0"><td class="c-num">#${t.number}</td><td>${esc(t.subject)}</td><td>${prio(t.priority)}</td><td>${esc(t.assigneeName || "Unassigned")}</td><td class="c-muted">${fmt(t.dueAt)}</td><td class="num bad-txt">${dur((t.closedAt || Date.now()) - t.dueAt)}${t.closedAt ? "" : " (still open)"}</td></tr>`), "No ticket missed its target in this period.")}</section>`;
}
function rpAgents(D) {
  const people = [...(S.settings.users || []).map(u => ({ name: u.name, email: u.email })), { name: "Unassigned", email: "" }];
  const rows = people.map(p => {
    const mine = t => (t.assigneeEmail || "") === p.email;
    const c = D.created.filter(mine), z = D.resolved.filter(mine), o = D.open.filter(mine), f = frStats(c), x = resStats(z);
    const tids = new Set(D.scope.filter(mine).map(t => t.id)); const fb = csatStats(D.fb.filter(r => tids.has(r.ticketId)));
    if (!c.length && !z.length && !o.length && !fb.n) return null;
    return { p, c: c.length, z: z.length, o: o.length, f, x, fb };
  }).filter(Boolean).sort((a, b) => b.z - a.z);
  return `<section class="card panel"><h2>Agent performance</h2>${rpTable([{ t: "Agent" }, { t: "Assigned", n: 1 }, { t: "Resolved", n: 1 }, { t: "Open now", n: 1 }, { t: "Avg first response", n: 1 }, { t: "Avg resolution", n: 1 }, { t: "Within target", n: 1 }, { t: "CSAT", n: 1 }, { t: "Avg rating", n: 1 }],
    rows.map(r => `<tr style="cursor:default"><td><div class="c-who"><span class="avatar">${esc(initials(r.p.name))}</span><b>${esc(r.p.name)}</b></div></td><td class="num">${r.c}</td><td class="num">${r.z}</td><td class="num">${r.o}</td><td class="num">${hrs(r.f.avg)}</td><td class="num">${hrs(r.x.avg)}</td><td class="num">${pct(r.x.met, r.x.of)}</td><td class="num">${pct(r.fb.sat, r.fb.n)}${r.fb.n ? ` <span class="c-muted">(${r.fb.n})</span>` : ""}</td><td class="num">${r.fb.avg ? r.fb.avg.toFixed(1) : "—"}</td></tr>`), "No agent activity in this period.")}</section>
    <section class="card panel" style="margin-top:16px"><h2>Tickets resolved, by agent</h2>${bars(Object.fromEntries(rows.filter(r => r.z).map(r => [r.p.name, r.z])))}</section>`;
}
function rpCsat(D) {
  const cs = csatStats(D.fb), r = rpState();
  const closedInPeriod = D.resolved.length;
  const dist = [5, 4, 3, 2, 1].map(n => [n, D.fb.filter(f => f.rating === n).length]);
  const B = buckets(D.from, D.to);
  const trend = B.list.map(b => { const x = D.fb.filter(f => f.at >= b.s && f.at <= b.e); return x.length ? Math.round(100 * x.filter(f => f.rating >= 4).length / x.length) : null; });
  const list = D.fb.filter(f => !r.lowOnly || f.rating <= 2).sort((a, b) => b.at - a.at);
  return `<div class="kpis">
      <div class="kpi"><div class="l">CSAT score</div><div class="v">${pct(cs.sat, cs.n)}</div><div class="c-muted kpi-sub">Share of ratings that are 4 or 5</div></div>
      <div class="kpi"><div class="l">Average rating</div><div class="v">${cs.avg ? cs.avg.toFixed(1) : "—"}<span class="kpi-unit">/5</span></div></div>
      <div class="kpi"><div class="l">Ratings received</div><div class="v">${cs.n}</div></div>
      <div class="kpi"><div class="l">Response rate</div><div class="v">${pct(cs.n, closedInPeriod)}</div><div class="c-muted kpi-sub">Ratings per ticket closed</div></div>
    </div>
    <div class="grid2">
      <section class="card panel"><h2>Rating distribution</h2>${dist.map(([n, v]) => `<div class="bar"><span>${stars(n)}</span><span class="track"><i style="width:${cs.n ? (v / Math.max(...dist.map(d => d[1]), 1)) * 100 : 0}%;background:${n >= 4 ? "var(--green)" : n === 3 ? "#E89A1E" : "var(--red)"}"></i></span><b>${v}</b></div>`).join("")}</section>
      <section class="card panel"><h2>CSAT by ${B.unit}</h2>${lineChart(B.list.map(b => b.label), [{ name: "CSAT", color: "var(--green)", values: trend }], { max: 100, suffix: "%", title: "CSAT trend" })}</section>
    </div>
    <section class="card panel" style="margin-top:16px"><div class="panel-head"><h2>Comments and ratings (${list.length})</h2><label class="switch" style="margin:0"><input type="checkbox" data-rp="lowOnly" ${r.lowOnly ? "checked" : ""}><span>Only low ratings (1–2)</span></label></div>
      ${list.length ? `<ul class="fb-list">${list.slice(0, 300).map(f => { const t = S.tickets.find(x => x.id === f.ticketId); return `<li><div>${stars(f.rating)} <b>${esc(RATING_LABELS[f.rating])}</b> <button class="linkish" data-open="${f.ticketId}">Ticket #${f.number}</button></div><div class="meta"><span>${esc(t ? t.requesterName : f.requesterEmail)}</span><span>Agent: ${esc(f.assigneeName || "Unassigned")}</span><span>${fmt(f.at)}</span><span>via ${esc(f.via)}</span></div>${f.comment ? `<blockquote>“${esc(f.comment)}”</blockquote>` : ""}</li>`; }).join("")}</ul>` : `<p class="c-muted" style="margin:0">${S.allFbLoading ? "Loading…" : "No ratings in this period."}</p>`}</section>`;
}
function rpBreakdown(D) {
  const count = (list, key) => list.reduce((m, t) => { const k = key(t) || "Not set"; m[k] = (m[k] || 0) + 1; return m; }, {});
  const reqs = Object.entries(count(D.created, t => t.requesterName || t.requesterEmail)).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const tags = {}; D.created.forEach(t => t.tags.forEach(g => { tags[g] = (tags[g] || 0) + 1; }));
  return `<div class="grid2">
      <section class="card panel"><h2>By department</h2>${bars(count(D.created, t => t.department))}</section>
      <section class="card panel"><h2>By channel</h2>${bars(count(D.created, t => t.channel))}</section>
      <section class="card panel"><h2>By priority</h2>${bars(count(D.created, t => t.priority))}</section>
      <section class="card panel"><h2>By current status</h2>${bars(count(D.created, t => t.status))}</section>
      <section class="card panel"><h2>Top requesters</h2>${reqs.length ? rpTable([{ t: "Requester" }, { t: "Tickets", n: 1 }], reqs.map(([k, v]) => `<tr style="cursor:default"><td>${esc(k)}</td><td class="num">${v}</td></tr>`), "") : `<p class="c-muted" style="margin:0">No tickets in this period.</p>`}</section>
      <section class="card panel"><h2>Top tags</h2>${Object.keys(tags).length ? bars(Object.fromEntries(Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 10))) : `<p class="c-muted" style="margin:0">No tags used in this period.</p>`}</section>
    </div>`;
}
function exportReport() {
  const D = rpData(), r = rpState();
  const fbBy = new Map((S.allFb || []).map(f => [f.ticketId, f]));
  const cell = v => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const h = ms => ms == null ? "" : (ms / 36e5).toFixed(2);
  const iso = t => t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) : "";
  const head = ["Ticket", "Subject", "Status", "Priority", "Department", "Channel", "Requester", "Requester email", "Assignee", "Opened (UTC)", "First response (UTC)", "First response hours", "First response within target", "Resolution due (UTC)", "Closed (UTC)", "Resolution hours", "Resolved within target", "Rating", "Rating comment", "Tags"];
  const list = [...new Map([...D.created, ...D.resolved].map(t => [t.id, t])).values()].sort((a, b) => a.number - b.number);
  const lines = [head.join(",")].concat(list.map(t => { const f = fbBy.get(t.id); return [t.number, t.subject, t.status, t.priority, t.department, t.channel, t.requesterName, t.requesterEmail, t.assigneeName, iso(t.createdAt), iso(t.firstResponseAt), h(t.firstResponseAt ? t.firstResponseAt - t.createdAt : null), t.firstResponseAt && t.firstResponseDueAt ? (t.firstResponseAt <= t.firstResponseDueAt ? "Yes" : "No") : "", iso(t.dueAt), iso(t.closedAt), h(t.closedAt ? t.closedAt - t.createdAt : null), t.closedAt && t.dueAt ? (t.closedAt <= t.dueAt ? "Yes" : "No") : "", f ? f.rating : "", f ? f.comment : "", t.tags.join("; ")].map(cell).join(","); }));
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `service-desk-report-${isoDay(D.from)}-to-${isoDay(D.to)}.csv`; document.body.appendChild(a); a.click(); a.remove();
  api("POST", "/reports/export", { report: (RP_TABS.find(t => t[0] === r.tab) || [])[1], from: isoDay(D.from), to: isoDay(D.to), filters: { department: r.dept, agent: r.agent }, rows: list.length }).catch(() => { });
  toast(`Exported ${list.length} tickets. Open the file in Excel.`);
}
root.addEventListener("click", e => {
  const el = e.target.closest("[data-rptab],[data-act='rpexport'],[data-act='rpprint']"); if (!el) return;
  if (el.dataset.rptab) { rpState().tab = el.dataset.rptab; render(); return; }
  if (el.dataset.act === "rpexport") exportReport();
  if (el.dataset.act === "rpprint") window.print();
});
root.addEventListener("change", e => {
  const t = e.target; if (!t.dataset.rp) return;
  const r = rpState(); r[t.dataset.rp] = t.type === "checkbox" ? t.checked : t.value; render();
});

function fbDraft() { if (!S.fbDraft) S.fbDraft = JSON.parse(JSON.stringify(S.settings.feedback || { enabled: true, question: "How did we do?", intro: "Rate the support you received. It takes one click.", linkDays: 30, alertAt: 2, alertEmails: [] })); return S.fbDraft; }
function setFeedback() {
  const d = fbDraft(); const dirty = JSON.stringify(d) !== JSON.stringify(S.settings.feedback);
  const users = (S.settings.users || []).filter(u => !d.alertEmails.includes(u.email));
  return `<section class="card section-card"><h2>Customer satisfaction survey</h2><p>When a ticket is closed, the requester’s email asks them to rate the support from 1 to 5. Results appear under <b>Reports → Customer satisfaction</b>.</p>
    <label class="switch"><input type="checkbox" data-fb="enabled" ${d.enabled ? "checked" : ""}><span>Ask for feedback when a ticket is closed</span></label>
    <fieldset class="bh" ${d.enabled ? "" : "disabled"}>
      <div class="cols"><div class="field"><label for="fbQ">Question</label><input id="fbQ" data-fb="question" maxlength="120" value="${esc(d.question)}"></div>
      <div class="field"><label for="fbDays">Rating links stay valid for</label><div class="hours"><input type="number" id="fbDays" data-fb="linkDays" min="3" max="90" value="${d.linkDays}"><span>days</span></div></div>
      <div class="field full"><label for="fbIntro">Line under the question</label><input id="fbIntro" data-fb="intro" maxlength="300" value="${esc(d.intro)}"></div></div>
      <span class="flabel">Preview</span>
      <div class="fb-preview"><b>${esc(d.question)}</b><span>${esc(d.intro)}</span><div>${[1, 2, 3, 4, 5].map(n => `<i><strong>${n}</strong>${RATING_LABELS[n]}</i>`).join("")}</div></div>
    </fieldset></section>
  <section class="card section-card" style="margin-top:16px"><h2>Low-rating alerts</h2><p>Follow up quickly when someone is unhappy. The agent on the ticket and the people below get an email with the rating and comment.</p>
    <div class="field" style="max-width:360px"><label for="fbAlert">Send an alert when the rating is</label><select id="fbAlert" data-fb="alertAt">${[[0, "Never (alerts off)"], [1, "1 (very dissatisfied)"], [2, "2 or lower"], [3, "3 or lower"]].map(o => `<option value="${o[0]}"${d.alertAt === o[0] ? " selected" : ""}>${o[1]}</option>`).join("")}</select></div>
    <fieldset class="bh" ${d.alertAt ? "" : "disabled"}><span class="flabel">Also alert</span>
      <div class="chips">${d.alertEmails.length ? d.alertEmails.map(e2 => `<span>${esc(((S.settings.users || []).find(u => u.email === e2) || {}).name || e2)}<button data-fbremove="${esc(e2)}" aria-label="Remove ${esc(e2)}">×</button></span>`).join("") : `<small class="c-muted">Only the assigned agent is alerted.</small>`}</div>
      <div class="addrow" style="max-width:520px"><input id="fbAddEmail" list="fbUsers" type="email" placeholder="Supervisor or manager email" aria-label="Email to alert"><datalist id="fbUsers">${users.map(u => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join("")}</datalist><button class="btn" data-act="fbaddemail">Add</button></div>
    </fieldset></section>
  <div class="savebar card"><span>${dirty ? "You have unsaved changes." : "All changes saved."}</span><span class="savebar-actions"><button class="btn" data-act="fbreset" ${dirty ? "" : "disabled"}>Discard</button><button class="btn primary" data-act="fbsave" ${dirty ? "" : "disabled"}>Save feedback settings</button></span></div>`;
}
root.addEventListener("click", async e => {
  const el = e.target.closest("[data-fbremove],[data-act^='fb']"); if (!el || !S.user?.isAdmin) return;
  const d = fbDraft();
  if (el.dataset.fbremove) { d.alertEmails = d.alertEmails.filter(x => x !== el.dataset.fbremove); render(); return; }
  const a = el.dataset.act;
  if (a === "fbaddemail") { const i = document.getElementById("fbAddEmail"); const v = (i.value || "").trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { toast("Enter a valid email address."); return; } if (!d.alertEmails.includes(v)) d.alertEmails = [...d.alertEmails, v]; render(); return; }
  if (a === "fbreset") { S.fbDraft = null; render(); return; }
  if (a === "fbsave") { try { const r = await api("PUT", "/settings", { feedback: d }); S.settings = { ...S.settings, ...r }; S.fbDraft = null; toast("Feedback settings saved"); } catch (e2) { } render(); }
});
root.addEventListener("input", e => { const t = e.target; if (!t.dataset.fb || t.type === "checkbox" || t.tagName === "SELECT") return; const d = fbDraft(); d[t.dataset.fb] = t.type === "number" ? Number(t.value) : t.value; const bar = document.querySelector(".savebar"); if (bar) { const dirty = JSON.stringify(d) !== JSON.stringify(S.settings.feedback); bar.querySelector("span").textContent = dirty ? "You have unsaved changes." : "All changes saved."; bar.querySelectorAll("button").forEach(b => b.disabled = !dirty); } const pv = document.querySelector(".fb-preview"); if (pv) { pv.querySelector("b").textContent = d.question; pv.querySelector("span").textContent = d.intro; } });
root.addEventListener("change", e => { const t = e.target; if (!t.dataset.fb) return; const d = fbDraft(); if (t.type === "checkbox") d[t.dataset.fb] = t.checked; else if (t.tagName === "SELECT") d[t.dataset.fb] = Number(t.value); else return; render(); });

async function saveSettingsPart(part, msg) {
  try { const r = await api("PUT", "/settings", part); S.settings = { ...S.settings, ...r }; S.slaDraft = null; toast(msg || "Settings saved"); } catch (e) { }
  render();
}
let dirTimer = null;
async function runDirSearch() {
  const q = S.uq.trim(); if (q.length < 2) { S.dir = []; render(); return; }
  try { const r = await api("GET", "/directory?q=" + encodeURIComponent(q)); if (q !== S.uq.trim()) return; S.dirAvailable = r.available; S.dir = r.people || []; } catch (e) { S.dir = []; }
  render();
}
function setPath(obj, path, val) { const k = path.split("."); let o = obj; for (let i = 0; i < k.length - 1; i++) o = o[k[i]]; o[k[k.length - 1]] = val; }
root.addEventListener("click", async e => {
  const el = e.target.closest("[data-stab],[data-pick],[data-uremove],[data-dremove],[data-holremove],[data-act^='u'],[data-act^='sla'],[data-act^='hol'],[data-act^='dept'],[data-act^='logo'],[data-act='mailcheck']");
  if (el && el.dataset.act === "logexport") { exportAudit(); return; }
  if (!el || !S.user || !S.user.isAdmin) return;
  if (el.dataset.stab) { S.stab = el.dataset.stab; if (S.stab === "audit") S.auditRows = null; if (S.stab === "backups") S.backups = null; S.fbDraft = null; render(); return; }
  if (el.dataset.pick != null) { const p = S.dir[Number(el.dataset.pick)]; S.unew = { ...S.unew, name: p.name, email: p.email }; S.uq = ""; S.dir = []; render(); document.getElementById("uRole")?.focus(); return; }
  const users = S.settings.users || [];
  if (el.dataset.uremove) {
    const u = users.find(x => x.email === el.dataset.uremove); if (!u) return;
    const admins = users.filter(x => x.role === "Admin");
    if (u.role === "Admin" && admins.length === 1 && u.email === S.user.email) { toast("Add another admin before removing yourself."); return; }
    if (!confirm(`Remove ${u.name}? They’ll lose access to the agent desk. Tickets assigned to them stay assigned until you change them.`)) return;
    await saveSettingsPart({ users: users.filter(x => x.email !== u.email) }, `${u.name} removed`); return;
  }
  if (el.dataset.dremove != null) { const ds = [...S.settings.departments]; const [gone] = ds.splice(Number(el.dataset.dremove), 1); await saveSettingsPart({ departments: ds }, `${gone} removed`); return; }
  if (el.dataset.holremove) { const d = slaDraft(); d.holidays = d.holidays.filter(h => h !== el.dataset.holremove); render(); return; }
  const a = el.dataset.act;
  if (a === "uadd") {
    const name = (S.unew.name || "").trim(), email = (S.unew.email || "").trim().toLowerCase(), role = S.unew.role || "Agent";
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Enter the person’s full name and a valid work email."); return; }
    if (users.some(u => u.email === email)) { toast("That person is already a user."); return; }
    S.unew = { name: "", email: "", role: "Agent" };
    await saveSettingsPart({ users: [...users, { name, email, role }] }, `${name} added as ${role === "Admin" ? "an admin" : "an agent"}`); return;
  }
  if (a === "holadd") { const v = document.getElementById("holIn").value; if (!v) { toast("Pick a date first."); return; } const d = slaDraft(); if (!d.holidays.includes(v)) d.holidays = [...d.holidays, v].sort(); render(); return; }
  if (a === "slareset") { S.slaDraft = null; render(); return; }
  if (a === "slasave") { await saveSettingsPart({ sla: slaDraft() }, "SLA policy saved"); return; }
  if (a === "deptadd") {
    const i = document.getElementById("deptIn"); const v = i.value.trim(); if (!v) return;
    if (S.settings.departments.some(d => d.toLowerCase() === v.toLowerCase())) { toast("That department already exists."); return; }
    await saveSettingsPart({ departments: [...S.settings.departments, v] }, `${v} added`); return;
  }
  if (a === "logoremove") { if (!confirm("Remove the logo? The desk and emails will show the name as text instead.")) return; try { const r = await api("DELETE", "/brand/logo"); S.settings = { ...S.settings, ...r }; toast("Logo removed"); } catch (e2) { } render(); return; }
  if (a === "mailcheck") { S.mailChecking = true; render(); try { const r = await api("POST", "/mail/check"); toast(`Mailbox checked: ${r.created} new tickets, ${r.replies} replies added.`); await loadAgent(); } catch (e2) { } S.mailChecking = false; render(); return; }
});
root.addEventListener("input", e => {
  const t = e.target; if (!S.user || !S.user.isAdmin) return;
  if (t.id === "uSearch") { S.uq = t.value; clearTimeout(dirTimer); dirTimer = setTimeout(runDirSearch, 300); if (t.value.trim().length < 2) { S.dir = []; render(); } return; }
  if (t.dataset.unew) { S.unew[t.dataset.unew] = t.value; return; }
  if (t.dataset.sla && t.type === "number") { const v = Number(t.value); if (t.value !== "" && Number.isFinite(v)) { setPath(slaDraft(), t.dataset.sla, v); updateSaveBar(); } }
});
function updateSaveBar() { const bar = document.querySelector(".savebar"); if (!bar) return; const d = slaDraft(); const dirty = JSON.stringify(d) !== JSON.stringify(S.settings.sla); bar.querySelector("span").innerHTML = `${dirty ? "You have unsaved changes." : "All changes saved."} With these settings, a High priority ticket raised now would be due by <b>${fmt(addBusinessTime(Date.now(), d.resolution.High, d))}</b>.`; bar.querySelectorAll("button").forEach(b => b.disabled = !dirty); }
root.addEventListener("change", async e => {
  const t = e.target; if (!S.user || !S.user.isAdmin) return;
  if (t.dataset.unew) { S.unew[t.dataset.unew] = t.value; return; }
  if (t.dataset.urole) { const users = S.settings.users.map(u => u.email === t.dataset.urole ? { ...u, role: t.value } : u); if (!users.some(u => u.role === "Admin") && S.settings.users.some(u => u.role === "Admin")) { if (!confirm("There will be no admins left in this list. Anyone with the Service Desk Agent role in Entra will then be able to manage settings. Continue?")) { render(); return; } } await saveSettingsPart({ users }, "Role updated"); return; }
  if (t.dataset.sla) { const v = t.type === "checkbox" ? t.checked : t.type === "number" || t.dataset.sla.endsWith("utcOffset") ? Number(t.value) : t.value; setPath(slaDraft(), t.dataset.sla, v); render(); return; }
  if (t.dataset.sladay != null) { const d = slaDraft(); const set = new Set(d.businessHours.days.map(Number)); t.checked ? set.add(Number(t.dataset.sladay)) : set.delete(Number(t.dataset.sladay)); d.businessHours.days = [...set].sort(); render(); return; }
  if (t.id === "logoFile" && t.files && t.files[0]) {
    const f = t.files[0];
    if (!/^image\/(png|jpeg)$/.test(f.type)) { toast("Choose a PNG or JPG image."); return; }
    if (f.size > 1024 * 1024) { toast("The logo must be smaller than 1 MB."); return; }
    S.uploading = true; render();
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
    try { const r = await api("PUT", "/brand/logo", { dataUrl }); S.settings = { ...S.settings, ...r }; toast("Logo updated. It now appears across the desk and in emails."); } catch (e2) { }
    S.uploading = false; render();
  }
});
root.addEventListener("change", e => { const t = e.target; if (!t.dataset.af || !S.user?.isAdmin) return; auditFilters()[t.dataset.af] = t.value; if (t.dataset.af === "from" || t.dataset.af === "to") loadAudit(); else render(); });
root.addEventListener("input", e => { const t = e.target; if (t.dataset.af === "q") { auditFilters().q = t.value; render(); } });
root.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "deptIn") { e.preventDefault(); document.querySelector('[data-act="deptadd"]')?.click(); } });

/* ---------- start ---------- */
function fatal(msg) { root.innerHTML = `<div class="signin-form" style="min-height:100%"><div class="signin-card"><div class="logo">${logoHTML()}</div><h2>We can’t open the service desk</h2><p>${esc(msg)}</p><button class="btn primary">Try again</button></div></div>`; document.querySelector(".signin-card .btn").onclick = () => location.reload(); }
function renderSignIn() {
  root.innerHTML = `<div class="signin">
    <section class="signin-brand">
      <div><h1>${esc(S.cfg.orgName)} Service Desk</h1><p>One place to raise requests, follow their progress and get help from the support team.</p>
        <ul><li>${ico("edit")}Raise requests in a few clicks</li><li>${ico("bell")}Email updates at every step</li><li>${ico("shield")}Secured with your Microsoft 365 account</li></ul></div>
      <div class="small">Support: ${esc(S.cfg.supportEmail)}</div>
    </section>
    <section class="signin-form"><div class="signin-card">
      <div class="logo">${logoHTML(false)}</div>
      <h2>Sign in</h2><p>Use your ${esc(S.cfg.orgName)} work account.</p>
      <button class="btn primary" id="signInBtn">Sign in with Microsoft</button>
      <p class="help">Having trouble signing in? Email ${esc(S.cfg.supportEmail)}.</p>
    </div></section></div>`;
  document.getElementById("signInBtn").onclick = () => pca.loginRedirect({ scopes: SCOPES });
}
function checkLogo() {
  return new Promise(res => { const img = new Image(); img.onload = () => { S.logoOk = img.naturalWidth > 0; res(); }; img.onerror = () => res(); img.src = "/brand/logo.png"; setTimeout(res, 2500); });
}
async function boot() {
  try { S.cfg = await (await fetch("/api/config")).json(); } catch (e) { fatal("Couldn’t reach the server. Try again in a moment."); return; }
  if (!S.cfg || !S.cfg.clientId) { fatal((S.cfg && S.cfg.error) || "The server isn’t configured yet. Check the Netlify environment variables."); return; }
  if (!S.cfg.logoUrl) await checkLogo();
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
  if (["dashboard", "contacts", "portal", "settings", "reports"].includes(h)) S.page = h;
  if (VIEWS.some(v => v[0] === h)) { S.page = "tickets"; S.view = h; }
  if (!S.user.isAgent && (h === "portal" || h === "mine")) S.ptab = "mine";
  render();
  try {
    if (S.user.isAgent) { await loadAgent(); if (S.page === "portal") await loadMine(); }
    else { const s = await api("GET", "/settings"); S.settings = { ...S.settings, ...s }; await loadMine(); }
  } catch (e) { S.loadError = e.message || "Something went wrong."; }
  render();
  setInterval(async () => {
    if (document.hidden) return;
    try {
      if (S.user.isAgent) { await loadAgent(); if (S.page === "dashboard") S.recentFb = await api("GET", "/feedback/recent"); if (S.page === "reports") S.allFb = await api("GET", "/feedback/all"); if (S.selected) S.details[S.selected] = await api("GET", "/tickets/" + S.selected); }
      if (!S.user.isAgent || S.page === "portal") { await loadMine(); if (S.psel) S.myDetails[S.psel] = await api("GET", "/tickets/" + S.psel); }
      const a = document.activeElement;
      if (!(a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.tagName === "SELECT")) && !dlgNew.open) render();
    } catch (e) { }
  }, 30000);
}
boot();
})();
