// Runs every 5 minutes on Netlify and turns new emails in the support mailbox into tickets.
import { pollInbox } from "../../lib/inbox.mjs";

export default async () => {
  try {
    const r = await pollInbox({ max: 10 });
    console.log("Mailbox check", JSON.stringify(r));
  } catch (e) {
    console.error("Mailbox check failed", e.message);
  }
  return new Response("ok");
};

export const config = { schedule: "*/5 * * * *" };
