// Approval place (U4, decision 83, A-08): `/v1/app/org/approval-window`, the company's recent sign-in window for approvals outside Rovara. `org` is a browser route family, so the app reaches it as `/v1/web/org/approval-window`.
// Exists only while the decision cards switch is on (`dk`, the switch the place rules sit under): with it off every method answers 404 as any unknown path.
//   GET     any company member: the window, whether the caller may change it and, for an owner or admin, the one request that waits.
//   POST    an owner or admin, from a live browser session only (a token, the CLI or Slack never change it), on the revision they read (`POLICY_STALE` when it moved):
//             { action: "set", expectedRevision, seconds }   a shorter (or equal) window applies at once; a LONGER one needs a sign-in within the last 10 minutes and then waits for a different admin (202);
//             { action: "approve", changeId }                a different admin approves the waiting lengthening, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise);
//             { action: "cancel", changeId }                 withdraws the waiting request (its proposer, or any admin).
// Answers are fixed words, numbers and ids. The rules and the transaction are `approval-place/window-setting.ts`.
import { ApprovalWindowBodySchema, APPROVAL_WINDOW_PATH, RECENT_SIGN_IN_DEFAULT_SECONDS, RECENT_SIGN_IN_MAX_SECONDS, RECENT_SIGN_IN_MIN_SECONDS, agentXError, type ApprovalWindowBody, type ApprovalWindowState, type OrgId } from "@agentx/contracts";
import { secondPersonTier0Authority } from "../../lessons/tier0-authority.js";
import { readCompanyAdminActorConditions } from "../../org/second-person-evidence.js";
import { sameId } from "../../lessons/types.js";
import { approveApprovalWindowChange, cancelApprovalWindowChange, openWindowChange, readApprovalWindow, setApprovalWindow, type ApprovalWindowDeps, type WindowRefusal } from "../../approval-place/window-setting.js";
import { logDeveloperEvent } from "../../developer/log.js";
import { nameResolverOf, resolveStoredName } from "../../developer/name-resolver.js";
import { safeDisplayName } from "../../developer/person-name.js";
import { decisionCardsEnabled } from "../../proof/switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { signInStoreOf } from "./common.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export { APPROVAL_WINDOW_PATH };
export const APPROVAL_WINDOW_BROWSER_MESSAGE = "Use a live browser session to change the recent sign-in window.";
const ADMINS_ONLY = "Only a company owner or admin can do this.";

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

/** What each refusal says, in fixed words (the code decides the error, never a message from below). */
function refusal(result: WindowRefusal): Error {
  switch (result.code) {
    case "not_eligible": return agentXError("FORBIDDEN", ADMINS_ONLY);
    case "second_person_required": return agentXError("FORBIDDEN", "A different admin has to approve this. If you are the company's only admin, only the company owner can do it alone.");
    case "sole_owner_cool_off": return agentXError("FORBIDDEN", `An admin was removed from the company in the last 24 hours, so a change that needs a second person cannot be made alone yet${result.availableAt === undefined ? "." : `. It opens at ${result.availableAt}.`}`);
    case "eligibility_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not check who may change this. Try again.");
    case "audit_unavailable": return agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    case "already_open": return agentXError("CHANGE_STALE", "A request is already waiting for a different admin. Withdraw it first.");
    case "expired": return agentXError("CHANGE_STALE", "That request expired. Ask again.");
    case "not_found": return agentXError("NOT_FOUND", "No such request.");
    case "not_pending": return agentXError("CHANGE_STALE", "That request was already settled.");
    case "stale": return agentXError("POLICY_STALE", "This changed while you were looking. Reload and try again.");
    case "unreadable": return agentXError("CONFIG_INVALID", "The stored sign-in window could not be read, so nothing was changed.");
    default: return agentXError("CONFIG_INVALID", "seconds: invalid");
  }
}

function windowDepsOf(deps: DeveloperRouteDependencies): ApprovalWindowDeps {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "This setting is not available here.");
  const evidence = { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now };
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now(),
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    authority: secondPersonTier0Authority(evidence),
    actor: (orgId, by) => readCompanyAdminActorConditions(evidence, { orgId, actorId: by }),
  };
}

