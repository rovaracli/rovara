// Pure builders for every audited action. Each takes the action's facts plus the `occurrence` that makes this occurrence
// unique (what to pass is pinned per builder below and in the plan's Task 6 table; Task 18 amended the table for role changes, project members and egress decisions, which add their target to the client's request id; Task 19 amended it for the writes that commit once per revision, which use the revision), and returns an AuditEventInput whose
// id is `auditEventId(action, occurrence, ...parts)`: a retry of one occurrence gets the same id, a later occurrence with
// the same facts gets a different one. Personal data (names, emails, logins, repository and project names, domains,
// reasons) goes only in `details`, or in a name-keyed target `{ kind, name }`, which the appender pseudonymizes.
import { auditEventId, type AuditAction, type AuditActor, type AuditDetailPart, type AuditEventInput, type AuditProof, type AuditTarget } from "@agentx/contracts";

export interface AuditBuilderBase {
  orgId: string;
  actor: AuditActor;
  occurredAt: string;
  /** What makes this occurrence unique. Compose several values with `auditOccurrence`. */
  occurrence: string;
  related?: string[];
  proof?: AuditProof;
  details?: AuditDetailPart[];
}

/**
 * Invariant for the revision-based occurrences (guardrails, a project's AI settings, the spend policy): such a document is never deleted and recreated
 * outside an org close, because its revision would start again at 1 and an event of the new document would get the id of an old one, which the
 * appender would drop as a duplicate. A path that resets one of them must carry something else in the occurrence (a generation, or the time).
 *
 * One occurrence value from several: `JSON.stringify(parts)`, so ("a|b", "c") and ("a", "b|c") stay different and no part can hold a newline.
 */
export function auditOccurrence(...parts: string[]): string {
  return JSON.stringify(parts);
}

type Fact = string | number | boolean | undefined;

function build(action: AuditAction, input: AuditBuilderBase, target: AuditTarget, facts: Record<string, Fact> = {}, parts: string[] = []): AuditEventInput {
  const present = Object.entries(facts).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined);
  return {
    eventId: auditEventId(action, input.occurrence, ...parts),
    orgId: input.orgId,
    action,
    actor: input.actor,
    target,
    occurredAt: input.occurredAt,
    ...(input.related === undefined ? {} : { related: input.related }),
    ...(present.length === 0 ? {} : { facts: Object.fromEntries(present) }),
    ...(input.proof === undefined ? {} : { proof: input.proof }),
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}

// Approvals, writes and spend requests -----------------------------------------------------------------------------------

/** `occurrence`: the approval id. Also part of the id: the decision. */
export function auditApprovalDecided(input: AuditBuilderBase & { approvalId: string; kind: string; decision: string; subjectKind: string; class?: string }): AuditEventInput {
  return build("approval.decided", input, { kind: "approval", id: input.approvalId }, { kind: input.kind, decision: input.decision, subjectKind: input.subjectKind, class: input.class }, [input.decision]);
}

/** `occurrence`: the approval id. */
export function auditApprovalExpired(input: AuditBuilderBase & { approvalId: string; kind: string; subjectKind: string }): AuditEventInput {
  return build("approval.expired", input, { kind: "approval", id: input.approvalId }, { kind: input.kind, subjectKind: input.subjectKind });
}

/** `occurrence`: the approval id. A write approval also says what it would run: the connector type, the tool and the digest of the arguments (never the arguments). */
export function auditApprovalRequested(input: AuditBuilderBase & { approvalId: string; kind: string; subjectKind: string; class?: string; connectorType?: string; tool?: string; argumentsHash?: string }): AuditEventInput {
  return build("approval.requested", input, { kind: "approval", id: input.approvalId }, { kind: input.kind, subjectKind: input.subjectKind, class: input.class, connectorType: input.connectorType, tool: input.tool, argumentsHash: input.argumentsHash });
}

