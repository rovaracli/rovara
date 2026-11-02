// Pure builders for every audited action. Each takes the action's facts plus the `occurrence` that makes this occurrence
// unique (what to pass is pinned per builder below and in the plan's Task 6 table; Task 18 amended the table for role changes, project members and egress decisions, which add their target to the client's request id; Task 19 amended it for the writes that commit once per revision, which use the revision), and returns an AuditEventInput whose
// id is `auditEventId(action, occurrence, ...parts)`: a retry of one occurrence gets the same id, a later occurrence with
// the same facts gets a different one. Personal data (names, emails, logins, repository and project names, domains,
// reasons) goes only in `details`, or in a name-keyed target `{ kind, name }`, which the appender pseudonymizes.
import {createHash} from "node:crypto";
import {ModelPolicyAuditFactsSchema,ModelFallbackAuditFactsSchema,type ModelIdentifier,type StageId,type ModelFallback} from "@agentx/contracts";
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

/**
 * `occurrence`: `auditOccurrence(approvalId, repositoryId, number)`. Written in the transaction that claims a pull request's merge, so a claim that was lost leaves nothing. The actor is the person who
 * pressed Merge and confirmed it; `related` names the approval. The repository goes in `details`.
 */
export function auditPullRequestMergeRequested(input: AuditBuilderBase & { pullRequestId: string; number: number; method: string }): AuditEventInput {
  return build("pull_request.merge_requested", input, { kind: "pull_request", id: input.pullRequestId }, { number: input.number, method: input.method });
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
export function auditMemberRemoved(input: AuditBuilderBase & { memberId: string; role: string; removalId?: string; successorKind?: "self" | "chosen" }): AuditEventInput {
  return build("member.removed", input, { kind: "member", id: input.memberId }, { role: input.role, removalId: input.removalId, successorKind: input.successorKind });
}

/**
 * `occurrence`: the removal id. Written once, when the removal's last step finished (S7): how it ended and what it did. `related` is the successor and
 * the person who removed them. Counts only; the per-item events carry the exact list.
 */
export function auditMemberRemovalCompleted(input: AuditBuilderBase & { memberId: string; outcome: "done" | "cancelled_rejoined"; wasRole: string; counts: Record<string, number | boolean> }): AuditEventInput {
  return build("member.removal_completed", input, { kind: "member", id: input.memberId }, { outcome: input.outcome, wasRole: input.wasRole, ...input.counts });
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

/**
 * `occurrence`: `auditOccurrence(requestId, project, teamId, channelId)` (release 0.4.17). A request id is remembered per project, so the same id can reach
 * another project or channel; each makes its own occurrence. The project is a name-keyed target; the Slack team and channel are opaque ids, related.
 */
export function auditSlackChannelBound(input: AuditBuilderBase & { projectName: string; teamId: string; channelId: string; mode?: "second_person" | "sole_owner_exception"; proposalId?: string }): AuditEventInput {
  return build("slack_channel.bound", { ...input, related: [input.teamId, input.channelId, ...(input.related ?? [])] }, { kind: "project", name: input.projectName }, { mode: input.mode, proposalId: input.proposalId });
}

/** `occurrence`: as for `auditSlackChannelBound`. */
export function auditSlackChannelUnbound(input: AuditBuilderBase & { projectName: string; teamId: string; channelId: string; source?: "admin_change_plan" }): AuditEventInput {
  return build("slack_channel.unbound", { ...input, related: [input.teamId, input.channelId, ...(input.related ?? [])] }, { kind: "project", name: input.projectName }, { source: input.source });
}

/**
 * `occurrence`: `auditOccurrence(teamId, occurredAt)` (release 0.4.17). An operator links a Slack workspace to an org, which sends all of that workspace's
 * Slack traffic to the org, so the org's own ledger records it. The actor is the operator's pseudonymous id; the org is the target; the team is related.
 */
export function auditSlackTeamConnected(input: AuditBuilderBase & { teamId: string }): AuditEventInput {
  return build("slack_team.connected", { ...input, related: [input.teamId, ...(input.related ?? [])] }, { kind: "org", id: input.orgId });
}

/** `occurrence`: as for `auditSlackTeamConnected`. */
export function auditSlackTeamDisconnected(input: AuditBuilderBase & { teamId: string }): AuditEventInput {
  return build("slack_team.disconnected", { ...input, related: [input.teamId, ...(input.related ?? [])] }, { kind: "org", id: input.orgId });
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

/** `occurrence`: the org and independent public invite UUID; never token/hash/address material. */
export function auditOrgInviteCreated(input: AuditBuilderBase & { inviteId: string; role: "admin" | "member"; targeted: boolean }): AuditEventInput {
  return build("org.invite_created", input, { kind: "invite", id: input.inviteId }, { role: input.role, targeted: input.targeted });
}

/** A person chose their own display name (release 0.4.16). `occurrence`: `auditOccurrence(developerId, time of the change)`. The name never enters the record. */
export function auditMemberRenamed(input: AuditBuilderBase & { memberId: string }): AuditEventInput {
  return build("member.renamed", input, { kind: "member", id: input.memberId }, {});
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

/**
 * `occurrence`: `auditOccurrence(sessionId, issue key, the time)`. A person linked a session to a Linear issue (Plan 6 Task 20): the target is the session, `related` the task, and the fact
 * says which kind of outside place it is. The issue key is an outside identifier and goes in `details`, never in the chain.
 */
export function auditSessionLinked(input: AuditBuilderBase & { sessionId: string; issueKey: string }): AuditEventInput {
  return build("session.linked", { ...input, details: [...(input.details ?? []), { subject: "org", fields: { issueKey: input.issueKey } }] }, { kind: "session", id: input.sessionId }, { surface: "linear_issue" });
}

/** `occurrence`: as `auditSessionLinked`. A person let go of the Linear issue a session followed (alone, or before replacing it). */
export function auditSessionUnlinked(input: AuditBuilderBase & { sessionId: string; issueKey: string }): AuditEventInput {
  return build("session.unlinked", { ...input, details: [...(input.details ?? []), { subject: "org", fields: { issueKey: input.issueKey } }] }, { kind: "session", id: input.sessionId }, { surface: "linear_issue" });
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

/**
 * `occurrence`: `auditOccurrence(project, new revision)`. A project's code settings are one document that commits once per revision, whether a maintainer's request or an administrator's
 * confirmation wrote it. `changed` is the comma-joined fixed names of what changed, the rest the settings as they now are (the reviewers as a count). The project is a name-keyed target, pseudonymized by the appender.
 */
export function auditCodeSettingsChanged(input: AuditBuilderBase & { projectName: string; revision: number; changed: string; selfApproval: boolean; mergeMethod: string; reviewers: number }): AuditEventInput {
  return build("code_settings.changed", input, { kind: "project", name: input.projectName }, { revision: input.revision, changed: input.changed, selfApproval: input.selfApproval, mergeMethod: input.mergeMethod, reviewers: input.reviewers });
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

/** `occurrence`: reviewed org/request/public UUID, never bearer material. */
export function auditOrgInviteRevoked(input: AuditBuilderBase & { inviteId: string; role: "admin" | "member" }): AuditEventInput {
  return build("org.invite_revoked", input, { kind: "invite", id: input.inviteId }, { role: input.role });
}

// Lane B: name-keyed project target is pseudonymized by the existing appender.
export function auditProjectArchived(input: AuditBuilderBase & { projectName: string; fromRevision: number; toRevision: number; projectRevision: number; requestId: string }): AuditEventInput {
 return build("project.archived", input, { kind: "project", name: input.projectName }, { fromRevision: input.fromRevision, toRevision: input.toRevision, projectRevision: input.projectRevision, requestId: input.requestId });
}

// Lane B: reviewed restore uses the same safe facts and name-keyed target handling.
export function auditProjectRestored(input: AuditBuilderBase & { projectName: string; fromRevision: number; toRevision: number; projectRevision: number; requestId: string }): AuditEventInput {
 return build("project.restored", input, { kind: "project", name: input.projectName }, { fromRevision: input.fromRevision, toRevision: input.toRevision, projectRevision: input.projectRevision, requestId: input.requestId });
}

// Unexposed working-branch save; repository/ref strings are erasable details, never facts.
export function auditProjectWorkingBranchChanged(input: AuditBuilderBase & {projectName:string;fromRevision:number;toRevision:number;lifecycleRevision:number;installationId:number;repositoryId:number;requestId:string;previousConfigured:boolean}): AuditEventInput {
 const identity = { installationId: String(input.installationId), repositoryId: String(input.repositoryId) };
 const details = input.details === undefined || input.details.length === 0 ? [{ subject: "org", fields: identity }] : input.details.map((part, index) => index === 0 ? { ...part, fields: { ...part.fields, ...identity } } : part);
 return build("project.working_branch_changed",{...input,details},{kind:"project",name:input.projectName},{fromRevision:input.fromRevision,toRevision:input.toRevision,lifecycleRevision:input.lifecycleRevision,requestId:input.requestId,previousConfigured:input.previousConfigured});
}

// "How we work" playbook ------------------------------------------------------------------------------------------------
// One block, so a merge with another branch's additions stays easy. The project is a name-keyed target (pseudonymized by the
// appender); a process is targeted by the process layer's agent id. Facts are counts, revisions, flags and fixed words.

/** `occurrence`: `auditOccurrence(project, new definition revision)`. The project's definition commits once per revision; `approvedCount` is the approved models after the change. */
export function auditProjectModelsChanged(input: AuditBuilderBase & { projectName: string; revision: number; approvedCount: number; defaultChanged: boolean }): AuditEventInput {
  return build("project.models_changed", input, { kind: "project", name: input.projectName }, { revision: input.revision, approvedCount: input.approvedCount, defaultChanged: input.defaultChanged });
}

/** `occurrence`: as `auditProjectModelsChanged`. The counts are of the required and optional checks after the change. */
export function auditProjectChecksChanged(input: AuditBuilderBase & { projectName: string; revision: number; requiredCount: number; optionalCount: number }): AuditEventInput {
  return build("project.checks_changed", input, { kind: "project", name: input.projectName }, { revision: input.revision, requiredCount: input.requiredCount, optionalCount: input.optionalCount });
}

/** `occurrence`: as `auditProjectModelsChanged`. The flags are the capture settings after the change. */
export function auditProjectE2ePolicyChanged(input: AuditBuilderBase & { projectName: string; revision: number; screenshots: boolean; traces: boolean; video: boolean; downloads: boolean }): AuditEventInput {
  return build("project.e2e_policy_changed", input, { kind: "project", name: input.projectName }, { revision: input.revision, screenshots: input.screenshots, traces: input.traces, video: input.video, downloads: input.downloads });
}

/** `occurrence`: the request id of the selection change. `surface` is a fixed word for where it was set (`slack`, `app`, `cli`); `cleared` says the selection was removed. */
export function auditProjectModelSelectionChanged(input: AuditBuilderBase & { projectName: string; surface: string; cleared: boolean }): AuditEventInput {
  return build("project.model_selection_changed", input, { kind: "project", name: input.projectName }, { surface: input.surface, cleared: input.cleared });
}

/** `occurrence`: the request id of the roster change. `added` and `removed` are counts; who they are belongs in `details`. */
export function auditProjectRosterChanged(input: AuditBuilderBase & { projectName: string; added: number; removed: number }): AuditEventInput {
  return build("project.roster_changed", input, { kind: "project", name: input.projectName }, { added: input.added, removed: input.removed });
}

/** `occurrence`: the store's `EVENT#` sort key, as `auditPublished`. `agentId` is the process layer's agent id; `selfConfirmedSoleOwner` says the publisher confirmed they were the only owner. */
export function auditProcessPublished(input: AuditBuilderBase & { agentId: string; version: number; safety: string; selfConfirmedSoleOwner: boolean }): AuditEventInput {
  return build("process.published", input, { kind: "process", id: input.agentId }, { version: input.version, safety: input.safety, selfConfirmedSoleOwner: input.selfConfirmedSoleOwner });
}

/** `occurrence`: the store's `EVENT#` sort key, as `auditRolledBack`. */
export function auditProcessRolledBack(input: AuditBuilderBase & { agentId: string; fromVersion: number; toVersion: number; safety: string }): AuditEventInput {
  return build("process.rolled_back", input, { kind: "process", id: input.agentId }, { fromVersion: input.fromVersion, toVersion: input.toVersion, safety: input.safety });
}

/** `occurrence`: `auditOccurrence(project, playbook revision)`. `processKind` is `builtin` or `project_process`; the process itself is never named. */
export function auditPlaybookDefaultProcessChanged(input: AuditBuilderBase & { projectName: string; revision: number; processKind: "builtin" | "project_process" }): AuditEventInput {
  return build("playbook.default_process_changed", input, { kind: "project", name: input.projectName }, { revision: input.revision, processKind: input.processKind });
}

/** `occurrence`: `auditOccurrence(project, company document revision)`. One event per project the change reached; `settingCount` is the number of settings that changed for it. */
export function auditCompanyChangeAppliedToProject(input: AuditBuilderBase & { projectName: string; changeRevision: number; settingCount: number }): AuditEventInput {
  return build("company.change_applied_to_project", input, { kind: "project", name: input.projectName }, { changeRevision: input.changeRevision, settingCount: input.settingCount });
}

/** `occurrence`: the request id of the approved change. `tier` is `sandbox`, `preview` or `shared`; `lessSafeCount` is the number of less-safe fields the change turned on (`testEnvLessSafeChanges`). */
export function auditProjectTestEnvChanged(input: AuditBuilderBase & { projectName: string; revision: number; tier: "sandbox" | "preview" | "shared"; lessSafeCount: number }): AuditEventInput {
  return build("project.test_env_changed", input, { kind: "project", name: input.projectName }, { revision: input.revision, tier: input.tier, lessSafeCount: input.lessSafeCount });
}

/** `occurrence`: the request id of the change. `setting` is the fixed word `propose_fix_task` (the nightly setting `nightly.proposeFixTask`); `enabled` says whether it is on after the change. */
export function auditProjectTestHealthSettingChanged(input: AuditBuilderBase & { projectName: string; setting: "propose_fix_task"; enabled: boolean }): AuditEventInput {
  return build("project.test_health_setting_changed", input, { kind: "project", name: input.projectName }, { setting: input.setting, enabled: input.enabled });
}

/**
 * `occurrence`: the request id of the card press. Facts are fixed words, counts and hashes, never a test name: `cause` (the auto-fix code word), `testCount` (marks added), `recordEpoch` (which card), `taskCount` and
 * `taskIdsSha256` (the tasks that were waiting), `testSetSha256` (sha256 of the sorted "check, test" lines marked, so the exact set can be checked later), `rowVersionAfter` and `totalAfter` (the project's list afterwards), `approvalMode` (`single`, `second_person` or `sole_owner_exception`) and `secondPersonWhy` (a fixed word: why a second person was or was not needed).
 */
export function auditProjectKnownFailingMarked(input: AuditBuilderBase & { projectName: string; cause: string; testCount: number; recordEpoch: number; taskCount: number; taskIdsSha256: string; testSetSha256: string; rowVersionAfter: number; totalAfter: number; approvalMode: "single" | "second_person" | "sole_owner_exception"; secondPersonWhy: string }): AuditEventInput {
  return build("project.known_failing_marked", input, { kind: "project", name: input.projectName }, {
    cause: input.cause, testCount: input.testCount, recordEpoch: input.recordEpoch, taskCount: input.taskCount, taskIdsSha256: input.taskIdsSha256, testSetSha256: input.testSetSha256, rowVersionAfter: input.rowVersionAfter, totalAfter: input.totalAfter, approvalMode: input.approvalMode, secondPersonWhy: input.secondPersonWhy,
  });
}

/**
 * KF-1. `occurrence`: the request id of the undo, or the slot id of the nightly run that showed the tests passing. Facts are a fixed word, counts and hashes, never a test name: `removal` (`undo` or `nightly_passing`),
 * `testCount` (marks removed), `markEpoch` (the card the mark was made on; 0 when the marks came from several cards), `testSetSha256` (sha256 of the sorted "check, test" lines removed), `rowVersionAfter` and `totalAfter`.
 */
export function auditProjectKnownFailingRemoved(input: AuditBuilderBase & { projectName: string; removal: "undo" | "nightly_passing"; testCount: number; markEpoch: number; testSetSha256: string; rowVersionAfter: number; totalAfter: number }): AuditEventInput {
  return build("project.known_failing_removed", input, { kind: "project", name: input.projectName }, {
    removal: input.removal, testCount: input.testCount, markEpoch: input.markEpoch, testSetSha256: input.testSetSha256, rowVersionAfter: input.rowVersionAfter, totalAfter: input.totalAfter,
  });
}

/** `occurrence`: the request id of the download. One event per download; the artifact is named by its fixed kind and retention class, never by a name or a path. */
export function auditEvidenceDownloaded(input: AuditBuilderBase & { taskId: string; artifactKind: string; retentionClass: string }): AuditEventInput {
  return build("evidence.downloaded", input, { kind: "task", id: input.taskId }, { artifactKind: input.artifactKind, retentionClass: input.retentionClass });
}

// Lane E: private MCP servers and project Sources ---------------------------------------------------------------------------

/** A server's label is free text an admin typed (it could hold an address): it is capped here and otherwise left as it is. It sits in the org details, never in a fact. */
const AUDIT_LABEL_MAX_CHARS = 60;

/**
 * `occurrence`: `auditOccurrence(serverId, time of the change)`. The target is the server's id; its label goes in `details` (org), its address and its token nowhere.
 * `transport` is `http` or `stdio`. Added and approved also say whether the server has a token (a flag, never the value).
 */
export function auditMcpServerChanged(input: AuditBuilderBase & { action: "mcp_server.added" | "mcp_server.approved" | "mcp_server.disabled" | "mcp_server.removed"; serverId: string; label: string; transport: "http" | "stdio"; hasToken?: boolean }): AuditEventInput {
  const { action, serverId, label, transport, hasToken, ...base } = input;
  const withToken = action === "mcp_server.added" || action === "mcp_server.approved";
  return build(action, { ...base, details: [...(base.details ?? []), { subject: "org", fields: { label: label.slice(0, AUDIT_LABEL_MAX_CHARS) } }] }, { kind: "mcp_server", id: serverId }, { transport, ...(withToken ? { hasCredential: hasToken === true } : {}) });
}

/** What an approval of a package-run server pinned. Hashes and counts are facts; the host names and secret NAMES (never values) go in the org's `details`. */
export interface McpServerApprovalPin { integrity: string; lockfileHash: string; bundleHash: string; toolsHash: string; destinationCount: number; secretCount: number; secretVersion?: string | undefined; destinations?: string; secretNames?: string }

/** `occurrence`: `auditOccurrence(serverId, time of the change)`. The target is the server's id; its label goes in `details` (org), its address and its token nowhere. */
export function auditMcpServerApproved(input: AuditBuilderBase & { serverId: string; label: string; transport: "http" | "stdio"; hasToken?: boolean; pin?: McpServerApprovalPin }): AuditEventInput {
  const { serverId, label, transport, hasToken, pin, ...base } = input;
  const fields: Record<string, string> = { label: label.slice(0, AUDIT_LABEL_MAX_CHARS), ...(pin?.destinations === undefined ? {} : { destinations: pin.destinations }), ...(pin?.secretNames === undefined ? {} : { secretNames: pin.secretNames }) };
  return build("mcp_server.approved", { ...base, details: [...(base.details ?? []), { subject: "org", fields }] }, { kind: "mcp_server", id: serverId }, {
    transport, hasCredential: hasToken === true,
    ...(pin === undefined ? {} : { integrity: pin.integrity, lockfileHash: pin.lockfileHash, bundleHash: pin.bundleHash, toolsHash: pin.toolsHash, destinationCount: pin.destinationCount, credentialCount: pin.secretCount, credentialVersion: pin.secretVersion }),
  });
}

/** `occurrence`: `auditOccurrence(serverId, time)`. What the install of a package produced: the package, its three fingerprints and its size. */
export function auditMcpServerInstalled(input: AuditBuilderBase & { serverId: string; name: string; version: string; integrity: string; lockfileHash: string; bundleHash: string; packageCount?: number | undefined; unpackedBytes?: number | undefined }): AuditEventInput {
  const { serverId, name, version, integrity, lockfileHash, bundleHash, packageCount, unpackedBytes, ...base } = input;
  return build("mcp_server.installed", base, { kind: "mcp_server", id: serverId }, { package: name, version, integrity, lockfileHash, bundleHash, packageCount, unpackedBytes });
}

/** `occurrence`: `auditOccurrence(serverId, time)`. A test of a package: for a `proposal` or an `approval`, with the hash of the tools it listed. */
export function auditMcpServerProbed(input: AuditBuilderBase & { serverId: string; purpose: "proposal" | "approval"; toolsHash: string; bundleHash: string; toolCount: number }): AuditEventInput {
  return build("mcp_server.probed", input, { kind: "mcp_server", id: input.serverId }, { purpose: input.purpose, toolsHash: input.toolsHash, bundleHash: input.bundleHash, toolCount: input.toolCount }, [input.purpose]);
}

/** The ids the host's events carry. The controller makes them (`occurrence` is the event's own key, so recording one twice is one event). */
export function auditMcpServerChangedNeedsReview(input: AuditBuilderBase & { serverId: string; approvedToolsHash: string; observedToolsHash: string }): AuditEventInput {
  return build("mcp_server.changed_needs_review", input, { kind: "mcp_server", id: input.serverId }, { approvedToolsHash: input.approvedToolsHash, observedToolsHash: input.observedToolsHash });
}
export function auditMcpServerTaskStarted(input: AuditBuilderBase & { serverId: string; trigger: "call" | "warm" }): AuditEventInput {
  return build("mcp_server.task_started", input, { kind: "mcp_server", id: input.serverId }, { trigger: input.trigger });
}
export function auditMcpServerTaskStopped(input: AuditBuilderBase & { serverId: string; reason: string }): AuditEventInput {
  return build("mcp_server.task_stopped", input, { kind: "mcp_server", id: input.serverId }, { cause: input.reason });
}
/** `addresses` (old and new, as the host saw them) are the org's details, not facts: only the counts are. */
export function auditMcpServerEgressUpdated(input: AuditBuilderBase & { serverId: string; added: number; removed: number; addresses?: string }): AuditEventInput {
  const { serverId, added, removed, addresses, ...base } = input;
  return build("mcp_server.egress_updated", { ...base, ...(addresses === undefined ? {} : { details: [...(base.details ?? []), { subject: "org", fields: { addresses } }] }) }, { kind: "mcp_server", id: serverId }, { added, removed });
}
export function auditMcpServerSecretReplaced(input: AuditBuilderBase & { serverId: string; secretCount: number; secretVersion: string }): AuditEventInput {
  return build("mcp_server.secret_replaced", input, { kind: "mcp_server", id: input.serverId }, { credentialCount: input.secretCount, credentialVersion: input.secretVersion }, [input.secretVersion]);
}

/** `occurrence`: `auditOccurrence(serverId, time)`. `change` is `stored` or `deleted`: that the server's token changed, never the token. */
export function auditMcpServerTokenChanged(input: AuditBuilderBase & { serverId: string; change: "stored" | "deleted" }): AuditEventInput {
  return build("mcp_server.token_changed", input, { kind: "mcp_server", id: input.serverId }, { change: input.change }, [input.change]);
}

/**
 * `occurrence`: `auditOccurrence(changeId)`. A change to a project's Sources: the project is the (name-keyed) target, the change's id is `related`, the source's short id goes in
 * `details` (org). `change` is `set` or `remove`.
 */
export function auditContextSourceChange(input: AuditBuilderBase & { action: "context_source.proposed" | "context_source.applied" | "context_source.rejected"; projectName: string; sourceId: string; change: "set" | "remove" }): AuditEventInput {
  const { action, projectName, sourceId, change, ...base } = input;
  return build(action, { ...base, details: [...(base.details ?? []), { subject: "org", fields: { sourceId } }] }, { kind: "project", name: projectName }, { change });
}

// Live interaction part 2: Stop & redirect, Ask about this task, Fix with agent ------------------------------------------------------------------------------
// Ids, fixed words and counts only. The instruction, the question, the answer and a diagnosis's text never enter an event.

/** `occurrence`: the redirect's request id. The target is the session; `related` holds the task and the instruction's message id (server-made ids). `outcome` is one of `REDIRECT_OUTCOMES`. */
export function auditSessionRedirected(input: AuditBuilderBase & { sessionId: string; taskId: string; messageId: string; mode: "keep_plan" | "change_plan"; step: string; outcome: "restarted" | "revise_started" | "left_blocked" | "refused" }): AuditEventInput {
  const { sessionId, taskId, messageId, mode, step, outcome, ...base } = input;
  return build("session.redirected", { ...base, related: [taskId, messageId, ...(base.related ?? [])] }, { kind: "session", id: sessionId }, { mode, step, outcome }, [outcome]);
}

/**
 * `occurrence`: the ask's request id (`scope: "each"`, Enterprise: every Ask, for the Auditor) or `auditOccurrence(project, day)` (`scope: "daily"`, Public: one count per project per day). The target
 * is the session for an Ask and the (name-keyed) project for a daily count; `related` holds the `ASK#` id. Never the question or the answer.
 */
export function auditTaskAsked(input: AuditBuilderBase & ({ scope: "each"; sessionId: string; askId: string; audience: "web" | "slack" | "linear"; contextBytes: number; model: string } | { scope: "daily"; projectName: string; count: number })): AuditEventInput {
  if (input.scope === "daily") {
    const { scope, projectName, count, ...base } = input;
    return build("task.asked", base, { kind: "project", name: projectName }, { audience: "all", scope, count });
  }
  const { scope, sessionId, askId, audience, contextBytes, model, ...base } = input;
  return build("task.asked", { ...base, related: [askId, ...(base.related ?? [])] }, { kind: "session", id: sessionId }, { audience, scope, count: 1, contextBytes, model });
}

/** `occurrence`: the diagnosis id. The target is the diagnosis; `errorKind`, `errorCode` and `tier` are fixed words. */
export function auditDiagnosisStarted(input: AuditBuilderBase & { diagnosisId: string; errorKind: string; errorCode: string; tier: "light" | "deep" }): AuditEventInput {
  return build("diagnosis.started", input, { kind: "diagnosis", id: input.diagnosisId }, { errorKind: input.errorKind, errorCode: input.errorCode, tier: input.tier });
}

/** `occurrence`: the diagnosis id. Counts of the proposals that survived, by kind, and how many were dropped. */
export function auditDiagnosisProposed(input: AuditBuilderBase & { diagnosisId: string; counts: { explain: number; retryWithNote: number; redirect: number; settingsChange: number; newTask: number; adminSteps: number; contactSupport: number }; dropped: number }): AuditEventInput {
  const { counts } = input;
  const total = counts.explain + counts.retryWithNote + counts.redirect + counts.settingsChange + counts.newTask + counts.adminSteps + counts.contactSupport;
  return build("diagnosis.proposed", input, { kind: "diagnosis", id: input.diagnosisId }, { total, dropped: input.dropped, ...counts });
}

/** `occurrence`: `auditOccurrence(diagnosisId, approvalId)`. A person pressed "Apply this change": `related` links the ordinary `approval.requested` id; nothing is applied by this event. */
export function auditDiagnosisProposalRaised(input: AuditBuilderBase & { diagnosisId: string; proposalKind: string; approvalId: string }): AuditEventInput {
  return build("diagnosis.proposal_raised", { ...input, related: [input.approvalId, ...(input.related ?? [])] }, { kind: "diagnosis", id: input.diagnosisId }, { proposalKind: input.proposalKind });
}

/** `occurrence`: the diagnosis id. Public, after the person ticked consent: codes, ids and the diagnosis went to staff. */
export function auditDiagnosisSupportEscalated(input: AuditBuilderBase & { diagnosisId: string; errorKind: string }): AuditEventInput {
  return build("diagnosis.support_escalated", input, { kind: "diagnosis", id: input.diagnosisId }, { errorKind: input.errorKind });
}

/** `occurrence`: the diagnosis id. Enterprise: the redacted support bundle was prepared for the customer's operator to read; nothing was sent. */
export function auditDiagnosisBundlePrepared(input: AuditBuilderBase & { diagnosisId: string; errorKind: string }): AuditEventInput {
  return build("diagnosis.bundle_prepared", input, { kind: "diagnosis", id: input.diagnosisId }, { errorKind: input.errorKind });
}

// v1.2 learning loop ----------------------------------------------------------------------------------------------------
// The project is a name-keyed target (pseudonymized by the appender). Facts are ids, counts, flags and fixed words: no builder takes a correction's, a rule's or a note's text.

/** `occurrence`: the suggestion id (a suggestion opens once). `sourceKinds` is a comma-joined list of fixed words. */
export function auditRuleSuggested(input: AuditBuilderBase & { projectName: string; suggestionId: string; stage: string; sourceCount: number; sourceKinds: string; lessSafe: boolean; fromOnePerson: boolean }): AuditEventInput {
  return build("rule.suggested", input, { kind: "project", name: input.projectName }, { suggestionId: input.suggestionId, stage: input.stage, sourceCount: input.sourceCount, sourceKinds: input.sourceKinds, lessSafe: input.lessSafe, fromOnePerson: input.fromOnePerson });
}

/** `occurrence`: the rule id. Also part of the id: the outcome, so a rule that waited for a person and was then applied has an event for each. `processVersion` is present when published. */
export function auditRuleAccepted(input: AuditBuilderBase & { projectName: string; suggestionId: string; ruleId: string; stage: string; processAgentId: string; outcome: "published" | "awaiting_approval"; processVersion?: number; approvalId?: string; edited: boolean; lessSafe: boolean }): AuditEventInput {
  return build("rule.accepted", input, { kind: "project", name: input.projectName }, {
    suggestionId: input.suggestionId, ruleId: input.ruleId, stage: input.stage, processAgentId: input.processAgentId, outcome: input.outcome, processVersion: input.processVersion, approvalId: input.approvalId, edited: input.edited, lessSafe: input.lessSafe,
  }, [input.outcome]);
}

/** `occurrence`: the rule id. `approvalOutcome` is `declined`, `expired` or `failed`. */
export function auditRuleNotApplied(input: AuditBuilderBase & { projectName: string; suggestionId: string; ruleId: string; approvalOutcome: "declined" | "expired" | "failed" }): AuditEventInput {
  return build("rule.not_applied", input, { kind: "project", name: input.projectName }, { suggestionId: input.suggestionId, ruleId: input.ruleId, approvalOutcome: input.approvalOutcome });
}

/** `occurrence`: the suggestion id. The note a person gave is never a fact. */
export function auditRuleDismissed(input: AuditBuilderBase & { projectName: string; suggestionId: string; stage: string; dismissKind: string }): AuditEventInput {
  return build("rule.dismissed", input, { kind: "project", name: input.projectName }, { suggestionId: input.suggestionId, stage: input.stage, dismissKind: input.dismissKind });
}

/** `occurrence`: the suggestion id. Rovara withdrew a suggestion whose sources went away (the actor is the system). `cause` is a fixed word: `forgotten`, `sources_gone`, `pr_capture_off` or `erased`. */
export function auditRuleWithdrawn(input: AuditBuilderBase & { projectName: string; suggestionId: string; stage: string; cause: "forgotten" | "sources_gone" | "pr_capture_off" | "erased" }): AuditEventInput {
  return build("rule.withdrawn", input, { kind: "project", name: input.projectName }, { suggestionId: input.suggestionId, stage: input.stage, cause: input.cause });
}

/** `occurrence`: the id of the published version that took the rule out. */
export function auditRuleRolledBack(input: AuditBuilderBase & { projectName: string; ruleId: string; processAgentId: string; processVersion: number }): AuditEventInput {
  return build("rule.rolled_back", input, { kind: "project", name: input.projectName }, { ruleId: input.ruleId, processAgentId: input.processAgentId, processVersion: input.processVersion });
}

/** `occurrence`: the request id of the Remember or Forget. Also part of the id: the op, so a forgotten correction has its own event. */
export function auditRuleCorrectionRemembered(input: AuditBuilderBase & { projectName: string; correctionId: string; stage: string; standing: string; op: "remember" | "forget" }): AuditEventInput {
  return build("rule.correction_remembered", input, { kind: "project", name: input.projectName }, { correctionId: input.correctionId, stage: input.stage, standing: input.standing, op: input.op }, [input.op]);
}

/** `occurrence`: `auditOccurrence(project, settings revision)`. `enabled` says whether PR-comment learning is on after the change. */
export function auditProjectLearningChanged(input: AuditBuilderBase & { projectName: string; revision: number; enabled: boolean; selfConfirmedSoleOwner: boolean }): AuditEventInput {
  return build("project.learning_changed", input, { kind: "project", name: input.projectName }, { revision: input.revision, enabled: input.enabled, selfConfirmedSoleOwner: input.selfConfirmedSoleOwner });
}

/** `occurrence`: `auditOccurrence(project, new revision)`. A maintainer went back to the last proved setup (TE-4). */
export function auditProjectSetupRestored(input: AuditBuilderBase & { projectName: string; revision: number; fromRevision: number; provenRevision: number }): AuditEventInput {
  return build("project.setup_restored", input, { kind: "project", name: input.projectName }, { revision: input.revision, fromRevision: input.fromRevision, provenRevision: input.provenRevision });
}

/** One system bootstrap/upgrade occurrence, preserving numeric policies already set by an admin. */
export function auditTaskStopPolicySeeded(input: AuditBuilderBase & { source: "bootstrap" | "upgrade"; mode: "rovara_estimate"; revision: number; ceilingMicrousd: number }): AuditEventInput {
  return build("spending.policy_seeded", input, { kind: "spend_policy", id: "task_stop" }, {
    mode: input.mode, source: input.source, revision: input.revision, ceilingMicrousd: input.ceilingMicrousd,
  });
}

// G3 registrations/builders only. Writers must pair each event with the actual state change atomically.
export function auditModelFallbackUsed(input:AuditBuilderBase&{projectName:string;stage:StageId;used:ModelIdentifier;wanted?:ModelIdentifier;reasonCode:ModelFallback["reasonCode"];companyRevision:number}):AuditEventInput {
 const digest=(model:ModelIdentifier)=>createHash("sha256").update(JSON.stringify([model.provider,model.modelId])).digest("hex");
 const facts=ModelFallbackAuditFactsSchema.parse({stage:input.stage,usedModelDigest:digest(input.used),...(input.wanted===undefined?{}:{wantedModelDigest:digest(input.wanted)}),cause:input.reasonCode,companyRevision:input.companyRevision});
 return build("model.fallback_used",input,{kind:"project",name:input.projectName},facts,[input.stage]);
}
type ModelPolicyAuditInput=AuditBuilderBase&{revision:number;policyDigest:string;previousDigest?:string;stage?:StageId;mode?:"second_person"|"sole_owner_exception"};
function modelPolicyEvent(action:"model_policy.changed"|"model_policy.lock_set"|"model_policy.lock_removed",input:ModelPolicyAuditInput):AuditEventInput {
 const facts=ModelPolicyAuditFactsSchema.parse({revision:input.revision,policyDigest:input.policyDigest,...(input.previousDigest===undefined?{}:{previousDigest:input.previousDigest}),...(input.stage===undefined?{}:{stage:input.stage}),...(input.mode===undefined?{}:{mode:input.mode})});
 return build(action,input,{kind:"org",id:input.orgId},facts,input.stage===undefined?[]:[input.stage]);
}
export const auditModelPolicyChanged=(input:ModelPolicyAuditInput)=>modelPolicyEvent("model_policy.changed",input);
export const auditModelPolicyLockSet=(input:ModelPolicyAuditInput)=>modelPolicyEvent("model_policy.lock_set",input);
export const auditModelPolicyLockRemoved=(input:ModelPolicyAuditInput)=>modelPolicyEvent("model_policy.lock_removed",input);
/**
 * `occurrence`: `auditOccurrence(org, settings revision)`. The company's master "suggestions" switch changed; `setting` and `previous` are `on` or `off`, `source` is `company`, and
 * `previousSource` says where the previous value came from (`company` or `install_default`). The target is the company itself.
 */
export function auditRuleSuggestionsSet(input: AuditBuilderBase & { setting: "on" | "off"; previous: "on" | "off"; source: "company"; previousSource?: "company" | "install_default" }): AuditEventInput {
  return build("rule.suggestions_set", input, { kind: "org", id: input.orgId }, { setting: input.setting, previous: input.previous, source: input.source, ...(input.previousSource === undefined ? {} : { previousSource: input.previousSource }) });
}

// Company domain verification (owner decision 2026-11-02) ----------------------------------------------------------------

type DomainEventInput = AuditBuilderBase & { domain: string };
const domainDetails = (input: DomainEventInput): AuditDetailPart[] => [...(input.details ?? []), { subject: "org", fields: { domain: input.domain } }];

/** `occurrence`: `auditOccurrence(domain, claimedAt)`. A domain the company added (not yet proven; any number of companies may add the same one). The domain is a detail. */
export function auditCompanyDomainAdded(input: DomainEventInput): AuditEventInput {
  return build("company_domain.added", { ...input, details: domainDetails(input) }, { kind: "org", id: input.orgId }, {});
}

/** `occurrence`: `auditOccurrence(domain, claimedAt, checkedAt)`. The check found the company's token (the actor is the person who pressed Check now, or the system for the daily re-check). `tookOver`: the proof moved the domain from another company's lost claim. */
export function auditCompanyDomainVerified(input: DomainEventInput & { wasState: "pending" | "lost"; tookOver?: boolean }): AuditEventInput {
  return build("company_domain.verified", { ...input, details: domainDetails(input) }, { kind: "org", id: input.orgId }, { wasState: input.wasState, tookOver: input.tookOver === true });
}

/** `occurrence`: `auditOccurrence(domain, claimedAt, checkedAt)`. The record has been gone for the whole grace period; the domain stops counting (the actor is the system). */
export function auditCompanyDomainLost(input: DomainEventInput & { missingDays: number }): AuditEventInput {
  return build("company_domain.lost", { ...input, details: domainDetails(input) }, { kind: "org", id: input.orgId }, { missingDays: input.missingDays });
}

/** `occurrence`: `auditOccurrence(domain, claimedAt)`. An owner removed the domain. */
export function auditCompanyDomainRemoved(input: DomainEventInput & { wasState: "pending" | "verified" | "lost" }): AuditEventInput {
  return build("company_domain.removed", { ...input, details: domainDetails(input) }, { kind: "org", id: input.orgId }, { wasState: input.wasState });
}

/** A pending approval is an observation and request, never an applied binding. */
export function auditSlackChannelProposed(input: AuditBuilderBase & { projectName: string; teamId: string; channelId: string; requestId: string }): AuditEventInput {
 return build("slack_channel.proposed", { ...input, related: [input.teamId, input.channelId, ...(input.related ?? [])] }, { kind: "project", name: input.projectName }, { requestId: input.requestId, proposalId: input.requestId });
}

/** Terminal pending-link decision; never claims a canonical binding changed. */
export function auditSlackChannelDecision(input: AuditBuilderBase & { projectName: string; teamId: string; channelId: string; requestId: string; proposalId: string; state: "cancelled" | "rejected" }): AuditEventInput {
 return build(input.state === "cancelled" ? "slack_channel.cancelled" : "slack_channel.rejected", { ...input, related: [input.teamId, input.channelId, ...(input.related ?? [])] }, { kind: "project", name: input.projectName }, { requestId: input.requestId, proposalId: input.proposalId });
}

// Company sign-in (Enterprise foundations I1) ------------------------------------------------------------------------------

/** The details every sign-in event carries: the rule ids the sign-in matched, so a reviewer can see which mapping rules let the person in. Rule ids are an admin's words: details, never facts. */
const ruleDetails = (matchedRuleIds: readonly string[]): AuditDetailPart[] => (matchedRuleIds.length === 0 ? [] : [{ subject: "org", fields: { matchedRuleIds: matchedRuleIds.join(",").slice(0, 480) } }]);

/** `occurrence`: `auditOccurrence(requestId, memberId)`, where the request id is the sign-in's auth request (one occurrence per sign-in). */
export function auditSsoSignIn(input: AuditBuilderBase & { memberId: string; role: string; matchedRuleIds: readonly string[] }): AuditEventInput {
  return build("sso.sign_in", { ...input, details: [...(input.details ?? []), ...ruleDetails(input.matchedRuleIds)] }, { kind: "member", id: input.memberId }, { source: "mapping", role: input.role, rules: input.matchedRuleIds.length });
}

/** `occurrence`: as `auditSsoSignIn`. `reason` is one of the fixed refusal words. */
export function auditSsoSignInRefused(input: AuditBuilderBase & { memberId: string; reason: string }): AuditEventInput {
  return build("sso.sign_in_refused", input, { kind: "member", id: input.memberId }, { refusal: input.reason });
}

/** `occurrence`: as `auditSsoSignIn`. */
export function auditSsoBreakGlassUsed(input: AuditBuilderBase & { memberId: string; sessionSeconds: number }): AuditEventInput {
  return build("sso.break_glass_used", input, { kind: "member", id: input.memberId }, { role: "owner", sessionSeconds: input.sessionSeconds });
}

/** `occurrence`: `auditOccurrence(String(toVersion))`: each saved version is one occurrence. `added` and `removed` are the rule ids the save changed (details). */
export function auditSsoGroupMappingChanged(input: AuditBuilderBase & { fromVersion: number; toVersion: number; rules: number; added: readonly string[]; removed: readonly string[] }): AuditEventInput {
  const fields: Record<string, string> = {};
  if (input.added.length > 0) fields.added = input.added.join(",").slice(0, 480);
  if (input.removed.length > 0) fields.removed = input.removed.join(",").slice(0, 480);
  return build("sso.group_mapping_changed", { ...input, details: [...(input.details ?? []), ...(Object.keys(fields).length === 0 ? [] : [{ subject: "org", fields }])] },
    { kind: "org", id: input.orgId }, { fromVersion: input.fromVersion, toVersion: input.toVersion, rules: input.rules });
}

/** `occurrence`: `auditOccurrence(String(toVersion))`. The owners' ids are in details. */
export function auditSsoBreakGlassChanged(input: AuditBuilderBase & { toVersion: number; owners: number; ownerIds: readonly string[] }): AuditEventInput {
  return build("sso.break_glass_changed", { ...input, details: [...(input.details ?? []), ...(input.ownerIds.length === 0 ? [] : [{ subject: "org", fields: { ownerIds: input.ownerIds.join(",").slice(0, 480) } }])] }, { kind: "org", id: input.orgId }, { owners: input.owners });
}

/**
 * `occurrence`: `auditOccurrence(String(toVersion))`. SAML sign-in settings (I4). `changed` lists which settings changed, as fixed words (`entity_id`, `sign_in_address`, `certificate`, `enabled`);
 * the settings' values are never recorded. The certificate is public, but a fingerprint of it is a fact an auditor can compare with the identity provider's own (details).
 */
export function auditSsoSamlChanged(input: AuditBuilderBase & { fromVersion: number; toVersion: number; changed: readonly string[]; certificateSha256?: string }): AuditEventInput {
  return build("sso.saml_changed", { ...input, details: [...(input.details ?? []), ...(input.certificateSha256 === undefined ? [] : [{ subject: "org", fields: { certificateSha256: input.certificateSha256 } }])] },
    { kind: "org", id: input.orgId }, { fromVersion: input.fromVersion, toVersion: input.toVersion, changed: input.changed.join(",") || "none" });
}

/** Exact original/proposed policy facts; estimate/inherit has no invented amount. */
export function auditTaskStopPolicyChange(input: AuditBuilderBase & {
 action: "spending.policy_changed" | "spending.policy_change_requested" | "spending.policy_change_decided";
 scopeKind: "company" | "project"; project?: string; revision: number; requestId: string; proposalId?: string;
 before: { kind: string; stopMicrousd?: number }; after: { kind: string; stopMicrousd?: number }; decision?: string; reason?: "tightening_applied";
}): AuditEventInput {
 return build(input.action, input, input.project === undefined ? { kind: "spend_policy", id: "task_stop" } : { kind: "project", name: input.project }, {
  scopeKind: input.scopeKind, revision: input.revision, requestId: input.requestId, beforeKind: input.before.kind, afterKind: input.after.kind,
  ...(input.reason === undefined ? {} : { outcomeCode: input.reason }), ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }), ...(input.decision === undefined ? {} : { decision: input.decision }),
  ...(input.before.stopMicrousd === undefined ? {} : { beforeMicrousd: input.before.stopMicrousd }), ...(input.after.stopMicrousd === undefined ? {} : { afterMicrousd: input.after.stopMicrousd }),
 });
}

/** Required decision audit, committed by the caller beside the native admission or pause. */
export function auditTaskStopDecision(input: AuditBuilderBase & {
 action: "spending.stop_admitted" | "spending.stop_reached";
 taskId: string; effectiveStopMicrousd: number; approvalCapMicrousd: number; policyDigest: string; admissionId: string;
}): AuditEventInput {
 return build(input.action, input, { kind: "task", id: input.taskId }, { effectiveStopMicrousd: input.effectiveStopMicrousd, approvalCapMicrousd: input.approvalCapMicrousd,
  policyDigest: input.policyDigest, workKind: "task-window", admissionId: input.admissionId });
}

// Setup agent website asks (sh-setup-wire, SH12) -----------------------------------------------------------------------------------

/**
 * `occurrence`: `auditOccurrence(project, askId, askedAt)`. The ask a setup run raised for a website it could not reach. The actor is the system acting for the person who started the run (their id is in the
 * details, with the host); nothing is granted by an ask. `journalN` is the run's journal position of the command that was blocked, when there is one.
 */
export function auditSetupHostAsked(input: AuditBuilderBase & { projectName: string; askId: string; taskId: string; journalN?: number | undefined; host: string; onBehalfOf: string; typedBy?: string | undefined }): AuditEventInput {
  return build("setup.host_asked", { ...input, details: [...(input.details ?? []), { subject: "org", fields: { host: input.host, onBehalfOf: input.onBehalfOf, ...(input.typedBy === undefined ? {} : { typedBy: input.typedBy }) } }] }, { kind: "project", name: input.projectName },
    { askId: input.askId, taskId: input.taskId, journalN: input.journalN });
}

/** `occurrence`: `auditOccurrence(project, askId, decidedAt)`. An admin refused the ask (or the broker did, for a fixed reason); `refusal` is one of the fixed words of the refusal. */
export function auditSetupHostRefused(input: AuditBuilderBase & { projectName: string; askId: string; refusal: string; host: string }): AuditEventInput {
  return build("setup.host_refused", { ...input, details: [...(input.details ?? []), { subject: "org", fields: { host: input.host } }] }, { kind: "project", name: input.projectName }, { askId: input.askId, refusal: input.refusal });
}

/** `occurrence`: the maintainer's request id. A project's own setup-run limits changed; the five values are the new ones. */
export function auditSetupLimitsChanged(input: AuditBuilderBase & { projectName: string; revision: number; previousDigest: string; nextDigest: string; limits: { commands?: number | undefined; sameStepTries?: number | undefined; wallClockMin?: number | undefined; budgetCents?: number | undefined; hostAsks?: number | undefined } }): AuditEventInput {
  return build("setup.limits_changed", input, { kind: "project", name: input.projectName }, { revision: input.revision, previousDigest: input.previousDigest, nextDigest: input.nextDigest, ...input.limits });
}

/** `occurrence`: the company locks' new revision (a locks row is never deleted and recreated, so the revision never repeats). The three events of a locks change: applied, proposed (a loosening waiting for a second admin) and approved. */
export function auditSetupLocksChange(input: AuditBuilderBase & { action: "setup.locks_changed" | "setup.locks_change_proposed" | "setup.locks_change_approved"; revision: number; previousDigest: string; nextDigest: string; loosened: boolean; approvalMode?: string | undefined; membershipVersion?: number | undefined; defaulted?: string | undefined }): AuditEventInput {
  return build(input.action, input, { kind: "org", id: input.orgId }, {
    revision: input.revision, previousDigest: input.previousDigest, nextDigest: input.nextDigest, loosened: input.loosened,
    ...(input.action === "setup.locks_change_approved" ? { approvalMode: input.approvalMode, membershipVersion: input.membershipVersion } : {}),
    // A repair of a damaged row: the locks that could not be read and were set to their strictest value.
    ...(input.defaulted === undefined ? {} : { defaulted: input.defaulted }),
  });
}

// Tracker people (team record) -------------------------------------------------------------------------------------------

/** `occurrence`: the admin's request id. `source` is `linear` or `jira`. The target is the member; the tool's id and the name it shows never go in. */
export function auditRecordTrackerPersonMapped(input: AuditBuilderBase & { memberId: string; source: string }): AuditEventInput {
  return build("record.tracker_person_mapped", input, { kind: "member", id: input.memberId }, { source: input.source });
}

/** `occurrence`: the admin's request id. */
export function auditRecordTrackerPersonUnmapped(input: AuditBuilderBase & { memberId: string; source: string }): AuditEventInput {
  return build("record.tracker_person_unmapped", input, { kind: "member", id: input.memberId }, { source: input.source });
}

/** `occurrence`: the admin's request id and the new state. The target is the company; `enabled` is the new state of the switch. */
export function auditRecordTrackerAutolinkChanged(input: AuditBuilderBase & { enabled: boolean }): AuditEventInput {
  return build("record.tracker_autolink_changed", input, { kind: "org", id: input.orgId }, { enabled: input.enabled });
}

// Company setup recipes (SH29) --------------------------------------------------------------------------------

export type SetupRecipeAuditAction = "setup_recipe.proposed" | "setup_recipe.created" | "setup_recipe.approved" | "setup_recipe.revoked" | "setup_recipe.scope_changed";

/**
 * `occurrence`: `auditOccurrence(recipeId or "locks", revision, action)` (every change adds one revision). The target is the company. Facts are ids, digests and fixed words only: a recipe's commands, hosts and label,
 * and the projects it is offered to, never go in.
 */
export function auditSetupRecipeChange(input: AuditBuilderBase & { action: SetupRecipeAuditAction; facts: Record<string, Fact> }): AuditEventInput {
  return build(input.action, input, { kind: "org", id: input.orgId }, input.facts);
}
