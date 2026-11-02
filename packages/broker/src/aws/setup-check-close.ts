// Final review I3: how a project setup check's workspace and limit slot end. A check takes a slot when it starts (commitSetupCheck) and holds it
// until `closeSetupCheck` gives it back in the same transaction that closes the workspace. Three things call it: the broker, right after the
// check's prepare reports (a check has nothing more to do on its machine, so it is closed at once); a new check, for the one it replaces; and the
// sweep (`sweepStuckSetupChecks`), for a check that never reported or whose close did not land. The check's `SETUP_CHECK` record says which slot
// it holds and whether it was given back, so a repeat of any of these changes nothing.
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { releaseItems } from "../developer/limits.js";
import type { WorkspaceCharge } from "../developer/task-records.js";
import { STALLED_CHECK_ERROR, SETUP_CHECK_WATCH_PK, setupCheckRecordKey, setupCheckWatchKey } from "../org/project-setup-check.js";
import { STUCK_SETUP_MS } from "./stuck-setup.js";

type Client = { send(command: unknown): Promise<unknown> };
type TransactItems = NonNullable<TransactWriteCommandInput["TransactItems"]>;
type Item = Record<string, unknown>;

/** What deletes a workspace's machine and volume: the broker's `deleteWorkspaceCompute`, or the reconciler's session deleter. */
export type DeleteWorkspaceCompute = (workspace: { id: string; deploymentMode: string }) => Promise<void>;

export type SetupCheckClose =
  /** The workspace is closed now (by this call or an earlier one), and the slot is back. */
  | "closed"
  /** Not a check's workspace (a task's, or a check from before checks held slots): nothing to do. */
  | "none"
  /** The check's prepare is still running (and not stalled), or the workspace is busy with something else: leave it. */
  | "busy";

const LIVE = ["ACCEPTED", "DISPATCHING", "RUNNING", "CANCEL_REQUESTED"];
const ATTEMPTS = 3;

interface CheckRecord { charge?: WorkspaceCharge; releasedAt?: unknown; createdAt?: unknown }

const isCancelled = (error: unknown): boolean => error instanceof Error && error.name === "TransactionCanceledException";

async function get(client: Client, tableName: string, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return ((await client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;
}

/** Fails a check's prepare that never reported, as the stuck-setup sweep fails a task's: the operation FAILED and the workspace PREPARATION_FAILED. False when a result landed first. */
async function failStalledPrepare(client: Client, tableName: string, workspaceId: string, workspace: Item, now: string): Promise<boolean> {
  const operationId = workspace.activeOperationId;
  if (typeof operationId !== "string") return false;
  const operation = await get(client, tableName, { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` });
  if (operation?.kind !== "prepare" || !LIVE.includes(String(operation.status)) || typeof operation.fence !== "number") return false;
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` },
        UpdateExpression: "SET #status = :failed, updatedAt = :now, #error = :error",
        ConditionExpression: "(#status = :accepted OR #status = :dispatching OR #status = :running OR #status = :cancelRequested) AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status", "#error": "error" },
        ExpressionAttributeValues: {
          ":failed": "FAILED", ":now": now, ":error": STALLED_CHECK_ERROR, ":fence": operation.fence,
          ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING", ":cancelRequested": "CANCEL_REQUESTED",
        },
      } },
      { Update: {
        TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" },
        UpdateExpression: "SET #status = :released, updatedAt = :now REMOVE activeOperationId, closeError",
        ConditionExpression: "activeOperationId = :operation AND fence = :fence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":released": "PREPARATION_FAILED", ":now": now, ":operation": operationId, ":fence": operation.fence },
      } },
    ] }));
    return true;
  } catch (error) {
    // A result landed first: it stands.
    if (isCancelled(error)) return false;
    throw error;
  }
}

/**
 * TE-4: whether a check that a newer change replaced may be stopped now. Its prepare is failed (the dispatcher claims only an ACCEPTED operation, so a prepare not yet claimed is never started; a RUNNING one has its machine
 * deleted by the close). One the dispatcher has claimed (DISPATCHING) may be starting a machine at this moment, which deleting now could miss, so it is left to finish (a check ends in 50 minutes at most, by its result or the sweep).
 */
