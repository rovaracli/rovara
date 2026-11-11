// The audit ledger's event catalog: every action it records, the shape of a record before the appender
// seals it, and the limits and error codes the writers and readers share. A record holds ids, pseudonyms
// and a few fixed-vocabulary or numeric facts; names, emails and reasons belong in `details` only.
import { sha256Hex } from "@rovara/audit-verifier";
import { z } from "zod";
import {StageIdSchema,ModelFallbackReasonCodeSchema} from "./stage-model-shared.js";
import { OrgIdSchema } from "./org.js";

// The writers (the appender) and readers of the chain use the verifier's own record, commitment and JSON functions,
// so what is written is by construction what an auditor recomputes.
export {
  AUDIT_LIMITS_COPY,
  buildTimeStampRequest,
  canonicalJson as auditCanonicalJson,
  checkChain,
  defaultAnchors,
  detailCommit,
  genesisHash,
  inclusionPath,
  merkleRoot,
  parseTimeStampResponse,
  recordHash,
  recordLeafData,
  sealHash,
  sealLeafData,
  statementHash,
  TIMESTAMP_SKEW_MS,
  timestampCoversRecord,
  verifyBundle,
  verifyTimeStampToken,
  type AuditBundleV1,
  type AuditRecordV1,
  type BundleDetail,
  type BundleReport,
  type BundleSeal,
  type BundleTimestamp,
  type EpochStatementV1,
  type LockedObjectV1,
  type OrgSealV1,
  type TimestampProblem,
  type TimestampVerdict,
} from "@rovara/audit-verifier";

export const AUDIT_SEAL_INTERVAL_MINUTES = 15;
export const AUDIT_RETENTION_DAYS_DEFAULT = 1096;
export const AUDIT_RETENTION_DAYS_MIN_COMPLIANCE = 365;
export const AUDIT_GOVERNANCE_RETENTION_DAYS = 1;

export const AUDIT_MAX_RELATED = 8;
export const AUDIT_MAX_FACTS = 12;
export const AUDIT_FACT_MAX_CHARS = 128;
export const AUDIT_DETAIL_PARTS_MAX = 4;
export const AUDIT_DETAIL_FIELDS_MAX = 10;
export const AUDIT_DETAIL_FIELD_MAX_CHARS = 500;

export const AUDIT_FLUSH_DEADLINE_MS = 1500;
export const AUDIT_SDK_REQUEST_TIMEOUT_MS = 800;
export const AUDIT_PENDING_SHARDS = 10;
export const AUDIT_PENDING_TTL_DAYS = 14;
export const AUDIT_PENDING_FAIL_AFTER_DAYS = 13;
export const AUDIT_INTAKE_MAX_RECEIVES = 5;

export const AUDIT_MAX_RECORDS_PER_ORG_EPOCH = 10000;
export const AUDIT_BACKSTOP_SEAL_AGE_MINUTES = 60;
export const AUDIT_VERSION_SWEEP_KEYS_PER_RUN = 200;

export const AUDIT_TSA_TIMEOUT_MS = 10000;
export const AUDIT_TSA_SPACING_MS = 15000;
export const AUDIT_TSA_ENDPOINTS = {
  digicert: "http://timestamp.digicert.com",
  sectigo: "http://timestamp.sectigo.com",
} as const;

export const AUDIT_EXPORT_MAX_RECORDS = 200000;
export const AUDIT_EXPORT_URL_SECONDS = 900;
/** How long the exports bucket keeps a file (its lifecycle rule), and how long an export is offered: a day less, so a link is never made for a file the bucket may already have removed. */
export const AUDIT_EXPORT_FILE_LIFECYCLE_DAYS = 7;
export const AUDIT_EXPORT_AVAILABLE_DAYS = AUDIT_EXPORT_FILE_LIFECYCLE_DAYS - 1;
/**
 * The export function's asynchronous-invoke limits and timeout. The platform may start an attempt up to the event age after the
 * request and let it run the timeout, so an export still `running` after both is lost: its view says failed and no later attempt
 * is allowed to make it ready (the worker refuses an attempt older than the event age).
 */
export const AUDIT_EXPORT_RETRY_ATTEMPTS = 1;
export const AUDIT_EXPORT_MAX_EVENT_AGE_SECONDS = 1800;
export const AUDIT_EXPORT_TIMEOUT_SECONDS = 900;
export const AUDIT_FILTER_SCAN_MAX = 20000;

export const AUDIT_DETAILS_SHRED_AFTER_CLOSE_DAYS = 30;
export const AUDIT_TRANSIENT_COPY_DAYS = 35;

/** The ledger's error codes (also members of `AgentXErrorCodeSchema`) and the text each one shows. */
export const AUDIT_ERROR_MESSAGES = {
  AUDIT_RANGE_INVALID: "Choose a range of at most 200,000 records, with from before to.",
  AUDIT_REASON_REQUIRED: "Say why you are reading this company's audit log (1 to 300 characters).",
  AUDIT_UNAVAILABLE: "Rovara couldn't record this read, so it didn't read anything. Try again in a minute.",
  AUDIT_FILTER_TOO_WIDE: "That filter covers too many records. Narrow the time range to under 20,000 records.",
} as const;

