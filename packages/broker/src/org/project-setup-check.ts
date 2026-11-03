// Plan 2, Task 22: a project's setup check. A maintainer asks for the project's setup commands and then its test commands to run on a fresh
// workspace of theirs at the project's latest revision. Starting one writes, in ONE transaction: the workspace and its prepare (what a task start
// writes for its own), the project's META `setupCheck` (which workspace, which revision, when, by whom) and the request record that makes the
// request id replayable, plus (final review I3) the check's limit slot, its `SETUP_CHECK` record (which slot it holds) and its watch for the sweep.
// No model runs: no budget is asked. The slot is given back, and the workspace closed, when the check ends (`closeSetupCheck`).
//
// The status is never stored. `setupStateOf` derives it on every read from META and the check's workspace:
//   no `setupCheck` -> unchecked; a newer revision exists -> outdated; the workspace is PREPARING -> checking (failed after 50 minutes, the limit
//   the sweep fails a stalled check at); PREPARATION_FAILED -> failed, with the failing step read from the prepare's recorded error; anything else
//   -> ready. A workspace the check closed reads as the status it had when it closed (`closedFrom`).
import { QueryCommand, TransactWriteCommand, GetCommand, UpdateCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE, agentXError, formatCommandLine, projectMetaKey, redactText,
  type AppProjectSummary, type OrgId, type OrgKey, type PreparePins, type ProjectCommand,
} from "@agentx/contracts";
import { STUCK_SETUP_MS } from "../aws/stuck-setup.js";
import { chargeConflict, chargeItems, limitReached } from "../developer/limits.js";
import { CANDIDATE_CHECK_ENTITY, candidateCheckKey, candidateExpiry } from "./test-env-candidate.js";
import type { ProjectMetaItem } from "../developer/project-roles.js";
import type { WorkspaceCharge } from "../developer/task-records.js";

type Send = { send(command: unknown): Promise<unknown> };
type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
type Item = Record<string, unknown>;

export interface SetupCheckDependencies {
  documentClient: Send;
  tableName: string;
  /** Epoch milliseconds. */
  now: () => number;
}

/** What the status needs to know of the revision it is judged against: its number, and the commands a failing step is named from. */
export interface SetupCheckedDefinition {
  revision: number;
  setup: readonly ProjectCommand[];
  readiness: readonly ProjectCommand[];
}

/** How many characters of the failure reason the status keeps (after the stage and command). */
export const FAILED_REASON_MAX = 300;
const COMMAND_SHOWN_MAX = 120;
export const STALLED_STEP = "setup: did not finish within 50 minutes";
/** What the sweep records as a stalled check's prepare error: with the "setup: " the status adds, it reads as `STALLED_STEP`. */
export const STALLED_CHECK_ERROR = "did not finish within 50 minutes";

/** The partition the sweep reads: one watch per check, sorted by the check's start, so "older than 50 minutes" is one key range. */
export const SETUP_CHECK_WATCH_PK = "SETUP_CHECK_WATCH";
export const setupCheckWatchKey = (createdAt: string, workspaceId: string): OrgKey => ({ pk: SETUP_CHECK_WATCH_PK, sk: `${createdAt}#${workspaceId}` });
/** The check's own record in its workspace's partition: which slot it holds, and whether that was given back. */
export const setupCheckRecordKey = (workspaceId: string): OrgKey => ({ pk: `WORKSPACE#${workspaceId}`, sk: "SETUP_CHECK" });

/** What a refused limit says; the admission and the write that raced it say the same. */
export function setupCheckLimitMessage(full: "member" | "organization", limits: { member: number; organization: number }): string {
  return full === "member"
    ? `you have reached the limit of ${limits.member} open workspaces per person; close a task or wait for one to finish, then run the setup check again`
    : `this AgentX has reached its limit of ${limits.organization} open workspaces; close a task, or ask an admin, then run the setup check again`;
}

const first = (text: string, limit: number) => [...text].slice(0, limit).join("").trimEnd();
/** Text for a person's screen: redacted, on one line, with every control and format character (escapes, direction overrides) turned into a space. */
const oneLine = (text: string) => redactText(text).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();

