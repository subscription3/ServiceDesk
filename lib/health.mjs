// Checks every connection the service desk depends on. Open /api/health in a browser.
// It reports which settings are missing or failing, but never shows secret values.
import { graph, appToken } from "./graph.mjs";
import { getSiteId, listId, LISTS } from "./lists.mjs";

const REQUIRED = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "SHAREPOINT_HOSTNAME", "SHAREPOINT_SITE_PATH", "SUPPORT_MAILBOX"];

export async function healthCheck() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ check: name, ok, detail });
  const run = async (name, fn) => {
    try { add(name, true, (await fn()) || "OK"); return true; }
    catch (e) { add(name, false, e.message); return false; }
  };

  const missing = REQUIRED.filter((k) => !(process.env[k] || "").trim());
  add("Environment variables", !missing.length, missing.length ? `Missing in Netlify: ${missing.join(", ")}. Add them, then redeploy.` : "All required variables are set");
  if (missing.length) return { ok: false, checks };

  if (!/^[0-9a-f-]{36}$/i.test(process.env.AZURE_TENANT_ID.trim())) add("Tenant ID format", false, "AZURE_TENANT_ID should be a GUID like 1a2b3c4d-…, the Directory (tenant) ID.");
  if (!/^[0-9a-f-]{36}$/i.test(process.env.AZURE_CLIENT_ID.trim())) add("Client ID format", false, "AZURE_CLIENT_ID should be a GUID like 1a2b3c4d-…, the Application (client) ID.");
  if (/^[0-9a-f-]{36}$/i.test(process.env.AZURE_CLIENT_SECRET.trim())) add("Client secret format", false, "AZURE_CLIENT_SECRET looks like a Secret ID. Use the secret’s Value instead (it contains characters like ~ and . and is shown only once).");

  if (!(await run("Server sign-in to Microsoft", async () => { await appToken(); return "Got an access token"; }))) return { ok: false, checks };
  if (!(await run("SharePoint site", async () => `Found site ${await getSiteId()}`))) return { ok: false, checks };
  for (const key of Object.keys(LISTS)) await run(`SharePoint list "${LISTS[key]}"`, async () => { await listId(key); return "Exists"; });

  const mailbox = process.env.SUPPORT_MAILBOX.trim();
  await run(`Mailbox ${mailbox}`, async () => {
    try { await graph(`/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id,unreadItemCount`); }
    catch (e) {
      if (e.status === 404) throw new Error(`The mailbox ${mailbox} wasn’t found. Check SUPPORT_MAILBOX.`);
      throw e;
    }
    return "Can read the inbox";
  });

  return { ok: checks.every((c) => c.ok), checks };
}