/**
 * `occurrence`: the approval id and the move's number. Rovara moved who may decide a pending approval because a member was merged into another (`mode`
 * `merged`) or removed (`removed`); `from` and `to` are the member ids, kept in `related`.
 */
export function auditApprovalRerouted(input: AuditBuilderBase & { approvalId: string; kind: string; mode: "merged" | "removed"; from: string; to: string }): AuditEventInput {
  return build("approval.rerouted", { ...input, related: [input.from, input.to, ...(input.related ?? [])] }, { kind: "approval", id: input.approvalId }, { kind: input.kind, mode: input.mode });
}

/** `occurrence`: the approval id. Also part of the id: the terminal status. */
export function auditWriteExecuted(input: AuditBuilderBase & { approvalId: string; connectorType: string; tool: string; status: string; argumentsHash: string }): AuditEventInput {
  return build("write.executed", input, { kind: "approval", id: input.approvalId }, { connectorType: input.connectorType, tool: input.tool, status: input.status, argumentsHash: input.argumentsHash }, [input.status]);
}

interface SpendRequestFacts { spendRequestId: string; kind: string; scopeKind: string; amountCents: number; newLimitCents?: number; decision?: string }
const spendFacts = (input: SpendRequestFacts): Record<string, Fact> => ({ kind: input.kind, scopeKind: input.scopeKind, amountCents: input.amountCents, newLimitCents: input.newLimitCents, decision: input.decision });
/** What a decision applied, as against what was asked: the amount approved, the limit it set and, for a month top-up, the month. All absent for a denial. */
interface SpendRequestApplied { approvedAmountCents?: number; appliedLimitCents?: number; topUpMonth?: string }

/** `occurrence`: the spend request id. */
export function auditSpendRequestCreated(input: AuditBuilderBase & SpendRequestFacts): AuditEventInput {
  return build("spend_request.created", input, { kind: "spend_request", id: input.spendRequestId }, spendFacts(input));
}

/** `occurrence`: the spend request id. Also part of the id: the decision. */
export function auditSpendRequestDecided(input: AuditBuilderBase & SpendRequestFacts & SpendRequestApplied & { decision: string }): AuditEventInput {
  return build("spend_request.decided", input, { kind: "spend_request", id: input.spendRequestId },
    { ...spendFacts(input), approvedAmountCents: input.approvedAmountCents, appliedLimitCents: input.appliedLimitCents, topUpMonth: input.topUpMonth }, [input.decision]);
}

/** `occurrence`: the spend request id. */
export function auditSpendRequestExpired(input: AuditBuilderBase & SpendRequestFacts): AuditEventInput {
  return build("spend_request.expired", input, { kind: "spend_request", id: input.spendRequestId }, spendFacts(input));
}

/** `occurrence`: the spend request id. Nobody answered an owner's request in time, so the org's owners and admins were added. */
export function auditSpendRequestEscalated(input: AuditBuilderBase & SpendRequestFacts): AuditEventInput {
  return build("spend_request.escalated", input, { kind: "spend_request", id: input.spendRequestId }, spendFacts(input));
}

/**
 * `occurrence`: the spend request id and the move's number. Rovara moved who a pending spend request is asked of because a member was merged into another
 * (`mode` `merged`) or removed (`removed`), when `from` and `to` are member ids kept in `related`; or because an owner's total moved under an approval
 * (`recounted`, Task 33), when `from` and `to` are the routes and nobody is named.
 */
export function auditSpendRequestRerouted(input: AuditBuilderBase & { spendRequestId: string; kind: string; mode: "merged" | "removed" | "recounted"; from: string; to: string }): AuditEventInput {
  // A recount moves the request between routes, not between people: no member is named.
  const related = input.mode === "recounted" ? input.related : [input.from, input.to, ...(input.related ?? [])];
  return build("spend_request.rerouted", { ...input, ...(related === undefined ? {} : { related }) }, { kind: "spend_request", id: input.spendRequestId }, { kind: input.kind, mode: input.mode });
}

