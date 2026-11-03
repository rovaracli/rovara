// The Jira organization admin key (DV-1, owner decision 2026-11-02): `/v1/app/org/jira-org-admin`, the one place a company owner or admin sets or clears the READ-ONLY Atlassian organization admin API key and the
// Atlassian organization id of a Jira connection. They let Rovara read which Jira accounts the company manages (opt-in automatic tracker linking). `org` is a browser route family, so the app reaches it as
// `/v1/web/org/jira-org-admin`. It exists only where the Team record's switch is on (`deps.teamRecord`) and the install has org connections; otherwise the path is not found, as any unknown path.
//   POST   an owner or admin, from a live browser session only, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise), where the audit ledger can take the change:
//            { action: "set",   requestId, connectionId, orgAdminKey, atlassianOrgId }   both or neither: a key without the id (or the reverse) is refused
//            { action: "clear", requestId, connectionId }
// There is no read: the key is write-only and nothing returns it. A save through the connection's own route that leaves the pair out keeps it. The reply is a fixed word. Refusals name the field, never its value.
import { z } from "zod";
import { AtlassianOrgAdminKey, AtlassianOrgId, ConnectionIdSchema, agentXError } from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const JIRA_ORG_ADMIN_PATH = "/v1/app/org/jira-org-admin";
export const JIRA_ORG_ADMIN_BROWSER_MESSAGE = "Use a live browser session to change the Jira organization admin key.";

const RequestId = z.string().uuid();
const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), requestId: RequestId, connectionId: ConnectionIdSchema, orgAdminKey: AtlassianOrgAdminKey, atlassianOrgId: AtlassianOrgId }).strict(),
  z.object({ action: z.literal("clear"), requestId: RequestId, connectionId: ConnectionIdSchema }).strict(),
]);

/** The reply, or undefined when the path is not this one or the Team record or the connections are not set up. */
export async function routeJiraOrgAdmin(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  if (url.pathname !== JIRA_ORG_ADMIN_PATH || deps.teamRecord === undefined || deps.orgConnections === undefined) return undefined;
  if (request.method !== "POST") return undefined;
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only a company owner or admin can change the Jira organization admin key.");
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", JIRA_ORG_ADMIN_BROWSER_MESSAGE);
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only, never a value or an unknown field's name: a body can carry a key where a name goes.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  await requireFreshSignIn(deps, caller);
  if (deps.audit === undefined) throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
  const body = parsed.data;
  const outcome = await deps.orgConnections.changeJiraOrgAdmin({
    orgId: caller.orgId, connectionId: body.connectionId, by: caller.developerId, requestId: body.requestId,
    change: body.action === "clear" ? "clear" : { orgAdminKey: body.orgAdminKey, atlassianOrgId: body.atlassianOrgId },
  });
  if (outcome === "not_found" || outcome === "not_jira") throw agentXError("NOT_FOUND", "no Jira connection has that ID");
  if (outcome === "not_ready") throw agentXError("CONFIG_INVALID", "connectionId: save this Jira connection's email and API token first");
  if (outcome === "request_reused") throw agentXError("IDEMPOTENCY_CONFLICT", "That request was used for a different change. Start again.");
  if (outcome === "audit_unavailable") throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
  logDeveloperEvent({ event: "developer.jira_org_admin_changed", orgId: caller.orgId, change: body.action });
  return new StatusReply(200, { status: body.action === "clear" ? "cleared" : "saved" });
}
