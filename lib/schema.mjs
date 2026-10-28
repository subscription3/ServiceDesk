// Columns of every SharePoint list the service desk uses. Shared by setup, backup and restore.
const text = (name, indexed = false) => ({ name, text: {}, indexed });
const note = (name) => ({ name, text: { allowMultipleLines: true, textType: "plain", linesForEditing: 6 } });
const num = (name, indexed = false) => ({ name, number: { decimalPlaces: "none" }, indexed });
const date = (name) => ({ name, dateTime: { format: "dateTime" } });
const bool = (name) => ({ name, boolean: {} });

export const SCHEMA = {
  tickets: [
    num("TicketNumber", true), note("Description"), text("Status", true), text("Priority"), text("Department"), text("Channel"),
    text("AssigneeName"), text("AssigneeEmail", true), text("RequesterName"), text("RequesterEmail", true), text("RequesterPhone"),
    text("Tags"), date("DueAt"), date("FirstResponseAt"), date("ClosedAt"), date("HoldAt"), date("LastActivityAt"), text("SourceMessageId", true),
    date("OpenedAt"),
  ],
  messages: [num("TicketId", true), text("MessageType"), text("AuthorName"), text("AuthorEmail"), note("Body"), date("SentAt"), text("Source"), text("InternetMessageId", true)],
  events: [num("TicketId", true), text("EventText"), text("Actor"), bool("IsPublic"), date("OccurredAt"), text("RequesterEmail", true)],
  settings: [note("Value")],
  feedback: [num("TicketId", true), num("TicketNumber"), num("Rating"), note("Comment"), text("RequesterEmail", true), text("AssigneeEmail", true), text("AssigneeName"), date("SubmittedAt"), text("Via")],
  audit: [text("Category", true), text("ActorName"), text("ActorEmail", true), text("TargetType"), text("TargetId"), note("Details"), text("IpAddress"), text("UserAgent"), { ...date("OccurredAt"), indexed: true }],
};


// Columns copied when restoring (Title plus every column above).
export const restoreColumns = (key) => ["Title", ...SCHEMA[key].map((c) => c.name)];