async function mayStopPrepare(client: Client, tableName: string, workspaceId: string, workspace: Item): Promise<boolean> {
  const operationId = workspace.activeOperationId;
  if (typeof operationId !== "string") return true;
  const operation = await get(client, tableName, { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` });
  return operation?.status !== "DISPATCHING";
}

/**
 * Ends a check: the machine and volume go, then one transaction closes the workspace (remembering the status it had, which the project's setup
 * status reads), gives the slot back and drops the watch. `stalled` says the check has had its 50 minutes, so a prepare still running is failed
 * first. Idempotent: a closed workspace only has its slot given back if that was missed, and a released slot is never given back twice.
 * A failure to delete the compute throws, with nothing changed; the caller (or the sweep, next time) tries again.
 */
export async function closeSetupCheck(
  client: Client,
  tableName: string,
  workspaceId: string,
  options: { now: Date; stalled: boolean; deleteCompute: DeleteWorkspaceCompute; /** TE-4: a newer change replaced this check; end it even though it is not stalled. */ stop?: boolean },
): Promise<SetupCheckClose> {
  const now = options.now.toISOString();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const record = await get(client, tableName, setupCheckRecordKey(workspaceId)) as CheckRecord | undefined;
    if (record === undefined) return "none";
    let workspace = await get(client, tableName, { pk: `WORKSPACE#${workspaceId}`, sk: "META" });
    const created = typeof record.createdAt === "string" ? record.createdAt : now;
    const watch = setupCheckWatchKey(created, workspaceId);
    if (workspace === undefined) {
      await client.send(new DeleteCommand({ TableName: tableName, Key: watch }));
      return "closed";
    }
    if (workspace.status === "PREPARING") {
      if (!options.stalled && options.stop !== true) return "busy";
      if (!options.stalled && !await mayStopPrepare(client, tableName, workspaceId, workspace)) return "busy";
      if (!await failStalledPrepare(client, tableName, workspaceId, workspace, now)) return "busy";
      workspace = await get(client, tableName, { pk: `WORKSPACE#${workspaceId}`, sk: "META" });
      if (workspace === undefined) continue;
    }
    const status = String(workspace.status);
    if (status !== "CLOSED" && status !== "READY" && status !== "PREPARATION_FAILED") return "busy";
    if (status !== "CLOSED") await options.deleteCompute({ id: workspaceId, deploymentMode: String(workspace.deploymentMode) });
    const release: TransactItems = record.releasedAt === undefined && record.charge !== undefined ? [
      // First, at positions 0 and 1 (releaseItems' own convention).
      ...releaseItems(tableName, record.charge, workspaceId),
      { Update: {
        TableName: tableName, Key: setupCheckRecordKey(workspaceId),
        UpdateExpression: "SET releasedAt = :now", ConditionExpression: "attribute_not_exists(releasedAt)", ExpressionAttributeValues: { ":now": now },
      } },
    ] : [];
    try {
      await client.send(new TransactWriteCommand({ TransactItems: [
        ...release,
        ...(status === "CLOSED" ? [] : [{ Update: {
          TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" },
          UpdateExpression: "SET #status = :closed, closedAt = :now, updatedAt = :now, closedFrom = :from REMOVE activeOperationId, closeError",
          ConditionExpression: "#status = :from",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":closed": "CLOSED", ":now": now, ":from": status },
        } }]),
        { Delete: { TableName: tableName, Key: watch } },
      ] }));
      return "closed";
    } catch (error) {
      // Something moved meanwhile (a repeat call closed it, or released the slot): read again and judge afresh.
      if (!isCancelled(error)) throw error;
    }
  }
  return "busy";
}

/** Time one sweep spends closing checks. A larger backlog goes on in the next run; the reconciler's own limit is 4 minutes. */
const SWEEP_BUDGET_MS = 120_000;
const SWEEP_PAGE = 100;

/**
 * The sweep: every check whose watch is older than the 50 minutes a prepare is given is closed (a prepare still running is failed first), and
 * its slot given back. The oldest come first and every page is read (follow-up N4), so watches that cannot be closed, which stay at the head,
 * never starve the ones behind them; one watch failing never stops the rest. `kept` is a check that could not be closed now (its compute could
 * not be deleted, a result landed during the failing transaction, the workspace is busy): its watch stays, the next run tries again, and a
 * `stuck_setup_check.close_failed` or `stuck_setup_check.kept` log line names it (the reconciler counts `kept` for an alarm). `dropped` is a
 * watch of a check with no record. After `budgetMs` it stops (having handled at least one watch) and logs `stuck_setup_check.sweep_incomplete`.
 */
export async function sweepStuckSetupChecks(
  client: Client,
  tableName: string,
  now: Date,
  deleteCompute: DeleteWorkspaceCompute,
  log: (entry: Record<string, unknown>) => void = () => undefined,
  options: { budgetMs?: number } = {},
): Promise<{ closed: string[]; dropped: number; kept: number }> {
  const cutoff = new Date(now.getTime() - STUCK_SETUP_MS).toISOString();
  const deadline = Date.now() + (options.budgetMs ?? SWEEP_BUDGET_MS);
  const closed: string[] = [];
  let dropped = 0;
  let kept = 0;
  let handled = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const response = await client.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND sk < :cutoff",
      ExpressionAttributeValues: { ":pk": SETUP_CHECK_WATCH_PK, ":cutoff": cutoff },
      ConsistentRead: true,
      Limit: SWEEP_PAGE,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Array<{ pk: string; sk: string; workspaceId?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const watch of response.Items ?? []) {
      if (handled > 0 && Date.now() >= deadline) {
        log({ event: "stuck_setup_check.sweep_incomplete", closed: closed.length, dropped, kept });
        return { closed, dropped, kept };
      }
      handled += 1;
      const workspaceId = typeof watch.workspaceId === "string" ? watch.workspaceId : undefined;
      try {
        if (workspaceId === undefined) {
          await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: watch.pk, sk: watch.sk } }));
          dropped += 1;
          continue;
        }
        const outcome = await closeSetupCheck(client, tableName, workspaceId, { now, stalled: true, deleteCompute });
        if (outcome === "closed") {
          closed.push(workspaceId);
          log({ event: "stuck_setup_check.closed", workspaceId });
        } else if (outcome === "none") {
          await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: watch.pk, sk: watch.sk } }));
          dropped += 1;
        } else {
          kept += 1;
          log({ event: "stuck_setup_check.kept", workspaceId });
        }
      } catch (error) {
        kept += 1;
        log({ event: "stuck_setup_check.close_failed", workspaceId, error: error instanceof Error ? error.name : "unknown" });
      }
    }
    startKey = response.LastEvaluatedKey;
  } while (startKey !== undefined);
  return { closed, dropped, kept };
}
