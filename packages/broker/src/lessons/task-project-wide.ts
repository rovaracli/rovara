// Lessons connect (fix 1, M4; owner decision 32, LESSON-PUBLISHABLE-SHARED): whether a task is, right now, visible to the whole project with no People denial, which is what the `sharedTask` mark on a lesson's source means.
// `agent-sessions/access.ts` gives every member of a task's project at least `view` of a task session, and only a People "denied" entry takes it away (a share adds people, it never narrows). So an ordinary task nobody
// shared is project-wide, exactly as decision 31 says; the Team record's own resolver (`task-visibility.ts`, "an unshared task is the owner's alone") is unchanged and is not used for this. Read live and STRICT: anything
// that cannot be read THROWS, and the caller reads that as "unknown". This is a coarse mark; publishing checks the live visibility of every source task again (another lane), so a "true" here is necessary, not sufficient.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { readTaskPeople } from "../agent-sessions/access.js";
import { AgentSessionStore } from "../agent-sessions/store.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";

type Table = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number };

/** True when the task's own project can open it and no one is denied; false when it is another company's or gone, has no task session, or any People entry denies someone. Throws when a record cannot be read. */
export async function resolveTaskProjectWide(table: Table, orgId: string, taskId: string): Promise<boolean> {
  const task = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
  if (task === undefined || task.orgId !== orgId) return false;
  const session = await new AgentSessionStore(table).getForTask(orgId, task);
  if (session === undefined) {
    // A task that names a session (or a chain's) whose record is missing or does not parse is unreadable; a task with no session at all has no session access to follow.
    if (task.sessionId !== undefined || task.chain !== undefined) throw new Error("lessons: the task's session can't be read");
    return false;
  }
  if (session.kind !== "task" || session.project !== task.project) return false;
  const people = await readTaskPeople(table, taskId);
  if (people === "unreadable") throw new Error("lessons: the task's People list can't be read");
  return ![...(people ?? [])].some(([, role]) => role === "denied");
}