export const AUDIT_ACTIONS = [
  "approval.decided",
  "approval.expired",
  "approval.requested",
  "approval.rerouted",
  "write.executed",
  "spend_request.created",
  "spend_request.decided",
  "spend_request.expired",
  "spend_request.escalated",
  "spend_request.rerouted",
  "spend_request.resume_dropped",
  "budget.changed",
  "spend_policy.changed",
  "spending.stop_admitted", "spending.stop_refused", "spending.stop_reached", "spending.stop_exempted",
  "spending.policy_seeded",
  "spending.enrollment_changed",
  "spending.policy_changed", "spending.policy_change_requested", "spending.policy_change_decided",
  "pull_request.opened",
  "pull_request.merged",
  "pull_request.merge_requested",
  "member.joined",
  "member.role_changed",
  "member.removed",
  "member.removal_completed",
  "member.left",
  "member.renamed",
  "org.closed",
  "org.renamed",
  "org.invite_created",
  "org.invite_revoked",
  // Lane B: reviewed project archive.
  "project.archived",
  "project.restored",
  "project.working_branch_changed",
  "project.allowed_domains_proposed",
  "project.allowed_domains_rejected",
  "project.allowed_domains_cancelled",
  "project.allowed_domains_changed",
  "project_member.changed",
  "project_member.removed",
  "slack_channel.proposed",
  "slack_channel.cancelled",
  "slack_channel.rejected",
  "slack_channel.bound",
  "slack_channel.unbound",
  "slack_team.connected",
  "slack_team.disconnected",
  "identity.linked",
  "identity.unlinked",
  "agent.owner_changed",
  "chain.owner_changed",
  "session.owner_changed",
  "session.stopped",
  "session.retried",
  "session.shared",
  "session.linked",
  "session.unlinked",
  "connection.saved",
  // The Jira organization admin key (and organization id) was set or cleared on a Jira connection. The fact is "set" or "cleared"; the key and the id never go in.
  "connection.jira_org_admin_changed",
  "connection.removed",
  "project_connector.changed",
  "guardrails.changed",
  "local_agents.policy_changed",
  "code_settings.changed",
  "comment_trigger_opt_out.applied",
  "comment_trigger_opt_out.lapsed",
  "egress_domain.decided",
  "agent.published",
  "agent.rolled_back",
  "builtin.adopted",
  "chain.published",
  "chain.rolled_back",
  "trigger.enabled",
  "trigger.disabled",
  "github.connected",
  "github.disconnected",
  "github.installation_changed",
  "model_source.saved",
  "model_source.removed",
  "model_source.order_changed",
  "model_policy.changed",
  "model_policy.lock_set",
  "model_policy.lock_removed",
  "model.fallback_used",
  "audit.read",
  "audit.exported",
  "audit.staff_read",
  "audit.subject_erased",
  "audit.org_shred_scheduled",
  // "How we work" playbook: one block, so a merge with another branch's additions stays easy.
  "project.models_changed",
  "project.checks_changed",
  "project.e2e_policy_changed",
  "project.model_selection_changed",
  "project.roster_changed",
  "process.published",
  "process.rolled_back",
  "playbook.default_process_changed",
  // Design review stage (DR8): a maintainer changed the project's design review setting in How we work.
  "playbook.design_review_changed",
  // Design review (DR-FU4): a company admin changed the company's design review policy (allowed, lock; before 0.5.7 the system also moved the old `dp` projects into it, and those events stay readable); turning "allowed" on waits for a different admin.
  "company.design_review_policy_proposed",
  "company.design_review_policy_changed",
  "company.change_applied_to_project",
  // Proof and evidence (W4/W5): the approved test environment changed; a task reader downloaded a stored evidence artifact.
  "project.test_env_changed",
  // Test services, slice 3 (M1): a maintainer approved, rejected or withdrew a hand-written or recorded answer set (a fake) of a project.
  "project.fixture_set_approved",
  "project.fixture_set_rejected",
  "project.fixture_set_withdrawn",
  // Setup and test health (SH28): a maintainer turned "propose a fix task when tests fail" on or off for a project.
  "project.test_health_setting_changed",
  "evidence.downloaded",
  // Setup and test health (SH17): a maintainer marked tests as already failing, so later results no longer count them against a change.
  "project.known_failing_marked",
  // Setup and test health KF-1: a mark was taken off the list, by a maintainer (undo) or by the system (a usable nightly showed the test passing).
  "project.known_failing_removed",
  // Setup and test health SH17 (F4): the company setting "always two people" for marking tests as already failing. Tightening applies at once; loosening is a proposal a different admin approves.
  "company.known_failing_policy_proposed",
  "company.known_failing_policy_changed",
  "company.known_failing_policy_refused",
  // Second review by another AI company (SR-1, switch `cr`): the company chose (or cleared) its reviewer models, and a project narrowed that choice. Counts and fixed words only: a model's name is not recorded.
  "company.second_review_choice_changed",
  "project.second_review_narrowed",
  // What the second reviewer is shown besides the code change (`change_only` or `same_as_first`).
  "company.second_review_context_changed",
  // The task owner acknowledged that an `on` second review did not run (the merge gate).
  "task.second_review_acknowledged",
  // Design review (DR7 slice C): the person who asked for a high-risk task approved its design because no other person could (the sole-owner exception). `tier` is the design's risk tier.
  "task.design_sole_owner_exception",
  // The second review's mode (`review.otherCompany`): raising applies at once; lowering is a proposal a different admin approves. `scope` is `company` or `project`.
  "company.second_review_mode_proposed",
  "company.second_review_mode_changed",
  "company.second_review_mode_refused",
  "company.second_review_mode_cancelled",
  // The evidence that lets a model block (written by Rovara staff in Public, the install's administrator in Enterprise; an admin can only withdraw a verdict).
  "company.second_review_replay_recorded",
  "company.second_review_verdict_recorded",
  "company.second_review_verdict_withdrawn",
  // Runtime UI flags (lane U5): an owner or admin turned screens on or off for the company, or changed whether a person may preview one on their own device.
  "company.ui_flags_changed",
  // Team record and lessons (learning v2): one block. Ids, fixed words and counts only; a lesson's or a source's text never goes in.
  "record.source_added",
  "record.source_changed",
  "record.source_removed",
  "record.tombstoned",
  "record.erased",
  // Tracker people (lane team-record-links): an admin mapped a Linear or Jira person to a member of the company, or took the mapping away. The target is the member; the tool's id and name never go in.
  "record.tracker_person_mapped",
  "record.tracker_person_unmapped",
  // The company switch for automatic tracker linking (off by default): who turned it on or off; the fact is the new state.
  "record.tracker_autolink_changed",
  "lesson.mode_changed",
  "lesson.proposed",
  "lesson.activated",
  "lesson.approved",
  "lesson.edited",
  "lesson.rejected",
  "lesson.retired",
  "lesson.expired",
  "lesson.withdrawn",
  "lesson.refused",
  "lesson.promoted",
  "lesson.rolled_back",
  "lesson.snapshot_created",
  // The tier-0 approval setting and the company sole-owner switch: loosening is a proposal for a second person (or the audited sole-owner exception); the ledger records both.
  "lesson.tier0_setting_proposed",
  "lesson.tier0_setting_changed",
  "lesson.sole_owner_switch_proposed",
  "lesson.sole_owner_switch_changed",
  // The company or project learning preset (Standard / Regulated): the ledger records who changed it and between which two values.
  "lesson.preset_changed",
  // Loosening a preset opens a proposal for a second person (or the sole-owner exception); a trial lesson earning "stable" is a grant (it makes the lesson publishable) and is recorded.
  "lesson.preset_proposed",
  "lesson.trial_stable",
  // The company set (or cleared) the model its lesson learning runs on. `fromModel` / `toModel` are `provider/modelId` or `default` (the cheapest suitable model).
  "lesson.model_set",
  // Lessons in the repository (R2): a weekly lessons pull request opened (counts and its number), one Rovara closed (a fixed cause: replaced, nothing left, switched off, erased lesson), and the project's switch for a repository.
  "lesson.repo_file_pr_opened",
  "lesson.repo_file_pr_closed",
  "lesson.repo_file_switched",
  // Decision 46b: a maintainer (project) or an owner or admin (company) switched local coding tools' access to lessons. `scope` is project or company, `enabled` is the setting after the change (for the company: lessons may leave Rovara).
  "lesson.local_tools_switched",
  // Lessons in the repository (R3, owner decision 78): a person confirmed retiring, or kept, the lessons that went missing from the file in one change (written before the answer is recorded).
  "lesson.repo_file_retire_decided",
  // Lane 7: an operator started a replay copy of a past task to measure the lessons (counts, ids and fixed words only), written before the copy starts.
  "lesson.replay_started",
  // Lane 7 re-check L-f: an operator read a past task for the offline pipeline, read the project's learning settings, or made one model call for the replay (ids, fixed words and counts only).
  "lesson.replay_read",
  // Lane E (private MCP servers and project Sources): ids, fixed words and flags only. A server's label, address and token, and a source's id, never go in a fact.
  "mcp_server.added",
  "mcp_server.approved",
  "mcp_server.disabled",
  "mcp_server.removed",
  "mcp_server.token_changed",
  // Stdio MCP host (register ME-14): package-run servers. Ids, hashes, counts and fixed words only; a package's output, a secret and a secret's value never go in a fact. Host names and addresses go in `details`.
  "mcp_server.installed",
  "mcp_server.probed",
  "mcp_server.changed_needs_review",
  "mcp_server.task_started",
  "mcp_server.task_stopped",
  "mcp_server.egress_updated",
  "mcp_server.secret_replaced",
  "context_source.proposed",
  "context_source.applied",
  "context_source.rejected",
  // Live interaction part 2 (Stop & redirect, Ask, Fix with agent): ids, fixed words and counts only. An instruction, a question, an answer and a diagnosis's text never go in.
  "session.redirected",
  "task.asked",
  // S2 (send-back gate): work a task would have started was refused because the person it runs as lost their place (removed, or no longer allowed in the project). Fixed words only: `path`, `cause`.
  "task.work_refused",
  // Lane ask-linear: a Linear comment an erase meant to rewrite could not be (given up after the bounded tries). Ids, a fixed reason word and a count only.
  "ask.linear_comment_kept",
  "diagnosis.started",
  "diagnosis.proposed",
  "diagnosis.proposal_raised",
  "diagnosis.support_escalated",
  "diagnosis.bundle_prepared",
  // Setup agent website asks (sh-setup-wire, SH12): the ask raised by a setup run (system, on behalf of the person who started it) and an admin's refusal. Ids, a journal position and a fixed reason code only; the host and the people go in `details`.
  "setup.host_asked",
  "setup.host_refused",
  // Setup run limits (sh-su-musts): a project's own limits, and the company's locks (a loosening waits for a second admin, then is approved). Ids, digests, counts and fixed words only.
  "setup.limits_changed",
  "setup.locks_changed",
  "setup.locks_change_proposed",
  "setup.locks_change_approved",
  // Company sign-in (Enterprise foundations I1): ids, fixed words and counts only. The rule ids a sign-in matched go in `details`, never in a fact.
  "sso.sign_in",
  "sso.sign_in_refused",
  "sso.break_glass_used",
  "sso.group_mapping_changed",
  "sso.break_glass_changed",
  "sso.saml_changed",
  // v1.2 learning loop: suggested rules and their decisions. Ids, counts, flags and fixed words only; never a correction's or a rule's text.
  "rule.suggested",
  "rule.accepted",
  "rule.not_applied",
  "rule.dismissed",
  "rule.withdrawn",
  "rule.rolled_back",
  "rule.correction_remembered",
  "project.learning_changed",
  "rule.suggestions_set",
  // Owner decision 2026-11-02: a company admin dismissed the one-time notice that reviews now use a model from a different company. No facts: the company is the target.
  "review_default_notice.dismissed",
  // Company domain verification (owner decision 2026-11-02): a domain claimed, checked, lost or removed. The domain itself is in `details`, never a fact.
  "company_domain.added",
  "company_domain.verified",
  "company_domain.lost",
  "company_domain.removed",
  // Company setup recipes (SH29; the company's locks are su-musts', with their own setup.locks_* actions): ids, digests and fixed words only. A recipe's text, its hosts and a project's name never go in a fact.
  "setup_recipe.proposed",
  "setup_recipe.created",
  "setup_recipe.approved",
  "setup_recipe.revoked",
  "setup_recipe.scope_changed",
  // TE-4: a maintainer went back to the last proved setup after a saved change failed its check. Revisions only: never a command.
  "project.setup_restored",
  // System owner of automatic runs (owner decision 2026-11-02): an automatic job started (actor `system`; the job and who approved the setup it runs), a maintainer changed the project's monthly cap, the cap paused the project's automatic runs.
  "automatic_run.started",
  "project.automatic_runs_cap_changed",
  "automatic_runs.paused",
  "automatic_run.ended",
  // Saved project images (SV wiring): ids, digests, counts and fixed words only.
  "saved_env.changed",
  "saved_env.setting_changed",
  // Customer test accounts (test services TS26, switch `ta`): ids, digests, counts and fixed words only. A host, label or role never goes in a fact (they are in `details`), and a secret's value is never known to the broker.
  "test_account.added",
  "test_account.approved",
  "test_account.narrowed",
  "test_account.widened",
  "test_account.reenable_requested",
  "test_account.rotated",
  "test_account.suspended",
  "test_account.expired",
  "test_account.deleted",
  "test_account.deleting",
  "test_account.rotation_failed",
  "test_account.used",
  // Script tokens (UX5b, switch `pt`): ids, counts and fixed words only. A token, its hash and its name never go in a fact.
  "script_token.created",
  "script_token.revoked",
  "script_token.used",
  // Company-approved extra test-service images (switch `pj`): ids, digests, counts and fixed words only. The image's name is in `details`, never a fact.
  "company_image.proposed",
  "company_image.approved",
  "company_image.revoked",
] as const;

