// File attachments for tickets and change requests, stored in the SharePoint site's document library.
import { graph, appToken } from "./graph.mjs";
import { getSiteId, createItem, getItem, queryItems, deleteItem } from "./lists.mjs";
import { httpError } from "./errors.mjs";

export const MAX_BYTES = 4 * 1024 * 1024;
const TYPES = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  vsdx: "application/vnd.ms-visio.drawing", txt: "text/plain", csv: "text/csv", log: "text/plain",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", msg: "application/vnd.ms-outlook", eml: "message/rfc822", zip: "application/zip",
};
export const ALLOWED = Object.keys(TYPES);
const ROOT = "ServiceDeskAttachments";
const ms = (x) => (x ? Date.parse(x) : null);
const safeName = (n) => String(n || "file").replace(/[\\/:*?"<>|#%{}~&]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";

export const toAttachment = (f) => ({
  id: Number(f.id), parentType: f.ParentType, parentId: Number(f.ParentId), name: f.FileName || "", type: f.ContentType || "",
  size: Number(f.SizeBytes) || 0, internal: !!f.Internal, by: f.UploadedByName || "", byEmail: f.UploadedByEmail || "", at: ms(f.UploadedAt) || ms(f.Created),
});

export function decodeFile(fileName, dataUrl) {
  const name = safeName(fileName);
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!TYPES[ext]) throw httpError(400, `Files of type .${ext || "?"} can’t be attached. Allowed: ${ALLOWED.join(", ")}.`);
  const m = String(dataUrl || "").match(/^data:[^;,]*;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw httpError(400, "The file couldn’t be read. Please try again.");
  const buf = Buffer.from(m[1], "base64");
  if (!buf.length) throw httpError(400, "That file is empty.");
  if (buf.length > MAX_BYTES) throw httpError(400, "Files must be 4 MB or smaller.");
  // Reject executables renamed to an allowed extension.
  if (buf[0] === 0x4d && buf[1] === 0x5a) throw httpError(400, "That file looks like a program, which can’t be attached.");
  return { name, ext, type: TYPES[ext], buf };
}

export async function saveAttachment({ parentType, parentId, parentNumber, internal, user }, file) {
  const sid = await getSiteId();
  const folder = `${ROOT}/${parentType === "Change" ? "Changes" : "Tickets"}/${parentNumber}`;
  const path = `${folder}/${Date.now()}-${file.name}`.split("/").map(encodeURIComponent).join("/");
  const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${sid}/drive/root:/${path}:/content`, {
    method: "PUT", headers: { Authorization: `Bearer ${await appToken()}`, "Content-Type": file.type }, body: file.buf,
  });
  if (!r.ok) throw new Error(`Upload to SharePoint failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const item = await r.json();
  const row = await createItem("attachments", {
    Title: file.name, ParentType: parentType, ParentId: Number(parentId), ParentNumber: String(parentNumber), FileName: file.name, ContentType: file.type,
    SizeBytes: file.buf.length, DriveItemId: item.id, Internal: !!internal, UploadedByName: user.name, UploadedByEmail: user.email, UploadedAt: new Date().toISOString(),
  });
  return toAttachment(row);
}

export async function listAttachments(parentType, parentId) {
  let rows;
  try { rows = await queryItems("attachments", `fields/ParentId eq ${Number(parentId)}`); }
  catch (e) { if (/doesn’t exist yet/.test(e.message)) return []; throw e; } // until the Set up SharePoint workflow has run
  return rows.filter((r) => r.ParentType === parentType).map(toAttachment).sort((a, b) => a.at - b.at);
}

export async function getAttachment(id) {
  const f = await getItem("attachments", id);
  return f ? { ...toAttachment(f), driveItemId: f.DriveItemId } : null;
}

export async function readAttachment(a) {
  const sid = await getSiteId();
  const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${sid}/drive/items/${encodeURIComponent(a.driveItemId)}/content`, { headers: { Authorization: `Bearer ${await appToken()}` } });
  if (r.status === 404) throw httpError(404, "That file is no longer in SharePoint.");
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

export async function removeAttachment(a) {
  const sid = await getSiteId();
  try { await graph(`/sites/${sid}/drive/items/${encodeURIComponent(a.driveItemId)}`, { method: "DELETE" }); } catch (e) { if (e.status !== 404) throw e; }
  await deleteItem("attachments", a.id);
}
