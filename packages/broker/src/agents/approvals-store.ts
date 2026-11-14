import {ModelApplyRefusalSchema} from "../model-selection/process-refusal.js";
// Plan 3 Task 7 and Task 21: the approvals' records and everything that writes or reads them one at a time: the three record kinds and their schemas, the
// registries of rules and subject handlers, creating a change, a step and a write approval, listing, who may decide, and the transaction helpers the decision, the
// sweep and the movers share. `approvals.ts` re-exports it.
import { resolveStoredName } from "../developer/name-resolver.js";
import { ModelSelectionPolicyPutSchema, type ModelSelectionPolicyPut } from "@rovara-code/contracts";
import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentGuardrailsSchema, AgentIdSchema, ChainIdSchema, TriggerIdSchema, AgentPrincipalSchema, ApprovalIdSchema, ConnectorConfigSchema, RunInputSchema, WORK_ORIGINS, INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, SessionIdSchema, SessionLevelSchema, agentXError, approvalKey, approverIndexKey, canonicalInstant, canonicalJson, capText, newPrefixedId, openApprovalKey, hideEmailAddresses, orgScoped, projectAllows, redactText, type AgentGuardrails, type AgentId, type ApprovalId, type ConnectorConfig, type OrgId, type RunInput, type WorkOrigin, type SessionId, type SessionLevel, AgentOwnerSchema, type AgentOwner } from "@rovara-code/contracts";
import { APPROVAL_EXECUTING_RETRY_MINUTES, CHANGE_APPROVAL_TTL_DAYS, orgOpenApprovalKey, type AuditProof, AgentPublishNoteSchema, PublishTargetSchema, type AuditEventInput, type PublishTarget } from "@agentx/cloud-contracts";
import type { SessionTakeOverDependencies } from "../agent-sessions/take-over.js";
import type { CodeMergeHost, PullRequestMergeSubject } from "../rovara-code/merge.js";
import { isTaskTakenOver, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { ProjectConnectorDependencies } from "../connections/project-connectors.js";
import { WRITE_APPROVAL_TTL_MS } from "./approval-ttl.js";
import { auditApprovalRequested } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import type { ChainStore } from "../chains/store.js";
import type { TriggerHookReader, TriggerHooks, TriggerLookup, TriggerScheduler } from "../triggers/ports.js";
import { orgRoleOf, type AgentAccessDeps, type AgentCaller, type AgentShare } from "./access.js";
import type { RoutingDependencies } from "../model-sources/routing.js";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import type { ServableModels } from "./guardrails.js";
import { resolveMember, sameMember } from "./lifecycle.js";
import type { ResolveOptions } from "./store.js";
import type { AgentRepositoryReader } from "../github-app.js";
import type { DecideGuard, WriteGateRuntime } from "./write-gate.js";
import type { AgentRunHost } from "./run-engine.js";
import type { TeamRecordTable } from "../team-record/types.js";
import { safeDisplayName } from "../developer/person-name.js";

/** What an agent's routes and the approvals that act on agents need: access checks, the store and where the page lives. */
export interface ApprovalDependencies extends AgentAccessDeps {
  /** TE-B2: whether the company's `honestCi` gate is on (TE-A1). Absent, or a read that fails: off, today's behaviour. */
  honestCi?(orgId: OrgId): Promise<boolean>;
  /** TE-B2: the project's real-check mode (see `ProjectCiMode`). `DEFAULT_CI_MODE` when absent. */
  ciMode?(task: { taskId: string; project: string }): Promise<"sandbox_only" | "their_ci_watch" | "their_ci_fix" | "rovara_real_run"> | "sandbox_only" | "their_ci_watch" | "their_ci_fix" | "rovara_real_run";
  modelRouting?: RoutingDependencies;
  /** Existing sign-in table, used only for global revocation ConditionChecks. */
  modelSignInTableName?: string;
  /** The Team record's table, where the company's sole-owner switch lives (test environments read it for the sole-owner exception). Absent where the Team record is off. */
  teamRecordTable?: TeamRecordTable;
  stageChatgpt?: Pick<ChatGptConnections,"settings"|"view">;
  /** Plan 4: the chain store, where a chain's change names the chain it is about on the confirmation page. Absent where chains are not set up. */
  chains?: ChainStore;
  /**
   * Plan 4 Task 18: the trigger store (a lookup of who created a trigger, for who approves an autonomous run's writes, and the whole store where the broker builds it), what
   * the changes that confirm and the member movers ask of the trigger code (`triggerHooks`), the hooks that receive events (`hooks`, Task 19) and the scheduler (`triggerSchedules`,
   * Task 26). Each is absent where its code is not set up.
   */
  triggers?: TriggerLookup;
  triggerHooks?: TriggerHooks;
  hooks?: TriggerHookReader;
  triggerSchedules?: TriggerScheduler;
  now: () => number;
  /** How long the confirmation page waits for the track record lines before it shows the changes without them (default 1.5 seconds). */
  trackRecordDeadlineMs?: number | undefined;
  /**
   * Plan 6 Task 3: whether Rovara Code version 2 is available (default `ROVARA_CODE_V2_FOR_NEW_ORGS`, off until Task 8). While it is off no admin can adopt version 2 and a
   * version 2 task does not start at Understand, which does not run yet. Tests set it to try version 2.
   */
  rovaraCodeV2Live?: boolean;
  /** The cell's origin, where `/v1/app/approve/<id>` is served. */
  confirmOrigin: string;
  /** Looks up an added skill's name and digest (Task 9); without it, a recipe that adds a skill can't be resolved. */
  resolveSkill?: ResolveOptions["resolveSkill"];
  /** The models some source the company can use serves (Task 26); without it, the models Rovara's own AI serves. */
  servableModels?: ServableModels;
  /** What a project's connectors need (Task 13): the org's connections, the project revision write and the live connector status. Without it those routes answer 404 and a widening cannot be applied. */
  projectConnectors?: ProjectConnectorDependencies;
  /** Task 14b: a read-only reader of a repository's default branch for an org, for the comment-triggered workflow scan. Without it, nothing can be reviewed or opted out. */
  repositoryReader?: (input: { orgId: OrgId; repositoryUrl: string; installationId?: number }) => Promise<AgentRepositoryReader>;
  /** Task 14b: the repositories of a project as they are registered now (undefined when there is no such project in the org). */
  projectRepositories?: (orgId: OrgId, project: string) => Promise<ReadonlyArray<{ name: string; url: string; installationId?: number | undefined }> | undefined>;
  /** Task 21: what a write approval needs beyond the table (the connector call path, the agent's grant and the run owner's authority). Task 19 supplies it; without it a write approval can't be made or decided. */
  writeGate?: WriteGateRuntime;
  /** Task 21a-wiring: the presence guard in front of the decide routes (the broker builds it over `requireDecideSession`). Without it, or `writeGate.requireDecide`, they answer 404. */
  requireDecide?: DecideGuard;
  /** Task 21a-wiring: the confirmation link for a token's member, with a decide ticket minted for them (after the same live check as `mayDecideApproval`); only `POST /v1/app/approvals/{id}/confirm-link` mints, a read never does. */
  mintConfirmUrl?: (caller: AgentCaller, approvalId: string) => Promise<string>;
  /**
   * Owner decision 2026-10-22 (option D): starts the run an owner approved for an older, less safe version (`agent_run_version`), as `developerId`, exactly once
   * (the run's own request id makes a redrive answer the first start), with the version check of the start waived. The broker supplies it; without it such a
   * change can't be applied.
   */
  startApprovedRun?: (input: { orgId: OrgId; requestId: string; project: string; agent: { agentId: AgentId; version: number }; input: RunInput; origin: WorkOrigin; developerId: string }) => Promise<void>;
  /** Task 22: what the agent-step engine needs of the broker (dispatching a step's operation, the creator and recipe checks, the parts of a task's end). Without it a run cannot go on. */
  agentRuns?: AgentRunHost;
  /**
   * Plan 5 Tasks 4 and 12b: what company-wide session shares and take-overs need (their rules and handlers): the session store and access, the sign-in store, the payer's
   * admission, the realtime events API and Plan 4's chain mover. Without it a `session_share_org` or `session_owner` change can't be decided or applied.
   */
  agentSessions?: SessionTakeOverDependencies;
  /** Plan 6 Task 19: what merging a task's pull requests needs (GitHub's reads and the merge, the task, its repositories). Without it a `pull_request_merge` change can't be pressed or applied. */
  codeMerge?: CodeMergeHost;
}

/** The part of the dependencies the record's own writes need. */
export type ApprovalStoreDependencies = Pick<ApprovalDependencies, "documentClient" | "tableName" | "now">;

/** Who must decide: the people named, or a rule evaluated when the decision is made (R64, R68), whose `candidates` only see it listed. */
export type ApproverSpec =
  | { kind: "ids"; ids: readonly string[] }
  | { kind: "rule"; rule: string; candidates: readonly string[] };

/** `APPROVED` ends a step approval (a person said yes; the subject's handler goes on from there); a change or a write ends `APPROVED_DONE` or `APPROVED_FAILED`. */
export type ApprovalStatus = "PENDING" | "EXECUTING" | "APPROVED" | "APPROVED_DONE" | "APPROVED_FAILED" | "DECLINED" | "EXPIRED";
const APPROVAL_STATUSES = ["PENDING", "EXECUTING", "APPROVED", "APPROVED_DONE", "APPROVED_FAILED", "DECLINED", "EXPIRED"] as const;

/** What a change record applies when it is confirmed. Each is bound to the exact version, revision or digest that was shown. */
export type AgentChangeSubject =
  /** Publish `agentId`'s draft: only while the draft is still `draftRevision` with `digest`, and the current version is still `expectedCurrentVersion`. */
  | { kind: "agent_publish"; agentId: AgentId; draftRevision: number; digest: string; expectedCurrentVersion?: number; note?: string; modelContext?: {companyRevision:number;sourcesRevision:number;registeredAt:string;tupleDigest?:string} }
  /** Make `version` (whose recipe has `digest`) current, while the current version is still `expectedCurrentVersion`. */
  | { kind: "agent_rollback"; agentId: AgentId; version: number; digest: string; expectedCurrentVersion: number; modelContext?: {companyRevision:number;sourcesRevision:number;registeredAt:string;tupleDigest?:string} }
  /** Move the org's pin of a built-in to `version`, while it is still `expectedPinnedVersion`. */
  | { kind: "builtin_adopt"; agentId: AgentId; version: number; digest: string; expectedPinnedVersion: number }
  /** Make `shares` the agent's share set (it includes a company-wide share), while it is still at `expectedSharesRevision`. */
  | { kind: "agent_share"; agentId: AgentId; shares: AgentShare[]; expectedSharesRevision: number; expectedCurrentVersion?: number; versionDigest?: string }
  /** Make `next` the company's agent guardrails, while they are still at `expectedRevision`. */
  | { kind: "guardrails"; next: AgentGuardrails; expectedRevision: number }
  | {kind:"model_selection_policy";body:ModelSelectionPolicyPut;sourcesRevision:number;guardrailsRevision:number}
  /**
   * Start the run `runRequestId` asked for on `version` of the agent (an older version than the one that runs now, `expectedCurrentVersion`; for a built-in the
   * org's pin), which is less safe than it: only while the version that runs now and the recipe of `version` (`digest`) are still what was shown. Approving it
   * starts the run once, as the person who asked (`requestedBy`); declining or expiry starts nothing.
   */
  | { kind: "agent_run_version"; agentId: AgentId; version: number; digest: string; expectedCurrentVersion: number; project: string; runRequestId: string; origin: WorkOrigin; input: RunInput }
  /**
   * Experience decision 24, owner decision 91: publish `agentId` to `target`. A project target moves ownership of the agent to the project (the person who approves is accountable; the
   * author keeps edit access); the company target adds a company-wide share at `use`. Bound to what the approver saw: the published `version` and its recipe `digest`, the owner
   * (`expectedOwner`) and the share set's revision. `requestId` is the requester's own id for the request (the withdraw route names it).
   */
  | AgentPublicationSubject;

/** See `AgentChangeSubject`'s `agent_publication`. */
export interface AgentPublicationSubject { kind: "agent_publication"; agentId: AgentId; target: PublishTarget; version: number; digest: string; requestId: string; note?: string; expectedOwner: AgentOwner; expectedSharesRevision: number }

/**
 * Make `connector` the connector called `name` on `project`: a tool newly approved as `write` (Task 13). It applies only while the project is still
 * at `expectedRevision`, and writes exactly the connector stored here.
 */
export interface ConnectorWidenSubject { kind: "connector_widen"; project: string; name: string; expectedRevision: number; connector: ConnectorConfig }

/**
 * Task 14b: lets agents comment, review and label in a repository whose workflows act on comments, on one project, while the workflows still have
 * the digest that was reviewed. `files` is what the admin saw.
 */
export interface OptOutChangeSubject { kind: "opt_out"; project: string; repository: string; expectedDigest: string; files: string[]; reason: string }

/**
 * Plan 5 Task 4: makes everyone in the company able to see a session at `level` (a share with the whole company needs the sharer's fresh sign-in, like
 * handing over its ownership). It applies as the person who decided it, if they may still share the session.
 */
export interface SessionShareOrgSubject { kind: "session_share_org"; sessionId: SessionId; level: SessionLevel }

/**
 * Plan 5 Task 12b: makes `to` the owner of a session, while the session is still at `sessionRevision` (only owner, sharing and leg changes move it, so a follow, a summary
 * refresh or an event can't make a take-over fail). It applies as the person who decided it, who is `to`, if they may still take the session over.
 */
export interface SessionOwnerSubject { kind: "session_owner"; sessionId: SessionId; to: string; sessionRevision: number }

/**
 * Setup wizard (E4): a SECOND person's confirmation of a less-safe test environment, bound to the proposal's digest and to the revision of the approved environment it was looked at against. Approving
 * it (on the confirmation page, with a fresh sign-in) records consent and changes nothing; the person who asked then finishes the approval from the setup page, which reads this record, the second person's
 * live authority and the sign-in proof again.
 */
export interface TestEnvSubject { kind: "test_env"; project: string; digest: string; expectedRevision: number }

/**
 * Setup and test health (SH17, owner decision F4): a SECOND person's confirmation of "Mark as known failing" for a Fix setup card, bound to the card it was made for (project, cause, record epoch and version) and to the
 * exact set of tests the card marks (`testSetSha256`, the sha256 of the sorted "check, test" lines). Approving it (on the confirmation page, with a fresh sign-in) records consent and changes nothing; the maintainer who
 * pressed Mark then presses it again, and the broker reads this record, both people's live authority and the sign-in proof again before it marks anything.
 */
export interface KnownFailingSubject { kind: "known_failing"; project: string; cause: string; epoch: number; recordVersion: number; testSetSha256: string }

/** The kinds of change that are not about an agent itself: connector widenings (Task 13), comment-trigger opt-outs (Task 14b), company-wide session shares and session take-overs (Plan 5). */
/**
 * Plan 6 Task 19: turns self-approval on for a project's code settings, while they are still at `settingsRevision`. An organization owner or admin decides it; nothing else about the
 * settings waits for anyone.
 */
export interface CodeSettingsSubject { kind: "code_settings"; project: string; settingsRevision: number; changes: { allowSelfApproval: true } }

/**
 * "How we work" follow-up M2: sets a project's playbook back to the built-in Rovara Code while the project's process layer `agentId` (at published version `layerVersion`) is stricter than
 * the built-in. It applies only while the playbook is still at `expectedRevision` and the layer still at `layerVersion`; the layer is named so the process self-confirm rules and the
 * `agent_publish` approvers apply to it as they do to a publish of the layer.
 */
export interface PlaybookDefaultProcessSubject { kind: "playbook_default_process"; project: string; agentId: AgentId; layerVersion: number; expectedRevision: number }

/**
 * Meta repo lane B: a person's consent to ONE risky item of the setup agent's proposal (a repository to add, a dev container pull request, a source, an intake trigger, a
 * secret). Each such item gets its own card. The card is bound to the draft (`draftTaskId`), the item (`itemId`) and a digest of the value that was shown (`digest`); approving it
 * records consent and changes nothing. The project's maintainer then applies the item from the setup page, through the same save every other change uses, and only while the
 * proposal still holds exactly that value.
 */
export interface SetupItemSubject { kind: "setup_item"; project: string; draftTaskId: string; itemId: string; itemKind: "repository" | "devcontainer" | "source" | "intake" | "secret"; digest: string }

/**
 * Security review (2026-11-06): the vehicle of the decide-grade sign-in for a HIGH card that has no approval of its own (a high design, a high requirements or coding plan). Made when the person presses
 * Approve without a decide session; the decide sign-in (email code, clean sign-in, own pool user) is minted for it, and the card's next press, with that session, applies the card's decision and then
 * approves this record with the session's proof. Approving it changes nothing by itself. Bound to the card and the version of it that was shown; `returnPath` is the task page focused on the card.
 */
export interface CardDecisionSubject { kind: "card_decision"; taskId: string; cardId: string; contentVersion: string; returnPath: string }

/** The kinds of change that are not about an agent itself: connector widenings (Task 13), comment-trigger opt-outs (Task 14b), company-wide session shares and session take-overs (Plan 5), merges and code settings (Plan 6), a project's process (How we work), a setup suggestion (meta repo lane B). */
export type OtherChangeSubject = ConnectorWidenSubject | OptOutChangeSubject | SessionShareOrgSubject | SessionOwnerSubject | PullRequestMergeSubject | CodeSettingsSubject | PlaybookDefaultProcessSubject | SetupItemSubject | TestEnvSubject | KnownFailingSubject | CardDecisionSubject;

/** Plan 4 Task 4: a chain's publish or rollback that makes something less safe, bound to the draft revision and digest (or the version) that was shown. */
export type ChainChangeSubject =
  | { kind: "chain_publish"; chainId: string; draftRevision: number; digest: string; expectedCurrentVersion?: number; note?: string }
  | { kind: "chain_rollback"; chainId: string; version: number; digest: string; expectedCurrentVersion: number }
  /** Make `shares` the chain's share set (it includes a company-wide share, or a wider one than there is), while it is still at `expectedSharesRevision`. */
  | { kind: "chain_share"; chainId: string; shares: AgentShare[]; expectedSharesRevision: number; expectedCurrentVersion?: number; versionDigest?: string };

/**
 * Plan 4 Task 18: turning a trigger on is a person's decision (N6). The approval is bound to the digest of the spec the person was shown, so a trigger edited in between
 * does not turn on under it, and to the revision of the trigger it was made for, so a request that outlived a turn-off or a newer request turns nothing on.
 */
export type TriggerChangeSubject = { kind: "trigger_enable"; triggerId: string; specDigest: string; triggerRevision: number };

export type ChangeSubject = AgentChangeSubject | ConnectorWidenSubject | OptOutChangeSubject | ChainChangeSubject | TriggerChangeSubject | SessionShareOrgSubject | SessionOwnerSubject | PullRequestMergeSubject | CodeSettingsSubject | PlaybookDefaultProcessSubject | SetupItemSubject | TestEnvSubject | KnownFailingSubject | CardDecisionSubject;

export interface ChangeApprovalRecord extends DecidedFields {
  orgId: OrgId;
  approvalId: ApprovalId;
  kind: "change";
  subject: ChangeSubject;
  /** What the change does, in words, as the page lists it. */
  changes: string[];
  approvers: ApproverSpec;
  status: ApprovalStatus;
  /** The developer who asked. */
  requestedBy: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Why a confirmed change could not be applied (status `APPROVED_FAILED`). */
  failure?: string;
  createdAt: string;
  expiresAt: string;
}

/** The change records Plan 3's earlier tasks make; the step and write records below are Task 21's. Handlers that apply a change take this one. */
export type ApprovalRecord = ChangeApprovalRecord;

/** What an approval is about when it is a step of a run (`agent_run`) or of a chain (`chain_gate`, Plan 4); a test may register any other kind. */
export type ApprovalSubject = { kind: "agent_run"; taskId: string; stepId: string } | { kind: "chain_gate"; chainRunId: string; seq: number };

/** The person a run belongs to and the project it runs in: what the `write_approver` rule decides on. */
export interface ApprovalRun { project: string; owner: { developerId: string; name: string } }

/** Fields every record that is decided carries once it is. */
interface DecidedFields {
  modelRefusal?: z.infer<typeof ModelApplyRefusalSchema>;
  decidedBy?: string;
  decidedAt?: string;
  /** The decision, kept so a retry after a crash finishes the same one. */
  decision?: "APPROVE" | "DECLINE";
  /** The request id of the decision: a repeat by the same person answers the stored outcome. */
  decisionRequestId?: string;
  /** How the decision was made (the decide session's proof), for the audit event of a retry. */
  decisionProof?: AuditProof;
  /** When the work after the decision (applying it, running the call) was last started, and how many times. */
  executingAt?: string;
  attempts?: number;
  /** Why it ended `APPROVED_FAILED`. */
  failure?: string;
  /** Whether the subject's handler has heard the outcome, who has the right to tell it now, and when the sweep looks again. */
  handlerDone?: boolean;
  handlerClaimedAt?: string;
  handlerDueAt?: string;
  /** How many times the handler failed; at `MAX_HANDLER_TRIES` the sweep gives up on it (`handlerDone` is then set). */
  handlerTries?: number;
  /** Set when the member movers changed who may decide this (a merge or a removal), with when: the audit event `approval.rerouted` names the people. */
  movedBy?: "system";
  movedAt?: string;
  /** Set when a step approval was closed because the run it belonged to ended (Plan 4, `closeStepApproval`), not decided: who closed it, why and when. */
  closedBy?: "system";
  closedReason?: string;
  closedAt?: string;
  /** A change record whose decliner gave a reason (agent publish requests): plain text, at most 300 characters, shown to the person who asked. */
  declineReason?: string;
  /** Set when the person who asked withdrew a change record (it ends `EXPIRED`, never decided): who and when (`withdrawChange`). */
  withdrawnBy?: string;
  withdrawnAt?: string;
}

/** A step of a run that waits for a person (an `approval` step, or a chain gate). */
export interface StepApprovalRecord extends DecidedFields {
  orgId: OrgId;
  approvalId: ApprovalId;
  kind: "step";
  subject: ApprovalSubject;
  prompt: string;
  approvers: ApproverSpec;
  status: ApprovalStatus;
  /** The project and the run's owner, when the creator knew them: `write_approver` reads them (else from the task). */
  project?: string;
  owner?: { developerId: string; name: string };
  createdAt: string;
  expiresAt: string;
}

/** A consequential or merge call of an agent that waits for a person, holding exactly what will be sent (Task 21). */
export interface WriteApprovalRecord extends DecidedFields, ApprovalRun {
  /** The agent that asked, as it was named when the approval was created (the page shows this, not a lookup: the agent may be renamed since). Absent on records made before it was stored. */
  agent?: { agentId: string; name: string };
  orgId: OrgId;
  approvalId: ApprovalId;
  kind: "write";
  subject: { kind: "agent_run"; taskId: string; stepId: string };
  operationId: string;
  /** The project's name for the connector, its type, the tool's upstream name and what the project approved it for. */
  connector: string;
  connectorType: string;
  tool: string;
  toolAccess: "read" | "write";
  scope: string;
  /** For a GitHub connector, the repository the scope names as `owner/name` (the server binds it, so the arguments never carry it); the page shows it. Absent on other connectors and on records made before it was stored. */
  repository?: string;
  schemaHash: string;
  /** The project revision it was asked under (for display; every check reads the current one). */
  projectRevision: number;
  credentialRef?: string;
  /** A digest of the connector's scope as it was stored when asked: a scope that changed since is not the one a person approved. */
  scopeDigest: string;
  /** The prepared arguments (Task 20b), exactly what will be sent. */
  arguments: Record<string, unknown>;
  argumentsHash: string;
  summary: string;
  class: "consequential" | "merge";
  approvers: ApproverSpec;
  status: ApprovalStatus;
  result?: { status: string; text: string; truncated: boolean; replayed: boolean };
  createdAt: string;
  expiresAt: string;
}

export type AnyApprovalRecord = ChangeApprovalRecord | StepApprovalRecord | WriteApprovalRecord;

export type ApprovalCaller = AgentCaller;

// Method syntax makes the parameter types bivariant, so a rule or handler written for the change record alone is still accepted.
/** Whether `caller` may decide `record` now. Evaluated live each time, so a person demoted since it was asked can't decide it. */
export type ApproverRuleCheck = { check(deps: ApprovalDependencies, record: AnyApprovalRecord, caller: ApprovalCaller): Promise<boolean> }["check"];
/**
 * Applies a confirmed record exactly as stored, or throws why it can't. `decidedBy` is set on the record when it runs. `decision.proof` is how the
 * decision was made (the decide session's, Task 21a): a handler whose own audit event should carry it reads it here. A step or write approval's
 * handler (`agent_run`, `chain_gate`) runs after the outcome is stored, whatever it was (`record.status`), and must be safe to run again.
 */
export type ApprovalSubjectHandler = { handle(deps: ApprovalDependencies, record: AnyApprovalRecord, decision?: { proof?: AuditProof }): Promise<void> }["handle"];

const rules = new Map<string, ApproverRuleCheck>();
const handlers = new Map<string, ApprovalSubjectHandler>();
const gaveUp = new Map<string, ApprovalSubjectHandler>();

/** Registers (or replaces) the rule a record's `approvers` can name. */
export function registerApproverRule(rule: string, eligible: ApproverRuleCheck): void {
  rules.set(rule, eligible);
}

/** Registers (or replaces) what confirming a record of this subject kind does. */
export function registerApprovalSubjectHandler(kind: ChangeSubject["kind"] | ApprovalSubject["kind"], handler: ApprovalSubjectHandler): void {
  handlers.set(kind, handler);
}

/**
 * Registers what is done when the sweep gives up telling a subject's handler about a decision (`MAX_HANDLER_TRIES` failures, `approval.handler_gave_up`):
 * the subject can no longer be taken forward from that approval, so whoever waits on it must be able to stop waiting (Task 22 fails the run). The sweep
 * gives up for good only once this has run; when it throws, it tries again later.
 */
export function registerApprovalGaveUpHandler(kind: ApprovalSubject["kind"], handler: ApprovalSubjectHandler): void {
  gaveUp.set(kind, handler);
}

/**
 * What a rule says to someone it refuses: `text` is the whole sentence the decide API answers `FORBIDDEN` with, `who` the words the confirmation page puts in
 * "Only <who> can decide this." `code`, when the rule gives one, is the error code of a record that can't be decided because it is closed (default `FORBIDDEN`). A rule that can name its people (Plan 4's chain gates) registers it; Plan 3's own rules keep their fixed words.
 */
export interface ApproverRefusal { text: string; who: string; code?: "APPROVAL_CLOSED" | "CHAIN_RUN_CLOSED" }
export type ApproverRefusalFor = (deps: ApprovalDependencies, record: AnyApprovalRecord) => Promise<ApproverRefusal | undefined>;
const refusals = new Map<string, ApproverRefusalFor>();

/** Registers (or replaces) how a rule words its refusal. Only words: it decides nothing, and a failure of it falls back to the generic text. */
export function registerApproverRefusal(rule: string, refusal: ApproverRefusalFor): void {
  refusals.set(rule, refusal);
}

/** The registered words for a record whose approvers are a rule that has some; undefined for any other record or when the rule's own lookup fails. */
export async function approverRefusalFor(deps: ApprovalDependencies, record: AnyApprovalRecord): Promise<ApproverRefusal | undefined> {
  if (record.approvers.kind !== "rule") return undefined;
  const refusal = refusals.get(record.approvers.rule);
  if (refusal === undefined) return undefined;
  try {
    return await refusal(deps, record);
  } catch {
    return undefined;
  }
}

/**
 * A check a decision passes after the record's rule says the caller may decide it, before anything is claimed: it throws (in the words the person is told) to refuse. Guards are registered
 * by name, so registering again replaces. "How we work" registers the one that stops the person who asked for a change to a project's process from confirming it themselves.
 */
export type ApprovalDecisionGuard = (deps: ApprovalDependencies, caller: ApprovalCaller, record: AnyApprovalRecord, decision: "APPROVE" | "DECLINE") => Promise<void>;
const decisionGuards = new Map<string, ApprovalDecisionGuard>();

export function registerApprovalDecisionGuard(name: string, guard: ApprovalDecisionGuard): void {
  decisionGuards.set(name, guard);
}

/** Runs every registered guard; the first to throw refuses the decision. */
export async function runApprovalDecisionGuards(deps: ApprovalDependencies, caller: ApprovalCaller, record: AnyApprovalRecord, decision: "APPROVE" | "DECLINE"): Promise<void> {
  for (const guard of decisionGuards.values()) await guard(deps, caller, record, decision);
}

/**
 * The audit events a decision of a change of this subject kind writes beside `approval.decided`, in the same claim transaction (agent publish requests write
 * `agent_publication.approved` or `.declined`). Registered by subject kind; registering again replaces.
 */
export type DecisionAuditEvents = (record: ApprovalRecord, decision: { by: string; at: string; decision: "APPROVE" | "DECLINE"; proof?: AuditProof; reason?: string }) => AuditEventInput[];
const decisionAudits = new Map<string, DecisionAuditEvents>();
export function registerDecisionAuditEvents(kind: ChangeSubject["kind"], events: DecisionAuditEvents): void {
  decisionAudits.set(kind, events);
}
export const getDecisionAuditEvents = (kind: string): DecisionAuditEvents | undefined => decisionAudits.get(kind);

export const getApprovalGaveUpHandler = (kind: string): ApprovalSubjectHandler | undefined => gaveUp.get(kind);
export const getApproverRule = (rule: string): ApproverRuleCheck | undefined => rules.get(rule);
export const getApprovalSubjectHandler = (kind: string): ApprovalSubjectHandler | undefined => handlers.get(kind);

/** The confirmation page for an approval: where a person decides it. */
export const confirmUrlFor = (deps: Pick<ApprovalDependencies, "confirmOrigin">, record: { approvalId: ApprovalId }): string => `${deps.confirmOrigin}/v1/app/approve/${record.approvalId}`;

/** A transaction holds 100 items: the record, its open index item and at most this many approver items. */
const MAX_LISTED_APPROVERS = 90;
const DAY_MS = 86_400_000;

export type Item = Record<string, unknown>;

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const ApproverSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ids"), ids: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("rule"), rule: z.string(), candidates: z.array(z.string()) }).strict(),
]);
const ChangeSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent_publish"), modelContext:z.object({companyRevision:z.number().int().min(0),sourcesRevision:z.number().int().min(0),registeredAt:z.string().datetime(),tupleDigest:Hex64.optional()}).strict().optional(), agentId: AgentIdSchema, draftRevision: z.number().int(), digest: Hex64, expectedCurrentVersion: z.number().int().optional(), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal("agent_rollback"), modelContext:z.object({companyRevision:z.number().int().min(0),sourcesRevision:z.number().int().min(0),registeredAt:z.string().datetime(),tupleDigest:Hex64.optional()}).strict().optional(), agentId: AgentIdSchema, version: z.number().int(), digest: Hex64, expectedCurrentVersion: z.number().int() }).strict(),
  z.object({ kind: z.literal("builtin_adopt"), agentId: AgentIdSchema, version: z.number().int(), digest: Hex64, expectedPinnedVersion: z.number().int() }).strict(),
  z.object({
    kind: z.literal("agent_share"), agentId: AgentIdSchema, expectedSharesRevision: z.number().int(), expectedCurrentVersion: z.number().int().min(0).optional(), versionDigest: Hex64.optional(),
    shares: z.array(z.object({ principal: AgentPrincipalSchema, level: z.enum(["view", "use", "edit"]) }).strict()),
  }).strict(),
  z.object({
    kind: z.literal("agent_publication"), agentId: AgentIdSchema, target: PublishTargetSchema, version: z.number().int().min(1), digest: Hex64, requestId: z.string().uuid(),
    note: AgentPublishNoteSchema.optional(), expectedOwner: AgentOwnerSchema, expectedSharesRevision: z.number().int().min(0),
  }).strict(),
  z.object({kind:z.literal("model_selection_policy"),body:ModelSelectionPolicyPutSchema,sourcesRevision:z.number().int().min(0),guardrailsRevision:z.number().int().min(0)}).strict(),
  z.object({ kind: z.literal("guardrails"), next: AgentGuardrailsSchema, expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("chain_publish"), chainId: ChainIdSchema, draftRevision: z.number().int(), digest: Hex64, expectedCurrentVersion: z.number().int().optional(), note: z.string().optional() }).strict(),
  z.object({ kind: z.literal("chain_rollback"), chainId: ChainIdSchema, version: z.number().int(), digest: Hex64, expectedCurrentVersion: z.number().int() }).strict(),
  z.object({
    kind: z.literal("chain_share"), chainId: ChainIdSchema, expectedSharesRevision: z.number().int(), expectedCurrentVersion: z.number().int().min(0).optional(), versionDigest: Hex64.optional(),
    shares: z.array(z.object({ principal: AgentPrincipalSchema, level: z.enum(["view", "use", "edit"]) }).strict()),
  }).strict(),
  z.object({ kind: z.literal("session_share_org"), sessionId: SessionIdSchema, level: SessionLevelSchema }).strict(),
  z.object({ kind: z.literal("session_owner"), sessionId: SessionIdSchema, to: Hex64, sessionRevision: z.number().int().min(1) }).strict(),
  z.object({
    kind: z.literal("pull_request_merge"), taskId: z.string().uuid(),
    pullRequests: z.array(z.object({ repositoryId: z.string().min(1).max(200), number: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict()).min(1).max(32),
  }).strict(),
  z.object({ kind: z.literal("code_settings"), project: z.string().min(1).max(63), settingsRevision: z.number().int().min(0), changes: z.object({ allowSelfApproval: z.literal(true) }).strict() }).strict(),
  z.object({
    kind: z.literal("agent_run_version"), agentId: AgentIdSchema, version: z.number().int().min(1), digest: Hex64, expectedCurrentVersion: z.number().int().min(1),
    project: z.string(), runRequestId: z.string().uuid(), origin: z.enum(WORK_ORIGINS), input: RunInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("setup_item"), project: z.string().min(1).max(63), draftTaskId: z.string().uuid(), itemId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    itemKind: z.enum(["repository", "devcontainer", "source", "intake", "secret"]), digest: Hex64,
  }).strict(),
  z.object({ kind: z.literal("test_env"), project: z.string().min(1).max(63), digest: Hex64, expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("card_decision"), taskId: z.string().uuid(), cardId: z.string().min(1).max(200), contentVersion: z.string().min(1).max(300), returnPath: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal("known_failing"), project: z.string().min(1).max(63), cause: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), epoch: z.number().int().min(1), recordVersion: z.number().int().min(1), testSetSha256: Hex64 }).strict(),
  z.object({ kind: z.literal("playbook_default_process"), project: z.string().min(1).max(63), agentId: AgentIdSchema, layerVersion: z.number().int().min(1), expectedRevision: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("trigger_enable"), triggerId: TriggerIdSchema, specDigest: Hex64, triggerRevision: z.number().int().min(1) }).strict(),
  z.object({ kind: z.literal("connector_widen"), project: z.string(), name: z.string(), expectedRevision: z.number().int().min(1), connector: ConnectorConfigSchema }).strict(),
  z.object({
    kind: z.literal("opt_out"), project: z.string(), repository: z.string(), expectedDigest: Hex64, files: z.array(z.string()), reason: z.string(),
  }).strict(),
]);
const StatusSchema = z.enum(APPROVAL_STATUSES);
const DecidedShape = {
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  decision: z.enum(["APPROVE", "DECLINE"]).optional(),
  decisionRequestId: z.string().optional(),
  decisionProof: z.unknown().optional(),
  executingAt: z.string().optional(),
  attempts: z.number().int().min(0).optional(),
  failure: z.string().optional(),
  modelRefusal: ModelApplyRefusalSchema.optional(),
  handlerDone: z.boolean().optional(),
  handlerClaimedAt: z.string().optional(),
  handlerDueAt: z.string().optional(),
  handlerTries: z.number().int().min(0).optional(),
  movedBy: z.literal("system").optional(),
  movedAt: z.string().optional(),
  closedBy: z.literal("system").optional(),
  closedReason: z.string().optional(),
  closedAt: z.string().optional(),
  declineReason: z.string().max(1200).optional(),
  withdrawnBy: z.string().optional(),
  withdrawnAt: z.string().optional(),
};
const RunOwnerSchema = z.object({ developerId: z.string(), name: z.string() }).strict();
/** What a stored change record must look like to be read; `passthrough`, so a field a later task adds is kept. */
const ChangeApprovalRecordSchema = z.object({
  orgId: OrgIdSchema,
  approvalId: ApprovalIdSchema,
  kind: z.literal("change"),
  subject: ChangeSubjectSchema,
  changes: z.array(z.string()),
  approvers: ApproverSpecSchema,
  status: StatusSchema,
  requestedBy: z.string(),
  ...DecidedShape,
  createdAt: z.string(),
  expiresAt: z.string(),
}).passthrough();
const StepApprovalRecordSchema = z.object({
  orgId: OrgIdSchema,
  approvalId: ApprovalIdSchema,
  kind: z.literal("step"),
  subject: z.object({ kind: z.string() }).passthrough(),
  prompt: z.string(),
  approvers: ApproverSpecSchema,
  status: StatusSchema,
  project: z.string().optional(),
  owner: RunOwnerSchema.optional(),
  ...DecidedShape,
  createdAt: z.string(),
  expiresAt: z.string(),
}).passthrough();
const WriteApprovalRecordSchema = z.object({
  orgId: OrgIdSchema,
  approvalId: ApprovalIdSchema,
  kind: z.literal("write"),
  subject: z.object({ kind: z.literal("agent_run"), taskId: z.string(), stepId: z.string() }).strict(),
  operationId: z.string(),
  connector: z.string(),
  connectorType: z.string(),
  tool: z.string(),
  toolAccess: z.enum(["read", "write"]),
  scope: z.string(),
  repository: z.string().optional(),
  schemaHash: Hex64,
  projectRevision: z.number().int(),
  credentialRef: z.string().optional(),
  scopeDigest: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  argumentsHash: Hex64,
  summary: z.string(),
  class: z.enum(["consequential", "merge"]),
  approvers: ApproverSpecSchema,
  status: StatusSchema,
  project: z.string(),
  owner: RunOwnerSchema,
  agent: z.object({ agentId: z.string(), name: z.string() }).strict().optional(),
  result: z.object({ status: z.string(), text: z.string(), truncated: z.boolean(), replayed: z.boolean() }).optional(),
  ...DecidedShape,
  createdAt: z.string(),
  expiresAt: z.string(),
}).passthrough();

