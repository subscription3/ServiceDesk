// Microsoft Graph client using the app's own credentials (client credentials flow).
const GRAPH = "https://graph.microsoft.com/v1.0";
let cached = { token: null, exp: 0 };

export function configError(message) {
  const e = new Error(message);
  e.expose = true;
  return e;
}

export function env(name, required = true) {
  const v = (process.env[name] || "").trim();
  if (required && !v) throw configError(`The environment variable ${name} is missing in Netlify. Add it under Site configuration → Environment variables, then redeploy.`);
  return v;
}

const TOKEN_HINTS = {
  AADSTS7000215: "The client secret is wrong. In Netlify, AZURE_CLIENT_SECRET must be the secret’s Value, not its Secret ID.",
  AADSTS7000222: "The client secret has expired. Create a new one in Entra and update AZURE_CLIENT_SECRET.",
  AADSTS700016: "AZURE_CLIENT_ID doesn’t match an app in this tenant. Check AZURE_CLIENT_ID and AZURE_TENANT_ID.",
  AADSTS90002: "AZURE_TENANT_ID isn’t a valid tenant. Use the Directory (tenant) ID from the app’s Overview page.",
  AADSTS900023: "AZURE_TENANT_ID isn’t a valid tenant. Use the Directory (tenant) ID from the app’s Overview page.",
};

export async function appToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const body = new URLSearchParams({
    client_id: env("AZURE_CLIENT_ID"),
    client_secret: env("AZURE_CLIENT_SECRET"),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(`https://login.microsoftonline.com/${env("AZURE_TENANT_ID")}/oauth2/v2.0/token`, { method: "POST", body });
  const j = await r.json();
  if (!r.ok) {
    const code = String(j.error_description || "").match(/AADSTS\d+/)?.[0];
    throw configError(TOKEN_HINTS[code] || `Microsoft sign-in for the server failed: ${String(j.error_description || r.status).split("\r\n")[0]}`);
  }
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

export async function graph(path, { method = "GET", body, headers = {} } = {}) {
  const url = path.startsWith("http") ? path : GRAPH + path;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await appToken()}`, "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 || r.status === 503 || r.status === 504) {
      const wait = Math.min(Number(r.headers.get("Retry-After")) || 2, 5);
      await new Promise((s) => setTimeout(s, wait * 1000));
      continue;
    }
    if (r.status === 202 || r.status === 204) return null;
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!r.ok) {
      const e = new Error(`Graph ${method} ${path.split("?")[0]} failed (${r.status}): ${j?.error?.message || text}`);
      e.status = r.status;
      if (r.status === 401 || r.status === 403) {
        e.expose = true;
        e.status = 500;
        e.message = `Microsoft Graph refused access (${r.status}) to ${path.split("?")[0]}. Check that the app has the Sites.ReadWrite.All, Mail.Send and Mail.ReadWrite application permissions with admin consent granted, and that no access policy blocks this site or mailbox. Details: ${j?.error?.message || ""}`;
      }
      throw e;
    }
    return j;
  }
  throw new Error("Microsoft Graph is busy. Try again shortly.");
}

export async function graphAll(path, opts) {
  let out = [];
  let next = path;
  for (let page = 0; next && page < 25; page++) {
    const j = await graph(next, opts);
    out = out.concat(j.value || []);
    next = j["@odata.nextLink"];
  }
  return out;
}
