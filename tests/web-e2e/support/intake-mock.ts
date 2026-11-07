// Slice 5 "Outside tools": the project's intake routes for the Tickets section and the Home ticket card (`project` scenario, project "payments"). State lives for one scenario. Bodies are parsed by
// the contract's strict schemas, as the real routes do.
import { DEFAULT_TICKET_UPDATES, IntakeChannelRefSchema, TicketUpdatesPutBodySchema, TicketUpdatesViewSchema, type IntakeChannelRef, type TicketUpdatesSettings } from "@agentx/contracts";
import { z } from "zod";
import type { MockExchange } from "./how-we-work-mock.js";

export const WAITING_ITEM = "a".repeat(32);
const SESSION = "ses_bbbbbbbbbbbbbbbbbbbb";
interface IntakeState { waiting: boolean; started: boolean; sources: Array<{ sourceId: string; ref: IntakeChannelRef; failing: boolean; failingSince?: string; lastError?: string }>; settings: TicketUpdatesSettings; home: boolean }
const fresh = (): IntakeState => ({
  waiting: true, started: false, home: false,
  sources: [{ sourceId: "b".repeat(24), ref: { channel: "tracker", system: "linear", when: { label: "rovara" } }, failing: true, failingSince: "2026-11-07T08:00:00.000Z", lastError: "CONNECTION_MISSING" }],
  settings: { ...DEFAULT_TICKET_UPDATES, statuses: { ...DEFAULT_TICKET_UPDATES.statuses } },
});
let state = fresh();
export function resetIntake(): void { state = fresh(); }
export function showTicketOnHome(): void { state.home = true; }

/** The Home card of the waiting ticket, while it waits and the test asked for it. */
export function intakeHomeCards(origin: string): unknown[] {
  if (!state.home || !state.waiting) return [];
  const base = `${origin}/v1/app/projects/payments/intake/${WAITING_ITEM}`;
  return [{
    cardId: `waiting_ticket:ph_${"0".repeat(24)}_${WAITING_ITEM}`, kind: "waiting_ticket", title: "Jira PAY-12: Refunds fail twice", at: "2026-11-07T09:00:00.000Z",
    reason: "Waiting to start in \"payments\". Nobody in your company is linked to the tracker account that asked. A company admin can link them in Tracker people.",
    buttons: [{ label: "Start", action: "start", href: `${base}/start`, method: "POST" }, { label: "Not this one", action: "dismiss", href: `${base}/dismiss`, method: "POST" }],
  }];
}

const list = () => ({
  items: state.waiting ? [{ itemId: WAITING_ITEM, channel: "jira", system: "jira", id: "PAY-12", url: "https://acme.atlassian.net/browse/PAY-12", title: "Refunds fail twice", requester: { display: "Dana", standing: "outsider" }, reason: "unlinked", waitingSince: "2026-11-07T09:00:00.000Z" }] : [],
  sources: state.sources,
});
const RequestBody = z.object({ requestId: z.string().uuid() }).strict();
const SourcesBody = z.object({ sources: z.array(IntakeChannelRefSchema).max(8) }).strict();

export async function intakeMock({ url, method, body, json, record }: MockExchange): Promise<boolean> {
  const base = "/v1/web/projects/payments/intake";
  if (url.pathname === base && method === "GET") { json(200, list());return true; }
  if (url.pathname === `${base}/updates`) {
    if (method === "GET") { json(200, TicketUpdatesViewSchema.parse({ settings: state.settings, canEdit: true, access: [{ tracker: "linear", state: "ok" }, { tracker: "jira", state: "needs_write_access", at: "2026-11-07T08:30:00.000Z" }, { tracker: "github", state: "ok" }] }));return true; }
    const input = await body();record(input);
    state.settings = TicketUpdatesPutBodySchema.parse(input).settings;
    json(200, TicketUpdatesViewSchema.parse({ settings: state.settings, canEdit: true, access: [{ tracker: "linear", state: "ok" }, { tracker: "jira", state: "ok" }, { tracker: "github", state: "ok" }] }));return true;
  }
  if (url.pathname === `${base}/sources` && method === "PUT") {
    const input = await body();record(input);
    state.sources = SourcesBody.parse(input).sources.map((ref, index) => ({ sourceId: String(index).repeat(24).slice(0, 24).replace(/\D/gu, "c"), ref, failing: false }));
    json(200, { sources: state.sources });return true;
  }
  const item = new RegExp(`^${base}/([a-f0-9]{32})/(start|dismiss)$`).exec(url.pathname);
  if (item === null || method !== "POST") return false;
  const input = await body();record(input);RequestBody.parse(input);
  if (item[1] !== WAITING_ITEM || !state.waiting) { json(404, { error: { code: "NOT_FOUND", message: "no such waiting ticket" } });return true; }
  state.waiting = false;
  if (item[2] === "dismiss") { json(200, { dismissed: true });return true; }
  state.started = true;
  json(202, { started: true, taskId: "11111111-1111-4111-8111-111111111111", sessionId: SESSION });return true;
}