/** The record of any kind, or undefined when there is none in this org or what is stored is not a record (reported, never handed on). */
export async function getAnyApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, approvalId: ApprovalId): Promise<AnyApprovalRecord | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: approvalKey(orgId, approvalId), ConsistentRead: true })) as { Item?: Item };
  const item = response.Item;
  // Records are looked up by an id the caller names; one that belongs to another org reads as missing.
  if (item === undefined || item["orgId"] !== orgId) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...record } = item;
  const schema = record["kind"] === "write" ? WriteApprovalRecordSchema : record["kind"] === "step" ? StepApprovalRecordSchema : ChangeApprovalRecordSchema;
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    console.error(JSON.stringify({ component: "broker", level: "error", event: "approval_record_invalid", orgId, approvalId, problem: parsed.error.issues[0]?.path.join(".") ?? "record" }));
    return undefined;
  }
  return withReadableOwner(parsed.data as unknown as AnyApprovalRecord);
}

/** A record as it is read: a run owner stored under their email (an approval made before release 0.4.16) is named without it, in every view and refusal built from the record. */
function withReadableOwner(record: AnyApprovalRecord): AnyApprovalRecord {
  if (record.kind === "change" || record.owner === undefined) return record;
  const name = safeDisplayName(record.owner.name, record.owner.developerId);
  return name === record.owner.name ? record : { ...record, owner: { ...record.owner, name } };
}

