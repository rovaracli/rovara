// Rovara Code (Plan 6 Task 9): what the project's setup status says to a start. A Rovara Code task always prepares its own new workspace at the project's latest revision, and the
// project's approved setup commands (Plan 2) run on it, on the worker, in the sandbox. Nothing here runs or defines a command: it reads the status that Plan 2's setup check keeps
// (`setupStateOf`, derived on every read, so it is never a stale copy) and decides the start's one reaction, for a version 2 (`"1.1.0"`) task only:
//   ready                                -> nothing is added;
//   unchecked, outdated, checking        -> one first event on the task's own prepare (`SETUP_NOT_CHECKED_NOTE`), written in the start's transaction;
//   failed                               -> the start is refused (`CONFIG_INVALID`, `setupFailedMessage`) before any budget, slot or workspace is touched.
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { readProjectMeta, type ProjectMetaReader } from "../developer/project-roles.js";
import { setupStateOf, type SetupCheckedDefinition } from "../org/project-setup-check.js";
import type { TransactItems } from "../aws/developer-task-actions.js";

/** The first event of a task started on a project whose setup is not known to work at its latest revision. */
export const SETUP_NOT_CHECKED_NOTE = "This project's setup hasn't been checked since it last changed. If the build fails to start, run a setup check.";

/** What a start is told when the project's last setup check failed; `step` is the status's own failing step (redacted, on one line, cut), or "setup" when none was recorded. */
export const setupFailedMessage = (step: string): string =>
  `This project's setup failed its last check (${step}). Fix the setup, or ask Rovara to draft it, before starting work.`;

/**
 * Reads the project's setup status as it stands and returns the note the start must write, or undefined when it writes none. A failed status throws the start's refusal. A read that
 * fails throws what it threw: the start does not go on without knowing (it fails closed, with nothing written).
 */
export async function setupNoteForStart(
  deps: ProjectMetaReader & { now: () => number },
  orgId: OrgId,
  project: string,
  definition: SetupCheckedDefinition,
): Promise<string | undefined> {
  const meta = await readProjectMeta(deps, orgId, project);
  const setup = await setupStateOf({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, meta, definition);
  switch (setup.status) {
    case "ready":
      return undefined;
    case "failed":
      throw agentXError("CONFIG_INVALID", setupFailedMessage(setup.failedStep ?? "setup"));
    case "unchecked":
    case "outdated":
    case "checking":
      return SETUP_NOT_CHECKED_NOTE;
  }
}

/**
 * The start's preparation items with `note` as the first event of the new prepare operation: the operation is written with its event sequence at 1 and the event item at sequence 1, so
 * the worker's own events (appended after the operation's current sequence) follow it, and the note exists exactly when the task does. The prepare is found by its kind; not finding
 * exactly one is a bug in the caller, so it throws rather than starting without the note.
 */
export function withFirstEvent(items: TransactItems, tableName: string, note: string, at: string): TransactItems {
  let operation: { id: string; workspaceId: string } | undefined;
  let found = 0;
  const changed = items.map((item) => {
    const put = item.Put;
    const record = put?.Item as { entityType?: unknown; kind?: unknown; id?: unknown; workspaceId?: unknown } | undefined;
    if (put === undefined || record?.entityType !== "OPERATION" || record.kind !== "prepare" || typeof record.id !== "string" || typeof record.workspaceId !== "string") return item;
    found += 1;
    operation = { id: record.id, workspaceId: record.workspaceId };
    return { Put: { ...put, Item: { ...put.Item, eventSequence: 1 } } };
  });
  if (found !== 1 || operation === undefined) throw new Error("the start's preparation has no single prepare operation to note");
  return [
    ...changed,
    { Put: {
      TableName: tableName,
      Item: {
        pk: `OPERATION#${operation.id}`, sk: `EVENT#${String(1).padStart(12, "0")}`, entityType: "EVENT",
        workspaceId: operation.workspaceId, operationId: operation.id, sequence: 1,
        type: "progress", timestamp: at, payload: { message: note },
      },
      ConditionExpression: "attribute_not_exists(pk)",
    } },
  ];
}
