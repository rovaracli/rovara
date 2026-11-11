// Tracker people (lane team-record-links): `/v1/app/org/tracker-people`, the page where a company admin maps the Linear and Jira people the automatic linker could not match to a member of the company. `org` is a
// browser route family, so the app reaches it as `/v1/web/org/tracker-people`. It exists only where the Team record's switch is on (`deps.teamRecord`); with it off the path is not found, as any unknown path.
//   GET    an owner or admin, from a live browser session only: the tool users nobody is linked to (the name the tool showed and the tool's id; never an email) and the ones that are linked (so one can be unmapped).
//   POST   an owner or admin, from a live browser session only, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise):
//            { action: "map",   requestId, system, sourceId, developerId }   links the tool user to a member of the SAME company; audited (the event is written first: a ledger that cannot take it refuses the change);
//            { action: "auto_link", requestId, enabled }  turns the company's automatic linking on or off (off by default; audited). Off stops NEW automatic links; existing links stay until unmapped.
//            { action: "unmap", requestId, system, sourceId }                 takes the link away; audited. Changes by that tool user are then not stored (and are counted); rows already stored stay and a
//                                                                             person's erase still takes them.
// Answers are fixed words, ids and the names the tool showed.
import { z } from "zod";
import { agentXError } from "@rovara-code/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TRACKER_PEOPLE_PATH = "/v1/app/org/tracker-people";
export const TRACKER_PEOPLE_BROWSER_MESSAGE = "Use a live browser session to map people from your tracker to your company.";

const System = z.string().regex(/^(linear|jira:[a-z0-9][a-z0-9.-]{0,252})$/u);
const SourceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/u);
const RequestId = z.string().uuid();
const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("map"), requestId: RequestId, system: System, sourceId: SourceId, developerId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("unmap"), requestId: RequestId, system: System, sourceId: SourceId }).strict(),
  z.object({ action: z.literal("auto_link"), requestId: RequestId, enabled: z.boolean() }).strict(),
]);

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";
const toolOf = (system: string): "Linear" | "Jira" => (system.startsWith("jira") ? "Jira" : "Linear");

/** The reply, or undefined when the path is not this one or the Team record is off. */
export async function routeTrackerPeople(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  if (url.pathname !== TRACKER_PEOPLE_PATH || deps.teamRecord === undefined) return undefined;
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  if (!isAdmin(caller)) throw agentXError("FORBIDDEN", "Only a company owner or admin can map tracker people.");
  // The names a tool showed and the ids of company members are for the page, in a browser: a token (an API key) does not read them either.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", TRACKER_PEOPLE_BROWSER_MESSAGE);
  const people = deps.teamRecord.trackerPeople;
  if (request.method === "GET") {
    const listed = await people.list(caller.orgId);
    return new StatusReply(200, {
      unmatched: listed.unmatched.map((user) => ({ tool: toolOf(user.system), system: user.system, sourceId: user.sourceId, displayName: user.displayName, ...(user.reason === undefined ? {} : { reason: user.reason }) })),
      linked: listed.linked.map((user) => ({ tool: toolOf(user.system), system: user.system, sourceId: user.sourceId, displayName: user.displayName, developerId: user.developerId, via: user.via, ...(user.why === undefined ? {} : { why: user.why }) })),
      truncated: listed.truncated,
      autoLink: listed.autoLink,
    });
  }
  // The change needs a sign-in within the last 10 minutes (a token, the CLI and Slack were refused above).
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  await requireFreshSignIn(deps, caller);
  const body = parsed.data;
  if (body.action === "auto_link") {
    const outcome = await people.setAutoLink(caller.orgId, { enabled: body.enabled, by: caller.developerId, requestId: body.requestId });
    if (outcome === "audit_unavailable") throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    if (outcome === "request_reused") throw agentXError("IDEMPOTENCY_CONFLICT", "That request was used for a different change. Start again.");
    logDeveloperEvent({ event: "developer.tracker_autolink_changed", orgId: caller.orgId, enabled: String(body.enabled) });
    return new StatusReply(200, { status: body.enabled ? "auto_link_on" : "auto_link_off" });
  }
  if (body.action === "map") {
    const outcome = await people.map(caller.orgId, { system: body.system, sourceId: body.sourceId, developerId: body.developerId, by: caller.developerId, requestId: body.requestId });
    if (outcome === "not_found") throw agentXError("NOT_FOUND", "That person is not on the list. Reload the page.");
    if (outcome === "not_member") throw agentXError("CONFIG_INVALID", "developerId: pick a member of your company.");
    if (outcome === "audit_unavailable") throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    if (outcome === "request_reused") throw agentXError("IDEMPOTENCY_CONFLICT", "That request was used for a different change. Start again.");
    logDeveloperEvent({ event: "developer.tracker_person_mapped", orgId: caller.orgId, tool: toolOf(body.system) });
    return new StatusReply(200, { status: "mapped" });
  }
  const outcome = await people.unmap(caller.orgId, { system: body.system, sourceId: body.sourceId, by: caller.developerId, requestId: body.requestId });
  if (outcome === "not_found") throw agentXError("NOT_FOUND", "That person is not mapped. Reload the page.");
  if (outcome === "audit_unavailable") throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
  if (outcome === "request_reused") throw agentXError("IDEMPOTENCY_CONFLICT", "That request was used for a different change. Start again.");
  logDeveloperEvent({ event: "developer.tracker_person_unmapped", orgId: caller.orgId, tool: toolOf(body.system) });
  return new StatusReply(200, { status: "unmapped" });
}
