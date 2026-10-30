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
  "pull_request.opened",
  "pull_request.merged",
  "pull_request.merge_requested",
  "member.joined",
  "member.role_changed",
  "member.removed",
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
  "company.change_applied_to_project",
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
  "pull_request.opened": ["number"],
  "pull_request.merged": ["number"],
  "pull_request.merge_requested": ["number", "method"],
  "member.joined": ["role", "via"],
  "member.role_changed": ["fromRole", "toRole"],
  "member.removed": ["role"],
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
  "company.change_applied_to_project": ["changeRevision", "settingCount"],
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
  "rule.suggestions_set": ["setting", "previous", "source"],
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