/** The change record, or undefined when there is none in this org, what is stored is not a record, or it is a step or a write (those are read with `getAnyApproval`). */
export async function getApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, approvalId: ApprovalId): Promise<ApprovalRecord | undefined> {
  const record = await getAnyApproval(deps, orgId, approvalId);
  return record?.kind === "change" ? record : undefined;
}

const namedPeople = (approvers: ApproverSpec): string[] => (approvers.kind === "ids" ? [...approvers.ids] : [...approvers.candidates]);
/**
 * The people a change is listed for, cut to what a transaction holds. The cut never drops the first person named (the agent's owner, who the member
 * movers find the approval through) or the person who asked; the rest are kept in id order.
 */
function listedPeople(approvers: ApproverSpec, requestedBy?: string): string[] {
  const named = [...new Set(namedPeople(approvers))];
  const first = [...new Set([named[0], requestedBy !== undefined && named.includes(requestedBy) ? requestedBy : undefined].filter((id): id is string => id !== undefined))];
  const rest = named.filter((id) => !first.includes(id)).sort();
  return [...first, ...rest].slice(0, MAX_LISTED_APPROVERS);
}
/** A step or write approval's transaction also holds its counter, its open item, its event and its audit item, so it lists fewer people. */
const MAX_LISTED_RUN_APPROVERS = 88;

