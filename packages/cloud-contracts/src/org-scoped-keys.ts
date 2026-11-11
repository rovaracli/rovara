// Multi-tenancy: the DynamoDB keys whose names two orgs can share (a project called "web", a member
// grant on it, the workspace limits) or that list across tenants (the usage and failure indexes).
// Each one is prefixed with `orgScoped(orgId, ...)`, and nothing else builds these keys.
import { createHash } from "node:crypto";
import { type AgentId, type ApprovalId, canonicalInstant, type DeviceId, type OrgId, OrgIdSchema, type OrgKey, orgPk, orgScoped, type SessionId, teamRecordPk } from "@rovara-code/contracts";
import { scopeKey, type BudgetScope } from "./spend.js";

export type OrgSettingName = "WORKSPACE_LIMITS" | "BUDGET" | "BUDGET_SYNCED" | "SPEND_POLICY" | "LOCAL_AGENTS" | "TASK_STOP_POLICY" | "MODEL_SELECTION_POLICY" | "REVIEW_DEFAULT_NOTICE";

export function orgSettingsKey(orgId: OrgId, name: OrgSettingName): OrgKey {
  return { pk: orgScoped(orgId, "SETTINGS"), sk: name };
}

/**
 * The marker that says what the model proxy was last told: the org's monthly limit, or, given a developer, that member's.
 * It sits beside the org's settings, so one lookup says whether an upsert is due.
 */
export function budgetSyncedKey(orgId: OrgId, developerId?: string): OrgKey {
  return developerId === undefined ? orgSettingsKey(orgId, "BUDGET_SYNCED") : { pk: orgScoped(orgId, "SETTINGS"), sk: `BUDGET_SYNCED#${developerId}` };
}

/** The partition of an org's machine-time counters (one item per UTC month) and their once-keys. */
export function machineTimePk(orgId: OrgId): string {
  return orgScoped(orgId, "MACHINE_TIME");
}

/** The seconds of EC2 compute an org used in one UTC month (`month` is `YYYY-MM`). */
export function machineTimeMonthKey(orgId: OrgId, month: string): OrgKey {
  return { pk: machineTimePk(orgId), sk: month };
}

/** The marker that makes recording one workspace's one compute stop idempotent. */
export function machineTimeOnceKey(orgId: OrgId, workspaceId: string, stoppedAt: number): OrgKey {
  return { pk: machineTimePk(orgId), sk: `ONCE#${workspaceId}#${stoppedAt}` };
}

/** The partition of an org's open-compute markers: one item per workspace whose instance is running right now. */
export function openComputePk(orgId: OrgId): string {
  return orgScoped(orgId, "OPEN_COMPUTE");
}

export function openComputeKey(orgId: OrgId, workspaceId: string): OrgKey {
  return { pk: openComputePk(orgId), sk: workspaceId };
}

/** The one partition that lists every member merge whose moves have not been finished yet. A named exception to org scoping: ids and the org only. The sign-in function can write it (PutItem, nothing else). */
export const MEMBER_MERGE_QUEUE_PK = "MEMBER_MERGE_QUEUE";

/** The partition that lists every member removal whose moves have not been finished yet. The broker's alone: no other role is granted it by name. */
export const MEMBER_REMOVAL_QUEUE_PK = "MEMBER_REMOVAL_QUEUE";

/**
 * The marker of one member merge the broker has yet to finish, in the sparse `MEMBER_MERGE_QUEUE` partition, so one query lists them all oldest
 * first. Keyed `<instant>#<orgId>#<duplicateId>` and written by the sign-in function in the merge's own transaction. The item holds ids and
 * `orgId` only; whoever reads it checks `orgId` against the key. `at` is an instant.
 */
export function memberMergeQueueKey(at: string, orgId: OrgId, duplicateId: string): OrgKey {
  return { pk: MEMBER_MERGE_QUEUE_PK, sk: `${canonicalInstant(at)}#${orgId}#${duplicateId}` };
}

/** The marker of one member removal, in the broker-only `MEMBER_REMOVAL_QUEUE` partition; keyed like a merge's. Written in the removal's own transaction. */
export function memberRemovalQueueKey(at: string, orgId: OrgId, developerId: string): OrgKey {
  return { pk: MEMBER_REMOVAL_QUEUE_PK, sk: `${canonicalInstant(at)}#${orgId}#${developerId}` };
}

