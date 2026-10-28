// Reads the support mailbox: new emails become tickets, replies are added to existing tickets.
import { graph, env } from "./graph.mjs";
import { createTicket, addMessage, getTicketByNumber, messageExists, getSettings, findAgent } from "./tickets.mjs";
import { audit } from "./audit.mjs";

const AUTO_HEADERS = /^(auto-submitted|x-autoreply|x-autorespond|precedence|x-auto-response-suppress)$/i;

function isAutomatic(msg, mailbox) {
  const from = (msg.from?.emailAddress?.address || "").toLowerCase();
  if (!from || from === mailbox) return true;
  if (/^(no-?reply|mailer-daemon|postmaster)@/i.test(from)) return true;
  if (/^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status notification)/i.test(msg.subject || "")) return true;
  for (const h of msg.internetMessageHeaders || []) {
    if (!AUTO_HEADERS.test(h.name)) continue;
    const v = String(h.value || "").toLowerCase();
    if (/^auto-submitted$/i.test(h.name) && v !== "no") return true;
    if (/^precedence$/i.test(h.name) && /(bulk|junk|list|auto_reply)/.test(v)) return true;
    if (/^x-auto/i.test(h.name)) return true;
  }
  return false;
}

function cleanBody(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n(?:From: .+\nSent: |-{2,} ?Original Message ?-{2,}|On .+ wrote:)/)[0]
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function pollInbox({ max = 10 } = {}) {
  const mailbox = env("SUPPORT_MAILBOX").toLowerCase();
  const base = `/users/${encodeURIComponent(mailbox)}`;
  const select = "id,subject,from,uniqueBody,body,receivedDateTime,internetMessageId,internetMessageHeaders";
  const j = await graph(`${base}/mailFolders/inbox/messages?$filter=isRead eq false&$top=${max}&$select=${select}`, {
    headers: { Prefer: 'outlook.body-content-type="text"' },
  });
  const messages = (j.value || []).sort((a, b) => Date.parse(a.receivedDateTime) - Date.parse(b.receivedDateTime));
  const result = { checked: messages.length, created: 0, replies: 0, skipped: 0, errors: 0 };
  const settings = await getSettings();

  for (const msg of messages) {
    try {
      if (isAutomatic(msg, mailbox) || (await messageExists(msg.internetMessageId))) {
        result.skipped++;
      } else {
        const fromEmail = msg.from.emailAddress.address.toLowerCase();
        const fromName = msg.from.emailAddress.name || fromEmail;
        const subject = String(msg.subject || "(no subject)");
        const body = cleanBody(msg.uniqueBody?.content || msg.body?.content) || "(The email had no text.)";
        const ref = subject.match(/\[#(\d+)\]/);
        const ticket = ref ? await getTicketByNumber(ref[1]) : null;
        if (ticket) {
          const agent = findAgent(settings, fromEmail);
          const isRequester = ticket.requesterEmail === fromEmail;
          const type = agent && !isRequester ? "reply" : "customer";
          await addMessage(ticket.id, { type, body }, { name: agent ? agent.name : fromName, email: fromEmail, isAgent: !!agent },
            { source: "email", internetMessageId: msg.internetMessageId, returnDetail: false });
          await audit({ name: fromName, email: fromEmail }, `${type === "reply" ? "Agent replied by email to" : "Requester replied by email to"} ticket #${ticket.number}`, { category: "Email", targetType: "Ticket", targetId: ticket.number, details: { subject, internetMessageId: msg.internetMessageId } });
          result.replies++;
        } else {
          const t = await createTicket(
            { subject: subject.replace(/^(re|fw|fwd):\s*/i, ""), description: body, name: fromName, email: fromEmail, priority: "Medium", sourceMessageId: msg.internetMessageId },
            { name: "Email", email: "" },
            { channel: "Email" },
          );
          await audit({ name: fromName, email: fromEmail }, `Created ticket #${t.number} by email`, { category: "Email", targetType: "Ticket", targetId: t.number, details: { subject: t.subject, internetMessageId: msg.internetMessageId } });
          result.created++;
        }
      }
      await graph(`${base}/messages/${msg.id}`, { method: "PATCH", body: { isRead: true } });
    } catch (e) {
      result.errors++;
      console.error("Could not process email", msg.id, e.message);
    }
  }
  return result;
}
