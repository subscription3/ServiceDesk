// Verifies the Microsoft sign-in token sent by the browser and works out the user's role.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "./graph.mjs";

let jwks;

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

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
  const allow = (process.env.AGENT_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return {
    email,
    name: String(payload.name || email),
    isAgent: roles.includes("ServiceDesk.Agent") || allow.includes(email),
  };
}

export function requireAgent(user) {
  if (!user.isAgent) throw httpError(403, "Only service desk agents can do that.");
}