// ---- spend (Plan 3 Task 28): settings, top-ups, counters and the records the budget tasks keep

/** A project's AI settings: its monthly budget, who pays, its source order and planning limits. */
export function projectAiKey(orgId: OrgId, project: string): OrgKey {
  return { pk: orgScoped(orgId, `PROJECT_AI#${project}`), sk: "SETTINGS" };
}

/** Review groups (owner decision 9): a project's named groups of reviewers, one document per project (`review-groups/groups.ts`). */
export function reviewGroupsKey(orgId: OrgId, project: string): OrgKey {
  if (project === "" || project.includes("#") || /[\p{Cc}\p{Cf}]/u.test(project)) throw new RangeError("a project name can't be part of a key");
  return { pk: orgScoped(orgId, `REVIEW_GROUPS#${project}`), sk: "META" };
}

/** The partition of a project's review claims: one item per task, so a person's erase finds every claim they hold project by project (`review-groups/erase.ts`). */
export function reviewClaimsPk(orgId: OrgId, project: string): string {
  if (project === "" || project.includes("#") || /[\p{Cc}\p{Cf}]/u.test(project)) throw new RangeError("a project name can't be part of a key");
  return orgScoped(orgId, `REVIEW_CLAIMS#${project}`);
}

/** Who claimed a task's waiting review (`review-groups/claims.ts`), under its project's partition, kept with its revision so a stale claim, release or reassign is refused. */
export function reviewClaimKey(orgId: OrgId, project: string, taskId: string): OrgKey {
  if (!/^[0-9a-f-]{36}$/u.test(taskId)) throw new RangeError("a task id can't be part of a key");
  return { pk: reviewClaimsPk(orgId, project), sk: `TASK#${taskId}` };
}

/** What an admin added to one scope's limit for one UTC month (`month` is `YYYY-MM`): an item holding `amountUsd`, changed with ADD. */
export function topUpKey(orgId: OrgId, month: string, scope: BudgetScope): OrgKey {
  return { pk: orgScoped(orgId, `TOPUP#${month}`), sk: scopeKey(scope) };
}

/** A spend counter for one UTC month; `sk` names what is counted (`scopeKey` of its scope, or `AGENT_USAGE#<agentId>`, which has no limit). */
export function spendCounterKey(orgId: OrgId, month: string, sk: string): OrgKey {
  return { pk: orgScoped(orgId, `SPEND#${month}`), sk };
}

/** The once-per-month marker that a budget alert was sent: `scope` is a `scopeKey`, `level` how far along the budget is. */
export function budgetAlertKey(orgId: OrgId, month: string, scope: string, level: string): OrgKey {
  return { pk: orgScoped(orgId, `BUDGET_ALERT#${month}`), sk: `${scope}#${level}` };
}

/** What the broker knows of a key it minted at the model proxy, by the key's id. */
export function modelKeyKey(orgId: OrgId, keyId: string): OrgKey {
  return { pk: orgScoped(orgId, `MODEL_KEY#${keyId}`), sk: "META" };
}

/** A request for more spend, waiting for the person who can approve it. */
export function spendRequestKey(orgId: OrgId, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, `SPEND_REQUEST#${requestId}`), sk: "META" };
}

/** Lists the spend requests still open, oldest first (`createdAt` is an instant). */
export function openSpendRequestsKey(orgId: OrgId, createdAt: string, requestId: string): OrgKey {
  return { pk: orgScoped(orgId, "SPEND_REQUESTS#OPEN"), sk: `${canonicalInstant(createdAt)}#${requestId}` };
}

/**
 * Every org's open spend requests, oldest first, for the settlement run's escalation and expiry (the ids and the org only; the reader re-checks `orgId` on the
 * record it points at, as with `openApprovalKey`). `createdAt` is an instant.
 */
export function openSpendRequestDueKey(createdAt: string, orgId: OrgId, requestId: string): OrgKey {
  return { pk: "OPEN_SPEND_REQUESTS", sk: `${canonicalInstant(createdAt)}#${orgId}#${requestId}` };
}