/**
 * The people whose `APPROVER#` items a record has: for a step or a write the run's owner first (so the member movers find it), then the people named,
 * cut to what a transaction can hold. Creating the record writes them; ending PENDING deletes the same ones.
 */
export function listedFor(record: { kind: AnyApprovalRecord["kind"]; approvers: ApproverSpec; owner?: { developerId: string } | undefined }): string[] {
  if (record.kind === "change") return listedPeople(record.approvers, (record as { requestedBy?: string }).requestedBy);
  const owner = record.owner?.developerId;
  const rest = [...new Set(namedPeople(record.approvers))].filter((id) => id !== owner).sort();
  return (owner === undefined ? rest : [owner, ...rest]).slice(0, MAX_LISTED_RUN_APPROVERS);
}

/** When an approver item (or a step counter) may be deleted by the table's TTL if nothing else removed it: a day after the approval would have expired. */
export const indexExpiryOf = (expiresAt: string): number => Math.floor(Date.parse(expiresAt) / 1000) + 86_400;

/** The change a person's request made (a pending record), or undefined when that request made none: how a route tells a repeat from a new request. */
export function pendingChangeFor(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, requestedBy: string, requestId: string): Promise<ApprovalRecord | undefined> {
  return getApproval(deps, orgId, approvalIdFor(orgId, requestedBy, requestId));
}

