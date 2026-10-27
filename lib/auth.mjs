// Verifies the Microsoft sign-in token sent by the browser and works out the user's role.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "./graph.mjs";
import { httpError } from "./errors.mjs";
import { getSettings } from "./tickets.mjs";

export { httpError };
let jwks;
const listEnv = (k) => (process.env[k] || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

export async function authenticate(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/);
  if (!m) throw httpError(401, "Please sign in.");
  const tenant = env("AZURE_TENANT_ID");
  jwks ||= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));
  let payload;
  try {
    ({ payload } = await jwtVerify(m[1], jwks, {
      issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
      audience: env("AZURE_CLIENT_ID"),
    }));
  } catch {
    throw httpError(401, "Your sign-in has expired. Please sign in again.");
  }
  const email = String(payload.email || payload.preferred_username || "").toLowerCase();
  if (!email) throw httpError(403, "Your account has no email address, so it can’t use the service desk.");
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  const s = await getSettings();
  const listed = s.users.find((u) => u.email === email);
  const entraAdmin = roles.includes("ServiceDesk.Admin") || listEnv("ADMIN_EMAILS").includes(email);
  const entraAgent = roles.includes("ServiceDesk.Agent") || listEnv("AGENT_EMAILS").includes(email);
  const hasAdmins = s.users.some((u) => u.role === "Admin") || listEnv("ADMIN_EMAILS").length > 0;
  const isAdmin = entraAdmin || listed?.role === "Admin" || (!hasAdmins && entraAgent);
  return {
    email,
    name: String(listed?.name || payload.name || email),
    isAgent: isAdmin || entraAgent || !!listed,
    isAdmin,
  };
}

export function requireAgent(user) {
  if (!user.isAgent) throw httpError(403, "Only service desk agents can do that.");
}
export function requireAdmin(user) {
  if (!user.isAdmin) throw httpError(403, "Only service desk admins can change settings.");
}