export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AUDIT_TARGET_KINDS = [
  "approval",
  "spend_request",
  "task",
  "pull_request",
  "org",
  "invite",
  "member",
  "project",
  "agent",
  "chain",
  "session",
  "trigger",
  "connection",
  "connector",
  "guardrails",
  "repository",
  "domain",
  "github_installation",
  "budget",
  "audit",
  "spend_policy",
  "model_source",
  "process",
  "lesson",
  "record_source",
  "mcp_server",
  "diagnosis",
  "test_account",
  "script_token",
] as const;

export const AuditTargetKindSchema = z.enum(AUDIT_TARGET_KINDS);
export type AuditTargetKind = z.infer<typeof AuditTargetKindSchema>;

const SPEND_REQUEST_FACTS = ["kind", "scopeKind", "amountCents", "newLimitCents", "decision"] as const;
/**
 * A decision also records what was applied, which an approver may set apart from what was asked (`amountUsd` on the decide body): the amount approved in
 * cents, the limit that amount sets (for a month top-up, the scope's limit with it) and, for a month's request, the month that was topped up (`YYYY-MM`).
 */
const SPEND_REQUEST_DECIDED_FACTS = [...SPEND_REQUEST_FACTS, "approvedAmountCents", "appliedLimitCents", "topUpMonth"] as const;