/**
 * The one PENDING request of a kind for a subject (a task, or for `owner_cap` an agent or a person): put in the transaction that makes the request and
 * deleted in the one that ends it, so a second pause on the same subject finds the first request instead of making another.
 */
export function spendRequestSlotKey(orgId: OrgId, subject: string, kind: string): OrgKey {
  return { pk: orgScoped(orgId, `SPEND_REQUEST_FOR#${subject}`), sk: kind };
}

/** A task paused for a budget; `pauseKey` names what it waits for, so raising that budget finds every task to resume. */
export function pausedTasksKey(orgId: OrgId, pauseKey: string, taskId: string): OrgKey {
  return { pk: orgScoped(orgId, `PAUSED_TASKS#${pauseKey}`), sk: taskId };
}

/** The total of the monthly budgets of every active agent one person owns (`totalUsd`, changed with ADD in the same transaction as the agent). */
export function ownerBudgetKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, `OWNER_AGENT_BUDGET#${developerId}`), sk: "TOTAL" };
}

/**
 * The global index of model keys the broker still settles (ids and `orgId` only; the item names the org and the key, and a reader re-checks
 * `orgId` on the record it points at). `createdAt` is an instant. An item stays until its key was finalized a day ago.
 */
export function openModelKeysKey(createdAt: string, orgId: OrgId, keyId: string): OrgKey {
  return { pk: "OPEN_MODEL_KEYS", sk: `${canonicalInstant(createdAt)}#${orgId}#${keyId}` };
}

/** One settled amount of one key, in the month's ledger (`at` is an instant, `seq` counts the key's settlements). */
export function ledgerKey(orgId: OrgId, month: string, at: string, keyId: string, seq: number): OrgKey {
  return { pk: orgScoped(orgId, `LEDGER#${month}`), sk: `${canonicalInstant(at)}#${keyId}#${String(seq).padStart(6, "0")}` };
}

// ---- agent sessions (Plan 5 Task 1)

/** A key segment: never empty and never holds the `#` that separates segments, so one segment can't be read as two. */
function keyPart(value: string, what: string): string {
  if (value.length === 0 || value.includes("#") || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error(`${what} can't be empty or hold a "#" or a control character`);
  return value;
}

const SESSION_COUNTER_WIDTH = 6;

function paddedCounter(value: number, what: string): string {
  if (!Number.isInteger(value) || value < 0 || value >= 10 ** SESSION_COUNTER_WIDTH) throw new Error(`${what} is a whole number from 0 to ${String(10 ** SESSION_COUNTER_WIDTH - 1)}`);
  return String(value).padStart(SESSION_COUNTER_WIDTH, "0");
}

/** A registered Mac: its record and its command queue share this partition. */
function devicePk(orgId: OrgId, deviceId: DeviceId): string {
  return orgScoped(orgId, `DEVICE#${keyPart(deviceId, "a device id")}`);
}

export function deviceKey(orgId: OrgId, deviceId: DeviceId): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: "META" };
}

/** The list of one member's devices, for the per-member limit and the settings page. */
export function memberDevicesKey(orgId: OrgId, developerId: string, deviceId: DeviceId): OrgKey {
  return { pk: orgScoped(orgId, `MEMBER_DEVICES#${keyPart(developerId, "a developer id")}`), sk: keyPart(deviceId, "a device id") };
}

/** The count of commands a device was given: the next command is this plus one. Sits beside the commands (its sort key is not a command's) and expires with them. */
export function deviceCommandCounterKey(orgId: OrgId, deviceId: DeviceId): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: "COMMAND_SEQ" };
}

/** Which sessions run on a device, one item per session (`SESSION#<sessionId>`), so removing the device finds them without reading its owner's whole list. */
export function deviceSessionKey(orgId: OrgId, deviceId: DeviceId, sessionId: SessionId): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: `SESSION#${keyPart(sessionId, "a session id")}` };
}

/** A window's count of one kind of write by a Mac (`update`), in the device's own partition so it goes with the device. */
export function deviceRateKey(orgId: OrgId, deviceId: DeviceId, kind: "update"): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: `RATE#${kind}` };
}

