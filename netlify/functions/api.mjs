// All /api/* requests from the browser.
import { env } from "../../lib/graph.mjs";
import { healthCheck } from "../../lib/health.mjs";
import { authenticate, requireAgent, httpError } from "../../lib/auth.mjs";
import {
  getSettings, saveSettings, publicSettings, listTickets, listMine, getDetail,
  createTicket, updateTicket, addMessage, deleteTicket,
} from "../../lib/tickets.mjs";
import { pollInbox } from "../../lib/inbox.mjs";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readBody(req) {
  try { return await req.json(); } catch { throw httpError(400, "The request body wasn’t valid JSON."); }
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method;
  try {
    if (path === "/config" && method === "GET") {
      return json({
        clientId: env("AZURE_CLIENT_ID"), tenantId: env("AZURE_TENANT_ID"),
        orgName: process.env.ORG_NAME || "InfraCredit", supportEmail: env("SUPPORT_MAILBOX"),
      });
    }

    if (path === "/health" && method === "GET") {
      const r = await healthCheck();
      return json(r, r.ok ? 200 : 500);
    }

    const user = await authenticate(req);

    if (path === "/me" && method === "GET") return json(user);

    if (path === "/settings" && method === "GET") {
      const s = await getSettings();
      return json(user.isAgent ? publicSettings(s) : { departments: s.departments });
    }
    if (path === "/settings" && method === "PUT") {
      requireAgent(user);
      return json(await saveSettings(await readBody(req)));
    }

    if (path === "/tickets" && method === "GET") {
      requireAgent(user);
      return json(await listTickets());
    }
    if (path === "/tickets" && method === "POST") {
      const b = await readBody(req);
      if (user.isAgent && b.mode === "agent") {
        const t = await createTicket(b, user, { channel: b.channel });
        return json(await getDetail(t.id, user), 201);
      }
      // Self-service portal: the requester is always the signed-in person.
      const t = await createTicket(
        { subject: b.subject, description: b.description, name: b.name || user.name, email: user.email, phone: b.phone, department: b.department, priority: b.priority },
        user, { channel: "Self-service portal" },
      );
      return json(await getDetail(t.id, { ...user, isAgent: false }), 201);
    }

    if (path === "/my/tickets" && method === "GET") return json(await listMine(user.email));

    const m = path.match(/^\/tickets\/(\d+)(\/messages)?$/);
    if (m) {
      const id = Number(m[1]);
      if (!m[2] && method === "GET") return json(await getDetail(id, user));
      if (!m[2] && method === "PATCH") { requireAgent(user); return json(await updateTicket(id, await readBody(req), user)); }
      if (!m[2] && method === "DELETE") { requireAgent(user); await deleteTicket(id); return json({ ok: true }); }
      if (m[2] && method === "POST") {
        const b = await readBody(req);
        if (b.type === "customer") {
          await getDetail(id, { ...user, isAgent: false }); // the requester can only reply to their own ticket
          return json(await addMessage(id, { type: "customer", body: b.body }, { ...user, isAgent: false }, { source: "portal" }));
        }
        requireAgent(user);
        return json(await addMessage(id, { type: b.type, body: b.body, closeAfter: !!b.closeAfter }, user));
      }
    }

    if (path === "/mail/check" && method === "POST") {
      requireAgent(user);
      return json(await pollInbox({ max: 8 }));
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
