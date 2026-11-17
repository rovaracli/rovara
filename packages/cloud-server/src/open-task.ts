// K2 (web task channel): opening a task by its Code id. Cloud's sessions exist only for the person who started the task, so a person Code lets
// read a task (a People co-owner, commenter or viewer) had no way to open it in Cloud. `POST /v1/app/tasks/{taskId}/open` answers the task's Cloud
// session, making it on the first open.
//
// The rules (web task channel plan 4.1):
//   - Code decides who may read the task: Cloud reads GET /v1/dev/tasks/{taskId} as the signed-in person FIRST, before it looks at its own store, so a
//     person Code refuses learns nothing from the answer (a session that exists answers the same as one that does not) and nothing is written.
//   - The task id is the path's, and is checked as a UUID. The project, the owner and the company never come from the request: the project from Code's
//     task, the owner from Code's People read of that task (below), the company from the signed-in session.
//   - One session per task: a conditional write (`once`) makes two openers at the same moment get the same session.
//   - Any refusal from Code (a 4xx from either read) answers the same fixed "no such session" words as a session Cloud does not hold. Code
//     being down (5xx, no answer) is not a refusal and passes through unchanged.
import { createHash } from "node:crypto";
import { CodeError } from "./code-client.js";
import { companyCaller, refused } from "./company-caller.js";
import type { RouteAnswer, RouteContext } from "./routes.js";
import { StoreConflict, newSessionId, type WorkSession } from "./work-sessions.js";

const TASK_VIEW = { "x-agentx-task-view": "2" };
const PEOPLE_MAX = 100;
const NAME_MAX = 80;
const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** The words for a task Code refuses, a task Cloud has no session for, and every other reason nothing is opened (SESSION_NOT_FOUND, as the session routes say). */
export const OPEN_REFUSED: RouteAnswer = { status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } } };

interface PeopleEntry { personId: string; name: string; you: boolean; effectiveRole: string | null }

/** Code's People read of the task (`{ view: { people } }`), checked strictly: an answer that is not this shape reads as no answer. */
function peopleOf(answer: unknown): PeopleEntry[] | undefined {
  const people = (answer as { view?: { people?: unknown } } | undefined)?.view?.people;
  if (!Array.isArray(people) || people.length > PEOPLE_MAX) return undefined;
  const entries: PeopleEntry[] = [];
  for (const raw of people) {
    const entry = raw as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null) return undefined;
    const { personId, name, you, effectiveRole } = entry;
    if (typeof personId !== "string" || !PERSON_ID.test(personId) || typeof name !== "string" || name.trim() === "" || name.length > NAME_MAX || typeof you !== "boolean") return undefined;
    if (effectiveRole !== null && effectiveRole !== "owner" && effectiveRole !== "commenter" && effectiveRole !== "viewer") return undefined;
    entries.push({ personId, name, you, effectiveRole });
  }
  return entries;
}

/** Code's task view names the task's own person (`task.owner`, Q7), checked strictly: a sign-in id and a readable name, or no owner (an older Code, or a task with no person owner). Never guessed from anything else. */
const SIGN_IN_ID = /^[0-9a-f]{64}$/u;
function codeOwnerOf(task: unknown): { developerId: string; name: string } | undefined {
  const owner = (task as { owner?: unknown } | undefined)?.owner;
  if (typeof owner !== "object" || owner === null || Array.isArray(owner) || Object.keys(owner).length !== 2) return undefined;
  const { developerId, name } = owner as { developerId?: unknown; name?: unknown };
  if (typeof developerId !== "string" || !SIGN_IN_ID.test(developerId) || typeof name !== "string" || name.trim() === "" || name.length > NAME_MAX) return undefined;
  return { developerId, name };
}

/** The statuses Code refuses a read with (bad id, not allowed, no such task, gone; a 401 is the sign-in ending, which the client handles). Any other answer (Code down, busy, rate limiting, the sign-in ended) is not a refusal and passes on. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 410]);
/** How long (ms) a first opener who lost the race waits before each of its re-reads for the winner's session (the winner's write may land a moment later). */
export const WINNER_WAITS_MS: readonly number[] = [0, 40, 120, 300];

/** A Code refusal is "no": undefined. Anything else that went wrong is not a refusal and passes on. */
async function readOrRefused<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CodeError && REFUSAL_STATUSES.has(error.status)) return undefined;
    throw error;
  }
}

/** A stand-in id for an owner who has not opened the task in Cloud: 64 hex, from Code's person id, matching no sign-in's developer id. */
const placeholderOwnerId = (personId: string): string => createHash("sha256").update(`cloud-task-owner\u0000${personId}`).digest("hex");

