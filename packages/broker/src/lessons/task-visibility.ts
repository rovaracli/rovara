// Who may read the Team record's rows about a task: the task's Plan 5 visibility (design 4.4.2, "Rovara session -> the Plan 5 visibility"). It is the session's shares (`agent-sessions/shares.ts`)
// and the task's People list (`developer/task-people.ts`), NOT the C1 flag `task.shared` (that says the task was shared to a Slack channel). One reader for every emit point of Rovara's own
// events (a send-back, a remembered note, a plan outcome, a review outcome, the end of a task).
//
//   - a share with the whole company, or with THIS project, makes the task the project's: rows are project-wide, unless the People list is unreadable (the owner's alone) or denies anyone (then the people listed);
//   - otherwise the people it names (member shares and People entries that are not "denied") make it shared with that list, the owner first, at most 500;
//   - otherwise it is the owner's alone.
// Fail closed: a session, a share list or a People list that cannot be read is the owner's alone. A task that cannot be read, is another org's, or has no readable owner has nobody to record it
// for, so nothing is recorded (`undefined`).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { readSessionShares, readTaskPeople } from "../agent-sessions/access.js";
import { AgentSessionStore } from "../agent-sessions/store.js";
import { effectiveTaskOwner, isTaskTakenOver, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import type { TaskVisibility } from "../team-record/sources/rovara.js";

export const SHARED_WITH_MAX = 500;

type Table = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number };

/**
 * `strict` is for READS of the record (SRL-4): any failure to read the task, its session, the shares or the People list throws, and a People list that does not parse throws, instead of becoming "the owner's
 * alone" (which is right when recording, so the row is never wider than the truth, but would still show rows to the owner when nothing is known). A task that is gone or another company's is still `undefined`.
 */
export async function resolveTaskVisibility(table: Table, orgId: string, taskId: string, options: { strict?: boolean } = {}): Promise<TaskVisibility | undefined> {
  const strict = options.strict === true;
  let task: DeveloperTaskRecord | undefined;
  let owner: string;
  try {
    task = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
    if (task === undefined || task.orgId !== orgId) return undefined;
    owner = effectiveTaskOwner(task).developerId;
  } catch (error) {
    if (strict) throw error;
    return undefined;
  }
  const ownerOnly: TaskVisibility = { kind: "private", ownerDeveloperId: owner };
  try {
    const org = orgId;
    const session = await new AgentSessionStore(table).getForTask(org, task);
    if (session === undefined) {
      // A task that names a session (or a chain's) whose record is missing or does not parse is unreadable; a task with no session at all is the owner's alone.
      if (strict && (task.sessionId !== undefined || task.chain !== undefined)) throw new Error("team-record: the task's session can't be read");
      return ownerOnly;
    }
    const shares = await readSessionShares(table, org, session.sessionId);
    // The same order as the session's own access answer (`agent-sessions/access.ts`): the shares, THEN the People list, which wins. An unreadable list denies everyone (but org admins), a "denied"
    // entry denies that person, and the earlier owner of a taken-over task gets nothing from a People "owner" entry.
    const people = await readTaskPeople(table, taskId);
    if (people === "unreadable") {
      if (strict) throw new Error("team-record: the task's People list can't be read");
      return ownerOnly;
    }
    const denied = [...(people ?? [])].some(([, role]) => role === "denied");
    if (!denied && shares.some((share) => share.principal.kind === "org" || (share.principal.kind === "project" && share.principal.project === task.project))) return { kind: "shared" };
    const takenOver = isTaskTakenOver(task);
    const listed = new Set<string>();
    for (const share of shares) if (share.principal.kind === "member") listed.add(share.principal.developerId);
    for (const [developerId, role] of people ?? []) {
      if (role === "denied") listed.delete(developerId);
      else if (!(role === "owner" && takenOver)) listed.add(developerId);
    }
    listed.delete(owner);
    if (listed.size === 0) return ownerOnly;
    return { kind: "shared_with", developerIds: [owner, ...[...listed].sort()].slice(0, SHARED_WITH_MAX) };
  } catch (error) {
    if (strict) throw error;
    return ownerOnly;
  }
}