/** A window's count of one kind of write by one person (`local_register`: local sessions started), in a partition of their own. */
export function personRateKey(orgId: OrgId, developerId: string, kind: "local_register"): OrgKey {
  return { pk: orgScoped(orgId, `PERSON_RATE#${keyPart(developerId, "a developer id")}`), sk: kind };
}

/** One command waiting for a device (stop, move to the cloud, a steering message); six digits keep them in order. */
export function deviceCommandKey(orgId: OrgId, deviceId: DeviceId, seq: number): OrgKey {
  return { pk: devicePk(orgId, deviceId), sk: `COMMAND#${paddedCounter(seq, "a command number")}` };
}

/** The two indexes of the TeamRecord table: GSI1 finds rows by their source (delete at the source), GSI2 by the person (erase). */
export const TEAM_RECORD_GSI1 = { index: "gsi1", partition: "gsi1pk" } as const;
export const TEAM_RECORD_GSI2 = { index: "gsi2", partition: "gsi2pk" } as const;
/** GSI5 is sparse: only rows that still hold raw text with an expiry carry it (`gsi5pk` one value per workspace, `textDueAt` the expiry as an ISO time), so the text-expiry job finds exactly the due rows. */
export const TEAM_RECORD_GSI5 = { index: "gsi5", partition: "gsi5pk", sort: "textDueAt" } as const;
export function recordTextDueIndexValue(orgId: OrgId): string {
  return `WS#${OrgIdSchema.parse(orgId)}#TEXTDUE`;
}
/** GSI4 finds rows by the source identity of their actor (a person with no developer id). */
export const TEAM_RECORD_GSI4 = { index: "gsi4", partition: "gsi4pk" } as const;
/** GSI3 finds rows by their scope (a Slack channel, a repository): a deleted channel, a membership change, a channel that turned private. */
export const TEAM_RECORD_GSI3 = { index: "gsi3", partition: "gsi3pk", sort: "gsi3sk" } as const;
/**
 * What GSI3 projects besides its keys (the table's own keys `pk` and `sk` come with it). The place scan is used by the tombstone fan-out and the audience changes only, so it
 * carries what they read and never an item's text. Search does not use this index. A new use of `byScope` that reads another attribute must add it here BEFORE the first deploy.
 */
export const TEAM_RECORD_GSI3_ATTRIBUTES = ["entityType", "tombstone", "id", "sourceRef", "audience", "factId", "createdAt", "scope", "system", "project"] as const;

const TEAM_RECORD_COUNTER_WIDTH = 12;
const teamRecordCounter = (value: number, what: string): string => {
  if (!Number.isInteger(value) || value < 0 || value >= 10 ** TEAM_RECORD_COUNTER_WIDTH) throw new Error(`${what} is a whole number below 10^${String(TEAM_RECORD_COUNTER_WIDTH)}`);
  return String(value).padStart(TEAM_RECORD_COUNTER_WIDTH, "0");
};

/** The first characters of the partition of any one workspace, for a walk of everything it holds (org close). */
export function teamRecordWorkspacePrefix(orgId: OrgId): string {
  return `WS#${OrgIdSchema.parse(orgId)}#`;
}

/** The workspace a record partition belongs to, or undefined for a key that is not one. */
export function orgOfTeamRecordPk(pk: string): OrgId | undefined {
  const parsed = OrgIdSchema.safeParse(/^WS#(org_[0-9a-z]{20})#P#/.exec(pk)?.[1]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A hash of a source's own id (so a "#" in it cannot move a key boundary): sha256 over the system, a NUL and the id, as 64 hex. The lake's `source_hash`
 * column is the same value, so a delete at a source reaches the hot row, the vector and the lake row by one key.
 */
export function teamRecordSourceHash(system: string, sourceId: string): string {
  if (system.length === 0 || system.includes("\u0000")) throw new Error("a source system can't be empty or hold a NUL");
  return createHash("sha256").update(`${system}\u0000${sourceId}`).digest("hex");
}

/** `REC#<time>#<id>`: a record event, in time order. `id` is the event's uuid. */
export function recordEventKey(orgId: OrgId, project: string | undefined, occurredAt: string, eventId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `REC#${canonicalInstant(occurredAt)}#${keyPart(eventId, "an event id")}` };
}
export const RECORD_EVENT_SK_PREFIX = "REC#";

/** The GSI1 partition value of every row that came from one source item: its record events and the derivation links of the facts built from it. */
export function recordSourceIndexValue(orgId: OrgId, system: string, sourceId: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#SRC#${keyPart(system, "a source system")}#${teamRecordSourceHash(system, sourceId)}`;
}
/**
 * The head of one source item (in the workspace partition): the version time of the newest version stored, its version, the LOWEST trust any version ever had, and where the
 * newest row is. It orders versions by source time (an older version arriving late is a no-op), says which row a newer version replaces, and answers the ingest lane's
 * "lowest trust this item ever had". Keyed by the source system and item id; the same hash as the lake's `source_hash`.
 */
export function recordItemHeadKey(orgId: OrgId, system: string, sourceId: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `ITEM#${teamRecordSourceHash(system, sourceId)}` };
}
/**
 * A place that was deleted or excluded (a channel, a repository, a whole workspace of one source: `slack:T1`). It covers every place under it (`slack:T1/C9`), is
 * permanent, and stops any later put under it. Saving a source row for the place again clears it.
 */