/**
 * `occurrence`: the due resume's sort key. Rovara dropped a month resume it could not make (Task 33 fix round 2): the task's creator or owner left the org
 * (`cause` `member_left`), so the task can't go on and the settlement run stops trying. The target is the task; the spend request is in `related`.
 */
export function auditSpendRequestResumeDropped(input: AuditBuilderBase & { spendRequestId: string; taskId: string; kind: string; cause: string }): AuditEventInput {
  return build("spend_request.resume_dropped", { ...input, related: [input.spendRequestId, ...(input.related ?? [])] }, { kind: "task", id: input.taskId }, { kind: input.kind, cause: input.cause });
}

// Budgets and policy -----------------------------------------------------------------------------------------------------

/**
 * `occurrence`: the request's `requestId`; for Plan 1's `writeBudgets`, `auditOccurrence(at, updatedBy, field, target id)` (one
 * write can change several limits, and each needs its own id); on a store path, the store's `EVENT#` sort key with the field
 * (`AgentStore.setBudget`: one write can move two limits); for a project's AI settings, `auditOccurrence(project, new revision, field)`;
 * when Rovara moves a member's own limit (a member's removal, a merge), `auditOccurrence("override_removed" | "override_merged", ..., updatedAt, limit)`.
 * `target` is the budget's scope (`{ kind: "budget", id }`, or a name for a project). A limit that was not set (or is removed) has no figure
 * on that side: `fromCents` or `toCents` is left out.
 */
export function auditBudgetChanged(input: AuditBuilderBase & { target: AuditTarget; scopeKind: string; field: string; fromCents?: number; toCents?: number }): AuditEventInput {
  return build("budget.changed", input, input.target, { scopeKind: input.scopeKind, field: input.field, fromCents: input.fromCents, toCents: input.toCents });
}

/** `occurrence`: `auditOccurrence(new revision, field)`: the policy commits once per revision, and one write can move several figures. `from` and `to` are integers (cents, or hundredths for the multiplier). */
export function auditSpendPolicyChanged(input: AuditBuilderBase & { field: string; from: number; to: number }): AuditEventInput {
  return build("spend_policy.changed", input, { kind: "spend_policy", id: input.orgId }, { field: input.field, from: input.from, to: input.to });
}

// Pull requests ----------------------------------------------------------------------------------------------------------

/** `occurrence`: the publish operation id. `pullRequestId` is an opaque id; the repository name goes in `details`. */
export function auditPullRequestOpened(input: AuditBuilderBase & { pullRequestId: string; number: number }): AuditEventInput {
  return build("pull_request.opened", input, { kind: "pull_request", id: input.pullRequestId }, { number: input.number });
}

/** `occurrence`: `auditOccurrence(repository, number)` (a pull request merges once). */
export function auditPullRequestMerged(input: AuditBuilderBase & { pullRequestId: string; number: number }): AuditEventInput {
  return build("pull_request.merged", input, { kind: "pull_request", id: input.pullRequestId }, { number: input.number });
}

// Members ----------------------------------------------------------------------------------------------------------------

/** `occurrence`: the invite's token hash, or `auditOccurrence(developerId, joinedAt)` for a join that is not an invite (an org made with its owner, a single-org install's sign-in). */
export function auditMemberJoined(input: AuditBuilderBase & { memberId: string; role: string; via: string }): AuditEventInput {
  return build("member.joined", input, { kind: "member", id: input.memberId }, { role: input.role, via: input.via });
}

/**
 * `occurrence`: `auditOccurrence(requestId, memberId, toRole)`. The request id is chosen by the client and a role change stores no request record,
 * so the id alone could be reused to leave a later change unrecorded; with the target and the new role, each change is its own occurrence.
 */
