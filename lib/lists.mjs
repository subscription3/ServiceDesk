// Thin data layer over SharePoint Lists.
import { graph, graphAll, env } from "./graph.mjs";

export const LISTS = {
  tickets: "SD Tickets",
  messages: "SD Ticket Messages",
  events: "SD Ticket Events",
  settings: "SD Settings",
};

let siteId = null;
const listIds = {};
const PREFER = { Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly" };

export const q = (s) => String(s ?? "").replace(/'/g, "''");

export async function getSiteId() {
  if (siteId) return siteId;
  const j = await graph(`/sites/${env("SHAREPOINT_HOSTNAME")}:${env("SHAREPOINT_SITE_PATH")}`);
  siteId = j.id;
  return siteId;
}

export async function listId(key) {
  if (listIds[key]) return listIds[key];
  const sid = await getSiteId();
  const name = LISTS[key];
  const j = await graph(`/sites/${sid}/lists?$filter=${encodeURIComponent(`displayName eq '${q(name)}'`)}&$select=id,displayName`);
  if (!j.value?.length) throw new Error(`SharePoint list "${name}" was not found. Run "npm run setup" first.`);
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

export async function queryItems(key, filter) {
  const f = filter ? `&$filter=${encodeURIComponent(filter)}` : "";
  const items = await graphAll(`${await itemsPath(key)}?$expand=fields&$top=500${f}`, { headers: PREFER });
  return items.map((i) => ({ ...i.fields, id: i.id }));
}