/** The same request always names the same approval, so a replay finds the record it made (R18). */
export function approvalIdFor(orgId: OrgId, requestedBy: string, requestId: string): ApprovalId {
  return newPrefixedId("apr", () => createHash("sha256").update(`${orgId}|${requestedBy}|${requestId}`, "utf8").digest());
}

/**
 * Records a change that waits for a person and applies nothing. The id comes from the request, so a replay of the same request
 * returns the record it made (another change under that request id is `CONFIG_INVALID`, as on the routes that apply at once). A rule or subject kind nobody
 * registered is refused here (`CONFIG_INVALID`), so no record is made that no one could ever decide.
 */
export async function createPendingChange(
  deps: ApprovalStoreDependencies & Pick<ApprovalDependencies, "audit">,
  input: {
    orgId: OrgId; requestId: string; requestedBy: string; subject: ChangeSubject; changes: string[]; approvers: ApproverSpec; expiresAt?: string;
    /** Items written in the same transaction as the record (an index the subject keeps), built from the record; and audit events written with it. */
    extra?: (record: ApprovalRecord) => { items: TransactItem[]; events: AuditEventInput[] };
  },
): Promise<ApprovalRecord> {
  if (input.approvers.kind === "rule" && getApproverRule(input.approvers.rule) === undefined) {
    throw agentXError("CONFIG_INVALID", `no one can decide this: the rule "${input.approvers.rule}" is not registered`);
  }
  if (getApprovalSubjectHandler(input.subject.kind) === undefined) {
    throw agentXError("CONFIG_INVALID", `no one can decide this: nothing is registered to apply a "${input.subject.kind}" change`);
  }
  const approvalId = approvalIdFor(input.orgId, input.requestedBy, input.requestId);
  const replay = async (): Promise<ApprovalRecord | undefined> => {
    const existing = await getApproval(deps, input.orgId, approvalId);
    if (existing === undefined) return undefined;
    if (canonicalJson(existing.subject) !== canonicalJson(input.subject)) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    return existing;
  };
  const before = await replay();
  if (before !== undefined) return before;

  const createdAt = new Date(deps.now()).toISOString();
  const expiresAt = input.expiresAt ?? new Date(deps.now() + CHANGE_APPROVAL_TTL_DAYS * DAY_MS).toISOString();
  const record: ApprovalRecord = {
    orgId: input.orgId, approvalId, kind: "change", subject: input.subject, changes: input.changes, approvers: input.approvers,
    status: "PENDING", requestedBy: input.requestedBy, createdAt, expiresAt,
  };
  const put = (key: { pk: string; sk: string }, entityType: string, fields: Item) => ({
    Put: { TableName: deps.tableName, Item: { ...key, entityType, ...fields }, ConditionExpression: "attribute_not_exists(pk)" },
  });
  const extra = input.extra?.(record) ?? { items: [], events: [] };
  try {
    await deps.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        put(approvalKey(input.orgId, approvalId), "APPROVAL", record as unknown as Item),
        put(openApprovalKey(expiresAt, input.orgId, approvalId), "OPEN_APPROVAL", { orgId: input.orgId, approvalId }),
        ...listedPeople(input.approvers, input.requestedBy).map((developerId) => put(approverIndexKey(input.orgId, developerId, approvalId), "APPROVER_INDEX", { approvalId, expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: indexExpiryOf(expiresAt) })),
        ...extra.items,
        put(orgOpenApprovalKey(input.orgId, createdAt, approvalId), "ORG_OPEN_APPROVAL", orgOpenFields(record)),
        ...extra.events.flatMap((event) => auditPending(deps, event)),
      ],
    }));
  } catch (error) {
    // Two copies of one request racing: the one that lost returns what the winner wrote.
    const raced = error instanceof Error && error.name === "TransactionCanceledException" ? await replay() : undefined;
    if (raced === undefined) throw error;
    return raced;
  }
  await flushAuditEvents(deps, extra.events);
  return record;
}

