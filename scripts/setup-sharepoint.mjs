// Creates the SharePoint lists and columns the service desk needs. Safe to run more than once.
// Usage: npm run setup   (reads settings from .env)
import { graph } from "../lib/graph.mjs";
import { getSiteId, LISTS, q } from "../lib/lists.mjs";

const text = (name, indexed = false) => ({ name, text: {}, indexed });
const note = (name) => ({ name, text: { allowMultipleLines: true, textType: "plain", linesForEditing: 6 } });
const num = (name, indexed = false) => ({ name, number: { decimalPlaces: "none" }, indexed });
const date = (name) => ({ name, dateTime: { format: "dateTime" } });
const bool = (name) => ({ name, boolean: {} });

const SCHEMA = {
  tickets: [
    num("TicketNumber", true), note("Description"), text("Status", true), text("Priority"), text("Department"), text("Channel"),
    text("AssigneeName"), text("AssigneeEmail", true), text("RequesterName"), text("RequesterEmail", true), text("RequesterPhone"),
    text("Tags"), date("DueAt"), date("FirstResponseAt"), date("ClosedAt"), date("HoldAt"), date("LastActivityAt"), text("SourceMessageId", true),
  ],
  messages: [num("TicketId", true), text("MessageType"), text("AuthorName"), text("AuthorEmail"), note("Body"), date("SentAt"), text("Source"), text("InternetMessageId", true)],
  events: [num("TicketId", true), text("EventText"), text("Actor"), bool("IsPublic"), date("OccurredAt"), text("RequesterEmail", true)],
  settings: [note("Value")],
};

const DEFAULT_SETTINGS = {
  departments: ["General", "IT support", "Finance", "Admin"],
  agents: [],
  sla: { Urgent: 4, High: 8, Medium: 24, Low: 72 },
};

async function main() {
  const siteId = await getSiteId();
  const site = await graph(`/sites/${siteId}?$select=webUrl,displayName`);
  console.log(`Site found: ${site.displayName} (${site.webUrl})`);
  console.log(`Site ID:    ${siteId}\n`);
  for (const [key, columns] of Object.entries(SCHEMA)) {
    const name = LISTS[key];
    const found = await graph(`/sites/${siteId}/lists?$filter=${encodeURIComponent(`displayName eq '${q(name)}'`)}&$select=id`);
    let listId = found.value?.[0]?.id;
    if (!listId) {
      const created = await graph(`/sites/${siteId}/lists`, { method: "POST", body: { displayName: name, list: { template: "genericList" } } });
      listId = created.id;
      console.log(`Created list "${name}"`);
    } else console.log(`List "${name}" already exists`);

    const existing = await graph(`/sites/${siteId}/lists/${listId}/columns?$select=name`);
    const have = new Set((existing.value || []).map((c) => c.name));
    for (const col of columns) {
      if (have.has(col.name)) continue;
      await graph(`/sites/${siteId}/lists/${listId}/columns`, { method: "POST", body: col });
      console.log(`  + column ${col.name}`);
    }

    if (key === "settings") {
      const rows = await graph(`/sites/${siteId}/lists/${listId}/items?$expand=fields($select=Title)&$top=50`);
      const titles = new Set((rows.value || []).map((r) => r.fields?.Title));
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (titles.has(k)) continue;
        await graph(`/sites/${siteId}/lists/${listId}/items`, { method: "POST", body: { fields: { Title: k, Value: JSON.stringify(v) } } });
        console.log(`  + default setting "${k}"`);
      }
    }
  }
  console.log("\nSharePoint is ready.");
}

main().catch((e) => {
  console.error("\nSetup failed:", e.message);
  process.exit(1);
});
