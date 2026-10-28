// Downloads one backup folder from SharePoint so it can be checked or restored.
// Usage: npm run download-backup -- 20261028-0100Z     (or "latest")
import fs from "node:fs";
import path from "node:path";
import { graph, appToken } from "../lib/graph.mjs";
import { getSiteId } from "../lib/lists.mjs";

async function main() {
  let name = process.argv[2];
  if (!name) { console.error("Give the backup ID, e.g. npm run download-backup -- 20261028-0100Z  (or: latest)"); process.exit(1); }
  const sid = await getSiteId();
  if (name === "latest") {
    const kids = await graph(`/sites/${sid}/drive/root:/ServiceDeskBackups:/children?$select=name,folder&$top=999`);
    name = (kids.value || []).filter((k) => k.folder).map((k) => k.name).sort().pop();
    if (!name) throw new Error("No backups found.");
  }
  const kids = await graph(`/sites/${sid}/drive/root:/ServiceDeskBackups/${name}:/children?$select=name,id&$top=200`);
  const out = path.join("restore-input", name);
  fs.mkdirSync(out, { recursive: true });
  for (const k of kids.value || []) {
    const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${sid}/drive/items/${k.id}/content`, { headers: { Authorization: `Bearer ${await appToken()}` } });
    if (!r.ok) throw new Error(`Download of ${k.name} failed (${r.status})`);
    fs.writeFileSync(path.join(out, k.name), Buffer.from(await r.arrayBuffer()));
    console.log(`  ${k.name}`);
  }
  console.log(`Downloaded backup ${name} to ${out}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `dir=${out}\n`);
}
main().catch((e) => { console.error("Download failed:", e.message); process.exit(1); });