export function auditMemberRoleChanged(input: AuditBuilderBase & { memberId: string; fromRole: string; toRole: string }): AuditEventInput {
  return build("member.role_changed", input, { kind: "member", id: input.memberId }, { fromRole: input.fromRole, toRole: input.toRole });
}

/** `occurrence`: the request's `requestId`. */
export function auditMemberRemoved(input: AuditBuilderBase & { memberId: string; role: string }): AuditEventInput {
  return build("member.removed", input, { kind: "member", id: input.memberId }, { role: input.role });
}

/** `occurrence`: the request's `requestId`. */
export function auditMemberLeft(input: AuditBuilderBase & { memberId: string; role: string }): AuditEventInput {
  return build("member.left", input, { kind: "member", id: input.memberId }, { role: input.role });
}

/**
 * `occurrence`: `auditOccurrence(requestId, project, memberId, toRole)`. A request id is remembered per project, so the same id can reach another
 * project; the project, the person and the role make each change its own occurrence. The project is name-keyed; the member is related by id.
 */
export function auditProjectMemberChanged(input: AuditBuilderBase & { projectName: string; memberId: string; fromRole?: string; toRole: string }): AuditEventInput {
  return build("project_member.changed", { ...input, related: [input.memberId, ...(input.related ?? [])] }, { kind: "project", name: input.projectName }, { fromRole: input.fromRole, toRole: input.toRole });
}

/** `occurrence`: `auditOccurrence(requestId, project, memberId)`, for the reason given on `auditProjectMemberChanged`. */
export function auditProjectMemberRemoved(input: AuditBuilderBase & { projectName: string; memberId: string; role: string }): AuditEventInput {
  return build("project_member.removed", { ...input, related: [input.memberId, ...(input.related ?? [])] }, { kind: "project", name: input.projectName }, { role: input.role });
}

/** `occurrence`: `auditOccurrence(identityKey, createdAt of the link item)`. */
export function auditIdentityLinked(input: AuditBuilderBase & { memberId: string; provider: string }): AuditEventInput {
  return build("identity.linked", input, { kind: "member", id: input.memberId }, { provider: input.provider });
}

/**
 * `occurrence`: `auditOccurrence(identityKey, unlink time)`. The unlink request carries no request id (`UnlinkIdentityRequestSchema`), so the time of
 * the unlink stands in. A retry of the same unlink cannot record twice: the transaction deletes the developer's reverse item under
 * `attribute_not_exists(unlinkedFrom)`, so it commits once, and the retry finds the method no longer linked and is refused (NOT_FOUND) before any event is built.
 */
export function auditIdentityUnlinked(input: AuditBuilderBase & { memberId: string; provider: string }): AuditEventInput {
  return build("identity.unlinked", input, { kind: "member", id: input.memberId }, { provider: input.provider });
}

/** The request UUID identifies one rename; names never enter the audit facts. */
export function auditOrgRenamed(input: AuditBuilderBase): AuditEventInput {
  return build("org.renamed", input, { kind: "org", id: input.orgId }, {});
}

/** `occurrence`: `closedAt`. */
export function auditOrgClosed(input: AuditBuilderBase & { plan: string }): AuditEventInput {
  return build("org.closed", input, { kind: "org", id: input.orgId }, { plan: input.plan });
}

// Agents, chains and published definitions ------------------------------------------------------------------------------

/** `occurrence`: the store's `EVENT#` sort key. `scope` picks `agent.owner_changed` or `chain.owner_changed`. */
export function auditOwnerChanged(input: AuditBuilderBase & { scope: "agent" | "chain"; targetId: string; field: string }): AuditEventInput {
  return build(input.scope === "agent" ? "agent.owner_changed" : "chain.owner_changed", input, { kind: input.scope, id: input.targetId }, { field: input.field });
}

/**
 * `occurrence`: the approval id. A session changed owner by a confirmed take-over (Plan 5 Task 12b): the actor is the taker, the target the session, `related` the previous
 * owner and the task or chain run, and the facts say what kind of session it is and whether who pays moved with it. Never a name or a title.
 */
