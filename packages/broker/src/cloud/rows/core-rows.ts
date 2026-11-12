// Convergence S0 ROWS: Cloud's readers of the records a task of Rovara Code's core leaves in Cloud's State table (readers before writers, plan 3.2).
//
// The core keeps some of a task's records under keys of its own. Cloud's pages and routes must read them before any core task exists, so a flip of the switch never
// shows a person an empty page. Per key, what was decided and why (the parity suite's normalize.ts names each as its D-table row):
//
//   D17 artifact       Cloud `WORKSPACE#<w>/ARTIFACT#<artifactId>`, core `WORKSPACE#<w>/ARTIFACT#<operationId>#<name>`.
//                      READERS READ BOTH. A worker's artifact is written once per operation and name, never moved or rewritten, and both shapes carry the same `id`, `operationId`,
//                      `name`, `mediaType` and `objectKey`; a move would rewrite immutable evidence rows for no gain. The by-prefix readers already match both (they filter on those
//                      attributes); the readers that ask for one artifact by id (`getArtifact`, the plan check's held answer) fall back to the id on the row.
//   D18 events         Cloud `OPERATION#<op>/EVENT#<12 digits>` (entityType EVENT), core `WORKSPACE#<w>/EVENT#<op>#<10 digits>` (entityType OPERATION_EVENT).
//                      READERS READ BOTH, on a miss: a Cloud task's events are where they always were (one query, as before); only an operation with none there is looked
//                      for under the workspace. Events are short-lived (14 days) and written all the time, so a move would chase a running task.
//   D19 verified files core only, `WORKSPACE#<w>/VERIFIED_FILES#<digest>`: the core's own cache of the changed files it read from the code host. No Cloud reader asks for it
//                      (Cloud's tracking keeps no such row), so there is nothing to read; it is a core-private row, retained and erased with its workspace partition.
//   D20 task end       Cloud-written `DEVTASK#<t>/TASK_END`: not read by shape but WRITTEN for a core task by the root's `taskEnded` handler (`coreTaskEndedHandler` below), so
//                      the end handlers (triggers, chains, agents, lessons) run once for a core task as for a Cloud one. The core calls its seam only on close, not on merge (open, Code).
//   D21 outcome keys   Cloud-written `DEVTASK#<t>/OUTCOME_KEYS#<round>` (the track record's pointer, written when a pull request opens). The core has no track record; a core task
//                      has no such row, and every Cloud reader of it treats "no pointer" as "nothing recorded" (outcome-hooks.ts reads a missing pointer as none). Stays Cloud-only until
//                      the lessons adoption (X2): a core task is not scored by the track record until then (reported, not hidden).
//   D3  limits         see `CORE_LIMIT_FAMILY` below.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { orgLimitKey, type OrgId } from "@rovara-code/contracts";

type Client = { send(command: unknown): Promise<unknown> };
export interface RowDeps { documentClient: Client; tableName: string }
type Row = Record<string, unknown>;

// ---- D17: artifacts ----

/** The key the core keeps a worker's artifact under. */
export const coreArtifactKey = (workspaceId: string, operationId: string, name: string) => ({ pk: `WORKSPACE#${workspaceId}`, sk: `ARTIFACT#${operationId}#${name}` });

async function queryPrefix(deps: RowDeps, pk: string, prefix: string, options: { limit?: number; newestFirst?: boolean; from?: string } = {}): Promise<Row[]> {
  const out = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, ConsistentRead: true,
    KeyConditionExpression: options.from === undefined ? "pk = :pk AND begins_with(sk, :prefix)" : "pk = :pk AND sk BETWEEN :from AND :to",
    ExpressionAttributeValues: options.from === undefined ? { ":pk": pk, ":prefix": prefix } : { ":pk": pk, ":from": options.from, ":to": `${prefix}￿` },
    ...(options.newestFirst ? { ScanIndexForward: false } : {}), ...(options.limit === undefined ? {} : { Limit: options.limit }),
  })) as { Items?: Row[] };
  return out.Items ?? [];
}

/** A core task's artifact by id: the row of the workspace whose `id` it is, among the rows that carry an operation and a name in their key (only the core's do). */
export async function findCoreArtifactRow(deps: RowDeps, workspaceId: string, artifactId: string): Promise<Row | undefined> {
  const rows = await queryPrefix(deps, `WORKSPACE#${workspaceId}`, "ARTIFACT#");
  return rows.find((row) => row["id"] === artifactId && typeof row["sk"] === "string" && /^ARTIFACT#[^#]+#.+/.test(row["sk"]));
}

/** One artifact of a workspace by its id, whichever shape its row has: Cloud's key first (a Cloud task's, one read as before), else the core's row. */
export async function findArtifactRow(deps: RowDeps, workspaceId: string, artifactId: string): Promise<Row | undefined> {
  const cloud = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: `ARTIFACT#${artifactId}` }, ConsistentRead: true })) as { Item?: Row }).Item;
  return cloud ?? await findCoreArtifactRow(deps, workspaceId, artifactId);
}

// ---- D18: operation events ----

/** The first sort key a core event of an operation can have, and the prefix of them all. */
export const coreEventPrefix = (operationId: string): string => `EVENT#${operationId}#`;

