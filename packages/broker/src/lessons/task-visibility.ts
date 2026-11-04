// Who may read the Team record's rows about a task: the task's Plan 5 visibility (design 4.4.2, "Rovara session -> the Plan 5 visibility"). It is the session's shares (`agent-sessions/shares.ts`)
// and the task's People list (`developer/task-people.ts`), NOT the C1 flag `task.shared` (that says the task was shared to a Slack channel). One reader for every emit point of Rovara's own
// events (a send-back, a remembered note, a plan outcome, a review outcome, the end of a task).
//
//   - a share with the whole company, or with THIS project, makes the task the project's: rows are project-wide;
//   - otherwise the people it names (member shares and People entries that are not "denied") make it shared with that list, the owner first, at most 500;
//   - otherwise it is the owner's alone.
// Fail closed: a session, a share list or a People list that cannot be read is the owner's alone. A task that cannot be read, is another org's, or has no readable owner has nobody to record it
// for, so nothing is recorded (`undefined`).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { readSessionShares, readTaskPeople } from "../agent-sessions/access.js";
import { AgentSessionStore } from "../agent-sessions/store.js";
import { effectiveTaskOwner, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { TaskVisibility } from "../team-record/sources/rovara.js";

export const SHARED_WITH_MAX = 500;

type Table = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number };

export async function resolveTaskVisibility(table: Table, orgId: string, taskId: string): Promise<TaskVisibility | undefined> {
  let task: DeveloperTaskRecord | undefined;
  let owner: string;
  try {
    task = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
    if (task === undefined || task.orgId !== orgId) return undefined;
    owner = effectiveTaskOwner(task).developerId;
  } catch {
    return undefined;
  }
  const ownerOnly: TaskVisibility = { kind: "private", ownerDeveloperId: owner };
  try {
    const org = orgId;
    const session = await new AgentSessionStore(table).getForTask(org, task);
    if (session === undefined) return ownerOnly;
    const shares = await readSessionShares(table, org, session.sessionId);
    if (shares.some((share) => share.principal.kind === "org" || (share.principal.kind === "project" && share.principal.project === task.project))) return { kind: "shared" };
    const people = await readTaskPeople(table, taskId);
    if (people === "unreadable") return ownerOnly;
    const listed = new Set<string>();
    for (const share of shares) if (share.principal.kind === "member") listed.add(share.principal.developerId);
    for (const [developerId, role] of people ?? []) {
      if (role === "denied") listed.delete(developerId);
      else listed.add(developerId);
    }
    listed.delete(owner);
    if (listed.size === 0) return ownerOnly;
    return { kind: "shared_with", developerIds: [owner, ...[...listed].sort()].slice(0, SHARED_WITH_MAX) };
  } catch {
    return ownerOnly;
  }
}