/**
 * What a finished member removal says (at most `AUDIT_MAX_FACTS`): how it ended (`done` or `cancelled_rejoined`), the role the person had, what moved to the
 * successor and what was cut. Counts come from the mover results kept on the marker, so `countsComplete` is false after a run that stopped part-way.
 * The exact list is the per-item events (`approval.rerouted`, `spend_request.rerouted`, `*.owner_changed`).
 */
const MEMBER_REMOVAL_COMPLETED_FACTS = [
  "outcome", "wasRole", "approvalsMoved", "spendRequestsMoved", "agentsMoved", "skillsMoved", "chainsMoved", "triggersMoved", "grantsRemoved", "grantsKept", "signInEnded", "countsComplete",
] as const;

/**
 * The facts each action may carry. Every value is a fixed-vocabulary word, a count, a sequence number, an amount
 * in cents or a flag: never a name, an email, a login, a repository or project name, a domain or a reason.
 * Where a key is a version, `from` and `to` are integers (a spend threshold in cents, the multiplier in hundredths). For `local_agents.policy_changed` they are
 * a flag (`allowed`), a comma-joined list of the tools' fixed names or `none` (`tools`), and `all` or the number of projects listed (`projects`).
 */
export const AUDIT_FACT_KEYS: Record<AuditAction, readonly string[]> = {
  "approval.decided": ["kind", "decision", "subjectKind", "class"],
  "approval.expired": ["kind", "subjectKind"],
  "approval.requested": ["kind", "subjectKind", "class", "connectorType", "tool", "argumentsHash"],
  "approval.rerouted": ["kind", "mode"],
  "write.executed": ["connectorType", "tool", "status", "argumentsHash"],
  "spend_request.created": SPEND_REQUEST_FACTS,
  "spend_request.decided": SPEND_REQUEST_DECIDED_FACTS,
  "spend_request.expired": SPEND_REQUEST_FACTS,
  "spend_request.escalated": SPEND_REQUEST_FACTS,
  "spend_request.rerouted": ["kind", "mode"],
  "spend_request.resume_dropped": ["kind", "cause"],
  "budget.changed": ["scopeKind", "field", "fromCents", "toCents"],
  "spend_policy.changed": ["field", "from", "to"],
  "spending.enrollment_changed": ["requestId", "reviewId", "reviewDigest", "before", "after", "revision", "tasksReviewed", "tasksAtEnable", "newImpacts", "pendingExpired"],
  "spending.policy_changed": ["scopeKind", "revision", "requestId", "proposalId", "beforeKind", "afterKind", "beforeMicrousd", "afterMicrousd", "decision", "outcomeCode"],
  "spending.policy_change_requested": ["scopeKind", "revision", "requestId", "proposalId", "beforeKind", "afterKind", "beforeMicrousd", "afterMicrousd", "decision", "outcomeCode"],
  "spending.policy_change_decided": ["scopeKind", "revision", "requestId", "proposalId", "beforeKind", "afterKind", "beforeMicrousd", "afterMicrousd", "decision", "outcomeCode"],
  "spending.stop_admitted": ["effectiveStopMicrousd", "approvalCapMicrousd", "policyDigest", "workKind", "admissionId"],
  "spending.stop_exempted": ["sourceId", "sourceKind", "sourcesRevision", "payerDeveloperId", "connectionRevision"],
  "spending.stop_refused": ["outcomeCode", "workKind", "admissionId", "sourceId", "sourceKind", "sourcesRevision"],
  "spending.stop_reached": ["effectiveStopMicrousd", "approvalCapMicrousd", "policyDigest", "workKind", "admissionId"],
  "spending.policy_seeded": ["mode", "source", "revision", "ceilingMicrousd", "outcome"],
  "pull_request.opened": ["number"],
  "pull_request.merged": ["number"],
  "pull_request.merge_requested": ["number", "method"],
  "member.joined": ["role", "via"],
  "member.role_changed": ["fromRole", "toRole"],
  "member.removed": ["role", "removalId", "successorKind"],
  "member.removal_completed": MEMBER_REMOVAL_COMPLETED_FACTS,
  "member.left": ["role"],
  "member.renamed": [],
  "org.closed": ["plan"],
  "org.renamed": [],
  "org.invite_created": ["role", "targeted"],
  "org.invite_revoked": ["role"],
  "project.archived": ["fromRevision", "toRevision", "projectRevision", "requestId"],
  "project.restored": ["fromRevision", "toRevision", "projectRevision", "requestId"],
  "project.working_branch_changed": ["fromRevision", "toRevision", "lifecycleRevision", "requestId", "previousConfigured"],
  "project.allowed_domains_proposed": ["fromRevision", "toRevision", "requestId", "proposalId", "added", "removed"],
  "project.allowed_domains_rejected": ["fromRevision", "toRevision", "requestId", "proposalId", "added", "removed"],
  "project.allowed_domains_cancelled": ["fromRevision", "toRevision", "requestId", "proposalId", "added", "removed"],
  "project.allowed_domains_changed": ["fromRevision", "toRevision", "requestId", "proposalId", "added", "removed", "mode"],
  "project_member.changed": ["fromRole", "toRole"],
  "project_member.removed": ["role"],
  "slack_channel.proposed": ["requestId", "proposalId"],
  "slack_channel.cancelled": ["requestId", "proposalId"],
  "slack_channel.rejected": ["requestId", "proposalId"],
  "slack_channel.bound": ["mode", "proposalId"],
  "slack_channel.unbound": ["source"],
  "slack_team.connected": [],
  "slack_team.disconnected": [],
  "identity.linked": ["provider"],
  "identity.unlinked": ["provider"],
  "agent.owner_changed": ["field"],
  "chain.owner_changed": ["field"],
  "session.owner_changed": ["sessionKind", "payerMoved"],
  "session.stopped": ["sessionKind"],
  "session.retried": ["sessionKind", "branch"],
  "session.shared": ["level", "principalKind"],
  "session.linked": ["surface"],
  "session.unlinked": ["surface"],
  "connection.saved": ["connectorType"],
  "connection.jira_org_admin_changed": ["change"],
  "connection.removed": ["connectorType"],
  "project_connector.changed": ["connectorType", "revision", "change"],
  "guardrails.changed": ["revision", "widened"],
  "local_agents.policy_changed": ["field", "from", "to"],
  "code_settings.changed": ["revision", "changed", "selfApproval", "mergeMethod", "reviewers"],
  "comment_trigger_opt_out.applied": ["scope"],
  "comment_trigger_opt_out.lapsed": ["scope"],
  "egress_domain.decided": ["decision"],
  "agent.published": ["version", "safety"],
  "agent.rolled_back": ["fromVersion", "toVersion"],
  "builtin.adopted": ["version"],
  "chain.published": ["version", "safety"],
  "chain.rolled_back": ["fromVersion", "toVersion"],
  "trigger.enabled": ["source", "type", "targetKind"],
  "trigger.disabled": ["cause", "source", "type", "targetKind"],
  "github.connected": ["accountType", "result"],
  "github.disconnected": ["accountType"],
  "github.installation_changed": ["status", "accountType"],
  "model_source.saved": ["kind", "change"],
  "model_source.removed": ["kind"],
  "model_source.order_changed": ["count"],
  "model_policy.changed": ["revision","policyDigest","previousDigest","stage","mode"],
  "model_policy.lock_set": ["revision","policyDigest","previousDigest","stage","mode"],
  "model_policy.lock_removed": ["revision","policyDigest","previousDigest","stage","mode"],
  "model.fallback_used": ["stage","usedModelDigest","wantedModelDigest","cause","companyRevision"],
  "audit.read": ["fromSeq", "toSeq", "count", "via"],
  "audit.exported": ["fromSeq", "toSeq", "withDetails"],
  "audit.staff_read": ["fromSeq", "toSeq", "count", "via"],
  "audit.subject_erased": [],
  "audit.org_shred_scheduled": ["shredAfterDays"],
  // "How we work" playbook: one block, so a merge with another branch's additions stays easy. Counts, revisions and flags only;
  // `surface` is a fixed word (`slack`, `app`, `cli`) and `processKind` is `builtin` or `project_process`.
  "project.models_changed": ["revision", "approvedCount", "defaultChanged"],
  "project.checks_changed": ["revision", "requiredCount", "optionalCount"],
  "project.e2e_policy_changed": ["revision", "screenshots", "traces", "video", "downloads"],
  "project.model_selection_changed": ["surface", "cleared"],
  "project.roster_changed": ["added", "removed"],
  "process.published": ["version", "safety", "selfConfirmedSoleOwner"],
  "process.rolled_back": ["fromVersion", "toVersion", "safety"],
  "playbook.default_process_changed": ["revision", "processKind"],
  // `mode` is auto, always or never; `tier` light, standard or thorough; `approverKind` maintainers, people or group (never the people or the group named); `capCents` the per-task cap in whole cents.
  "playbook.design_review_changed": ["revision", "mode", "tier", "allowSkip", "capCents", "approverKind", "approverCount"],
  // `field` is `allowed` or `lock`; `from` and `to` are fixed words (on/off) or, for `lock`, how many fields the lock holds; `mode` is `direct`, `second_person`, `sole_owner_exception`, `migration` or `cancelled` (a waiting request withdrawn: `from` is `requested`, `to` is `withdrawn`).
  "company.design_review_policy_proposed": ["field", "from", "to"],
  "company.design_review_policy_changed": ["field", "from", "to", "mode", "revision"],
  "company.change_applied_to_project": ["changeRevision", "settingCount"],
  // `tier` is `sandbox`, `preview` or `shared`; `lessSafeCount` is how many less-safe fields the change turned on. `artifactKind` and `retentionClass` are the fixed words of the evidence contract.
  "project.test_env_changed": ["revision", "tier", "lessSafeCount"],
  // The set's digest only (64 hex): never a word of its content. The actor, the org and the project are the event's own.
  "project.fixture_set_approved": ["digest"],
  "project.fixture_set_rejected": ["digest"],
  "project.fixture_set_withdrawn": ["digest"],
  "project.test_health_setting_changed": ["setting", "enabled"],
  "evidence.downloaded": ["artifactKind", "retentionClass"],
  // `cause` is a fixed auto-fix code word (the environment fault the card was about); `testCount` is how many tests were added to the project's already-failing list; the rest are the card's epoch, counts, two sha256 hashes (the waiting tasks, the exact set marked) and the list's version and size afterwards. Never a test name.
  "project.known_failing_marked": ["cause", "testCount", "recordEpoch", "taskCount", "taskIdsSha256", "testSetSha256", "rowVersionAfter", "totalAfter", "approvalMode", "secondPersonWhy"],
  // `fromAlwaysTwo` / `toAlwaysTwo` are booleans; `mode` is `direct`, `second_person`; `refusal` a fixed word.
  // `removal` is `undo` or `nightly_passing`; `testCount` is how many marks left the list; `markEpoch` is the card the mark was made on (0: marks from several cards); `testSetSha256` is the sha256 of the sorted "check, test" lines removed; `rowVersionAfter` and `totalAfter` describe the list afterwards.
  "project.known_failing_removed": ["removal", "testCount", "markEpoch", "testSetSha256", "rowVersionAfter", "totalAfter"],
  "company.known_failing_policy_proposed": ["fromAlwaysTwo", "toAlwaysTwo"],
  "company.known_failing_policy_changed": ["fromAlwaysTwo", "toAlwaysTwo", "mode"],
  "company.known_failing_policy_refused": ["refusal"],
  // `change` is `choose` or `clear`; `count` is how many models the choice now holds (0 to 2).
  "company.second_review_choice_changed": ["change", "count"],
  "project.second_review_narrowed": ["change", "count"],
  // `to` is `change_only` or `same_as_first`; `widens` is true when more of the company's connected context now reaches the second reviewer.
  "company.second_review_context_changed": ["to", "widens"],
  // `turnedOn` and `turnedOff` are flag names (a closed list of plain words) joined by `+`, or `none`; `previews` is `on`, `off` or `same`; `revision` is the new revision of the company's flags.
  "company.ui_flags_changed": ["revision", "turnedOn", "turnedOff", "previews"],
  // `cause` is one of the fixed words for why the second review did not run.
  "task.second_review_acknowledged": ["cause"],
  "task.design_sole_owner_exception": ["tier", "openBlockers"],
  // `scope` is `company` or `project`; `from` / `to` are `off`, `shadow` or `on`; `mode` is `direct` or `second_person`; `refusal` a fixed word.
  "company.second_review_mode_proposed": ["scope", "from", "to"],
  "company.second_review_mode_changed": ["scope", "from", "to", "mode"],
  "company.second_review_mode_refused": ["refusal"],
  // A waiting proposal withdrawn (by a person) or replaced by a newer one because the mode it was made against moved (`cause`: `withdrawn` or `stale`).
  "company.second_review_mode_cancelled": ["scope", "from", "to", "cause"],
  // `runId` is the replay run's id; `cases` how many it holds; `passed` what the bar says when it is scored afresh (never stored). `model` is the model's key; `days`, `findings` and `agreed` are the shadow window the broker counted itself.
  "company.second_review_replay_recorded": ["runId", "cases", "passed"],
  "company.second_review_verdict_recorded": ["model", "runId", "days", "findings", "agreed"],
  "company.second_review_verdict_withdrawn": ["model"],
  // Team record and lessons. `source` is a fixed word (`slack`, `github`, `linear`, `jira`, `mcp`, `rovara`, `codehost`); retention is `A` to `D`; `cause` a fixed
  // word (`source_deleted`, `person_erased`, `project_archived`, `org_closed`, `excluded`, `harmful`, `stale`, `expired`, `sources_deleted`); `refusal` a fixed code; `mode` is `off`, `collect`, `suggest` or `on`.
  // Owner decision 2026-11-04: no second person for a source change; it applies at once. `widened` (only when the write widened something, in either edition) is the fixed words `retention_raise`, `private_channel`, `dm`, `mpim`
  // joined with commas, in that order: what an auditor looks for. The place (scope) and the person's words never go in: the target names the source row.
  // `via` is `slack` when the source was added from a Slack interaction ("learn from this channel"); absent for the web.
  "record.source_added": ["source", "retention", "restricted", "widened", "via"],
  "record.source_changed": ["source", "fromRetention", "toRetention", "enabled", "widened"],
  "record.source_removed": ["source"],
  "record.tombstoned": ["source", "cause", "count"],
  "record.erased": ["cause", "rows", "facts", "lessons", "vectors"],
  // `source` is `linear` or `jira`.
  "record.tracker_person_mapped": ["source"],
  "record.tracker_person_unmapped": ["source"],
  "record.tracker_autolink_changed": ["enabled"],
  "lesson.mode_changed": ["fromMode", "toMode", "locked"],
  "lesson.proposed": ["lessonType", "tier"],
  "lesson.activated": ["lessonType", "tier", "auto"],
  "lesson.approved": ["tier", "approvals", "soleOwner"],
  "lesson.edited": ["tier", "fromTier"],
  "lesson.rejected": ["tier"],
  "lesson.retired": ["cause", "tier"],
  "lesson.expired": ["tier"],
  "lesson.withdrawn": ["cause"],
  "lesson.refused": ["refusal"],
  "lesson.promoted": ["tier"],
  "lesson.rolled_back": ["fromSetVersion", "toSetVersion"],
  "lesson.snapshot_created": ["lessonSetVersion", "lessonCount"],
  // `scope` is `project` or `company`; levels are `auto`, `one` or `two`; `mode` is `direct`, `second_person` or `sole_owner_exception`.
  "lesson.tier0_setting_proposed": ["scope", "fromLevel", "toLevel"],
  "lesson.tier0_setting_changed": ["scope", "fromLevel", "toLevel", "mode"],
  "lesson.sole_owner_switch_proposed": ["fromEnabled", "toEnabled"],
  "lesson.sole_owner_switch_changed": ["fromEnabled", "toEnabled", "mode"],
  // `scope` is `project` or `company`; presets are `standard` or `regulated`.
  "lesson.preset_changed": ["scope", "fromPreset", "toPreset", "mode"],
  "lesson.preset_proposed": ["scope", "fromPreset", "toPreset"],
  "lesson.trial_stable": ["tier"],
  "lesson.model_set": ["fromModel", "toModel"],
  // `removals` / `edits` / `adds` are counts (written before the host is asked, so no number yet), `pullRequest` the host's number (0 for a branch with none); `cause` is `replaced`, `nothing_left`, `switched_off`, `erased`, `merged`, `closed_by_team` or `lessons_off`; `enabled` is the switch after the change.
  "lesson.repo_file_pr_opened": ["removals", "edits", "adds"],
  "lesson.repo_file_pr_closed": ["cause", "pullRequest"],
  "lesson.repo_file_switched": ["enabled"],
  "lesson.local_tools_switched": ["scope", "enabled"],
  // `verdict` is `retire` or `keep`; `missing` is how many lessons the answer covers.
  "lesson.repo_file_retire_decided": ["verdict", "missing"],
  // `operator` is the opaque `op_` id, `memory` is `off` or `snapshot`, `snapshotLessons` a count, `maxCents` the run's spend limit in whole cents, `sourceTask` the past task's id.
  "lesson.replay_started": ["operator", "memory", "snapshotLessons", "maxCents", "sourceTask"],
  // `operator` is the opaque `op_` id, `what` one of `subject`, `settings`, `model_grade`, `model_learn`, `maxCents` the call's hold in whole cents (0 for a read), `target` the past task's id for a subject read.
  "lesson.replay_read": ["operator", "what", "maxCents", "target"],
  "mcp_server.added": ["transport", "hasCredential"],
  // approved also pins a package-run server's install: the tarball's integrity, the lockfile and bundle hashes, the tools hash the admin saw, how many addresses and secret names it was given, and the secret's version.
  "mcp_server.approved": ["transport", "hasCredential", "integrity", "lockfileHash", "bundleHash", "toolsHash", "destinationCount", "credentialCount", "credentialVersion"],
  "mcp_server.disabled": ["transport"],
  "mcp_server.removed": ["transport"],
  "mcp_server.token_changed": ["change"],
  "mcp_server.installed": ["package", "version", "integrity", "lockfileHash", "bundleHash", "packageCount", "unpackedBytes"],
  "mcp_server.probed": ["purpose", "toolsHash", "bundleHash", "toolCount"],
  "mcp_server.changed_needs_review": ["approvedToolsHash", "observedToolsHash"],
  "mcp_server.task_started": ["trigger"],
  "mcp_server.task_stopped": ["cause"],
  "mcp_server.egress_updated": ["added", "removed"],
  "mcp_server.secret_replaced": ["credentialCount", "credentialVersion"],
  "context_source.proposed": ["change"],
  "context_source.applied": ["change"],
  "context_source.rejected": ["change"],
  // Live interaction. `mode` is keep_plan or change_plan, `outcome` a redirect outcome word, `audience` web, slack or linear (or `all` on a daily count), `scope` each or daily, `tier` light or deep.
  "session.redirected": ["mode", "step", "outcome"],
  "task.asked": ["audience", "scope", "count", "contextBytes", "model"],
  // `path` is a fixed word for the place work was refused (`ci_fix_round`, `feedback_round`, `conflict_round`, `program_step`, `feedback_review`, `queued_dispatch`, `direct_start`, `agent_step`, `spend_resume`, `autofix`); `cause` is `owner_removed`, `no_project_access`, `viewer`, `project_archived`, `project_inactive`, `other_org` or `slack_unavailable`.
  "task.work_refused": ["path", "cause"],
  "ask.linear_comment_kept": ["cause", "attempts"],
  "diagnosis.started": ["errorKind", "errorCode", "tier"],
  "diagnosis.proposed": ["total", "dropped", "explain", "retryWithNote", "redirect", "settingsChange", "newTask", "adminSteps", "contactSupport"],
  "diagnosis.proposal_raised": ["proposalKind"],
  "diagnosis.support_escalated": ["errorKind"],
  "diagnosis.bundle_prepared": ["errorKind"],
  "setup.host_asked": ["askId", "taskId", "journalN"],
  "setup.host_refused": ["askId", "refusal"],
  "setup.limits_changed": ["revision", "previousDigest", "nextDigest", "commands", "sameStepTries", "wallClockMin", "budgetCents", "hostAsks"],
  "setup.locks_changed": ["revision", "previousDigest", "nextDigest", "loosened", "defaulted"],
  "setup.locks_change_proposed": ["revision", "previousDigest", "nextDigest", "loosened"],
  "setup.locks_change_approved": ["revision", "previousDigest", "nextDigest", "loosened", "approvalMode", "membershipVersion"],
  // `source` is `mapping` or `break_glass`; `refusal` one of the fixed refusal words (GROUP_MAPPING_REFUSALS, or `break_glass_not_fresh`); `rules` and `owners` are counts.
  "sso.sign_in": ["source", "role", "rules"],
  "sso.sign_in_refused": ["refusal"],
  "sso.break_glass_used": ["role", "sessionSeconds"],
  "sso.group_mapping_changed": ["fromVersion", "toVersion", "rules"],
  "sso.break_glass_changed": ["owners"],
  // SAML sign-in settings (I4): the saved version, whether the identity provider's entity id, sign-in address or certificate changed; never their values.
  "sso.saml_changed": ["fromVersion", "toVersion", "changed"],
  // v1.2 learning loop. `stage` is a stage id, `sourceKinds` a comma-joined list of fixed words (`comment`, `send_back`, `pr_comment`), `outcome` is `published` or `awaiting_approval`,
  // `approvalOutcome` is `declined`, `expired` or `failed`, `dismissKind` is a fixed word, `standing` is `member` or `outsider` and `op` is `remember` or `forget`.
  "rule.suggested": ["suggestionId", "stage", "sourceCount", "sourceKinds", "lessSafe", "fromOnePerson"],
  "rule.accepted": ["suggestionId", "ruleId", "stage", "processAgentId", "outcome", "processVersion", "approvalId", "edited", "lessSafe"],
  "rule.not_applied": ["suggestionId", "ruleId", "approvalOutcome"],
  "rule.dismissed": ["suggestionId", "stage", "dismissKind"],
  // Rovara withdrew a suggestion whose sources went away (system actor); `cause` is a fixed word: forgotten, sources_gone, pr_capture_off, erased.
  "rule.withdrawn": ["suggestionId", "stage", "cause"],
  "rule.rolled_back": ["ruleId", "processAgentId", "processVersion"],
  "rule.correction_remembered": ["correctionId", "stage", "standing", "op"],
  "project.learning_changed": ["revision", "enabled", "selfConfirmedSoleOwner"],
  // The company's master suggestions switch: `setting` and `previous` are `on` or `off`, `source` is `company`.
  "rule.suggestions_set": ["setting", "previous", "source", "previousSource"],
  "review_default_notice.dismissed": [],
  // Company domains: `tookOver` is true when the proof moved the domain from another company's lost claim; `wasState` is the state before (pending, verified or lost); `missingDays` the whole days the record was gone.
  "company_domain.added": [],
  "company_domain.verified": ["wasState", "tookOver"],
  "company_domain.lost": ["missingDays"],
  "company_domain.removed": ["wasState"],
  // Setup recipes: `authority` is `fresh_sign_in` or `project_maintainer`; `bodyDigest` is the recipe body's sha256.
  "setup_recipe.proposed": ["recipeId", "revision", "bodyDigest", "authority"],
  "setup_recipe.created": ["recipeId", "revision", "bodyDigest", "authority"],
  "setup_recipe.approved": ["recipeId", "revision", "bodyDigest", "authority"],
  "setup_recipe.revoked": ["recipeId", "revision", "bodyDigest", "authority"],
  "setup_recipe.scope_changed": ["recipeId", "revision", "bodyDigest", "authority"],
  // `revision` is the new revision, `fromRevision` the one that failed its check, `provenRevision` the revision the restored setup was proved at.
  "project.setup_restored": ["revision", "fromRevision", "provenRevision"],
  // `job` is a fixed word (`nightly`, `image_rebuild`, `scheduled_check`); `setupApprovedBy` is the id of the member who approved the setup the job runs (`none` when it names nobody); `runsThisMonth` and `cap` are counts.
  "automatic_run.started": ["job", "setupApprovedBy", "runsThisMonth", "cap"],
  // `fromCap` / `toCap` are the monthly cap on automatic runs before and after (counts).
  "project.automatic_runs_cap_changed": ["fromCap", "toCap"],
  // `month` is `YYYY-MM`; `cap` is the cap that was reached.
  "automatic_runs.paused": ["month", "cap"],
  // Rovara ended an automatic run itself: `job` as above, `cause` is `project_stopped` (the project was archived or the company closed) or `too_old` (it ran past its time and the sweep ended it).
  "automatic_run.ended": ["job", "cause"],
  // `change` is a fixed word of the saved environment registry's ledger (queued, recorded, refused, failed, marked stale, reset, images deleted, archived, deleted, registered, walk, scan, lease refused); `cause` a fixed word; `digest` an image digest.
  "saved_env.changed": ["change", "cause", "digest", "count"],
  // `enabled` is the project's savedEnv.enabled setting after the change.
  "saved_env.setting_changed": ["enabled"],
  // Customer test accounts. `kind` is the account kind, `digest` the sha256 of what was approved (`testAccountApprovalDigest`), `fromDigest` the one before a change, `hostCount` and `projectScope` (`all` or `list`) its reach.
  // `approvalMode` is `second_person` or `sole_owner_exception`; `approvals` how many people's approvals count; `expiresInDays` the days from the approval to the expiry. `cause` is a fixed word (`manual`, `expired`, `widened`).
  // `used` is the daily roll-up of one project: `day` (YYYY-MM-DD), `rounds` and `requests`.
  "test_account.added": ["kind", "digest", "hostCount", "projectScope"],
  "test_account.approved": ["digest", "approvalMode", "approvals", "expiresInDays"],
  "test_account.narrowed": ["digest", "fromDigest"],
  "test_account.widened": ["digest", "fromDigest"],
  "test_account.reenable_requested": ["digest", "fromStatus"],
  "test_account.rotated": ["digest"],
  "test_account.suspended": ["cause"],
  "test_account.expired": ["digest"],
  "test_account.deleted": ["kind", "cause"],
  "test_account.deleting": ["kind", "cause"],
  "test_account.rotation_failed": ["cause"],
  "test_account.used": ["day", "rounds", "connections", "bytes"],
  "script_token.created": ["days", "projects", "permissions"],
  "script_token.revoked": ["by"],
  "script_token.used": ["day", "permission"],
  // Company-approved extra images: `imageId` names the exact image and digest it pinned (`img_` plus the first 20 hex of the sha256 of `registry/repository@sha256:<digest>`); `digest` is that image digest; `authority` is `fresh_sign_in` (approved), `live_admin` (revoked or proposed by an admin) or `project_setup` (proposed from a project's setup).
  "company_image.proposed": ["imageId", "digest", "authority"],
  "company_image.approved": ["imageId", "digest", "authority"],
  "company_image.revoked": ["imageId", "digest", "authority"],
};

