// Customer satisfaction (CSAT) feedback after a ticket is closed.
import crypto from "node:crypto";
import { createItem, updateItem, queryItems } from "./lists.mjs";
import { env } from "./graph.mjs";
import { httpError } from "./errors.mjs";

export const RATINGS = { 1: "Very dissatisfied", 2: "Dissatisfied", 3: "Neutral", 4: "Satisfied", 5: "Very satisfied" };
const LINK_DAYS = 30;
const b64 = (buf) => Buffer.from(buf).toString("base64url");

function secret() {
  // A dedicated FEEDBACK_SECRET is best; otherwise derive one from the app secret.
  return process.env.FEEDBACK_SECRET || crypto.createHmac("sha256", env("AZURE_CLIENT_SECRET")).update("feedback-links").digest("hex");
}
export function signFeedbackToken(t) {
  const body = b64(JSON.stringify({ id: t.id, n: t.number, e: t.requesterEmail, x: Date.now() + LINK_DAYS * 864e5 }));
  return `${body}.${b64(crypto.createHmac("sha256", secret()).update(body).digest())}`;
}
export function verifyFeedbackToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) throw httpError(400, "This feedback link isn’t valid.");
  const want = crypto.createHmac("sha256", secret()).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw httpError(400, "This feedback link isn’t valid.");
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  if (Date.now() > p.x) throw httpError(410, "This feedback link has expired. You can still rate the ticket in the service desk portal.");
  return p;
}

const ms = (x) => (x ? Date.parse(x) : null);
export const toFeedback = (f) => ({
  id: Number(f.id), ticketId: Number(f.TicketId), number: Number(f.TicketNumber), rating: Number(f.Rating), label: RATINGS[Number(f.Rating)] || "",
  comment: f.Comment || "", requesterEmail: f.RequesterEmail || "", assigneeEmail: f.AssigneeEmail || "", assigneeName: f.AssigneeName || "",
  at: ms(f.SubmittedAt) || ms(f.Created), via: f.Via || "",
});

export async function getFeedback(ticketId) {
  const rows = await queryItems("feedback", `fields/TicketId eq ${Number(ticketId)}`);
  return rows.length ? toFeedback(rows.sort((a, b) => Number(b.id) - Number(a.id))[0]) : null;
}
export async function listFeedback() {
  return (await queryItems("feedback", null, { top: 999 })).map(toFeedback);
}
// One rating per ticket: submitting again updates it.
export async function saveFeedback(t, { rating, comment, via }) {
  const r = Math.round(Number(rating));
  if (!(r >= 1 && r <= 5)) throw httpError(400, "Choose a rating from 1 to 5.");
  if (t.status !== "Closed") throw httpError(400, "You can rate a ticket once it’s been resolved.");
  const fields = {
    Title: `#${t.number}`, TicketId: t.id, TicketNumber: t.number, Rating: r, Comment: String(comment || "").trim().slice(0, 4000) || undefined,
    RequesterEmail: t.requesterEmail || undefined, AssigneeEmail: t.assigneeEmail || undefined, AssigneeName: t.assigneeName || undefined,
    SubmittedAt: new Date().toISOString(), Via: via,
  };
  const existing = await getFeedback(t.id);
  if (existing) { await updateItem("feedback", existing.id, fields); return { ...existing, ...toFeedback({ ...fields, id: existing.id }), updated: true }; }
  const item = await createItem("feedback", fields);
  return { ...toFeedback(item), updated: false };
}