async function getItem(deps: Send, tableName: string, key: OrgKey | { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await deps.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/**
 * The failing step as the app shows it: `"setup: npm ci - <reason>"` or `"test: npm test - <reason>"`. The stage and command come from the failure
 * the worker recorded (`setup step 0 (...)`, `readiness check 1 (...)`), looked up in the revision that was checked; a failure that names neither
 * (a clone, a devcontainer) is `"setup: <reason>"`. The reason is the first 300 characters of the recorded, redacted error, on one line.
 */
export function failedStepOf(error: string, definition: Pick<SetupCheckedDefinition, "setup" | "readiness">): string {
  const named = /^(setup step|readiness check) (\d{1,4}) \(/u.exec(error);
  const reason = first(oneLine(error), FAILED_REASON_MAX);
  if (named === null) return reason === "" ? "setup" : `setup: ${reason}`;
  const stage = named[1] === "setup step" ? "setup" : "test";
  const run = (stage === "setup" ? definition.setup : definition.readiness)[Number(named[2])];
  const shown = run === undefined ? "" : first(oneLine(formatCommandLine(run)), COMMAND_SHOWN_MAX);
  return `${stage}:${shown === "" ? "" : ` ${shown}`}${reason === "" ? "" : ` - ${reason}`}`;
}

/** The error the check's prepare recorded, or undefined when it recorded none (or the workspace has no prepare). */
async function recordedFailure(deps: SetupCheckDependencies, workspaceId: string): Promise<string | undefined> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `WORKSPACE#${workspaceId}`, ":prefix": "OPERATION#" },
    ConsistentRead: true,
  })) as { Items?: Item[] };
  const prepares = (response.Items ?? []).filter((item) => item.kind === "prepare" && typeof item.error === "string");
  const created = (item: Item) => (typeof item.createdAt === "string" ? item.createdAt : "");
  prepares.sort((a, b) => created(a).localeCompare(created(b)));
  const latest = prepares.at(-1);
  return typeof latest?.error === "string" ? latest.error : undefined;
}

/** The setup status of a project, derived from its META and the check's workspace on every read. */
export async function setupStateOf(deps: SetupCheckDependencies, meta: ProjectMetaItem | undefined, definition: SetupCheckedDefinition): Promise<AppProjectSummary["setup"]> {
  return setupStateOfCheck(deps, meta?.setupCheck, definition);
}

/** The status of one check (the project's own, or a proposal's candidate check): derived from the check's workspace on every read. */
export async function setupStateOfCheck(deps: SetupCheckDependencies, check: NonNullable<ProjectMetaItem["setupCheck"]> | undefined, definition: SetupCheckedDefinition): Promise<AppProjectSummary["setup"]> {
  if (check === undefined) return { status: "unchecked" };
  const checked = { checkedRevision: check.revision, checkedAt: check.startedAt };
  if (check.revision < definition.revision) return { status: "outdated", ...checked };
  const workspace = await getItem(deps.documentClient, deps.tableName, { pk: `WORKSPACE#${check.workspaceId}`, sk: "META" });
  if (workspace === undefined || typeof workspace.status !== "string") return { status: "unchecked" };
  // A closed workspace reads as it did when it closed; one closed with no record of that (never PREPARING, or failed) reads ready.
  const workspaceStatus = workspace.status === "CLOSED" && typeof workspace.closedFrom === "string" ? workspace.closedFrom : workspace.status;
  if (workspaceStatus === "PREPARING") {
    const started = Date.parse(check.startedAt);
    // A prepare nobody finished: it reads as failed, so the person is told and a new check may start. (A task's prepare has the stuck-setup sweep.)
    if (Number.isFinite(started) && deps.now() - started > STUCK_SETUP_MS) return { status: "failed", ...checked, failedStep: STALLED_STEP };
    return { status: "checking", ...checked };
  }
  if (workspaceStatus === "PREPARATION_FAILED") {
    const error = await recordedFailure(deps, check.workspaceId);
    return { status: "failed", ...checked, ...(error === undefined ? {} : { failedStep: failedStepOf(error, definition) }) };
  }
  return { status: "ready", ...checked };
}

/** Where a project's setup-check requests are remembered: its own partition, beside META and the revisions, under a prefix nothing else reads. */
const requestKey = (orgId: OrgId, project: string, requestId: string): OrgKey => ({ pk: projectMetaKey(orgId, project).pk, sk: `SETUP_CHECK_REQUEST#${requestId}` });

/** How long a request id is remembered: a day, as the project-creation and member requests are. After that the State table's TTL removes it. */
const REQUEST_SECONDS = 86_400;

/**
 * The stored outcome of a request id already used on this project, or undefined for a fresh one. A record past its expiry is gone as far as an id
 * is concerned (the TTL can lag). Another caller's id is IDEMPOTENCY_CONFLICT, so one person can neither read nor replay another's request.
 */