/** The display name of whoever last changed the window: their sign-in name, a placeholder for someone erased, and a fixed word when it cannot be read (the state never fails over a name). */
async function changedByName(deps: DeveloperRouteDependencies, orgId: OrgId, developerId: string): Promise<string> {
  try {
    const row = await signInStoreOf(deps).getDeveloper(developerId);
    const stored = row === undefined ? "A former member" : safeDisplayName(row.displayName, developerId);
    return await resolveStoredName(nameResolverOf(deps, orgId), developerId, stored);
  } catch {
    return "A company admin";
  }
}

async function stateOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<ApprovalWindowState> {
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const read = await readApprovalWindow(table, caller.orgId);
  const admin = isAdmin(caller);
  const open = admin ? await openWindowChange(table, caller.orgId, deps.now()).catch(() => undefined) : undefined;
  return {
    revision: read.revision, seconds: read.seconds, isDefault: read.isDefault, defaultSeconds: RECENT_SIGN_IN_DEFAULT_SECONDS, minSeconds: RECENT_SIGN_IN_MIN_SECONDS, maxSeconds: RECENT_SIGN_IN_MAX_SECONDS,
    ...(read.changedBy === undefined || read.changedAt === undefined ? {} : { changedBy: await changedByName(deps, caller.orgId, read.changedBy), changedAt: read.changedAt }),
    canChange: admin, unreadable: read.unreadable,
    ...(open === undefined ? {} : { pending: { changeId: open.id, seconds: open.seconds, proposedByYou: sameId(open.proposedBy, caller.developerId), expiresAt: new Date(open.expiresAt).toISOString() } }),
  };
}

/** The reply, or undefined when the path is not this one or the decision cards switch is off (the path is then not found, as any unknown path: the app's nav probes it with a GET). */
export async function routeApprovalWindow(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (url.pathname !== APPROVAL_WINDOW_PATH || !decisionCardsEnabled(env)) return undefined;
  if (request.method === "GET") return new StatusReply(200, await stateOf(deps, caller));
  if (request.method !== "POST") return undefined;
  // Defence in depth: the entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", APPROVAL_WINDOW_BROWSER_MESSAGE);
  if (!isAdmin(caller)) throw agentXError("FORBIDDEN", ADMINS_ONLY);
  const parsed = ApprovalWindowBodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  return changeApprovalWindow(deps, caller, caller.orgId, parsed.data);
}

/** One line per refused change, so a press that changed nothing can be found in the logs: the action and the refusal's fixed reason word only (no person ids, no values). */
function logRefused(orgId: OrgId, action: ApprovalWindowBody["action"], reason: string): void {
  logDeveloperEvent({ event: "developer.approval_window_refused", orgId, action, reason });
}

async function changeApprovalWindow(deps: DeveloperRouteDependencies, caller: DeveloperCaller, orgId: OrgId, body: ApprovalWindowBody): Promise<StatusReply> {
  const window = windowDepsOf(deps);
  const refused = (result: WindowRefusal): Error => { logRefused(orgId, body.action, result.code); return refusal(result); };
  const freshSignIn = async (): Promise<void> => {
    try { await requireFreshSignIn(deps, caller); } catch (error) { if ((error as { code?: unknown }).code === "REAUTH_REQUIRED") logRefused(orgId, body.action, "reauth_required"); throw error; }
  };
  if (body.action === "set") {
    const result = await setApprovalWindow(window, { orgId, by: caller.developerId, expectedRevision: body.expectedRevision, seconds: body.seconds, onLengthening: freshSignIn });
    if (!result.ok) throw refused(result);
    logDeveloperEvent({ event: "developer.approval_window_set", orgId, status: result.status });
    if (result.status === "needs_approval") return new StatusReply(202, { status: "needs_approval", changeId: result.changeId, ...(await stateOf(deps, caller)) });
    return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
  }
  if (body.action === "cancel") {
    const result = await cancelApprovalWindowChange(window, { orgId, by: caller.developerId, changeId: body.changeId });
    if (!result.ok) throw refused(result);
    logDeveloperEvent({ event: "developer.approval_window_request_withdrawn", orgId });
    return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
  }
  await freshSignIn();
  const result = await approveApprovalWindowChange(window, { orgId, changeId: body.changeId, approverId: caller.developerId });
  if (!result.ok) throw refused(result);
  logDeveloperEvent({ event: "developer.approval_window_approved", orgId });
  return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
}