const opened = (context: RouteContext, record: WorkSession): RouteAnswer => ({
  status: 200, body: { sessionId: record.sessionId, sessionUrl: `${context.origin.replace(/\/+$/u, "")}/s/${record.sessionId}` },
});

export async function openTaskByCodeId(context: RouteContext): Promise<RouteAnswer> {
  const taskId = context.params[0]!.toLowerCase();
  // The person and their company are Code's access check made now (company-caller.ts), never the request's; a person Code names no company for opens nothing.
  const caller = await companyCaller(context);
  if (refused(caller)) return OPEN_REFUSED;
  const me = { developerId: caller.developerId, name: caller.name };
  const company = caller.companyId;
  // 1. Code's own read, as this person, before anything else is looked at.
  const read = await readOrRefused(() => context.client.json<{ task?: { taskId?: unknown; project?: unknown; owner?: unknown } }>(context.session, `/v1/dev/tasks/${encodeURIComponent(taskId)}?events=0`, { headers: TASK_VIEW }));
  const project = read?.task?.project;
  if (read === undefined || read.task?.taskId !== taskId || typeof project !== "string" || project === "") return OPEN_REFUSED;
  const codeOwner = codeOwnerOf(read.task);
  // 2. The session Cloud already holds for the task (the starter's, or one an earlier open made).
  const existing = await context.work.byTask(taskId);
  if (existing !== undefined) {
    // A session another company's person opened is not this person's, even if a Code that mixed companies let them read the task.
    if (existing.companyId !== undefined && existing.companyId !== company) return OPEN_REFUSED;
    if (existing.ownerUnresolved === true) {
      // Code names the owner on the task: the placeholder is replaced by the real person whoever opens (never the opener unless the opener is that person).
      if (codeOwner !== undefined) await replaceOwner(context, existing, codeOwner.developerId === me.developerId ? me : codeOwner);
      else await healOwner(context, existing, me);
    }
    return opened(context, existing);
  }
  // 3. First open: who owns the task, from Code's People read of it (a refusal or an unreadable answer opens nothing).
  let person: { developerId: string; name: string };
  let unresolved = false;
  if (codeOwner !== undefined) {
    // Code says who owns the task (its own person): no People read, no placeholder.
    person = codeOwner.developerId === me.developerId ? me : codeOwner;
  } else {
    // An older Code names no owner on the task: the owner is read from its People list, with a placeholder until the real owner opens.
    const people = peopleOf(await readOrRefused(() => context.client.json<unknown>(context.session, `/v1/dev/tasks/${encodeURIComponent(taskId)}/people`)));
    const owners = people?.filter((entry) => entry.effectiveRole === "owner") ?? [];
    const owner = owners.find((entry) => entry.you) ?? owners[0];
    if (owner === undefined) return OPEN_REFUSED;
    person = owner.you ? me : { developerId: placeholderOwnerId(owner.personId), name: owner.name };
    unresolved = !owner.you;
  }
  const record: WorkSession = {
    sessionId: newSessionId(), taskId, project, startedBy: person, owner: person, createdAt: context.now().toISOString(), revision: 1,
    companyId: company,
    ...(unresolved ? { ownerUnresolved: true as const } : {}),
  };
  try {
    await context.work.put(record, undefined, { once: true });
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
    // Another opener made the session since step 2 (or is writing it right now): this person gets that one, found by a few short re-reads.
    // A session this company's view does not show (another company's) never appears, and is no answer.
    for (const wait of WINNER_WAITS_MS) {
      if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
      const winner = await context.work.byTask(taskId);
      if (winner !== undefined) return opened(context, winner);
    }
    return OPEN_REFUSED;
  }
  return opened(context, record);
}

/** The owner opening a session someone else's open made: Code says they are an owner, so the record names them. Best effort; the open already succeeded. */
async function healOwner(context: RouteContext, record: WorkSession, me: { developerId: string; name: string }): Promise<void> {
  const people = peopleOf(await readOrRefused(() => context.client.json<unknown>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/people`)));
  if (people?.some((entry) => entry.you && entry.effectiveRole === "owner") !== true) return;
  await replaceOwner(context, record, me);
}

/** Code names the owner: a session made with a placeholder owner now names that person (in both places when the placeholder was also the starter). Best effort; the open already succeeded. */
async function replaceOwner(context: RouteContext, record: WorkSession, person: { developerId: string; name: string }): Promise<void> {
  const healed: WorkSession = { ...record, owner: person, ...(record.startedBy.developerId === record.owner.developerId ? { startedBy: person } : {}), revision: record.revision + 1 };
  delete healed.ownerUnresolved;
  try {
    await context.work.put(healed);
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
  }
}
