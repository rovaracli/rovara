// Convergence S0, D12 (owner decision 74, RETENTION-UNCHANGED): Cloud keeps its current data retention through its adapters. Code's core puts an expiry
// (`indexExpiresAt`, the State table's TTL attribute) on more kinds of item than Cloud does: approval and decision records and proof markers (400 days),
// evidence (180 days), session summaries (365 days), the cost ledger, operation events (14 days). On Cloud's table that attribute is a real delete.
//
// The rule, per item kind (`entityType`):
//   - `keep`  : Cloud's own path already writes this kind with an expiry. The core's expiry is kept.
//   - `strip` : anything else. The core's expiry is removed before the write reaches the table, so the item lives as long as Cloud keeps such items today
//               (Cloud's erasure and retention jobs still apply). Unknown kinds are stripped too: the safe side of a retention rule is to keep.
//
// `CLOUD_TTL_KINDS` is the reviewed list; tests/unit/cloud-app-retention.test.ts scans Cloud's own sources and fails when Cloud writes a kind with an
// expiry that is not listed, so a new kind is reviewed here instead of being stripped silently. Changing this list is a retention decision (owner).
import { INDEX_EXPIRY_ATTRIBUTE, type DocumentStore, type StoredDocument, type TransactItem, type UpdateOp } from "@rovara-code/contracts";

/** The kinds Cloud's own path writes with an expiry today (reviewed 2026-11-12 against packages/broker/src). */
export const CLOUD_TTL_KINDS: ReadonlySet<string> = new Set([
  // Set through a helper or a spread, not on the line that names the kind (the scan in the test cannot see them): checked by hand.
  "WORKFLOW_DISPATCH", "PR_HEAD", "GITHUB_WORKFLOW_MERGE", "NOTIFY_PENDING", "NOTIFY_SENT", "NOTICE", "CHANNEL_OPERATION",
  // Found by the scan (tests/unit/cloud-app-retention.test.ts).
  "ADMIN_CHANGE_REQUEST", "AGENT_SESSION_FOLLOWER", "AGENT_SESSION_LOCAL", "AGENT_SESSION_MESSAGE", "AGENT_SESSION_REQUEST", "AGENT_SESSION_RETRIED",
  "APPROVER_INDEX", "ASK_LINEAR_COMMENT", "ASK_LINEAR_FIX", "ASK_LINEAR_FIX_CURSOR", "ASK_LINEAR_KEPT", "ASK_LOCK", "AUTOMATIC_RUN_CLAIM",
  "AUTOMATIC_RUN_ENDED", "AUTOMATIC_RUN_STARTED", "AUTOMATIC_RUN_WATCH", "AUTOMATIC_RUNS_PAUSED", "CHANGE_NOTICE", "CODEHOST_EVENT",
  "COMPANY_RULES_DECIDED", "COMPANY_RULES_PROPOSAL", "COMPANY_SWITCH_REQUEST", "DECISION_DISMISSAL", "DECISION_EVIDENCE_OPENED", "DEVICE_SESSION",
  "DIAGNOSIS_BY", "DIAGNOSIS_OPEN", "DIAGNOSIS_PERSON", "DIAGNOSIS_RECORD", "EGRESS_PROPOSAL_LIVE", "FAILURE_INDEX", "FULLRUN", "FULLRUN_LATEST",
  "GITHUB_DELIVERY_INSTALL_REQUEST", "HOOK_EVENT", "INSIGHTS_ACCESS_REQUEST", "INTAKE_CHANGE", "INTAKE_EVENT", "INTAKE_ITEM", "LEARN_CLAIM",
  "LEARNING_SOURCE", "OUTCOME_KEYS", "OUTCOME_SAMPLE", "PROJECT_CREATE_REQUEST", "PROJECT_MEMBER_REQUEST", "PROJECT_SETUP_CHECK_REQUEST", "REDIRECT",
  "REDIRECT_OPEN", "RUN_LIMIT_ASKED", "RUNTIME_REQUALIFY_SETUP_WORK", "SCRIPT_TOKEN", "SCRIPT_TOKEN_ROW", "SECOND_REVIEW_TRACK",
  "SECOND_REVIEW_TRACK_LAST", "SESSION_RATE_SPENT", "SETUP_COMMAND_REQUEST", "SETUP_DRAFT_APPLY", "SETUP_HOST_OPEN", "SETUP_JOURNAL", "SETUP_RECIPE",
  "SETUP_TYPED_COMMANDS", "SHARED_SESSION", "SLACK_ASK_REFUSED", "SLACK_BINDING_PROPOSAL_LIVE", "SLACK_MEMBER_WARNING", "TEAM_RECORD_DELETED",
  "TEAM_RECORD_ERASE_SWEEP", "TEAM_RECORD_ONCE_CLAIM", "TEAM_RECORD_PRIOR_EDIT_MARK", "TEAM_RECORD_SLACK_ADD", "TEAM_RECORD_SOURCE_OPTIONS",
  "TEAM_RECORD_SOURCE_REQUEST", "TEAM_RECORD_TRACKER_REQUEST", "TEST_ENV_BASELINE", "TEST_ENV_DRAFT_REFUSED", "TEST_ENV_EDITED", "TEST_ENV_HEALTH",
  "TEST_ENV_LOOK_LOCK", "TEST_ENV_NIGHT", "TEST_ENV_NIGHTLY_ACTIVE", "TEST_ENV_NIGHTLY_DAY", "TEST_ENV_NIGHTLY_SLOT", "TEST_ENV_PIN",
  "TEST_ENV_PROPOSED_FIX_TASK", "TEST_ENV_PROVE", "TEST_ENV_SETUP_RUN", "TICKET_UPDATE", "TRIGGER_SUBJECT", "USAGE_INDEX", "WEB_ACTIVE_COMPANY",
  "WORK_EVENT",
]);