export async function setupCheckReplay(deps: SetupCheckDependencies, orgId: OrgId, project: string, requestId: string, actorId: string): Promise<{ workspaceId: string } | undefined> {
  const stored = await getItem(deps.documentClient, deps.tableName, requestKey(orgId, project, requestId));
  if (stored === undefined) return undefined;
  if (typeof stored[INDEX_EXPIRY_ATTRIBUTE] === "number" && stored[INDEX_EXPIRY_ATTRIBUTE] <= Math.floor(deps.now() / 1000)) return undefined;
  if (stored.by !== actorId) throw agentXError("IDEMPOTENCY_CONFLICT", "that request id was already used for a different request; use a new one");
  return { workspaceId: String(stored.workspaceId) };
}

export interface SetupCheckStart {
  orgId: OrgId;
  project: string;
  requestId: string;
  actorId: string;
  revision: number;
  /** The workspace the prepare creates, and the items that create it (a task start's own: workspace, default pointer, operation, outbox, membership). */
  workspaceId: string;
  /** When the prepare was created: the watch is keyed by it. */
  createdAt: string;
  preparation: TransactItems;
  /** The slot the check takes (the person's and the org's counters) and the limits it is taken under. The workspace's id is the holder. */
  charge: WorkspaceCharge;
  limits: { member: number; organization: number };
  /** The workspace of the `setupCheck` this start read in META (undefined when it read none): the write holds only while that is still the one there. */
  seenWorkspaceId: string | undefined;
  /**
   * TE-2: a CANDIDATE check of a test-environment proposal. It does not touch META's `setupCheck` (the project's own check): its record is kept under the proposal's digest and the settings revision, with the exact
   * command lists the workspace was prepared with. `seenWorkspaceId` is then the workspace of the earlier candidate record this start read.
   */
  candidate?: { digest: string; setup: readonly ProjectCommand[]; readiness: readonly ProjectCommand[]; origin?: "setup_run" | undefined; pins?: PreparePins | undefined };
}

/**
 * Starts the check: the slot, the prepare's items, the check's record and watch, the META `setupCheck` and the request record, in one transaction.
 * True when it committed; false when it was cancelled (another check, an archive or the same request id got in first: the caller reads again and
 * decides). A counter that filled since the caller read it is WORKSPACE_LIMIT. The META write also holds only while the project is not archived, so
 * a check never starts on a project archived since the caller looked.
 */
