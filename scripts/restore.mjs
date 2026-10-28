// Restores a backup into the SharePoint site set in SHAREPOINT_SITE_PATH.
// The lists must exist (run npm run setup first) and be empty, so nothing is ever overwritten.
// Usage: npm run restore -- restore-input/20261028-0100Z
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { graph } from "../lib/graph.mjs";
import { getSiteId, LISTS, queryItems, createItem, updateItem } from "../lib/lists.mjs";
import { restoreColumns } from "../lib/schema.mjs";
import { audit } from "../lib/audit.mjs";

const FILES = { tickets: "tickets.json", messages: "ticket-messages.json", events: "ticket-events.json", feedback: "feedback.json", settings: "settings.json", audit: "activity-log.json" };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function pool(items, n, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); if (++done % 100 === 0) console.log(`    ${done}/${items.length}`); }
  }));
}
const pick = (key, row) => Object.fromEntries(restoreColumns(key).filter((c) => row[c] !== undefined && row[c] !== null && row[c] !== "").map((c) => [c, row[c]]));

async function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(path.join(dir, "manifest.json"))) { console.error("Give the folder that contains manifest.json, e.g. npm run restore -- restore-input/20261028-0100Z"); process.exit(1); }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  console.log(`Backup ${manifest.backupId} from ${manifest.source.siteUrl}`);

  // 1. Integrity: every file must match the hash recorded when the backup was taken.
  for (const f of manifest.files) {
    const ok = sha256(fs.readFileSync(path.join(dir, f.name))) === f.sha256;
    console.log(`  hash ${f.name}: ${ok ? "OK" : "MISMATCH"}`);
    if (!ok) throw new Error(`${f.name} doesn’t match its recorded hash. The file may have been changed; restore stopped.`);
  }
  const data = Object.fromEntries(Object.entries(FILES).map(([k, n]) => [k, JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")).items]));

  // 2. Safety: the target lists must be empty.
  const sid = await getSiteId();
  const site = await graph(`/sites/${sid}?$select=webUrl`);
  console.log(`Restoring into ${site.webUrl}`);
  for (const k of ["tickets", "messages", "events", "feedback"]) {
    const n = (await queryItems(k)).length;
    if (n) throw new Error(`The list "${LISTS[k]}" on the target site already has ${n} items. Restore only into empty lists (a new site, or after clearing them).`);
  }

  // 3. Settings (replace).
  const existing = Object.fromEntries((await queryItems("settings")).map((r) => [r.Title, r.id]));
  for (const row of data.settings) {
    if (existing[row.Title]) await updateItem("settings", existing[row.Title], { Value: row.Value });
    else await createItem("settings", { Title: row.Title, Value: row.Value });
  }
  console.log(`  settings: ${data.settings.length}`);

  // 4. Tickets keep their numbers and dates; new SharePoint IDs are mapped for the related lists.
  const idMap = new Map();
  await pool(data.tickets, 4, async (row) => {
    const fields = pick("tickets", row);
    fields.TicketNumber = Number(row.TicketNumber) || 1000 + Number(row.id);
    fields.OpenedAt = row.OpenedAt || row.Created;
    const item = await createItem("tickets", fields);
    idMap.set(Number(row.id), Number(item.id));
  });
  console.log(`  tickets: ${data.tickets.length}`);
  const related = async (key) => {
    let skipped = 0;
    await pool(data[key], 4, async (row) => {
      const tid = idMap.get(Number(row.TicketId));
      if (!tid) { skipped++; return; }
      await createItem(key, { ...pick(key, row), TicketId: tid });
    });
    console.log(`  ${LISTS[key]}: ${data[key].length - skipped}${skipped ? ` (${skipped} skipped: their ticket was deleted before the backup)` : ""}`);
  };
  await related("messages");
  await related("events");
  await related("feedback");
  await pool(data.audit, 4, async (row) => { await createItem("audit", { ...pick("audit", row), OccurredAt: row.OccurredAt || row.Created }); });
  console.log(`  activity log: ${data.audit.length}`);

  const report = { restoredAt: new Date().toISOString(), backupId: manifest.backupId, backupManifestSha256: sha256(fs.readFileSync(path.join(dir, "manifest.json"))), from: manifest.source.siteUrl, into: site.webUrl, counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])) };
  fs.writeFileSync(path.join(dir, "restore-report.json"), JSON.stringify(report, null, 2));
  await audit({ name: "Restore", email: "" }, `Restored backup ${manifest.backupId} into this site`, { category: "Backup", targetType: "Restore", targetId: manifest.backupId, details: report });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Restore test\n\nBackup **${manifest.backupId}** restored into ${site.webUrl}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  console.log("\nRestore completed. Report saved to", path.join(dir, "restore-report.json"));
}
main().catch((e) => { console.error("\nRestore stopped:", e.message); process.exit(1); });