export function recordScopeMarkerKey(orgId: OrgId, scope: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `SCOPEDEL#${createHash("sha256").update(scope).digest("hex")}` };
}
/**
 * The access record of one ACCESS UNIT (a channel, a repository, one issue of a tracker: the unit of the source's own ACL), in the workspace partition. A small HEADER item
 * (visibility, whether it was seeded from a full list, the groups) plus one tiny item per person (`recordAccessMemberKey`), so a record has no size limit and a leave is one
 * conditional write. Reads check these for every hit, so a row's own snapshot (which can be stale) never grants more than they do.
 */
export function recordAccessKey(orgId: OrgId, scope: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `ACCESS#${createHash("sha256").update(scope).digest("hex")}` };
}
const accessPersonHash = (person: string): string => createHash("sha256").update(`access\u0000${person}`).digest("hex");
/** One person's entry in one unit's record: `ACCESS#<unit hash>#M#<person hash>` (the raw id is never in a key). */
export function recordAccessMemberKey(orgId: OrgId, scope: string, person: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `${recordAccessKey(orgId, scope).sk}#M#${accessPersonHash(person)}` };
}
/** Prefix of every person entry of one unit. */
export function recordAccessMemberPrefix(orgId: OrgId, scope: string): string {
  return `${recordAccessKey(orgId, scope).sk}#M#`;
}
/** The index item that lets an erase find a person's entries in every unit: `ACCESSP#<person hash>#<unit hash>`. */
export function recordAccessPersonKey(orgId: OrgId, person: string, scope: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `${recordAccessPersonPrefix(person)}${recordAccessKey(orgId, scope).sk.slice("ACCESS#".length)}` };
}
export function recordAccessPersonPrefix(person: string): string {
  return `ACCESSP#${accessPersonHash(person)}#`;
}
/** The erased marker of a source person id for access records: while it stands, no event or snapshot writes that id into any record again. */
export function recordAccessErasedKey(orgId: OrgId, person: string): OrgKey {
  return erasedPersonKey(orgId, { actorSourceHash: recordActorSourceHash("access", person) });
}
/** The places a scope sits under, itself first: `slack:T1/C9` -> `slack:T1/C9`, `slack:T1`. */
export function scopeAndAncestors(scope: string): string[] {
  const out = [scope];
  let current = scope;
  for (;;) {
    const at = current.lastIndexOf("/");
    if (at <= 0) return out;
    current = current.slice(0, at);
    out.push(current);
  }
}
/** A marker that one source item was deleted at its source (kept for a while, in the workspace partition), so a late retry of its create cannot bring it back. */
export function recordDeletedMarkerKey(orgId: OrgId, system: string, sourceId: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `DELETED#${teamRecordSourceHash(system, sourceId)}` };
}
/** The GSI1 partition value of the one source row (`SOURCE#`) of a scope: how a tap finds a scope's retention and audience without knowing its project. */
export function recordSourceConfigIndexValue(orgId: OrgId, source: string, scope: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#CFG#${teamRecordSourceHash(source, scope)}`;
}
/**
 * The hashes the lake keeps beside a row so it can be erased without free text in SQL (the lake's `actor_source_hash` and `scope_hash` columns). A person with no
 * developer id (an outsider, an unmapped Slack user) is erased by `recordActorSourceHash`; a place (a deleted channel or repository) by `recordScopeHash`.
 */