/** A core event row as the Cloud readers' `EVENT` row (the same attributes; only the entity name and the key differ). */
export const asCloudEvent = (row: Row): Row => ({ ...row, entityType: "EVENT" });

/**
 * The core's events of an operation, in Cloud's event shape, oldest first or newest first. `afterSequence` reads those with a higher sequence (a page cursor). Reads only when asked:
 * a Cloud task's events are read where they always were, and this runs for an operation that has none there.
 */
export async function coreOperationEvents(deps: RowDeps, workspaceId: string, operationId: string, options: { limit?: number; newestFirst?: boolean; afterSequence?: number } = {}): Promise<Row[]> {
  const prefix = coreEventPrefix(operationId);
  const rows = await queryPrefix(deps, `WORKSPACE#${workspaceId}`, prefix, {
    ...(options.limit === undefined ? {} : { limit: options.limit }), ...(options.newestFirst === true ? { newestFirst: true } : {}),
    ...(options.afterSequence === undefined ? {} : { from: `${prefix}${String(options.afterSequence).padStart(10, "0")}` }),
  });
  return rows.filter((row) => row["entityType"] === "OPERATION_EVENT" && typeof row["sequence"] === "number").map(asCloudEvent);
}

// ---- D20: the end of a core task ----

/** What the core's `taskEnded` seam tells (vendor core/task-flow/close.ts finishClose). */
export interface CoreTaskEndedEvent { orgId: string; taskId: string }

export interface CoreTaskEndedDeps {
  /** The task's record, as it is stored (the core's and Cloud's task records share `DEVTASK#<id>/META`). */
  readTask(taskId: string): Promise<Row | undefined>;
  /** Cloud's `onTaskEnded`, over the same table and handlers. */
  onTaskEnded(task: Row & { orgId: string }, outcome: "closed"): Promise<unknown>;
}

/**
 * The root's `taskEnded` handler for a core task: reads the task's record, gives Cloud's end bookkeeping a record in the shape it reads (`orgId`; the core names the company
 * `companyId` on some of its records, D7) and records the end as `closed` (the core calls the seam from a close). A task with no record, or of another company, tells nobody.
 */
export function coreTaskEndedHandler(deps: CoreTaskEndedDeps): (event: CoreTaskEndedEvent) => Promise<void> {
  return async (event) => {
    const task = await deps.readTask(event.taskId);
    if (task === undefined) return;
    const owner = typeof task["orgId"] === "string" ? task["orgId"] : typeof task["companyId"] === "string" ? task["companyId"] : undefined;
    if (owner !== event.orgId) return;
    await deps.onTaskEnded({ ...task, orgId: owner }, "closed");
  };
}

// ---- D3: the limits family ----

/**
 * D3, decided: a task started on the core charges the core's PERSON family, whoever started it and wherever (the Slack thread included): the person's counter
 * `DEVELOPER_LIMIT#<developerId>/MEMBER` with a `TASK#<id>` marker row, and the company's `ORG#<c>#DEVELOPER_LIMIT#ORGANIZATION` counter.
 *
 * Why this family and not Cloud's Slack workspace counters (`ORG#<c>#SLACK_LIMIT#<team>`):
 *   1. The core's start has no seam for the counter it charges (vendor core/task-flow/start.ts:137 builds it from the company and the person); the family cannot be chosen
 *      without a change to Code, and the task record keeps the charge it took (`task.charge`), so a release always gives the slot back where it was taken.
 *   2. One family per person: the person is the one thing a Slack user, a web sign-in, a script token and a laptop have in common. Cloud's Slack counter is per Slack
 *      workspace and per Slack user, so a person's tasks from the web and from Slack are two counters today (R6 joins them only for a linked developer on a Slack install).
 *   3. Cloud's own route-started tasks already charge this family (`developer/limits.ts` developerCharge without a team), so after the switch every task of a person counts in
 *      the same place; the Slack counters are Cloud-path-only and go with the Cloud path (DEL).
 *   4. Nothing of Cloud's is rewritten: no counter moves, no marker is written for Cloud's in-flight tasks (a move needs Cloud's writers on markers first: the held S2 move).
 * The cost: while Cloud-path tasks that were already running at the flip finish, a Slack-linked person's slots are split over the two families. The readers close that gap:
 * Cloud's start counts the person's core tasks too (`coreFamilyCounters`, their `TASK#` markers, read by `limitReached`), so a person cannot start past the limit on Cloud's
 * path with core tasks open. The company's counter is shared by Cloud's non-Slack tasks and the core's already. The core cannot see Cloud's Slack counters (vendor), so on the core's side a Slack-linked person may hold up to their limit in each family until those tasks finish.
 */
export const CORE_LIMIT_FAMILY = "person" as const;

/** The core family's counters for a person: where a core task of theirs is counted (what Cloud's start reads besides its own, the person's counter and its `TASK#` markers). */
export function coreFamilyCounters(orgId: OrgId, developerId: string): { member: { pk: string; sk: string }; organization: { pk: string; sk: string } } {
  return { member: { pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER" }, organization: orgLimitKey(orgId) };
}
