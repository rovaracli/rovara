// Setup and test health SH17 (owner decision F4): `/v1/app/org/known-failing-policy`, the company setting "always two people" for marking tests as already failing. Behind the `vx` switch: with it off the path is
// not found, as any unknown path. `org` is a browser route family, so the app reaches it as `/v1/web/org/known-failing-policy`.
//   GET     any member of the company: whether every mark needs a second person, and whether a proposal to turn that off is waiting. An admin also gets the proposal's id and whether they made it.
//   POST    an owner or admin, from a live browser session only (a token, the CLI or Slack never change it):
//             { action: "set", alwaysTwoPeople: true }     applies at once (the stricter side), audited;
//             { action: "set", alwaysTwoPeople: false }    opens a proposal (202 needs_approval) that a DIFFERENT eligible admin approves; audited;
//             { action: "approve", changeId }              a different admin approves turning it off, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise). The company's sole-owner exception does NOT apply: a company of one that turned it on keeps it on until a second admin joins.
// The rules are the shared sole-owner switch's (lessons/sole-owner-switch.ts), through `org/known-failing-policy.ts`: every write is conditional on the value it was made against and fenced on the membership the decision
// rested on; an unreadable setting counts as "always two people". Answers are fixed words, booleans and ids.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { type AuditEventInput } from "@agentx/cloud-contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending } from "../../audit/outbox.js";
import { KnownFailingPolicyStore, alwaysTwoPeople, approveAlwaysTwoPeopleOff, knownFailingPolicyAuditSink, setAlwaysTwoPeople, type KnownFailingPolicyDeps } from "../../org/known-failing-policy.js";
import { verifyResultsEnabled } from "../../verification/switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { Tier0Failure } from "../../lessons/sole-owner-switch.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const KNOWN_FAILING_POLICY_PATH = "/v1/app/org/known-failing-policy";
export const KNOWN_FAILING_POLICY_BROWSER_MESSAGE = "Use a live browser session to change how marking known-failing tests is approved.";

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), alwaysTwoPeople: z.boolean() }).strict(),
  z.object({ action: z.literal("approve"), changeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u) }).strict(),
]);

/** What each refusal of the shared switch says, in fixed words (the code decides the error, never a message from below). */
function refusal(code: Tier0Failure): Error {
  switch (code) {
    case "not_eligible": return agentXError("FORBIDDEN", "Only a company owner or admin can change this.");
    case "second_person_required": return agentXError("FORBIDDEN", "A different admin has to approve turning this off.");
    case "eligibility_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not check who may change this. Try again.");
    case "audit_unavailable": return agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    case "already_open": return agentXError("CHANGE_STALE", "A proposal to turn this off is already waiting for a different admin.");
    case "expired": return agentXError("CHANGE_STALE", "That proposal expired. Ask again.");
    case "not_found": return agentXError("NOT_FOUND", "No such proposal.");
    case "membership_changed_retry": return agentXError("CHANGE_STALE", "Someone joined or left the admins meanwhile. Check and approve again.");
    default: return agentXError("CHANGE_STALE", "This setting changed. Reload and try again.");
  }
}

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

function policyDepsOf(deps: DeveloperRouteDependencies): KnownFailingPolicyDeps {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "This setting is not available here.");
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const auditDeps = { ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  // The event is written to the pending outbox and sent; with no ledger the write throws, so a loosening (which requires its event) is refused and a tightening goes on without one.
  const write = async (event: AuditEventInput): Promise<void> => {
    const items = auditPending(auditDeps, event);
    const put = items[0]?.Put;
    if (put === undefined) throw new Error("no audit ledger");
    await deps.documentClient.send(new PutCommand(put));
    await flushAuditEvents(auditDeps, [event]);
  };
  return { table, evidence: { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now }, now: () => deps.now(), audit: knownFailingPolicyAuditSink(write, () => deps.now()) };
}

async function stateOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller) {
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const always = await alwaysTwoPeople(table, caller.orgId);
  const open = await new KnownFailingPolicyStore(table).open(caller.orgId, deps.now()).catch(() => undefined);
  return {
    alwaysTwoPeople: always,
    pendingLoosening: open !== undefined,
    // Only an admin is told which proposal it is, and whether it is theirs (a member has nothing to do with it).
    ...(open !== undefined && isAdmin(caller) ? { pending: { changeId: open.id, proposedByYou: open.proposedBy === caller.developerId, expiresAt: new Date(open.expiresAt).toISOString() } } : {}),
  };
}

/** The reply, or undefined when the switch is off or the path is not this one. */
export async function routeKnownFailingPolicy(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!verifyResultsEnabled(env) || url.pathname !== KNOWN_FAILING_POLICY_PATH) return undefined;
  if (request.method === "GET") return new StatusReply(200, await stateOf(deps, caller));
  if (request.method !== "POST") return undefined;
  // Defence in depth: the entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", KNOWN_FAILING_POLICY_BROWSER_MESSAGE);
  if (!isAdmin(caller)) throw agentXError("FORBIDDEN", "Only a company owner or admin can change this.");
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const policy = policyDepsOf(deps);
  const orgId: OrgId = caller.orgId;
  if (parsed.data.action === "set") {
    const result = await setAlwaysTwoPeople(policy, { orgId, alwaysTwo: parsed.data.alwaysTwoPeople, requestedBy: caller.developerId });
    if (!result.ok) throw refusal(result.code);
    logDeveloperEvent({ event: "developer.known_failing_policy_set", orgId, status: result.status });
    if (result.status === "needs_approval") return new StatusReply(202, { status: "needs_approval", changeId: result.changeId, ...(await stateOf(deps, caller)) });
    return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
  }
  // Loosening needs the approving admin to have signed in within the last 10 minutes (the same rule as approving a less-safe test environment): a left-open browser cannot turn the safeguard off.
  await requireFreshSignIn(deps, caller);
  const result = await approveAlwaysTwoPeopleOff(policy, { orgId, changeId: parsed.data.changeId, approverId: caller.developerId });
  if (!result.ok) throw refusal(result.code);
  logDeveloperEvent({ event: "developer.known_failing_policy_approved", orgId });
  return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
}