export function recordActorSourceHash(system: string, actorSourceId: string): string {
  return createHash("sha256").update(`actor\u0000${system}\u0000${actorSourceId}`).digest("hex");
}
/**
 * A developer id as the erase markers and the lake keep it: hashed, never plain. The lake's `actor_developer_id` columns hold this value and the lake-delete target of an erase
 * carries it, so an erase can find a person's lake rows without the id sitting in a queue item or a marker.
 */
export function recordDeveloperHash(developerId: string): string {
  return createHash("sha256").update(`developer\u0000${developerId}`).digest("hex");
}
export function recordScopeHash(scope: string): string {
  return createHash("sha256").update(`scope\u0000${scope}`).digest("hex");
}
/** The GSI4 partition value of every row made by one source identity (erase a person who has no developer id). */
export function recordActorSourceIndexValue(orgId: OrgId, system: string, actorSourceId: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#ACTORSRC#${recordActorSourceHash(keyPart(system, "a source system"), actorSourceId)}`;
}
/**
 * An erased person, kept for good (no expiry) so a backfill, a poller or an edit cannot bring them back. By developer id, or by the hash of a source identity
 * (`recordActorSourceHash`) for someone who never had a developer id.
 */
export function erasedPersonKey(orgId: OrgId, who: { developerId: string } | { actorSourceHash: string }): OrgKey {
  return { pk: teamRecordPk(orgId), sk: "developerId" in who ? `ERASED#dev#${recordDeveloperHash(keyPart(who.developerId, "a developer id"))}` : `ERASED#src#${keyPart(who.actorSourceHash, "a hash")}` };
}
/** Which vector bucket holds a workspace's index, written once when the workspace gets its index and read back from then on (a second bucket must never remap a workspace). */
export function workspaceVectorBucketKey(orgId: OrgId): OrgKey {
  return { pk: teamRecordPk(orgId), sk: "VECBUCKET" };
}
/** The top of a place: `slack:T1/C9` -> `slack:T1`; a place with no `/` is its own top. */
export function scopeRoot(scope: string): string {
  const at = scope.indexOf("/");
  return at <= 0 ? scope : scope.slice(0, at);
}
/**
 * The GSI3 partition value of every row under one top place (`slack:T1`, `github:repo`; a scope is already prefixed with its source). The sort value is the row's own
 * place, so one query finds a place AND every place under it (a tombstone of `slack:T1` reaches `slack:T1/C9`).
 */
export function recordScopeIndexValue(orgId: OrgId, scope: string): string {
  if (scope.length === 0) throw new Error("a scope can't be empty");
  return `WS#${OrgIdSchema.parse(orgId)}#SCOPE#${createHash("sha256").update(scopeRoot(scope)).digest("hex")}`;
}
/**
 * The GSI3 partition value of the PLACE rows (the source rows) under one top place. Finding the places below a place reads only these, so it is bounded by the number of
 * places and never by the number of stored items.
 */
export function recordPlaceIndexValue(orgId: OrgId, scope: string): string {
  return `${recordScopeIndexValue(orgId, scope)}#PLACES`;
}
/** The GSI2 partition value of every row a person's actions made (person erase). */
export function recordActorIndexValue(orgId: OrgId, developerId: string): string {
  return `WS#${OrgIdSchema.parse(orgId)}#ACTOR#${keyPart(developerId, "a developer id")}`;
}

export function recordFactKey(orgId: OrgId, project: string | undefined, factId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `FACT#${keyPart(factId, "a fact id")}` };
}
export const RECORD_FACT_SK_PREFIX = "FACT#";

