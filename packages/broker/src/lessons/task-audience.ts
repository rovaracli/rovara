// LV-1 R1 / owner decision 31 (LESSON-TASK-AUDIENCE): for LESSONS, a task's audience is who can actually open its session. `agent-sessions/access.ts` gives every member of the task's project at least `view`
// of a task session, takes `view` away from a person the task's People list DENIES, and lets a share (the whole company, another project, one member) or a People entry (owner, commenter, viewer) ADD people. A
// share never narrows. So the audience of a task is:
//
//   roster(project) minus denied  +  the owner, member shares and People entries (minus denied)  [+ the whole company when shared with it, + another project's members when shared with that project]
//
// A lesson may reach an agent (or screen) of a running task T only if EVERY person who can see T can see EVERY source task P of the lesson: audience(T) is a subset of audience(P), for each P (`audienceWithin`).
// Audiences are computed as sets here, from the same reads the session access uses (the session, its shares, the task's People list, the project's roster). Anything that cannot be read is "unknown" and
// the lesson is withheld. This is for lessons ONLY: the Team record's own resolver (`task-visibility.ts`, "an unshared task is the owner's alone") is unchanged, and so is every caller of it.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { OrgId } from "@agentx/contracts";
import { readSessionShares, readTaskPeople } from "../agent-sessions/access.js";
import { AgentSessionStore } from "../agent-sessions/store.js";
import { effectiveTaskOwner, isTaskTakenOver, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { listProjectMembers, type ProjectMembersDependencies } from "../org/project-members.js";

/** The most people one audience names. A task past it (its roster or its lists) reads as unknown. */
export const AUDIENCE_PEOPLE_MAX = 5_000;

export interface LessonTaskAudience {
  project: string;
  /** The project's members now (grants, and org owners and admins). */
  roster: ReadonlySet<string>;
  /** People the task's People list denies: they can't open the task, whatever else says. */
  denied: ReadonlySet<string>;
  /** People who reach the task by name: its owner, member shares, People entries that are not "denied". Minus denied. */
  extras: ReadonlySet<string>;
  /** Shared with the whole company. */
  orgWide: boolean;
  /** Projects other than its own that the task is shared with. */
  otherProjects: ReadonlySet<string>;
}

/** Whether `person` can open a task with this audience. */
export function inAudience(audience: LessonTaskAudience, person: string): boolean {
  return !audience.denied.has(person) && (audience.orgWide || audience.roster.has(person) || audience.extras.has(person));
}

/**
 * Whether EVERY person who can see `inner` can also see `outer` (audience(inner) is a subset of audience(outer)). Never wider than the truth: different projects, a denial of `outer` that `inner` does not
 * repeat (a person the lesson's task hides could still open the running one), a wider share, or a person who reaches `inner` but not `outer` all say no.
 */
export function audienceWithin(inner: LessonTaskAudience, outer: LessonTaskAudience): boolean {
  if (inner.project !== outer.project) return false;
  for (const person of outer.denied) if (!inner.denied.has(person)) return false;
  if (inner.orgWide && !outer.orgWide) return false;
  if (!outer.orgWide) for (const project of inner.otherProjects) if (!outer.otherProjects.has(project)) return false;
  for (const person of inner.roster) if (!inner.denied.has(person) && !inAudience(outer, person)) return false;
  for (const person of inner.extras) if (!inAudience(outer, person)) return false;
  return true;
}

type StateTable = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number };

/** The project rosters read during one request: a project is listed once. */
export type RosterMemo = Map<string, Promise<ReadonlySet<string>>>;