/** `op_` plus the first 24 hex of `sha256(issuer + "\n" + subject)`: a staff member's id in the chain, never their identity. */
export function auditOperatorId(issuer: string, subject: string): string {
  return `op_${sha256Hex(`${issuer}\n${subject}`).slice(0, 24)}`;
}

/**
 * The opaque id both pull request events name their target by: `pr_` and the first 32 hex of the SHA-256 of the lowercased
 * `owner/name` and the number. The repository's name is personal data and never part of an id the chain holds; it goes in
 * an event's `details`. The same pull request has the same id wherever it is recorded (opened, merged).
 */
export function auditPullRequestId(repositoryFullName: string, number: number): string {
  return `pr_${sha256Hex(`${repositoryFullName.toLowerCase()}#${String(number)}`).slice(0, 32)}`;
}

const ActorId = z.string().min(1).max(100);

export const AuditActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), id: ActorId }).strict(),
  z.object({ kind: z.literal("operator"), id: z.string().regex(/^op_[0-9a-f]{24}$/) }).strict(),
  z.object({ kind: z.literal("system"), id: z.literal("rovara") }).strict(),
  z.object({ kind: z.literal("github"), id: z.string().regex(/^[0-9]{1,20}$/) }).strict(),
]);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditTargetSchema = z.union([
  z.object({ kind: AuditTargetKindSchema, id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: AuditTargetKindSchema, name: z.string().min(1).max(200) }).strict(),
]);
export type AuditTarget = z.infer<typeof AuditTargetSchema>;