export type RetentionAction = "keep" | "strip";

export function retentionFor(entityType: unknown): RetentionAction {
  return typeof entityType === "string" && CLOUD_TTL_KINDS.has(entityType) ? "keep" : "strip";
}

/** The item as Cloud stores it: the expiry removed unless the kind keeps one. */
export function withCloudRetention(item: StoredDocument): StoredDocument {
  if (!(INDEX_EXPIRY_ATTRIBUTE in item) || retentionFor(item.entityType) === "keep") return item;
  const kept: StoredDocument = { ...item };
  delete kept[INDEX_EXPIRY_ATTRIBUTE];
  return kept;
}

/** An update's steps as Cloud stores them. An update carries no entity type of its own, so a `set` of the expiry is kept only when `entityType` is known to keep one. */
function opsWithRetention(ops: readonly UpdateOp[], entityType: unknown): readonly UpdateOp[] {
  const setsKind = ops.find((op) => (op.op === "set" || op.op === "setIfAbsent") && op.path.length === 1 && op.path[0] === "entityType") as { value?: unknown } | undefined;
  const kind = setsKind?.value ?? entityType;
  if (retentionFor(kind) === "keep") return ops;
  return ops.filter((op) => !((op.op === "set" || op.op === "setIfAbsent" || op.op === "add") && op.path.length === 1 && op.path[0] === INDEX_EXPIRY_ATTRIBUTE));
}

export interface RetentionLog {
  stripped(entityType: string): void;
}

/**
 * The State table store as the core sees it in Cloud: every write passes `withCloudRetention`. Reads are untouched. `ttlAttribute` is still reported, so
 * a core reader that tests "is this past its time" keeps working on the kinds that keep an expiry.
 */
export function cloudRetentionStore(store: DocumentStore, log?: RetentionLog): DocumentStore {
  const note = (before: StoredDocument, after: StoredDocument): void => {
    if (log !== undefined && before !== after) log.stripped(typeof before.entityType === "string" ? before.entityType : "(none)");
  };
  const item = (value: StoredDocument): StoredDocument => {
    const kept = withCloudRetention(value);
    note(value, kept);
    return kept;
  };
  const step = (value: TransactItem): TransactItem => {
    if (value.kind === "put") return { ...value, item: item(value.item) };
    if (value.kind === "update") return { ...value, ops: opsWithRetention(value.ops, undefined) };
    return value;
  };
  return {
    get indexes() { return store.indexes; },
    ...(store.ttlAttribute === undefined ? {} : { ttlAttribute: store.ttlAttribute }),
    ...(store.changes === undefined ? {} : { changes: store.changes }),
    get: (key) => store.get(key),
    getMany: (keys) => store.getMany(keys),
    put: (request) => store.put({ ...request, item: item(request.item) }),
    update: (request) => store.update({ ...request, ops: opsWithRetention(request.ops, undefined) }),
    delete: (request) => store.delete(request),
    query: (request) => store.query(request),
    queryIndex: (request) => store.queryIndex(request),
    transact: (items) => store.transact(items.map(step)),
  };
}
