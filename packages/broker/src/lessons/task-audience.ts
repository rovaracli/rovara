// LV-1 R1 / owner decision 31 (LESSON-TASK-AUDIENCE): for LESSONS, a task's audience is who can actually open its session. `agent-sessions/access.ts` gives every member of the task's project at least `view`
// of a task session, takes `view` away from a person the task's People list DENIES, and lets a share (the whole company, another project, one member) or a People entry (owner, commenter, viewer) ADD people. A
// share never narrows. So the audience of a task is:
//
//   roster(project) minus denied  +  the owner, member shares and People entries (minus denied)  [+ the whole company when shared with it, + another project's members when shared with that project]
//
// A lesson may reach an agent of a running task T only if EVERY person who can see T can see EVERY source task P of the lesson: audience(T) is a subset of audience(P), for each P (`audienceWithin`). A lesson may be
// shown to a PERSON if that person can open every source task (`inAudience`); and it may be NAMED where a whole project reads (a pull request) if every source task is open to the whole project (`openToWholeProject`).
// The audience is held as the few things that DIFFER between tasks (denials, named people, wider shares) plus a one-person roster check: the project's roster is never listed, because within one project it cancels out.
// Anything that cannot be read is "unknown" and the lesson is withheld. This is for lessons ONLY: the Team record's own resolver (`task-visibility.ts`, "an unshared task is the owner's alone") is unchanged, and so is every caller of it.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgRoleSchema, orgMemberKey, projectMemberKey, type OrgId } from "@agentx/contracts";
import { readSessionShares, readTaskPeople } from "../agent-sessions/access.js";
import { AgentSessionStore } from "../agent-sessions/store.js";
import { effectiveTaskOwner, isTaskTakenOver, taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { grantRoleOf } from "../developer/project-roles.js";

export interface LessonTaskAudience {
  project: string;
  /** People the task's People list denies: they can't open the task, whatever else says. */
  denied: ReadonlySet<string>;
  /** People who reach the task by name: its owner, member shares, People entries that are not "denied". Minus denied. */
  extras: ReadonlySet<string>;
  /** Shared with the whole company. */
  orgWide: boolean;
  /** Projects other than its own that the task is shared with. */
  otherProjects: ReadonlySet<string>;
  /**
   * Whether `person` is on the task's project roster now: an org owner or admin, or a member holding a grant. ONE person is read (their org member row, then their grant), never the whole roster: within one
   * project the roster is the same for every task, so a comparison of two tasks of a project only ever needs the few people who DIFFER. The answer is remembered for the rest of the request, and `signal` stops the reads.
   * Throws when it cannot be read.
   */
  onRoster(person: string, signal?: AbortSignal): Promise<boolean>;
}

/** Whether `person` can open a task with this audience. May throw (an unreadable roster entry). */
export async function inAudience(audience: LessonTaskAudience, person: string, signal?: AbortSignal): Promise<boolean> {
  if (audience.denied.has(person)) return false;
  return audience.orgWide || audience.extras.has(person) || await audience.onRoster(person, signal);
}

/** Decision 32: the task is visible to the whole project, with no People denial. (The project is the caller's to compare: `audience.project`.) */
export function openToWholeProject(audience: LessonTaskAudience): boolean {
  return audience.denied.size === 0;
}

/**
 * Whether EVERY person who can see `inner` can also see `outer` (audience(inner) is a subset of audience(outer)). Never wider than the truth: different projects, a denial of `outer` that `inner` does not repeat
 * (a person the lesson's task hides could still open the running one), a wider share, or a person who reaches `inner` by name but not `outer` all say no.
 *
 * Within one project the roster cancels out, so only the people that DIFFER are compared (audience(T) = roster minus T.denied, plus T's named people, plus its wider shares):
 *   1. everyone `outer` denies, `inner` also denies (so a roster member `inner` lets in is not denied by `outer`; this also covers people who open project tasks without a roster row: the project's Slack channel,
 *      an Auditor with a grant, a merged id);
 *   2. `inner`'s shares go no wider than `outer`'s (the company; other projects, unless `outer` is company-wide);
 *   3. everyone `inner` names (not denied by it) can open `outer`: named on it, `outer` is company-wide, or on the project's roster (one read per person, not the roster).
 * Throws when a person cannot be read.
 */
export async function audienceWithin(inner: LessonTaskAudience, outer: LessonTaskAudience, signal?: AbortSignal): Promise<boolean> {
  if (inner.project !== outer.project) return false;
  for (const person of outer.denied) if (!inner.denied.has(person)) return false;
  if (inner.orgWide && !outer.orgWide) return false;
  if (!outer.orgWide) for (const project of inner.otherProjects) if (!outer.otherProjects.has(project)) return false;
  for (const person of inner.extras) if (!await inAudience(outer, person, signal)) return false;
  return true;
}

type StateTable = { documentClient: { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> }; tableName: string; now: () => number };

/** The people whose roster rows were read during one request: one answer per (project, person). */
export type RosterMemo = Map<string, Promise<boolean>>;

/** The same table whose every read stops when `signal` aborts: no new read starts, and a read in flight is cut. */
function abortable(table: StateTable, signal: AbortSignal | undefined): StateTable {
  if (signal === undefined) return table;
  return { ...table, documentClient: { send: async (command, options) => {
    if (signal.aborted) throw new Error("lessons: stopped");
    return table.documentClient.send(command, { ...options, abortSignal: signal });
  } } };
}

type Item = Record<string, unknown>;
const getItem = async (table: StateTable, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** Whether `person` is on the project's roster, as `listProjectMembers` says (org owner and admin; a member holding a grant; an Auditor never), for one person. */
async function isOnRoster(table: StateTable, orgId: OrgId, project: string, person: string): Promise<boolean> {
  const member = await getItem(table, orgMemberKey(orgId, person));
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  if (!role.success || member?.["developerId"] !== person) return false;
  if (role.data === "owner" || role.data === "admin") return true;
  if (role.data !== "member") return false;
  return grantRoleOf(await getItem(table, projectMemberKey(orgId, person, project))) !== undefined;
}

/** The audience of one task, strictly. Throws when anything cannot be read; `undefined` for a task that is gone or another company's. `signal` stops the reads (a timeout). */
export async function resolveLessonTaskAudience(table: StateTable, orgId: OrgId, taskId: string, memo: RosterMemo = new Map(), signal?: AbortSignal): Promise<LessonTaskAudience | undefined> {
  const reads = abortable(table, signal);
  const task = (await getItem(reads, taskKey(taskId))) as DeveloperTaskRecord | undefined;
  if (task === undefined || task.orgId !== orgId) return undefined;
  const session = await new AgentSessionStore(reads).getForTask(orgId, task);
  // A task with no readable task session has no session access to follow: unknown, never the owner's alone.
  if (session === undefined || session.kind !== "task" || session.subject.kind !== "task" || session.project === undefined) throw new Error("lessons: the task's session can't be read");
  const project = session.project;
  const shares = await readSessionShares(reads, orgId, session.sessionId);
  const people = await readTaskPeople(reads, taskId);
  if (people === "unreadable") throw new Error("lessons: the task's People list can't be read");
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
  const onRoster = (person: string, later?: AbortSignal): Promise<boolean> => {
    const key = `${orgId}\u0000${project}\u0000${person}`;
    let known = memo.get(key);
    if (known === undefined) {
      const read = isOnRoster(abortable(table, later ?? signal), orgId, project, person);
      known = read;
      memo.set(key, read);
      // A failed or stopped read is not remembered: the next ask reads again.
      read.catch(() => { if (memo.get(key) === read) memo.delete(key); });
    }
    return known;
  };
  return { project, denied, extras, orgWide, otherProjects, onRoster };
}

/** The live audiences of tasks. A task missing from the answer, or mapped to `undefined`, is unknown. May throw: that reads as unknown for every task asked about. */
export interface LessonAudiencePort {
  /** `signal` aborts when the caller stops waiting: the port should start no new reads then. `memo` keeps the roster answers (one per person) for the rest of the request. */
  read(orgId: OrgId, taskIds: readonly string[], options?: { signal?: AbortSignal; memo?: RosterMemo }): Promise<ReadonlyMap<string, LessonTaskAudience | undefined>>;
}

const LOOKUP_PARALLEL = 8;

/** The State-table side. Every task is read strictly; one that cannot be read is unknown. */
export function tableLessonAudiencePort(table: StateTable): LessonAudiencePort {
  return {
    async read(orgId, taskIds, options) {
      const out = new Map<string, LessonTaskAudience | undefined>();
      const queue = [...new Set(taskIds)];
      const memo: RosterMemo = options?.memo ?? new Map<string, Promise<boolean>>();
      const worker = async (): Promise<void> => {
        for (let id = queue.shift(); id !== undefined && options?.signal?.aborted !== true; id = queue.shift()) {
          try { out.set(id, await resolveLessonTaskAudience(table, orgId, id, memo, options?.signal)); } catch { out.set(id, undefined); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(LOOKUP_PARALLEL, queue.length) }, worker));
      return out;
    },
  };
}

/**
 * The lesson-audience port rides on the task-visibility port the access check carries, so the shared access port (`team-record/access-port.ts`) and the Team record's port types stay exactly as they were.
 * A port without it (a test stub, an older wiring) gives no audiences, and every lesson that names a task is then withheld.
 */
export interface WithLessonAudiences { lessonAudiences: LessonAudiencePort }

export function withLessonAudiences<T extends object>(port: T, audiences: LessonAudiencePort): T & WithLessonAudiences {
  return Object.assign(Object.create(Object.getPrototypeOf(port) as object | null), port, { lessonAudiences: audiences }) as T & WithLessonAudiences;
}

export function lessonAudiencesOf(port: object | undefined): LessonAudiencePort | undefined {
  const found = (port as Partial<WithLessonAudiences> | undefined)?.lessonAudiences;
  return found !== undefined && typeof found.read === "function" ? found : undefined;
}