// ---------------------------------------------------------------------------------------------
// Task 21: step and write approvals, deciding, the sweep, and the member movers
// ---------------------------------------------------------------------------------------------
//
// One state machine for every kind. A decision claims the record with ONE conditional transaction (`PENDING` to its next state, the audit item, the
// open-index items and the step's counter in it). What comes after the claim is repeatable and found again by the sweep:
//   - a change or a write that is approved goes `EXECUTING` (applying it, or running the call, is the work), then ends `APPROVED_DONE` or
//     `APPROVED_FAILED`; a crash leaves it `EXECUTING` with `executingAt`, and the sweep drives it again after APPROVAL_EXECUTING_RETRY_MINUTES;
//   - a step that is approved ends `APPROVED`, a decline ends `DECLINED`, an expiry ends `EXPIRED`; for a step or a write the subject's handler then
//     hears the outcome (`handlerDone` says whether it did), and a handler that did not hear is called again by the sweep.
// Every follow-up has a due item in the OPEN_APPROVALS index (`<due time>#<org>#<id>`), written in the transaction that makes it owed.

export type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

export const RETRY_MS = APPROVAL_EXECUTING_RETRY_MINUTES * 60_000;
/** A run of a write approval is driven at most this many times; after that it ends `APPROVED_FAILED`. */
export const MAX_APPROVAL_ATTEMPTS = 5;
export const PAGE_LIMIT = 100;
export const iso = (ms: number): string => new Date(ms).toISOString();
export const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
export const DUE_SK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)#(org_[0-9a-z]{20})#(apr_[0-9a-z]{20})$/;

const stepCounterKey = (orgId: OrgId, taskId: string, stepId: string) => ({ pk: orgScoped(orgId, `STEP_APPROVALS#${taskId}`), sk: stepId });
/** The task event a write approval leaves (Task 22's task view reads `DEVTASK#<task>` items whose sort key starts `EVENT#`; a task partition is global, so a reader re-checks `orgId`). */
export const approvalTaskEventKey = (taskId: string, at: string, approvalId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `EVENT#${at}#${approvalId}` });

export const log = (deps: Pick<ApprovalDependencies, "log">, event: string, fields: Record<string, unknown>): void =>
  (deps.log ?? ((name, detail) => console.log(JSON.stringify({ component: "broker", event: name, ...detail }))))(event, fields);

export const stripCode = (error: { message: string; code?: string }): string => (error.code !== undefined && error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message);

/** Words an agent or a vendor supplied, made safe to show: no control or format characters, secrets redacted, no email address (S3), cut to `max`. */
export function shownText(text: string, max: number): string {
  const cleaned = hideEmailAddresses(redactText(text)).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return capText(cleaned, max).text;
}

/**
 * A person's name as other people read it in an approval text: the name without any address in it, or their placeholder when nothing else is left (`safeDisplayName`), then cleaned like any text.
 * Not `shownText` alone: a name that is only an address would read "[email removed]" (S3-L3).
 */
export function shownPersonName(person: { developerId: string; name: string }, max: number): string {
  return shownText(safeDisplayName(person.name, person.developerId), max);
}

/** `reason` (agent publish requests, experience decision 24): the decliner's words for the person who asked; plain text up to 300 characters, and only with DECLINE. */
const DecideBodySchema = z.object({ requestId: z.string().uuid(), decision: z.enum(["APPROVE", "DECLINE"]), reason: AgentPublishNoteSchema.optional() }).strict();
export type DecideBody = z.infer<typeof DecideBodySchema>;

export function parseDecideBody(body: unknown): DecideBody {
  const parsed = DecideBodySchema.safeParse(body);
  if (parsed.success) {
    if (parsed.data.reason !== undefined && parsed.data.decision !== "DECLINE") throw agentXError("CONFIG_INVALID", "reason: only a decline takes a reason");
    const reason = parsed.data.reason?.trim();
    return { requestId: parsed.data.requestId, decision: parsed.data.decision, ...(reason === undefined || reason === "" ? {} : { reason }) };
  }
  const issue = parsed.error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
  throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
}

export const hasHandlerPhase = (record: AnyApprovalRecord): boolean => record.kind !== "change";

// ---- who and what a record is about

export interface ApprovalRunView { project: string; owner: { developerId: string; name: string } }

/** The task a write or step approval is about, read live; undefined when the record names none, it is gone, or it belongs to another org. */
export async function taskOfApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, record: StepApprovalRecord | WriteApprovalRecord): Promise<DeveloperTaskRecord | undefined> {
  const taskId = (record.subject as { taskId?: unknown }).taskId;
  if (typeof taskId !== "string") return undefined;
  let response: { Item?: DeveloperTaskRecord };
  try {
    response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `DEVTASK#${taskId}`, sk: "META" }, ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
  } catch {
    // Who owns the task decides who may decide, so a read that failed answers nobody's yes: it is a transient fault to retry, never a refusal of the person (12a review M-5).
    throw agentXError("RUNTIME_UNAVAILABLE", "Rovara couldn't read the task just now. Try again in a moment.");
  }
  return response.Item?.orgId === record.orgId ? response.Item : undefined;
}

/**
 * The person a write or step approval is about, read live: the task's effective owner (Plan 5 Task 12a) when someone took the task over, since the person who took it
 * over decides what it does, and otherwise the owner the record stored (a task nobody took over, a task that is gone); the stored one stays as history. A step the
 * creator didn't annotate takes its owner from the task. Undefined when the task was taken over and its owner can't be read: nobody is the owner then.
 */
function ownerOfRun(task: DeveloperTaskRecord | undefined, stored: ApprovalRunView["owner"] | undefined): ApprovalRunView["owner"] | undefined {
  if (task === undefined) return stored;
  if (stored !== undefined && !isTaskTakenOver(task)) return stored;
  const owner = tryEffectiveTaskOwner(task);
  return owner === undefined ? undefined : { developerId: owner.developerId, name: owner.name };
}

/**
 * The project and the person a write or step approval is about. A step the creator didn't annotate takes them from its task; a task someone took over names its
 * taker (`ownerOfRun`). Undefined when they can't be told (a change record, a chain gate without them): a rule that needs them then refuses.
 */