export async function commitSetupCheck(deps: SetupCheckDependencies, input: SetupCheckStart): Promise<boolean> {
  const at = new Date(deps.now());
  const seconds = Math.floor(at.getTime() / 1000);
  const check: NonNullable<ProjectMetaItem["setupCheck"]> = { workspaceId: input.workspaceId, revision: input.revision, startedAt: at.toISOString(), startedBy: input.actorId };
  const notArchived = { ConditionCheck: {
    TableName: deps.tableName,
    Key: projectMetaKey(input.orgId, input.project),
    ConditionExpression: "attribute_not_exists(#status) OR #status <> :archived",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":archived": "archived" },
  } };
  const candidateRecord = input.candidate === undefined ? undefined : { Put: {
    TableName: deps.tableName,
    Item: {
      ...candidateCheckKey(input.orgId, input.project, input.candidate.digest, input.revision), entityType: CANDIDATE_CHECK_ENTITY, orgId: input.orgId, project: input.project, digest: input.candidate.digest,
      workspaceId: input.workspaceId, revision: input.revision, startedAt: check.startedAt, startedBy: input.actorId, setup: [...input.candidate.setup], readiness: [...input.candidate.readiness], ...(input.candidate.origin === undefined ? {} : { origin: input.candidate.origin }), ...(input.candidate.pins === undefined ? {} : { pins: input.candidate.pins }),
      [INDEX_EXPIRY_ATTRIBUTE]: candidateExpiry(deps.now()),
    },
    // Only over the record this start read (or none, or one past its expiry that the TTL has not yet removed).
    ConditionExpression: input.seenWorkspaceId === undefined ? `attribute_not_exists(pk) OR ${INDEX_EXPIRY_ATTRIBUTE} <= :now` : "workspaceId = :seen",
    ExpressionAttributeValues: input.seenWorkspaceId === undefined ? { ":now": seconds } : { ":seen": input.seenWorkspaceId },
  } };
  const meta = { Update: {
    TableName: deps.tableName,
    Key: projectMetaKey(input.orgId, input.project),
    // A project registered before Plan 2 has no META: this makes one, as an archive does.
    UpdateExpression: "SET entityType = if_not_exists(entityType, :entity), #name = if_not_exists(#name, :name), #status = if_not_exists(#status, :active), createdAt = if_not_exists(createdAt, :at), createdBy = if_not_exists(createdBy, :unknown), setupCheck = :check",
    ConditionExpression: `(attribute_not_exists(#status) OR #status <> :archived) AND ${input.seenWorkspaceId === undefined ? "attribute_not_exists(setupCheck)" : "setupCheck.workspaceId = :seen"}`,
    ExpressionAttributeNames: { "#name": "name", "#status": "status" },
    ExpressionAttributeValues: {
      ":entity": "PROJECT_META", ":name": input.project, ":active": "active", ":archived": "archived", ":at": check.startedAt, ":unknown": "unknown", ":check": check,
      ...(input.seenWorkspaceId === undefined ? {} : { ":seen": input.seenWorkspaceId }),
    },
  } };
  const request = { Put: {
    TableName: deps.tableName,
    Item: { ...requestKey(input.orgId, input.project, input.requestId), entityType: "PROJECT_SETUP_CHECK_REQUEST", by: input.actorId, workspaceId: input.workspaceId, revision: input.revision, at: check.startedAt, [INDEX_EXPIRY_ATTRIBUTE]: seconds + REQUEST_SECONDS },
    // A record that has expired but is not yet deleted by the TTL does not stop the id being used again.
    ConditionExpression: `attribute_not_exists(pk) OR ${INDEX_EXPIRY_ATTRIBUTE} <= :now`,
    ExpressionAttributeValues: { ":now": seconds },
  } };
  const record = { Put: {
    TableName: deps.tableName,
    Item: { ...setupCheckRecordKey(input.workspaceId), entityType: "SETUP_CHECK", orgId: input.orgId, project: input.project, workspaceId: input.workspaceId, charge: input.charge, createdAt: input.createdAt },
    ConditionExpression: "attribute_not_exists(pk)",
  } };
  const watch = { Put: {
    TableName: deps.tableName,
    Item: { ...setupCheckWatchKey(input.createdAt, input.workspaceId), entityType: "SETUP_CHECK_WATCH", workspaceId: input.workspaceId },
  } };
  try {
    // The slot first, at positions 0 and 1: chargeConflict reads the cancellation reasons by position.
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...chargeItems(deps.tableName, input.charge, input.limits, input.workspaceId), ...input.preparation, record, watch, candidateRecord === undefined ? meta : notArchived, ...(candidateRecord === undefined ? [] : [candidateRecord]), request] }));
    return true;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionCanceledException") throw error;
    let full: Awaited<ReturnType<typeof chargeConflict>> | undefined;
    try {
      full = await chargeConflict(deps.documentClient, deps.tableName, input.charge, input.workspaceId, error);
    } catch (unmodeled) {
      // Not about the counters (or unreadable): the caller reads again and decides.
      if (unmodeled !== error) throw unmodeled;
    }
    // The counters are read again before a refusal: a cancellation only says an item's condition failed, and a counter that has room is no reason.
    if (full === "member" || full === "organization") {
      const reached = await limitReached(deps.documentClient, deps.tableName, input.charge, input.limits);
      if (reached !== undefined) throw agentXError("WORKSPACE_LIMIT", setupCheckLimitMessage(reached, input.limits));
    }
    return false;
  }
}

/**
 * TE-3: makes a passed CANDIDATE check the project's own setup check at `revision` (what a setup draft's save just made), so the same commands are not run twice. It only writes META's `setupCheck` when the
 * project is not archived and holds no check at `revision` or later (a newer check is never replaced). True when it wrote.
 */
export async function adoptCandidateAsProjectCheck(
  deps: SetupCheckDependencies, input: { orgId: OrgId; project: string; workspaceId: string; startedAt: string; actorId: string; revision: number },
): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: projectMetaKey(input.orgId, input.project),
      UpdateExpression: "SET setupCheck = :check",
      ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :archived) AND (attribute_not_exists(setupCheck) OR setupCheck.revision < :revision)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":check": { workspaceId: input.workspaceId, revision: input.revision, startedAt: input.startedAt, startedBy: input.actorId }, ":archived": "archived", ":revision": input.revision },
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