export function auditSessionOwnerChanged(input: AuditBuilderBase & { sessionId: string; sessionKind: string; payerMoved: boolean }): AuditEventInput {
  return build("session.owner_changed", input, { kind: "session", id: input.sessionId }, { sessionKind: input.sessionKind, payerMoved: input.payerMoved });
}

/**
 * `occurrence`: the request id. A person stopped a session (Plan 5 Task 13): the target is the session, `related` the task or chain run, and the fact is what kind of session it is.
 */
export function auditSessionStopped(input: AuditBuilderBase & { sessionId: string; sessionKind: string }): AuditEventInput {
  return build("session.stopped", input, { kind: "session", id: input.sessionId }, { sessionKind: input.sessionKind });
}

/**
 * `occurrence`: the request id. A person retried a session (Plan 5 Task 13): `branch` says whether the same workflow went on (`workflow`) or a new run or chain run was started
 * (`new_run`, `new_chain_run`); `related` holds the task or run and, for a new run, the new session.
 */
export function auditSessionRetried(input: AuditBuilderBase & { sessionId: string; sessionKind: string; branch: "workflow" | "new_run" | "new_chain_run" }): AuditEventInput {
  return build("session.retried", input, { kind: "session", id: input.sessionId }, { sessionKind: input.sessionKind, branch: input.branch });
}

/**
 * `occurrence`: the approval id of the confirmed share (Plan 5 Task 22). A session was shared with everyone in the company, which is the only share the ledger records: the actor is the
 * person who confirmed it, the target the session, `related` the owner and the task or chain run, and the facts say the level it was shared at. A share with a person or a project, and a
 * share taken back, are not recorded. Never a name or a title.
 */
export function auditSessionSharedOrg(input: AuditBuilderBase & { sessionId: string; level: string }): AuditEventInput {
  return build("session.shared", input, { kind: "session", id: input.sessionId }, { level: input.level, principalKind: "org" });
}

/** `occurrence`: the store's `EVENT#` sort key. `scope` picks `agent.published` or `chain.published`. */
export function auditPublished(input: AuditBuilderBase & { scope: "agent" | "chain"; targetId: string; version: number; safety: string }): AuditEventInput {
  return build(input.scope === "agent" ? "agent.published" : "chain.published", input, { kind: input.scope, id: input.targetId }, { version: input.version, safety: input.safety });
}

/** `occurrence`: the store's `EVENT#` sort key. `scope` picks `agent.rolled_back` or `chain.rolled_back`. */
export function auditRolledBack(input: AuditBuilderBase & { scope: "agent" | "chain"; targetId: string; fromVersion: number; toVersion: number }): AuditEventInput {
  return build(input.scope === "agent" ? "agent.rolled_back" : "chain.rolled_back", input, { kind: input.scope, id: input.targetId }, { fromVersion: input.fromVersion, toVersion: input.toVersion });
}

/** `occurrence`: the store's `EVENT#` sort key. */
export function auditBuiltinAdopted(input: AuditBuilderBase & { agentId: string; version: number }): AuditEventInput {
  return build("builtin.adopted", input, { kind: "agent", id: input.agentId }, { version: input.version });
}

// Connections, connectors, guardrails ------------------------------------------------------------------------------------

/** `occurrence`: `auditOccurrence(requestId, connectionId)` when the save has a request id, else `auditOccurrence(connectionId, time of the save)`. */
export function auditConnectionSaved(input: AuditBuilderBase & { connectionId: string; connectorType: string }): AuditEventInput {
  return build("connection.saved", input, { kind: "connection", id: input.connectionId }, { connectorType: input.connectorType });
}

/** `occurrence`: as `auditConnectionSaved`. */
export function auditConnectionRemoved(input: AuditBuilderBase & { connectionId: string; connectorType: string }): AuditEventInput {
  return build("connection.removed", input, { kind: "connection", id: input.connectionId }, { connectorType: input.connectorType });
}