export async function runOfApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, record: AnyApprovalRecord): Promise<ApprovalRunView | undefined> {
  const run = await storedRunOfApproval(deps, record);
  // ERASE-NAME-2: the owner's name was stored with the task or the approval; an erased person reads "A former member", a removed one never the name they chose.
  return run === undefined ? undefined : { ...run, owner: { ...run.owner, name: await resolveStoredName({ documentClient: deps.documentClient, tableName: deps.tableName, orgId: record.orgId }, run.owner.developerId, run.owner.name) } };
}

async function storedRunOfApproval(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, record: AnyApprovalRecord): Promise<ApprovalRunView | undefined> {
  if (record.kind === "write") {
    const owner = ownerOfRun(await taskOfApproval(deps, record), record.owner);
    return owner === undefined ? undefined : { project: record.project, owner };
  }
  if (record.kind !== "step") return undefined;
  if (record.subject.kind !== "agent_run") return record.project !== undefined && record.owner !== undefined ? { project: record.project, owner: record.owner } : undefined;
  const task = await taskOfApproval(deps, record);
  const owner = ownerOfRun(task, record.owner);
  const project = record.project ?? (typeof task?.project === "string" ? task.project : undefined);
  return project === undefined || owner === undefined ? undefined : { project, owner };
}

/** What the person who can't decide is told; `ownerName` is the run's owner as `runOfApproval` names them now. */
export function forbiddenText(record: AnyApprovalRecord, ownerName?: string): string {
  return record.kind === "write" ? `Only ${ownerName ?? record.owner.name} or a project maintainer can decide this.` : "You can't decide this.";
}

/** Whether `caller` may decide `record` now: the registered rule says yes, or they are listed and still hold `start_tasks` on the project. Everything is read live. */
export async function mayDecideApproval(deps: ApprovalDependencies, caller: ApprovalCaller, record: AnyApprovalRecord): Promise<boolean> {
  const spec = record.approvers;
  if (spec.kind === "rule") {
    const rule = getApproverRule(spec.rule);
    return rule !== undefined && await rule(deps, record, caller);
  }
  let listed = false;
  for (const id of spec.ids) {
    if (await sameMember(deps, record.orgId, id, caller.developerId)) { listed = true; break; }
  }
  if (!listed) return false;
  // A change record names no project: being listed is all its id list asks. A step or write whose run can't be told is refused (fail closed).
  if (record.kind === "change") return true;
  const run = await runOfApproval(deps, record);
  if (run === undefined) return false;
  const orgRole = await orgRoleOf(deps, record.orgId, caller.developerId);
  if (orgRole === undefined) return false;
  const role = await deps.projectMembers.roleOf(record.orgId, run.project, { developerId: await resolveMember(deps, record.orgId, caller.developerId), orgRole });
  return role !== undefined && projectAllows(role, "start_tasks");
}

// ---- creating step and write records

/** The id a seed always makes: the same seed in the same org is the same approval, so a repeat finds the record it made. */
export function approvalIdFromSeed(orgId: OrgId, seed: string): ApprovalId {
  return newPrefixedId("apr", () => createHash("sha256").update(`${orgId}|${seed}`, "utf8").digest());
}

type NewRecord = StepApprovalRecord | WriteApprovalRecord;
type CreateDependencies = ApprovalStoreDependencies & Pick<ApprovalDependencies, "audit" | "log">;

/** Refuses (`CONFIG_INVALID`) approvers that name a rule nobody registered: no record is made that no one could decide. */
export function requireRegisteredApprovers(approvers: ApproverSpec): void {
  if (approvers.kind === "rule" && getApproverRule(approvers.rule) === undefined) {
    throw agentXError("CONFIG_INVALID", `no one can decide this: the rule "${approvers.rule}" is not registered`);
  }
}

/**
 * Writes a new record with its open index item, its approver items, the step's counter (a write approval only: refused when `max` are already pending)
 * and `extraItems`, in ONE transaction. Answers `exists` when the id is taken (the caller reads it) and `full` when the step has no room.
 */
async function createRecord(
  deps: CreateDependencies,
  input: { record: NewRecord; counter?: { taskId: string; stepId: string; max: number }; extraItems?: TransactItem[]; claimIndex?: number; guardIndex?: number },
): Promise<"created" | "exists" | "full" | "claimed" | "ended"> {
  const { record } = input;
  const listed = listedFor(record);
  const named = new Set(namedPeople(record.approvers));
  if (named.size > listed.length) log(deps, "approval.candidates_capped", { orgId: record.orgId, approvalId: record.approvalId, listed: listed.length, named: named.size });
  const events = await tryAuditEvents(deps, () => [auditApprovalRequested({
    orgId: record.orgId, actor: auditActorOf("system"), occurredAt: record.createdAt, occurrence: record.approvalId, approvalId: record.approvalId, kind: record.kind, subjectKind: record.subject.kind,
    ...(record.kind === "write" ? { class: record.class, connectorType: record.connectorType, tool: record.tool, argumentsHash: record.argumentsHash } : {}),
    ...(record.owner === undefined ? {} : { related: [record.owner.developerId] }),
  })]);
  const items: TransactItem[] = [];
  if (input.counter !== undefined) {
    items.push({
      Update: {
        TableName: deps.tableName, Key: stepCounterKey(record.orgId, input.counter.taskId, input.counter.stepId),
        UpdateExpression: "ADD #pending :one SET #ttl = :ttl", ConditionExpression: "attribute_not_exists(#pending) OR #pending < :max",
        ExpressionAttributeNames: { "#pending": "pending", "#ttl": INDEX_EXPIRY_ATTRIBUTE }, ExpressionAttributeValues: { ":one": 1, ":max": input.counter.max, ":ttl": indexExpiryOf(record.expiresAt) },
      },
    });
  }
  const offset = items.length;
  items.push(
    { Put: { TableName: deps.tableName, Item: { ...approvalKey(record.orgId, record.approvalId), entityType: "APPROVAL", ...record }, ConditionExpression: "attribute_not_exists(pk)" } },
    { Put: { TableName: deps.tableName, Item: { ...openApprovalKey(record.expiresAt, record.orgId, record.approvalId), entityType: "OPEN_APPROVAL", orgId: record.orgId, approvalId: record.approvalId } } },
    ...listed.map((developerId): TransactItem => ({
      Put: { TableName: deps.tableName, Item: { ...approverIndexKey(record.orgId, developerId, record.approvalId), entityType: "APPROVER_INDEX", approvalId: record.approvalId, expiresAt: record.expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: indexExpiryOf(record.expiresAt) } },
    })),
    ...(input.extraItems ?? []),
    // After the extra items, so `claimIndex` and `guardIndex` still point at theirs in the cancellation reasons.
    { Put: { TableName: deps.tableName, Item: { ...orgOpenApprovalKey(record.orgId, record.createdAt, record.approvalId), entityType: "ORG_OPEN_APPROVAL", ...orgOpenFields(record) } } },
    ...events.flatMap((event) => auditPending(deps, event)),
  );
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (errorNameOf(error) !== "TransactionCanceledException") throw error;
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
    if (reasons?.[offset]?.Code === "ConditionalCheckFailed") return "exists";
    // The extra item at `claimIndex` is a conditional claim of something else (the call's request id): it was already taken, and nothing was made.
    if (input.claimIndex !== undefined && reasons?.[offset + 2 + listed.length + input.claimIndex]?.Code === "ConditionalCheckFailed") return "claimed";
    // The extra item at `guardIndex` is a condition on the operation that asked: it had ended, so nothing was made (Task 22 review, M2).
    if (input.guardIndex !== undefined && reasons?.[offset + 2 + listed.length + input.guardIndex]?.Code === "ConditionalCheckFailed") return "ended";
    if (offset === 1 && reasons?.[0]?.Code === "ConditionalCheckFailed") return "full";
    throw error;
  }
  await flushAuditEvents(deps, events);
  return "created";
}

/** Creates a write approval's record (Task 21's `decideWrite` calls this); see `createRecord`. */
export async function createWriteApprovalRecord(
  deps: CreateDependencies,
  record: WriteApprovalRecord,
  extraItems: TransactItem[],
  max: number,
  claimIndex?: number,
  guardIndex?: number,
): Promise<"created" | "exists" | "full" | "claimed" | "ended"> {
  return createRecord(deps, { record, counter: { taskId: record.subject.taskId, stepId: record.subject.stepId, max }, extraItems, ...(claimIndex === undefined ? {} : { claimIndex }), ...(guardIndex === undefined ? {} : { guardIndex }) });
}

/** How many write approvals of a step are PENDING by the step's counter (Task 21 keeps it in the transaction that makes and that decides each); 0 when it has none. */
export async function pendingWriteApprovals(deps: Pick<ApprovalStoreDependencies, "documentClient" | "tableName">, orgId: OrgId, taskId: string, stepId: string): Promise<number> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: stepCounterKey(orgId, taskId, stepId), ConsistentRead: true })) as { Item?: { pending?: unknown } };
  return typeof response.Item?.pending === "number" ? Math.max(0, response.Item.pending) : 0;
}

