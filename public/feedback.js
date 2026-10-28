(function () {
"use strict";
const root = document.getElementById("fb");
const params = new URLSearchParams(location.search);
const token = params.get("t") || "";
let state = { rating: Number(params.get("r")) || 0, comment: "", sending: false, done: false, info: null, error: "" };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LABELS = { 1: "Very dissatisfied", 2: "Dissatisfied", 3: "Neutral", 4: "Satisfied", 5: "Very satisfied" };

function shell(inner) {
  const i = state.info || {};
  const logo = i.logoUrl ? `<img src="${esc(i.logoUrl)}" alt="${esc(i.orgName || "InfraCredit")}">` : `<span class="wordmark">${esc(i.orgName || "InfraCredit")}</span>`;
  return `<header class="topbar fb-top"><div class="logo">${logo}<span class="product">Service Desk</span></div></header><main class="fb-main"><div class="card fb-card">${inner}</div></main>`;
}
function render() {
  if (state.error) { root.innerHTML = shell(`<h1>We couldn’t open this link</h1><p class="fb-sub">${esc(state.error)}</p><a class="btn primary" href="/#portal">Open the service desk</a>`); return; }
  if (!state.info) return;
  const i = state.info;
  if (state.done) {
    root.innerHTML = shell(`<div class="okmark"><svg class="ico" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div><h1 style="text-align:center">Thank you${i.name ? ", " + esc(i.name) : ""}</h1><p class="fb-sub" style="text-align:center">Your feedback on ticket #${i.number} has been recorded. It helps us improve the service we give you.</p><p style="text-align:center"><a class="btn" href="/#portal">Go to the service desk</a></p>`);
    return;
  }
  root.innerHTML = shell(`
    <h1>How did we do${i.name ? ", " + esc(i.name) : ""}?</h1>
    <p class="fb-sub">Ticket #${i.number}: ${esc(i.subject)}</p>
    ${i.rating ? `<p class="notice" style="margin-bottom:16px">You rated this ticket ${i.rating}/5 before. Sending again will update your rating.</p>` : ""}
    <fieldset class="rating"><legend class="flabel">How satisfied are you with the support you received?</legend>
      <div class="rating-row">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="r" value="${n}" ${state.rating === n ? "checked" : ""}><span><b>${n}</b>${LABELS[n]}</span></label>`).join("")}</div>
    </fieldset>
    <div class="field"><label for="c">Anything you’d like to add? (optional)</label><textarea id="c" rows="4" maxlength="4000" placeholder="What went well, or what could we do better?">${esc(state.comment)}</textarea></div>
    <div class="c-actions"><button class="btn primary" id="send" ${state.rating && !state.sending ? "" : "disabled"}>${state.sending ? "Sending…" : "Send feedback"}</button></div>`);
  root.querySelectorAll('input[name="r"]').forEach(r => r.onchange = () => { state.rating = Number(r.value); render(); });
  const c = document.getElementById("c"); c.oninput = () => { state.comment = c.value; };
  document.getElementById("send").onclick = send;
}
async function send() {
  state.sending = true; render();
  try {
    const r = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: token, rating: state.rating, comment: state.comment }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "Your feedback couldn’t be sent. Please try again.");
    state.done = true;
  } catch (e) { const t = document.getElementById("toast"); t.textContent = e.message; t.classList.add("on"); setTimeout(() => t.classList.remove("on"), 4000); }
  state.sending = false; render();
}
(async () => {
  try {
    const r = await fetch("/api/feedback?t=" + encodeURIComponent(token));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "This link isn’t valid.");
    state.info = j;
    if (!state.rating && j.rating) state.rating = j.rating;
    if (j.comment) state.comment = j.comment;
  } catch (e) { state.error = e.message; }
  render();
})();
})();
