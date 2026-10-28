// Backs up every service desk list to the SharePoint site's document library, verifies the copy,
// and produces audit evidence: a manifest with SHA-256 hashes and a readable evidence report.
// Runs nightly on GitHub Actions (.github/workflows/backup.yml) or by hand: npm run backup
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { graph, appToken } from "../lib/graph.mjs";
import { getSiteId, LISTS, queryItems } from "../lib/lists.mjs";
import { audit } from "../lib/audit.mjs";

const ROOT = "ServiceDeskBackups";
const FILES = [
  ["tickets", "tickets.json"], ["messages", "ticket-messages.json"], ["events", "ticket-events.json"],
  ["feedback", "feedback.json"], ["settings", "settings.json"], ["audit", "activity-log.json"],
];
const SYSTEM_FIELDS = new Set(["@odata.etag", "ContentType", "Edit", "LinkTitleNoMenu", "LinkTitle", "DocIcon", "ItemChildCount", "FolderChildCount", "_UIVersionString", "_ComplianceFlags", "_ComplianceTag", "_ComplianceTagWrittenTime", "_ComplianceTagUserId", "AppAuthorLookupId", "AppEditorLookupId", "Attachments"]);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const graphBase = "https://graph.microsoft.com/v1.0";

async function upload(sid, rel, buf, type) {
  const target = `${graphBase}/sites/${sid}/drive/root:/${rel.split("/").map(encodeURIComponent).join("/")}`;
  const auth = { Authorization: `Bearer ${await appToken()}` };
  if (buf.length < 3_500_000) {
    const r = await fetch(`${target}:/content`, { method: "PUT", headers: { ...auth, "Content-Type": type }, body: buf });
    if (!r.ok) throw new Error(`Upload of ${rel} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
  const s = await fetch(`${target}:/createUploadSession`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }) });
  if (!s.ok) throw new Error(`Could not start upload of ${rel} (${s.status})`);
  const { uploadUrl } = await s.json();
  const CHUNK = 327_680 * 15; // ~4.9 MB, a multiple of 320 KiB as Graph requires
  let last;
  for (let i = 0; i < buf.length; i += CHUNK) {
    const part = buf.subarray(i, Math.min(i + CHUNK, buf.length));
    last = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Length": String(part.length), "Content-Range": `bytes ${i}-${i + part.length - 1}/${buf.length}` }, body: part });
    if (!last.ok && last.status !== 202) throw new Error(`Upload of ${rel} failed at byte ${i} (${last.status})`);
  }
  return last.json();
}
async function download(sid, rel) {
  const r = await fetch(`${graphBase}/sites/${sid}/drive/root:/${rel.split("/").map(encodeURIComponent).join("/")}:/content`, { headers: { Authorization: `Bearer ${await appToken()}` } });
  if (!r.ok) throw new Error(`Download of ${rel} failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}
function csv(rows, cols) {
  const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "\uFEFF" + [cols.map((c) => c[0]).join(","), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(","))].join("\r\n");
}

async function main() {
  const started = new Date();
  const stamp = started.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-") + "Z";
  const folder = `${ROOT}/${stamp}`;
  const sid = await getSiteId();
  const site = await graph(`/sites/${sid}?$select=webUrl,displayName`);
  const run = process.env.GITHUB_RUN_ID ? {
    type: process.env.GITHUB_EVENT_NAME === "schedule" ? "Scheduled (GitHub Actions)" : "Manual (GitHub Actions)",
    runUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    startedBy: process.env.GITHUB_ACTOR || "", commit: (process.env.GITHUB_SHA || "").slice(0, 12),
  } : { type: "Manual (command line)", runUrl: "", startedBy: process.env.USERNAME || process.env.USER || "", commit: "" };
  console.log(`Backing up ${site.webUrl} to ${folder}`);

  const outDir = path.join("backup-output", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  let ticketsRows = [];
  for (const [key, name] of FILES) {
    const rows = (await queryItems(key, null, { top: 999 })).map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => !SYSTEM_FIELDS.has(k))));
    rows.sort((a, b) => Number(a.id) - Number(b.id));
    if (key === "tickets") ticketsRows = rows;
    const buf = Buffer.from(JSON.stringify({ list: LISTS[key], exportedAt: new Date().toISOString(), count: rows.length, items: rows }, null, 1));
    files.push({ name, list: LISTS[key], rows: rows.length, bytes: buf.length, sha256: sha256(buf), buf, type: "application/json" });
    console.log(`  ${LISTS[key]}: ${rows.length} rows`);
  }
  const ticketsCsv = Buffer.from(csv(ticketsRows, [
    ["Ticket", (r) => r.TicketNumber], ["Subject", (r) => r.Title], ["Status", (r) => r.Status], ["Priority", (r) => r.Priority],
    ["Department", (r) => r.Department], ["Channel", (r) => r.Channel], ["Requester", (r) => r.RequesterName], ["Requester email", (r) => r.RequesterEmail],
    ["Assignee", (r) => r.AssigneeName], ["Opened", (r) => r.OpenedAt || r.Created], ["Resolution due", (r) => r.DueAt], ["First response", (r) => r.FirstResponseAt], ["Closed", (r) => r.ClosedAt],
  ]), "utf8");
  files.push({ name: "tickets.csv", list: "SD Tickets (spreadsheet view)", rows: ticketsRows.length, bytes: ticketsCsv.length, sha256: sha256(ticketsCsv), buf: ticketsCsv, type: "text/csv" });

  // Upload, then download again and compare hashes to prove the stored copy is intact.
  for (const f of files) {
    await upload(sid, `${folder}/${f.name}`, f.buf, f.type);
    fs.writeFileSync(path.join(outDir, f.name), f.buf);
  }
  for (const f of files) {
    const back = await download(sid, `${folder}/${f.name}`);
    f.verified = sha256(back) === f.sha256;
    console.log(`  verify ${f.name}: ${f.verified ? "OK" : "MISMATCH"}`);
  }
  const verified = files.every((f) => f.verified);
  const finished = new Date();
  const folderItem = await graph(`/sites/${sid}/drive/root:/${folder}?$select=webUrl`);
  const manifest = {
    application: `${process.env.ORG_NAME || "InfraCredit"} Service Desk`,
    backupId: stamp, startedAt: started.toISOString(), finishedAt: finished.toISOString(),
    durationSeconds: Math.round((finished - started) / 1000),
    source: { site: site.displayName, siteUrl: site.webUrl },
    storedAt: folderItem.webUrl, trigger: run,
    verification: verified ? "PASSED: every file was read back from SharePoint and its SHA-256 hash matched" : "FAILED: one or more files did not match after upload",
    totals: { files: files.length, records: files.filter((f) => f.name.endsWith(".json")).reduce((n, f) => n + f.rows, 0), bytes: files.reduce((n, f) => n + f.bytes, 0) },
    files: files.map(({ buf, type, ...f }) => f),
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
  const manifestHash = sha256(manifestBuf);
  const report = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Backup evidence ${esc(stamp)}</title>
<style>body{font:14px/1.5 Segoe UI,Arial,sans-serif;color:#172B45;max-width:900px;margin:32px auto;padding:0 20px}h1{color:#0B2D5B;font-size:22px;border-bottom:4px solid #76B82A;padding-bottom:10px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #DDE3EB;padding:6px 10px;text-align:left;vertical-align:top}th{background:#F3F5F8}code{font-size:12px;word-break:break-all}.ok{color:#3E7D16;font-weight:bold}.bad{color:#B42318;font-weight:bold}</style></head><body>
<h1>${esc(manifest.application)}: backup evidence</h1>
<table><tr><th>Backup ID</th><td>${esc(stamp)}</td></tr><tr><th>Started</th><td>${esc(manifest.startedAt)} (UTC)</td></tr><tr><th>Finished</th><td>${esc(manifest.finishedAt)} (UTC)</td></tr>
<tr><th>Source</th><td>${esc(site.displayName)}<br>${esc(site.webUrl)}</td></tr><tr><th>Stored at</th><td>${esc(folderItem.webUrl)}</td></tr>
<tr><th>Triggered by</th><td>${esc(run.type)}${run.startedBy ? `, ${esc(run.startedBy)}` : ""}${run.runUrl ? `<br>Run log: ${esc(run.runUrl)}` : ""}</td></tr>
<tr><th>Verification</th><td class="${verified ? "ok" : "bad"}">${esc(manifest.verification)}</td></tr>
<tr><th>Manifest SHA-256</th><td><code>${manifestHash}</code></td></tr></table>
<h2>Files</h2><table><tr><th>File</th><th>Contents</th><th>Records</th><th>Size (bytes)</th><th>SHA-256</th><th>Verified</th></tr>
${manifest.files.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.list)}</td><td>${f.rows}</td><td>${f.bytes}</td><td><code>${f.sha256}</code></td><td class="${f.verified ? "ok" : "bad"}">${f.verified ? "Yes" : "No"}</td></tr>`).join("")}</table>
<h2>How to check this backup independently</h2><p>Download any file and compare its SHA-256 hash with the table above. On Windows: <code>certutil -hashfile tickets.json SHA256</code>. On macOS or Linux: <code>shasum -a 256 tickets.json</code>. The same hashes are recorded in the service desk activity log${run.runUrl ? " and in the GitHub Actions run log" : ""}, so a changed file can always be detected.</p>
<h2>How to restore</h2><p>Follow “Restoring from a backup” in the project README. A restore recreates every list, keeps the original ticket numbers and dates, and checks every hash before it starts.</p>
</body></html>`);
  await upload(sid, `${folder}/manifest.json`, manifestBuf, "application/json");
  await upload(sid, `${folder}/evidence-report.html`, report, "text/html");
  fs.writeFileSync(path.join(outDir, "manifest.json"), manifestBuf);
  fs.writeFileSync(path.join(outDir, "evidence-report.html"), report);

  // Optional retention: delete backup folders older than BACKUP_RETENTION_DAYS (0 or unset keeps everything).
  const keepDays = Number(process.env.BACKUP_RETENTION_DAYS || 0);
  const removed = [];
  if (keepDays > 0) {
    const kids = await graph(`/sites/${sid}/drive/root:/${ROOT}:/children?$select=name,id,folder&$top=999`);
    for (const k of kids.value || []) {
      const m = k.folder && k.name.match(/^(\d{4})(\d{2})(\d{2})-/);
      if (m && Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3]) > keepDays * 864e5) {
        await graph(`/sites/${sid}/drive/items/${k.id}`, { method: "DELETE" });
        removed.push(k.name);
      }
    }
  }

  await audit({ name: "Automated backup", email: "" }, `Backup ${verified ? "completed and verified" : "FAILED verification"}: ${manifest.totals.records} records in ${files.length} files`, {
    category: "Backup", targetType: "Backup", targetId: stamp,
    details: { verified, folderUrl: folderItem.webUrl, manifestSha256: manifestHash, records: manifest.totals.records, bytes: manifest.totals.bytes, files: manifest.files.map((f) => ({ name: f.name, rows: f.rows, sha256: f.sha256 })), runUrl: run.runUrl, trigger: run.type, retentionDays: keepDays || null, removedOldBackups: removed },
  });

  const summary = [`## Service desk backup ${stamp}`, "", `**Verification:** ${manifest.verification}`, `**Stored at:** ${folderItem.webUrl}`, `**Manifest SHA-256:** \`${manifestHash}\``, "",
    "| File | Records | SHA-256 | Verified |", "|---|---|---|---|", ...manifest.files.map((f) => `| ${f.name} | ${f.rows} | \`${f.sha256}\` | ${f.verified ? "✅" : "❌"} |`),
    removed.length ? `\nRemoved ${removed.length} backups older than ${keepDays} days: ${removed.join(", ")}` : ""].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  console.log(`\n${summary}\n`);
  if (!verified) { console.error("Backup verification FAILED"); process.exit(2); }
  console.log("Backup completed and verified.");
}

main().catch(async (e) => {
  console.error("Backup failed:", e.message);
  await audit({ name: "Automated backup", email: "" }, "Backup FAILED", { category: "Backup", targetType: "Backup", details: { error: e.message, runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "" } });
  process.exit(1);
});