/** `occurrence`: `auditOccurrence(project, new revision number)`. The project name goes in `details`. */
export function auditProjectConnectorChanged(input: AuditBuilderBase & { connectorId: string; connectorType: string; revision: number; change: string }): AuditEventInput {
  return build("project_connector.changed", input, { kind: "connector", id: input.connectorId }, { connectorType: input.connectorType, revision: input.revision, change: input.change });
}

/**
 * `occurrence`: `auditOccurrence(new revision)`. The guardrails are one document that commits once per revision, whether a person's request or a confirmation on
 * the page wrote it, so the revision is the occurrence in both cases (Task 19 amended the table's request id or approval id).
 */
export function auditGuardrailsChanged(input: AuditBuilderBase & { guardrailsId: string; revision: number; widened: boolean }): AuditEventInput {
  return build("guardrails.changed", input, { kind: "guardrails", id: input.guardrailsId }, { revision: input.revision, widened: input.widened });
}

/** `occurrence`: the approval id. The repository is a name-keyed target. */
export function auditOptOutApplied(input: AuditBuilderBase & { repositoryName: string; scope: string }): AuditEventInput {
  return build("comment_trigger_opt_out.applied", input, { kind: "repository", name: input.repositoryName }, { scope: input.scope });
}

/** `occurrence`: `auditOccurrence(repository, old digest, new digest)`. */
export function auditOptOutLapsed(input: AuditBuilderBase & { repositoryName: string; scope: string }): AuditEventInput {
  return build("comment_trigger_opt_out.lapsed", input, { kind: "repository", name: input.repositoryName }, { scope: input.scope });
}

/**
 * `occurrence`: `auditOccurrence(requestId, domain, owner)`. The decision body carries a `requestId`; one id could name another domain or owner, so
 * both are part of the occurrence. The domain is a name-keyed target.
 */
export function auditEgressDecided(input: AuditBuilderBase & { domain: string; decision: string }): AuditEventInput {
  return build("egress_domain.decided", input, { kind: "domain", name: input.domain }, { decision: input.decision });
}

/**
 * `occurrence`: the rule's new revision (Plan 5 Task 22); the field is an id part, because one write can change several fields and each needs its own id. The rule is one document that
 * commits once per revision. The target is the org. `from` and `to` are the fixed words of the field: a flag for `allowed`, the tools' own names joined by commas (or `none`) for `tools`,
 * and `all` or the number of projects for `projects`; the project names go in `details`.
 */
export function auditLocalAgentsPolicyChanged(input: AuditBuilderBase & { field: string; from: string | number | boolean; to: string | number | boolean }): AuditEventInput {
  return build("local_agents.policy_changed", input, { kind: "org", id: input.orgId }, { field: input.field, from: input.from, to: input.to }, [input.field]);
}

// Triggers ---------------------------------------------------------------------------------------------------------------

/** `occurrence`: the approval id. */
export function auditTriggerEnabled(input: AuditBuilderBase & { triggerId: string; source: string; type: string; targetKind: string }): AuditEventInput {
  return build("trigger.enabled", input, { kind: "trigger", id: input.triggerId }, { source: input.source, type: input.type, targetKind: input.targetKind });
}

/** `occurrence`: `auditOccurrence(triggerId, the record's new updatedAt)`. `cause`: person, requirements, archive or owner_removed. */
export function auditTriggerDisabled(input: AuditBuilderBase & { triggerId: string; cause: string; source: string; type: string; targetKind: string }): AuditEventInput {
  return build("trigger.disabled", input, { kind: "trigger", id: input.triggerId }, { cause: input.cause, source: input.source, type: input.type, targetKind: input.targetKind });
}

// GitHub -----------------------------------------------------------------------------------------------------------------

