// Thin data layer over SharePoint Lists.
import { graph, graphAll, env, configError } from "./graph.mjs";

export const LISTS = {
  tickets: "SD Tickets",
  messages: "SD Ticket Messages",
  events: "SD Ticket Events",
  settings: "SD Settings",
  feedback: "SD Feedback",
  audit: "SD Audit Log",
};

let siteId = null;
const listIds = {};
const PREFER = { Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly" };

export const q = (s) => String(s ?? "").replace(/'/g, "''");

export async function getSiteId() {
  if (siteId) return siteId;
  const host = env("SHAREPOINT_HOSTNAME").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  let path = env("SHAREPOINT_SITE_PATH").replace(/\/+$/, "");
  if (!path.startsWith("/")) path = "/" + path;
  try {
    const j = await graph(`/sites/${host}:${path}`);
    siteId = j.id;
  } catch (e) {
    if (e.status === 404 || e.status === 400) throw configError(`The SharePoint site https://${host}${path} wasn’t found. Check SHAREPOINT_HOSTNAME (e.g. infracredit.sharepoint.com) and SHAREPOINT_SITE_PATH (e.g. /sites/ServiceDesk).`);
    throw e;
  }
  return siteId;
}

export async function listId(key) {
  if (listIds[key]) return listIds[key];
  const sid = await getSiteId();
  const name = LISTS[key];
  const j = await graph(`/sites/${sid}/lists?$filter=${encodeURIComponent(`displayName eq '${q(name)}'`)}&$select=id,displayName`);
  if (!j.value?.length) throw configError(`The SharePoint list "${name}" doesn’t exist yet. Run "npm run setup" on your computer (with the same settings in .env) to create the lists.`);
  listIds[key] = j.value[0].id;
  return listIds[key];
}

async function itemsPath(key) {
  return `/sites/${await getSiteId()}/lists/${await listId(key)}/items`;
}

const clean = (fields) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null));

export async function createItem(key, fields) {
  const j = await graph(await itemsPath(key), { method: "POST", body: { fields: clean(fields) } });
  return { ...j.fields, id: j.id };
}

export async function updateItem(key, id, fields) {
  return graph(`${await itemsPath(key)}/${id}/fields`, { method: "PATCH", body: clean(fields) });
}

export async function deleteItem(key, id) {
  return graph(`${await itemsPath(key)}/${id}`, { method: "DELETE" });
}

export async function getItem(key, id) {
  try {
    const j = await graph(`${await itemsPath(key)}/${id}?$expand=fields`);
    return { ...j.fields, id: j.id };
  } catch (e) {
    if (e.status === 404 || e.status === 400) return null;
    throw e;
  }
}

export async function queryItems(key, filter, { top = 500 } = {}) {
  const f = filter ? `&$filter=${encodeURIComponent(filter)}` : "";
  const items = await graphAll(`${await itemsPath(key)}?$expand=fields&$top=${top}${f}`, { headers: PREFER });
  return items.map((i) => ({ ...i.fields, id: i.id }));
}