export const AuditProofSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fresh_sign_in"),
    method: z.literal("email_code"),
    authTime: z.string().datetime(),
    /** sha256 hex of the decide session's key. */
    sessionRef: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({ kind: z.literal("button"), via: z.literal("slack") }).strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type AuditProof = z.infer<typeof AuditProofSchema>;

/** One subject's personal details for an event: `org` or a developer id. Encrypted per subject; never in the chain. */
export const AuditDetailPartSchema = z.object({
  subject: z.string().min(1).max(100),
  fields: z.record(z.string().min(1).max(64), z.string().max(AUDIT_DETAIL_FIELD_MAX_CHARS)).refine(
    (fields) => Object.keys(fields).length <= AUDIT_DETAIL_FIELDS_MAX,
    { message: `at most ${AUDIT_DETAIL_FIELDS_MAX} fields` },
  ),
}).strict();
export type AuditDetailPart = z.infer<typeof AuditDetailPartSchema>;

export const AuditEventIdSchema = z.string().regex(/^aev_[0-9a-f]{40}$/);

/** The shape of an email address, checked on every fact string as a second guard behind the per-action allowlist. */
const EMAIL_SHAPED = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const AuditFactValueSchema = z.union([
  z.string().max(AUDIT_FACT_MAX_CHARS).regex(PRINTABLE_ASCII, "printable ASCII only").refine((text) => !EMAIL_SHAPED.test(text), {
    message: "looks like an email address",
  }),
  z.number().refine(Number.isSafeInteger, { message: "integers only" }),
  z.boolean(),
]);