/** A link from a source item to a fact distilled from it, so a delete at a source that stored no row (retention B) still finds its facts. */
export function recordDerivationKey(orgId: OrgId, project: string | undefined, system: string, sourceId: string, factId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `DERIV#${teamRecordSourceHash(system, sourceId)}#${keyPart(factId, "a fact id")}` };
}
export const RECORD_DERIVATION_SK_PREFIX = "DERIV#";
export function learnedSkillKey(orgId: OrgId, project: string, skillId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `SKILL#${keyPart(skillId, "a skill id")}` };
}
export function learnedSkillVersionKey(orgId: OrgId, project: string, skillId: string, version: number): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `SKILL#${keyPart(skillId, "a skill id")}#V#${teamRecordCounter(version, "a skill version")}` };
}
export function recordSourceKey(orgId: OrgId, project: string, system: string, scope: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `SOURCE#${keyPart(system, "a source system")}#${teamRecordSourceHash(system, scope)}` };
}
export const RECORD_SOURCE_SK_PREFIX = "SOURCE#";
export function memorySnapshotKey(orgId: OrgId, project: string, snapshotId: string): OrgKey {
  return { pk: teamRecordPk(orgId, project), sk: `SNAPSHOT#${keyPart(snapshotId, "a snapshot id")}` };
}
/** A queued delete of rows hidden at a source (a tombstone request the delete worker finishes), in the workspace's own partition. */
export function recordDeleteQueueKey(orgId: OrgId, at: string, requestId: string): OrgKey {
  return { pk: teamRecordPk(orgId), sk: `DELQ#${canonicalInstant(at)}#${keyPart(requestId, "a request id")}` };
}
export const RECORD_DELETE_QUEUE_SK_PREFIX = "DELQ#";

/**
 * Team record (wire-team-record): the directory of the workspaces that have written to the record, so the scheduled jobs (the delete worker, the raw-text expiry, the archiver) can reach every
 * workspace that has anything to delete. One small item per org, holding the org id and a time; written before the first record write of an org, removed when the org's record is erased.
 */
export const TEAM_RECORD_ORG_DIRECTORY_PK = "TEAM_RECORD_ORGS";
export function teamRecordOrgDirectoryKey(orgId: OrgId): { pk: string; sk: string } {
  return { pk: TEAM_RECORD_ORG_DIRECTORY_PK, sk: orgId };
}

/** An owner's immutable, expiring company cutover review (never a paid-work receipt). */
export function taskStopReviewKey(orgId: OrgId, reviewId: string): OrgKey {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(reviewId)) throw new Error("Invalid review id.");
  return { pk: orgScoped(orgId, "TASK_STOP_REVIEW"), sk: reviewId };
}

/** The company's runtime UI flags (lane U5): `ORG#<org>` / `UI_FLAGS`. One row, a map of known flag names to on/off plus the preview permission, fenced by `revision`. Absent until the company first changes one: everything is off. */
export function orgUiFlagsKey(orgId: OrgId): OrgKey {
  return { pk: orgPk(orgId), sk: "UI_FLAGS" };
}

/**
 * Agent publish requests (experience decision 24): the org's index of every request, newest last (`<createdAt>#<approvalId>`), which the request lists read. The
 * approval record is the request; this item names it so a list needs no scan of the approvals.
 */
export function agentPublicationsIndexKey(orgId: OrgId, createdAt: string, approvalId: ApprovalId): OrgKey {
  return { pk: orgScoped(orgId, "AGENT_PUBLICATIONS"), sk: `${canonicalInstant(createdAt)}#${keyPart(approvalId, "an approval id")}` };
}

/**
 * One agent's publish requests: `REQ#<createdAt>#<approvalId>` for each request (its history), and `PENDING#<target>` naming the request that waits for that target, so a
 * second request for the same agent and target is refused while the first waits (`target` is `company` or `project:<name>`).
 */
export function agentPublicationKey(orgId: OrgId, agentId: AgentId, item: { request: { createdAt: string; approvalId: ApprovalId } } | { pending: string }): OrgKey {
  const sk = "pending" in item ? `PENDING#${keyPart(item.pending, "a publish target")}` : `REQ#${canonicalInstant(item.request.createdAt)}#${keyPart(item.request.approvalId, "an approval id")}`;
  return { pk: orgScoped(orgId, `AGENT_PUBLICATION#${keyPart(agentId, "an agent id")}`), sk };
}

/** One person's favourite agents in one org (experience decision 23): the ordered ids and a revision, in one item. */
export function agentFavouritesKey(orgId: OrgId, developerId: string): OrgKey {
  return { pk: orgScoped(orgId, `AGENT_FAVOURITES#${keyPart(developerId, "a developer id")}`), sk: "META" };
}