/** The audience of one task, strictly. Throws when anything cannot be read; `undefined` for a task that is gone or another company's. */
export async function resolveLessonTaskAudience(table: StateTable, orgId: OrgId, taskId: string, memo: RosterMemo = new Map()): Promise<LessonTaskAudience | undefined> {
  const task = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
  if (task === undefined || task.orgId !== orgId) return undefined;
  const session = await new AgentSessionStore(table).getForTask(orgId, task);
  // A task with no readable task session has no session access to follow: unknown, never the owner's alone.
  if (session === undefined || session.kind !== "task" || session.subject.kind !== "task" || session.project === undefined) throw new Error("lessons: the task's session can't be read");
  const project = session.project;
  const shares = await readSessionShares(table, orgId, session.sessionId);
  const people = await readTaskPeople(table, taskId);
  if (people === "unreadable") throw new Error("lessons: the task's People list can't be read");
  const key = `${orgId}\u0000${project}`;
  let listed = memo.get(key);
  if (listed === undefined) {
    listed = listProjectMembers(table as ProjectMembersDependencies, orgId, project).then((rows) => {
      if (rows.length > AUDIENCE_PEOPLE_MAX) throw new Error("lessons: the project roster is too large to compare");
      return new Set(rows.map((row) => row.developerId));
    });
    memo.set(key, listed);
  }
  const roster = await listed;
  const denied = new Set<string>();
  for (const [developerId, role] of people ?? []) if (role === "denied") denied.add(developerId);
  const extras = new Set<string>([effectiveTaskOwner(task).developerId]);
  const takenOver = isTaskTakenOver(task);
  let orgWide = false;
  const otherProjects = new Set<string>();
  for (const share of shares) {
    const principal = share.principal;
    if (principal.kind === "org") orgWide = true;
    else if (principal.kind === "project") { if (principal.project !== project) otherProjects.add(principal.project); }
    else extras.add(principal.developerId);
  }
  for (const [developerId, role] of people ?? []) if (role !== "denied" && !(role === "owner" && takenOver)) extras.add(developerId);
  for (const person of denied) extras.delete(person);
  if (extras.size > AUDIENCE_PEOPLE_MAX) throw new Error("lessons: the task names too many people to compare");
  return { project, roster, denied, extras, orgWide, otherProjects };
}

/** The live audiences of tasks. A task missing from the answer, or mapped to `undefined`, is unknown. May throw: that reads as unknown for every task asked about. */
export interface LessonAudiencePort {
  /** `signal` aborts when the caller stops waiting: the port should start no new reads then. `memo` keeps a project's roster for the rest of the request. */
  read(orgId: OrgId, taskIds: readonly string[], options?: { signal?: AbortSignal; memo?: RosterMemo }): Promise<ReadonlyMap<string, LessonTaskAudience | undefined>>;
}

const LOOKUP_PARALLEL = 8;

/** The State-table side. Every task is read strictly; one that cannot be read is unknown. */
export function tableLessonAudiencePort(table: StateTable): LessonAudiencePort {
  return {
    async read(orgId, taskIds, options) {
      const out = new Map<string, LessonTaskAudience | undefined>();
      const queue = [...new Set(taskIds)];
      const memo: RosterMemo = options?.memo ?? new Map<string, Promise<ReadonlySet<string>>>();
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined && options?.signal?.aborted !== true; id = queue.shift()) {
          try { out.set(id, await resolveLessonTaskAudience(table, orgId, id, memo)); } catch { out.set(id, undefined); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(LOOKUP_PARALLEL, queue.length) }, worker));
      return out;
    },
  };
}

/**
 * The lesson-audience port rides on the task-visibility port the access check carries, so the shared access port (`team-record/access-port.ts`) and the Team record's port types stay exactly as they were.
 * A port without it (a test stub, an older wiring) gives no audiences, and the running task then reads as nobody in particular.
 */
export interface WithLessonAudiences { lessonAudiences: LessonAudiencePort }

export function withLessonAudiences<T extends object>(port: T, audiences: LessonAudiencePort): T & WithLessonAudiences {
  return Object.assign(Object.create(Object.getPrototypeOf(port) as object | null), port, { lessonAudiences: audiences }) as T & WithLessonAudiences;
}

export function lessonAudiencesOf(port: object | undefined): LessonAudiencePort | undefined {
  const found = (port as Partial<WithLessonAudiences> | undefined)?.lessonAudiences;
  return found !== undefined && typeof found.read === "function" ? found : undefined;
}