/**
 * Records a step of a run that waits for a person (an `approval` step of an agent, or a chain gate), PENDING and listed for its candidates. The id comes
 * from the subject, so asking again for the same step returns the record already made. A rule or subject kind nobody registered is refused
 * (`CONFIG_INVALID`), so no record is made that no one could decide. `expiresAt` defaults to the write approval TTL from now.
 */
export async function createStepApproval(
  deps: CreateDependencies,
  input: { orgId: OrgId; subject: ApprovalSubject; prompt: string; approvers: ApproverSpec; expiresAt?: string; project?: string; owner?: { developerId: string; name: string } },
): Promise<StepApprovalRecord> {
  if (input.prompt.length < 1 || input.prompt.length > 300 || /[\p{Cc}\p{Cf}]/u.test(input.prompt)) throw agentXError("CONFIG_INVALID", "prompt: must be 1 to 300 characters of plain text");
  requireRegisteredApprovers(input.approvers);
  // Who may decide an id list is judged by their role on the run's project now, so the step has to say which project and whose run it is.
  if (input.approvers.kind === "ids" && (input.project === undefined || input.owner === undefined)) throw agentXError("CONFIG_INVALID", "project and owner: an approval that names people also names the project and the run's owner");
  if (getApprovalSubjectHandler(input.subject.kind) === undefined) throw agentXError("CONFIG_INVALID", `no one can decide this: nothing is registered to continue a "${input.subject.kind}" step`);
  let expiresAt: string;
  try {
    expiresAt = input.expiresAt === undefined ? iso(deps.now() + WRITE_APPROVAL_TTL_MS) : iso(Date.parse(canonicalInstant(input.expiresAt)));
  } catch {
    throw agentXError("CONFIG_INVALID", "expiresAt: not a time");
  }
  const approvalId = approvalIdFromSeed(input.orgId, `step|${canonicalJson(input.subject)}`);
  const record: StepApprovalRecord = {
    orgId: input.orgId, approvalId, kind: "step", subject: input.subject, prompt: input.prompt, approvers: input.approvers, status: "PENDING",
    ...(input.project === undefined ? {} : { project: input.project }), ...(input.owner === undefined ? {} : { owner: input.owner }),
    attempts: 0, createdAt: iso(deps.now()), expiresAt,
  };
  const made = await createRecord(deps, { record });
  if (made === "created") return record;
  const existing = await getAnyApproval(deps, input.orgId, approvalId);
  if (existing?.kind !== "step") throw agentXError("CONFIG_INVALID", "this step already has an approval of another kind");
  return existing;
}

// ---- listing

/** Every record of `status` (default PENDING) that lists `caller` as an approver, a candidate or the run's owner, newest first. A record that ended PENDING no longer has an item in anyone's list, so only PENDING is listed. */
export async function listApprovalsFor(deps: ApprovalDependencies, caller: ApprovalCaller, status: ApprovalStatus = "PENDING"): Promise<AnyApprovalRecord[]> {
  const found: AnyApprovalRecord[] = [];
  let start: Record<string, unknown> | undefined;
  for (let pages = 0; pages < 5; pages += 1) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": approverIndexKey(caller.orgId, caller.developerId, "apr_00000000000000000000").pk },
      ConsistentRead: true, Limit: PAGE_LIMIT, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ approvalId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = ApprovalIdSchema.safeParse(item.approvalId);
      if (!parsed.success) continue;
      const record = await getAnyApproval(deps, caller.orgId, parsed.data);
      if (record?.status === status) found.push(record);
    }
    start = page.LastEvaluatedKey;
    if (start === undefined) break;
  }
  return found.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

const dueItem = (deps: Pick<ApprovalStoreDependencies, "tableName">, orgId: OrgId, approvalId: ApprovalId, at: string): TransactItem => ({
  Put: { TableName: deps.tableName, Item: { ...openApprovalKey(at, orgId, approvalId), entityType: "OPEN_APPROVAL", orgId, approvalId } },
});
export const dropItem = (deps: Pick<ApprovalStoreDependencies, "tableName">, orgId: OrgId, approvalId: ApprovalId, at: string): TransactItem => ({
  Delete: { TableName: deps.tableName, Key: openApprovalKey(at, orgId, approvalId) },
});
/** Drops the due items at `drop` and puts one at `put` (never both on one key: a transaction can't hold two operations on an item). */
export const dueItems = (deps: Pick<ApprovalStoreDependencies, "tableName">, record: AnyApprovalRecord, drop: readonly string[], put: string | undefined): TransactItem[] => [
  ...[...new Set(drop)].filter((at) => at !== put).map((at) => dropItem(deps, record.orgId, record.approvalId, at)),
  ...(put === undefined ? [] : [dueItem(deps, record.orgId, record.approvalId, put)]),
];
export const counterDrop = (deps: Pick<ApprovalStoreDependencies, "tableName">, record: AnyApprovalRecord): TransactItem[] => (record.kind === "write"
  ? [{
    Update: {
      TableName: deps.tableName, Key: stepCounterKey(record.orgId, record.subject.taskId, record.subject.stepId),
      UpdateExpression: "SET #pending = if_not_exists(#pending, :one) - :one", ExpressionAttributeNames: { "#pending": "pending" }, ExpressionAttributeValues: { ":one": 1 },
    },
  }]
  : []);

/**
 * Deletes what lists the record while it is PENDING: its `APPROVER#` items and its item in the company's open index (`orgOpenApprovalKey`). Once it is no longer PENDING nobody's list holds it
 * (done in the transaction that ends PENDING: decide, expire, withdraw, cancel). Deleting the company item of a record that has none (made before 0.5.15 and not yet backfilled) is a no-op.
 */
export const approverDrops = (deps: Pick<ApprovalStoreDependencies, "tableName">, record: AnyApprovalRecord): TransactItem[] => [
  ...listedFor(record).map((developerId): TransactItem => ({
    Delete: { TableName: deps.tableName, Key: approverIndexKey(record.orgId, developerId, record.approvalId) },
  })),
  { Delete: { TableName: deps.tableName, Key: orgOpenApprovalKey(record.orgId, record.createdAt, record.approvalId) } },
];

/** What a company's open-index item holds: the ids, the org and the record's expiry (no person), with the index TTL as a backstop for an item whose delete was lost. */
export const orgOpenFields = (record: { orgId: OrgId; approvalId: ApprovalId; expiresAt: string }): Item => ({
  orgId: record.orgId, approvalId: record.approvalId, expiresAt: record.expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: indexExpiryOf(record.expiresAt),
});

/** An update of the record's fields, conditional on `when` (an expression over the aliases); undefined values are left out. */
export function updateRecord(deps: Pick<ApprovalStoreDependencies, "tableName">, record: AnyApprovalRecord, set: Record<string, unknown>, when: Array<[attribute: string, value: unknown]> | "pending", openAt?: string): TransactItem {
  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  Object.entries(set).filter(([, value]) => value !== undefined).forEach(([name, value], index) => {
    names[`#f${String(index)}`] = name;
    values[`:f${String(index)}`] = value;
    sets.push(`#f${String(index)} = :f${String(index)}`);
  });
  const conditions: string[] = [];
  if (when === "pending") {
    conditions.push("#status = :pending");
    values[":pending"] = "PENDING";
    // A decision's claim also needs the approval to be unexpired at that moment (ISO times compare as text), so it and the sweep's expiry can't both win across the boundary.
    if (openAt !== undefined) {
      conditions.push("#expiresAt > :openAt");
      names["#expiresAt"] = "expiresAt";
      values[":openAt"] = openAt;
    }
  } else {
    when.forEach(([attribute, value], index) => {
      const alias = attribute === "status" ? "#status" : `#w${String(index)}`;
      if (attribute !== "status") names[`#w${String(index)}`] = attribute;
      conditions.push(`${alias} = :w${String(index)}`);
      values[`:w${String(index)}`] = value;
    });
  }
  return {
    Update: {
      TableName: deps.tableName, Key: approvalKey(record.orgId, record.approvalId), UpdateExpression: `SET ${sets.join(", ")}`, ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names, ExpressionAttributeValues: values,
    },
  };
}

/** Sends a transaction; false when the record's own condition (item `at`) failed, i.e. someone else changed it first. */
export async function commitOrLost(deps: ApprovalStoreDependencies, items: TransactItem[], at = 0): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (errorNameOf(error) !== "TransactionCanceledException") throw error;
    const reasons = (error as { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
    if (reasons?.[at]?.Code === "ConditionalCheckFailed") return false;
    throw error;
  }
}

export const withFields = <T extends AnyApprovalRecord>(record: T, fields: Record<string, unknown>): T => ({ ...record, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) });
