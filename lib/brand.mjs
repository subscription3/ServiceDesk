// Logo storage in the SharePoint site's document library.
import { graph, appToken } from "./graph.mjs";
import { getSiteId } from "./lists.mjs";
import { httpError } from "./errors.mjs";

const FOLDER = "ServiceDeskBranding";
const TYPES = { "image/png": "png", "image/jpeg": "jpg" };
const MAX = 1024 * 1024;

export function decodeLogo(dataUrl) {
  const m = String(dataUrl || "").match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw httpError(400, "Upload a PNG or JPG image.");
  const buf = Buffer.from(m[2], "base64");
  if (!buf.length) throw httpError(400, "That image file is empty.");
  if (buf.length > MAX) throw httpError(400, "The logo must be smaller than 1 MB.");
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if ((m[1] === "image/png" && !isPng) || (m[1] === "image/jpeg" && !isJpg)) throw httpError(400, "That file isn’t a valid PNG or JPG image.");
  return { type: m[1], ext: TYPES[m[1]], buf };
}

export async function uploadLogo({ type, ext, buf }) {
  const sid = await getSiteId();
  const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${sid}/drive/root:/${FOLDER}/logo.${ext}:/content`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${await appToken()}`, "Content-Type": type },
    body: buf,
  });
  if (!r.ok) throw new Error(`Logo upload to SharePoint failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
}

export async function downloadLogo(ext) {
  const sid = await getSiteId();
  const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${sid}/drive/root:/${FOLDER}/logo.${ext}:/content`, {
    headers: { Authorization: `Bearer ${await appToken()}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Logo download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

export async function deleteLogoFiles() {
  const sid = await getSiteId();
  for (const ext of Object.values(TYPES)) {
    try { await graph(`/sites/${sid}/drive/root:/${FOLDER}/logo.${ext}`, { method: "DELETE" }); }
    catch (e) { if (e.status !== 404) throw e; }
  }
}

export async function searchDirectory(q) {
  const term = String(q || "").replace(/["\\]/g, "").trim().slice(0, 60);
  if (term.length < 2) return { available: true, people: [] };
  try {
    const j = await graph(`/users?$search=${encodeURIComponent(`"displayName:${term}" OR "mail:${term}"`)}&$select=displayName,mail,userPrincipalName,jobTitle,department&$top=8`, {
      headers: { ConsistencyLevel: "eventual" },
    });
    return {
      available: true,
      people: (j.value || []).filter((u) => u.mail || u.userPrincipalName).map((u) => ({
        name: u.displayName || u.mail, email: String(u.mail || u.userPrincipalName).toLowerCase(), title: [u.jobTitle, u.department].filter(Boolean).join(", "),
      })),
    };
  } catch (e) {
    if (e.status === 500 && /refused access/.test(e.message)) return { available: false, people: [] };
    if (e.status === 403 || e.status === 401) return { available: false, people: [] };
    throw e;
  }
}
