// Plan 2, Task 22: a project's setup check. A maintainer asks for the project's setup commands and then its test commands to run on a fresh
// workspace of theirs at the project's latest revision. Starting one writes, in ONE transaction: the workspace and its prepare (what a task start
// writes for its own), the project's META `setupCheck` (which workspace, which revision, when, by whom) and the request record that makes the
// request id replayable. Nothing else is written, and no model runs: no budget is asked and no limit slot is taken (the check is one prepare, and
// the idle reaper stops its machine like any other).
//
// The status is never stored. `setupStateOf` derives it on every read from META and the check's workspace:
//   no `setupCheck` -> unchecked; a newer revision exists -> outdated; the workspace is PREPARING -> checking (failed after 50 minutes, as the
//   stuck-setup sweep treats a task's prepare, because a check has no task for that sweep to find); PREPARATION_FAILED -> failed, with the failing
//   step read from the prepare's recorded error; anything else -> ready.
import { QueryCommand, TransactWriteCommand, GetCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE, agentXError, formatCommandLine, projectMetaKey, redactText,
  type AppProjectSummary, type OrgId, type OrgKey, type ProjectCommand,
} from "@agentx/contracts";
import { STUCK_SETUP_MS } from "../aws/stuck-setup.js";
import type { ProjectMetaItem } from "../developer/project-roles.js";

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
  const check = meta?.setupCheck;
  if (check === undefined) return { status: "unchecked" };
  const checked = { checkedRevision: check.revision, checkedAt: check.startedAt };
  if (check.revision < definition.revision) return { status: "outdated", ...checked };
  const workspace = await getItem(deps.documentClient, deps.tableName, { pk: `WORKSPACE#${check.workspaceId}`, sk: "META" });
  if (workspace === undefined || typeof workspace.status !== "string") return { status: "unchecked" };
  if (workspace.status === "PREPARING") {
    const started = Date.parse(check.startedAt);
    // A prepare nobody finished: it reads as failed, so the person is told and a new check may start. (A task's prepare has the stuck-setup sweep.)
    if (Number.isFinite(started) && deps.now() - started > STUCK_SETUP_MS) return { status: "failed", ...checked, failedStep: STALLED_STEP };
    return { status: "checking", ...checked };
  }
  if (workspace.status === "PREPARATION_FAILED") {
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
  preparation: TransactItems;
  /** The workspace of the `setupCheck` this start read in META (undefined when it read none): the write holds only while that is still the one there. */
  seenWorkspaceId: string | undefined;
}

/**
 * Starts the check: the prepare's items, the META `setupCheck` and the request record, in one transaction. True when it committed; false when it was
 * cancelled (another check, an archive or the same request id got in first: the caller reads again and decides). The META write also holds only
 * while the project is not archived, so a check never starts on a project archived since the caller looked.
 */
export async function commitSetupCheck(deps: SetupCheckDependencies, input: SetupCheckStart): Promise<boolean> {
  const at = new Date(deps.now());
  const seconds = Math.floor(at.getTime() / 1000);
  const check: NonNullable<ProjectMetaItem["setupCheck"]> = { workspaceId: input.workspaceId, revision: input.revision, startedAt: at.toISOString(), startedBy: input.actorId };
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
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [...input.preparation, meta, request] }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException") return false;
    throw error;
  }
}
