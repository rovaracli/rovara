// Design review (DR-FU4): `/v1/app/org/design-review`, the company's How we work card for design review, for company owners and admins only. It exists only while the `dr` switch is on: with it off the path is not found, as any
// unknown path, and nothing is read. `org` is a browser route family, so the app reaches it as `/v1/web/org/design-review`.
//   GET     an owner or admin: whether design review is allowed for the company, the default mode of projects with no setting (never = Off by default), the stricter-only lock, and a waiting request to allow it.
//   POST    an owner or admin, from a live browser session only (a token, the CLI or Slack never change it), on the revision they read (`POLICY_STALE` when it moved):
//             { action: "save", expectedRevision, defaultMode?, lock? }   the default mode and/or the lock, applied at once, audited;
//             { action: "allow", expectedRevision, allowed: false }       applied at once (the stricter side), audited;
//             { action: "allow", expectedRevision, allowed: true }        202 needs_approval: a DIFFERENT admin approves (a company with one eligible admin applies it for that admin, audited as `sole_admin`);
//             { action: "approve", changeId }                              a different admin approves allowing it, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise).
// Allowing and approving need a sign-in within the last 10 minutes, like the other company safeguards. The rules and the transaction are design-review/company.ts. Answers are fixed words, booleans, numbers and ids.
import { featureEnabled, agentXError, DesignReviewCompanyBodySchema, DESIGN_REVIEW_COMPANY_PATH, type DesignReviewCompanyState, type OrgId } from "@agentx/contracts";
import { secondPersonTier0Authority } from "../../lessons/tier0-authority.js";
import { sameId } from "../../lessons/types.js";
import { approveDesignReviewAllowed, companyViewOf, openAllowChange, requestDesignReviewAllowed, saveDesignReviewCompany, type DesignReviewCompanyDeps, type DesignReviewPolicyFailure } from "../../design-review/company.js";
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
function refusal(code: DesignReviewPolicyFailure): Error {
  switch (code) {
    case "not_eligible": return agentXError("FORBIDDEN", ADMINS_ONLY);
    case "second_person_required": return agentXError("FORBIDDEN", "A different admin has to approve allowing design review.");
    case "eligibility_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not check who may change this. Try again.");
    case "audit_unavailable": return agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    case "already_open": return agentXError("CHANGE_STALE", "A request to allow design review is already waiting for a different admin.");
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
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: () => deps.now(), edition: deps.editionPolicy,
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    authority: secondPersonTier0Authority({ documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now }),
  };
}

async function stateOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<DesignReviewCompanyState> {
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const view = companyViewOf(await readDesignReviewCompany(table, caller.orgId));
  const open = await openAllowChange(table, caller.orgId, deps.now()).catch(() => undefined);
  const groups = deps.editionPolicy !== undefined && featureEnabled(deps.editionPolicy, "groups");
  return {
    revision: view.revision ?? 0, allowed: view.allowed, defaultMode: view.defaultMode, lock: view.lock, unreadable: view.unreadable,
    ...(groups ? { groups: true as const } : {}),
    ...(open === undefined ? {} : { pending: { changeId: open.id, proposedByYou: sameId(open.proposedBy, caller.developerId), expiresAt: new Date(open.expiresAt).toISOString() } }),
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
  const company = companyDepsOf(deps);
  const orgId: OrgId = caller.orgId;
  const body = parsed.data;
  if (body.action === "save") {
    const result = await saveDesignReviewCompany(company, { orgId, by: caller.developerId, expectedRevision: body.expectedRevision, defaultMode: body.defaultMode, lock: body.lock });
    if (!result.ok) throw refusal(result.code);
    logDeveloperEvent({ event: "developer.design_review_company_saved", orgId, changed: String(result.changed) });
    return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
  }
  if (body.action === "allow") {
    if (body.allowed) await requireFreshSignIn(deps, caller);
    const result = await requestDesignReviewAllowed(company, { orgId, by: caller.developerId, allowed: body.allowed, expectedRevision: body.expectedRevision });
    if (!result.ok) throw refusal(result.code);
    logDeveloperEvent({ event: "developer.design_review_allowed_set", orgId, status: result.status });
    if (result.status === "needs_approval") return new StatusReply(202, { status: "needs_approval", changeId: result.changeId, ...(await stateOf(deps, caller)) });
    return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
  }
  await requireFreshSignIn(deps, caller);
  const result = await approveDesignReviewAllowed(company, { orgId, changeId: body.changeId, approverId: caller.developerId });
  if (!result.ok) throw refusal(result.code);
  logDeveloperEvent({ event: "developer.design_review_allowed_approved", orgId });
  return new StatusReply(200, { status: "applied", ...(await stateOf(deps, caller)) });
}