const ModelAuditDigest=z.string().regex(/^[a-f0-9]{64}$/u);
export const ModelPolicyAuditFactsSchema=z.object({revision:z.number().int().min(1),policyDigest:ModelAuditDigest,previousDigest:ModelAuditDigest.optional(),stage:StageIdSchema.optional(),mode:z.enum(["second_person","sole_owner_exception"]).optional()}).strict();
export const ModelFallbackAuditFactsSchema=z.object({stage:StageIdSchema,usedModelDigest:ModelAuditDigest,wantedModelDigest:ModelAuditDigest.optional(),cause:ModelFallbackReasonCodeSchema,companyRevision:z.number().int().min(0)}).strict();
export const AuditEventInputSchema = z.object({
  eventId: AuditEventIdSchema,
  orgId: OrgIdSchema,
  action: AuditActionSchema,
  actor: AuditActorSchema,
  target: AuditTargetSchema,
  occurredAt: z.string().datetime(),
  related: z.array(z.string().min(1).max(100)).max(AUDIT_MAX_RELATED).optional(),
  facts: z.record(z.string(), AuditFactValueSchema).optional(),
  proof: AuditProofSchema.optional(),
  details: z.array(AuditDetailPartSchema).max(AUDIT_DETAIL_PARTS_MAX).optional(),
}).strict().superRefine((event, context) => {
  const modelFacts=event.action==="model.fallback_used"?ModelFallbackAuditFactsSchema:event.action.startsWith("model_policy.")?ModelPolicyAuditFactsSchema:undefined;
  if(modelFacts!==undefined&&!modelFacts.safeParse(event.facts).success) context.addIssue({code:"custom",path:["facts"],message:"invalid model audit facts"});
  if (event.facts === undefined) return;
  const keys = Object.keys(event.facts);
  if (keys.length > AUDIT_MAX_FACTS) {
    context.addIssue({ code: "custom", path: ["facts"], message: `at most ${AUDIT_MAX_FACTS} facts` });
  }
  const allowed = AUDIT_FACT_KEYS[event.action];
  for (const key of keys) {
    if (!allowed.includes(key)) {
      context.addIssue({ code: "custom", path: ["facts", key], message: `not a fact of ${event.action}` });
    }
  }
});
export type AuditEventInput = z.infer<typeof AuditEventInputSchema>;

/**
 * The id of one occurrence of an action: `"aev_" + sha256Hex([action, occurrence, ...parts].join("\n")).slice(0, 40)`.
 * `occurrence` changes with every real occurrence (a request, delivery, approval or revision id), so the same
 * facts recorded twice get different ids while a retry of one occurrence gets the same id. A part holding a
 * newline is refused, because it could move the boundary between two parts.
 */
export function auditEventId(action: AuditAction, occurrence: string, ...parts: string[]): string {
  if (occurrence === "") throw new RangeError("auditEventId needs a non-empty occurrence");
  const all = [action, occurrence, ...parts];
  if (all.some((part) => part.includes("\n"))) throw new RangeError("auditEventId parts must not contain a newline");
  return `aev_${sha256Hex(all.join("\n")).slice(0, 40)}`;
}
