// Design review (DR-FU4): `/v1/app/org/design-review`, the company's How we work card for design review, for company owners and admins only. It exists only while the `dr` switch is on: with it off the path is not found, as any
// unknown path, and nothing is read. `org` is a browser route family, so the app reaches it as `/v1/web/org/design-review`.
//   GET     an owner or admin: whether design review is allowed for the company, the stricter-only lock, and the one request that waits, if any. (Projects choose their own mode in their How we work; unset means Off.)
//   POST    an owner or admin, from a live browser session only (a token, the CLI or Slack never change it), on the revision they read (`POLICY_STALE` when it moved):
//             { action: "save", expectedRevision, lock }                   a lock change that only tightens applies at once; a lock change that LOOSENS anything waits for a different admin (202);
//             { action: "allow", expectedRevision, allowed: false }       applied at once (the stricter side; it also withdraws a waiting request), audited;
//             { action: "allow", expectedRevision, allowed: true }        202 needs_approval: a DIFFERENT admin approves. Alone only through the shared sole-owner exception (the only owner, 24 hours after the last admin was lost);
//             { action: "approve", changeId }                              a different admin approves the waiting request, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise);
//             { action: "cancel", changeId }                               withdraws the waiting request (its proposer, or any admin).
// A loosening and an approval need a sign-in within the last 10 minutes, like the other company safeguards. The rules and the transaction are design-review/company.ts. Answers are fixed words, booleans, numbers and ids.
import { featureEnabled, agentXError, DesignReviewCompanyBodySchema, DESIGN_REVIEW_COMPANY_PATH, type DesignReviewCompanyBody, type DesignReviewCompanyState, type OrgId } from "@agentx/contracts";
import { secondPersonTier0Authority } from "../../lessons/tier0-authority.js";
import { readCompanyAdminActorConditions } from "../../org/second-person-evidence.js";
import { sameId } from "../../lessons/types.js";
import { approveDesignReviewChange, cancelDesignReviewChange, companyViewOf, openPolicyChange, requestDesignReviewAllowed, saveDesignReviewCompany, type DesignReviewCompanyDeps, type PolicyRefusal } from "../../design-review/company.js";
import { readDesignReviewCompany } from "../../design-review/lock.js";
import { designReviewEnabled } from "../../design-review/switch.js";
import { logDeveloperEvent } from "../../developer/log.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export { DESIGN_REVIEW_COMPANY_PATH };
export const DESIGN_REVIEW_COMPANY_BROWSER_MESSAGE = "Use a live browser session to change design review for the company.";
const ADMINS_ONLY = "Only a company owner or admin can do this.";

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";

/** What each refusal says, in fixed words (the code decides the error, never a message from below). */
function refusal(result: PolicyRefusal): Error {
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
    case "unreadable": return agentXError("CONFIG_INVALID", "The stored design review settings could not be read, so nothing was changed.");
    case "group_not_available": return agentXError("CONFIG_INVALID", "lock.approverGroupId: group approvers need the Enterprise edition.");
    default: return agentXError("CONFIG_INVALID", "body: invalid");
  }
}

function companyDepsOf(deps: DeveloperRouteDependencies): DesignReviewCompanyDeps {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "This setting is not available here.");
  const evidence = { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now };
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now(), edition: deps.editionPolicy,
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    authority: secondPersonTier0Authority(evidence),
    actor: (orgId, by) => readCompanyAdminActorConditions(evidence, { orgId, actorId: by }),
  };
}

async function stateOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DesignReviewCompanyState> {
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const view = companyViewOf(await readDesignReviewCompany(table, caller.orgId));
  const open = await openPolicyChange(table, caller.orgId, deps.now()).catch(() => undefined);
  const groups = deps.editionPolicy !== undefined && featureEnabled(deps.editionPolicy, "groups");
  return {
    revision: view.revision ?? 0, allowed: view.allowed, lock: view.lock, unreadable: view.unreadable,
    ...(groups ? { groups: true as const } : {}),
    ...(open === undefined ? {} : { pending: { changeId: open.id, kind: open.kind, proposedByYou: sameId(open.proposedBy, caller.developerId), expiresAt: new Date(open.expiresAt).toISOString() } }),
  };
}

/** The reply, or undefined when `dr` is off or the path is not this one. */
export async function routeDesignReviewCompany(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!designReviewEnabled(env) || url.pathname !== DESIGN_REVIEW_COMPANY_PATH) return undefined;
  if (request.method === "GET") {
    if (!isAdmin(caller)) throw agentXError("FORBIDDEN", ADMINS_ONLY);
    return new StatusReply(200, await stateOf(deps, caller));
  }
  if (request.method !== "POST") return undefined;
  // Defence in depth: the entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", DESIGN_REVIEW_COMPANY_BROWSER_MESSAGE);
  if (!isAdmin(caller)) throw agentXError("FORBIDDEN", ADMINS_ONLY);
  const parsed = DesignReviewCompanyBodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const orgId: OrgId = caller.orgId;
  const body = parsed.data;
  try {
    return await changeDesignReviewCompany(deps, caller, orgId, body);
  } catch (error) {
    // One line per refused change, so a press that did nothing can be found in the logs: the action and the error code only (no person ids, no values).
    const code = (error as { code?: unknown }).code;
    logDeveloperEvent({ event: "developer.design_review_company_refused", orgId, action: body.action, code: typeof code === "string" ? code : "UNKNOWN" });
    throw error;
  }
}

async function changeDesignReviewCompany(deps: DeveloperRouteDependencies, caller: DeveloperCaller, orgId: OrgId, body: DesignReviewCompanyBody): Promise<StatusReply> {
  const company = companyDepsOf(deps);
  if (body.action === "save") {
    const result = await saveDesignReviewCompany(company, {
      orgId, by: caller.developerId, expectedRevision: body.expectedRevision, lock: body.lock,
      // A lock change that loosens anything is a loosening: it needs a sign-in within the last 10 minutes, like allowing.
      onLoosening: async () => { await requireFreshSignIn(deps, caller); },
    });
    if (!result.ok) throw refusal(result);
    logDeveloperEvent({ event: "developer.design_review_company_saved", orgId, status: result.status });
    if (result.status === "needs_approval") return new StatusReply(202, { status: "needs_approval", changeId: result.changeId, ...(await stateOf(deps, caller)) });
    return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
  }
  if (body.action === "allow") {
    if (body.allowed) await requireFreshSignIn(deps, caller);
    const result = await requestDesignReviewAllowed(company, { orgId, by: caller.developerId, allowed: body.allowed, expectedRevision: body.expectedRevision });
    if (!result.ok) throw refusal(result);
    logDeveloperEvent({ event: "developer.design_review_allowed_set", orgId, status: result.status });
    if (result.status === "needs_approval") return new StatusReply(202, { status: "needs_approval", changeId: result.changeId, ...(await stateOf(deps, caller)) });
    return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
  }
  if (body.action === "cancel") {
    const result = await cancelDesignReviewChange(company, { orgId, by: caller.developerId, changeId: body.changeId });
    if (!result.ok) throw refusal(result);
    logDeveloperEvent({ event: "developer.design_review_request_withdrawn", orgId });
    return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
  }
  await requireFreshSignIn(deps, caller);
  const result = await approveDesignReviewChange(company, { orgId, changeId: body.changeId, approverId: caller.developerId });
  if (!result.ok) throw refusal(result);
  logDeveloperEvent({ event: "developer.design_review_allowed_approved", orgId });
  return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
}