/** `occurrence`: the connect state hash, or the webhook delivery id. */
export function auditGithubConnected(input: AuditBuilderBase & { installationId: string; accountType: string; result: string }): AuditEventInput {
  return build("github.connected", input, { kind: "github_installation", id: input.installationId }, { accountType: input.accountType, result: input.result });
}

/** `occurrence`: the request's `requestId`. */
export function auditGithubDisconnected(input: AuditBuilderBase & { installationId: string; accountType: string }): AuditEventInput {
  return build("github.disconnected", input, { kind: "github_installation", id: input.installationId }, { accountType: input.accountType });
}

/** `occurrence`: the webhook delivery id. */
export function auditGithubInstallationChanged(input: AuditBuilderBase & { installationId: string; status: string; accountType: string }): AuditEventInput {
  return build("github.installation_changed", input, { kind: "github_installation", id: input.installationId }, { status: input.status, accountType: input.accountType });
}

// Company AI sources -----------------------------------------------------------------------------------------------------

/**
 * `occurrence`: `auditOccurrence(new revision)`. The org's AI sources are one document that commits once per revision, so the revision
 * is the occurrence. No label, role, host or key goes in: the event names the source by its id and its kind.
 */
export function auditModelSourceSaved(input: AuditBuilderBase & { sourceId: string; sourceKind: string; change: "created" | "updated" | "tested" }): AuditEventInput {
  return build("model_source.saved", input, { kind: "model_source", id: input.sourceId }, { kind: input.sourceKind, change: input.change });
}

/** `occurrence`: as `auditModelSourceSaved`. */
export function auditModelSourceRemoved(input: AuditBuilderBase & { sourceId: string; sourceKind: string }): AuditEventInput {
  return build("model_source.removed", input, { kind: "model_source", id: input.sourceId }, { kind: input.sourceKind });
}

/** `occurrence`: as `auditModelSourceSaved`. The target is the org, whose order changed; the fact is how many sources the new order names. */
export function auditModelSourceOrderChanged(input: AuditBuilderBase & { count: number }): AuditEventInput {
  return build("model_source.order_changed", input, { kind: "org", id: input.orgId }, { count: input.count });
}

// The ledger itself ------------------------------------------------------------------------------------------------------

interface ReadFacts { fromSeq: number; toSeq: number; count: number; via: string }

/** `occurrence`: the API Gateway `requestContext.requestId`. */
export function auditRead(input: AuditBuilderBase & ReadFacts): AuditEventInput {
  return build("audit.read", input, { kind: "audit", id: input.orgId }, { fromSeq: input.fromSeq, toSeq: input.toSeq, count: input.count, via: input.via });
}

/** `occurrence`: the API Gateway `requestContext.requestId`. */
export function auditStaffRead(input: AuditBuilderBase & ReadFacts): AuditEventInput {
  return build("audit.staff_read", input, { kind: "audit", id: input.orgId }, { fromSeq: input.fromSeq, toSeq: input.toSeq, count: input.count, via: input.via });
}

/** `occurrence`: the export id. */
export function auditExported(input: AuditBuilderBase & { exportId: string; fromSeq: number; toSeq: number; withDetails: boolean }): AuditEventInput {
  return build("audit.exported", input, { kind: "audit", id: input.exportId }, { fromSeq: input.fromSeq, toSeq: input.toSeq, withDetails: input.withDetails });
}

/** `occurrence`: the erasure request id. `subject` is a developer id. */
export function auditSubjectErased(input: AuditBuilderBase & { subject: string }): AuditEventInput {
  return build("audit.subject_erased", input, { kind: "member", id: input.subject });
}

/** `occurrence`: `closedAt`. */
export function auditShredScheduled(input: AuditBuilderBase & { shredAfterDays: number }): AuditEventInput {
  return build("audit.org_shred_scheduled", input, { kind: "org", id: input.orgId }, { shredAfterDays: input.shredAfterDays });
}
