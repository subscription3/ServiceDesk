// Outbound email through the shared support mailbox (Microsoft Graph sendMail).
import { graph, env } from "./graph.mjs";

const NAVY = "#0B2D5B";
const GREEN = "#76B82A";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const para = (s) => esc(s).replace(/\r?\n/g, "<br>");

let brand = { logoVersion: 0, logoExt: "png" };
export function setBrand(b) { if (b) brand = b; }

export function siteUrl() {
  return (process.env.SITE_URL || process.env.URL || "").replace(/\/$/, "");
}

function layout({ heading, paragraphs = [], quote, quoteBy, ticket, link, linkText }) {
  const org = esc(process.env.ORG_NAME || "InfraCredit");
  return `<!doctype html><html><body style="margin:0;background:#F1F4F8;font-family:Segoe UI,Arial,sans-serif;color:#172B45">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1F4F8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#ffffff;padding:18px 24px;border-bottom:1px solid #DDE3EB">
${siteUrl() && brand.logoVersion ? `<img src="${esc(siteUrl())}/api/brand/logo?v=${brand.logoVersion}" alt="${org}" height="32" style="height:32px;width:auto;display:inline-block;vertical-align:middle;border:0">` : `<span style="font-size:18px;font-weight:bold;color:${NAVY}">${org}</span>`}
<span style="font-size:14px;color:#5A6B82;padding-left:12px;margin-left:12px;border-left:1px solid #DDE3EB;vertical-align:middle">Service Desk</span></td></tr>
<tr><td style="height:4px;background:${GREEN};line-height:4px;font-size:0">&nbsp;</td></tr>
<tr><td style="padding:24px">
<h1 style="font-size:20px;margin:0 0 12px;color:${NAVY}">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${para(p)}</p>`).join("")}
${quote ? `<div style="border-left:3px solid ${GREEN};background:#F6F8FB;padding:12px 16px;margin:16px 0;font-size:15px;line-height:1.5">${quoteBy ? `<div style="font-size:13px;color:#5B6B84;margin-bottom:6px">${esc(quoteBy)}</div>` : ""}${para(quote)}</div>` : ""}
${ticket ? `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:16px 0;color:#5B6B84">
<tr><td style="padding:2px 16px 2px 0">Ticket</td><td style="color:#13284A;font-weight:bold">#${esc(ticket.number)}</td></tr>
<tr><td style="padding:2px 16px 2px 0">Subject</td><td style="color:#13284A">${esc(ticket.subject)}</td></tr>
<tr><td style="padding:2px 16px 2px 0">Status</td><td style="color:#13284A">${esc(ticket.status)}</td></tr>
<tr><td style="padding:2px 16px 2px 0">Priority</td><td style="color:#13284A">${esc(ticket.priority)}</td></tr></table>` : ""}
${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;font-weight:bold;padding:11px 20px;border-radius:6px">${esc(linkText || "View request")}</a></p>` : ""}
</td></tr>
<tr><td style="padding:14px 24px;background:#F3F5F8;font-size:12.5px;color:#5A6B82;border-top:1px solid #DDE3EB">Reply to this email to add information to your ticket. Please keep the ticket number [#${esc(ticket?.number ?? "")}] in the subject line.</td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendMail({ to, subject, html }) {
  if (!to) return;
  const mailbox = env("SUPPORT_MAILBOX");
  await graph(`/users/${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    body: {
      message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: true,
    },
  });
}

// Never let an email failure break a ticket update.
export async function safeSend(msg) {
  try { await sendMail(msg); } catch (e) { console.error("Email failed:", e.message); }
}

const portal = (t) => `${siteUrl()}/#portal`;
const desk = () => `${siteUrl()}/`;
const tag = (t) => `[#${t.number}]`;

export const templates = {
  created: (t) => ({
    to: t.requesterEmail,
    subject: `${tag(t)} We’ve received your request: ${t.subject}`,
    html: layout({
      heading: "We’ve received your request",
      paragraphs: [`Hi ${t.requesterName || "there"},`, `Thanks for getting in touch. We’ve logged your request as ticket #${t.number} and our team will pick it up shortly. We’ll email you whenever there’s an update.`],
      ticket: t, link: portal(t), linkText: "Track your request",
    }),
  }),
  reply: (t, msg) => ({
    to: t.requesterEmail,
    subject: `${tag(t)} Re: ${t.subject}`,
    html: layout({
      heading: "There’s a new reply on your request",
      paragraphs: [`Hi ${t.requesterName || "there"},`],
      quote: msg.body, quoteBy: `${msg.author} replied`,
      ticket: t, link: portal(t), linkText: "View the conversation",
    }),
  }),
  status: (t, text) => ({
    to: t.requesterEmail,
    subject: `${tag(t)} ${t.status === "Closed" ? "Resolved" : "Update"}: ${t.subject}`,
    html: layout({
      heading: t.status === "Closed" ? "Your request has been resolved" : "Your request has been updated",
      paragraphs: [`Hi ${t.requesterName || "there"},`, text, ...(t.status === "Closed" ? ["If the problem isn’t fixed, just reply to this email and we’ll reopen the ticket."] : [])],
      ticket: t, link: portal(t), linkText: "View your request",
    }),
  }),
  assigned: (t, agent) => ({
    to: agent.email,
    subject: `${tag(t)} Assigned to you: ${t.subject}`,
    html: layout({
      heading: "A ticket has been assigned to you",
      paragraphs: [`Hi ${agent.name},`, `Ticket #${t.number} from ${t.requesterName || t.requesterEmail || "a requester"} is now yours.`],
      quote: t.description, ticket: t, link: desk(), linkText: "Open the service desk",
    }),
  }),
  requesterReplied: (t, msg) => ({
    to: t.assigneeEmail,
    subject: `${tag(t)} New reply from ${t.requesterName || "the requester"}`,
    html: layout({
      heading: "The requester replied",
      paragraphs: [`Hi ${t.assigneeName || "there"},`],
      quote: msg.body, quoteBy: `${msg.author} wrote`, ticket: t, link: desk(), linkText: "Open the service desk",
    }),
  }),
};
