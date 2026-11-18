// The People panel's routes (web task channel K3, plan 4.2): who is on a session's task, who may be added, role changes, adding a person and
// taking ownership. Each one asks Rovara Code's task People route as the signed-in person. Cloud is a pass-through: Code decides who may do what
// and its refusals reach the app unchanged (the handler passes every CodeError on). What Cloud adds is only this:
//   - the task id comes from Cloud's own record of the session (`ses_...` in the path), never from the browser;
//   - each body is checked at runtime against a strict schema, and a bad one gets fixed words that echo nothing and reaches Code never;
//   - Code's answers are read against the shape Cloud expects and projected to the fields the app reads (nothing else is passed on);
//   - the address of Code's confirm page is built here from Code's own base address, the task id and the proposal's id, never taken from Code's answer.
// Every write is a non-GET under /v1/web, so the handler's CSRF check (the `x-rovara-csrf` header against the sign-in's token) covers it already.
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import type { WorkSession } from "./work-sessions.js";

// Cloud's server keeps no runtime dependency on zod or the contracts package (it is bundled alone), so the checks below are written out. The app's own
// readers for these answers are in packages/contracts/src/app-session-people.ts (a test reads every answer here through them).
const SESSION = "(ses_[0-9a-z]{20})";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;
/** Code's TASK_PEOPLE_CANDIDATES_MAX and the most people one task's list holds. */
const CANDIDATES_MAX = 200;
const PEOPLE_MAX = 100;

const sessionNotFound: RouteAnswer = { status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } } };
const badBody: RouteAnswer = { status: 400, body: { error: { code: "CONFIG_INVALID", message: "That request isn't in the shape this page sends." } } };
/** Code answered something Cloud cannot read as a People answer: fixed words, nothing echoed. */
const unreadable: RouteAnswer = { status: 502, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent a People answer Cloud couldn't read." } } };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const isName = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 80;
const ROLES = ["owner", "commenter", "viewer", "denied"] as const;
const ADD_ROLES = ["owner", "commenter", "viewer"] as const;
const METHODS = ["slack", "oidc", "github", "cloud", "saml"] as const;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
/** True when `value` is an object holding exactly these keys (a body with any other member is refused, so nothing unexpected reaches Code). */
const exactly = (value: unknown, keys: readonly string[]): value is Obj => isObj(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

interface PeopleBody { requestId: string; expectedPeopleRevision: number; [other: string]: unknown }
/** A request body in the shape the page sends, or undefined. The keys are exactly the ones named: a task id or any other member is refused. */
function readBody(value: unknown, extra: Array<[string, (member: unknown) => boolean]>): PeopleBody | undefined {
  if (!exactly(value, ["requestId", "expectedPeopleRevision", ...extra.map(([key]) => key)])) return undefined;
  if (!isUuid(value["requestId"]) || !isRevision(value["expectedPeopleRevision"])) return undefined;
  if (!extra.every(([key, check]) => check(value[key]))) return undefined;
  return { requestId: value["requestId"], expectedPeopleRevision: value["expectedPeopleRevision"], ...Object.fromEntries(extra.map(([key]) => [key, value[key]])) };
}

interface PeopleView { revision: number; orphaned: boolean; people: Obj[]; canManage: boolean; canTakeOwnership: boolean }
/** Code's People view as the app reads it, or undefined when it is not in the shape Cloud expects. Only the named fields are kept (`addPeopleUrl`, a chat invitation, is never shown). */
function projectView(value: unknown): PeopleView | undefined {
  if (!isObj(value) || !isRevision(value["revision"]) || typeof value["orphaned"] !== "boolean" || typeof value["canManage"] !== "boolean" || typeof value["canTakeOwnership"] !== "boolean") return undefined;
  const list = value["people"];
  if (!Array.isArray(list) || list.length > PEOPLE_MAX) return undefined;
  const people: Obj[] = [];
  for (const person of list as unknown[]) {
    if (!isObj(person) || !isUuid(person["personId"]) || !isName(person["name"]) || !oneOf(ROLES, person["role"]) || typeof person["you"] !== "boolean") return undefined;
    const effective = person["effectiveRole"];
    if (effective !== null && !oneOf(ADD_ROLES, effective)) return undefined;
    people.push({
      personId: person["personId"], name: person["name"], role: person["role"], you: person["you"], effectiveRole: effective,
      // How the person signs in, when Code says; a word Cloud does not know is left out, not shown.
      ...(oneOf(METHODS, person["method"]) ? { method: person["method"] } : {}),
    });
  }
  return { revision: value["revision"], orphaned: value["orphaned"], people, canManage: value["canManage"], canTakeOwnership: value["canTakeOwnership"] };
}

/** The session's record, or undefined for a session Cloud does not have. Code decides, on its own route, whether the person may see its task. */
const recordOf = (context: RouteContext): Promise<WorkSession | undefined> => context.work.get(context.params[0]!);
const peoplePath = (record: WorkSession, suffix = "") => `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/people${suffix}`;

/** Code's confirm page for a proposal, on Code's own address. Undefined when the task id is not the id Code uses (nothing safe to link to). */
function confirmAddress(context: RouteContext, record: WorkSession, requestId: string): string | undefined {
  return UUID.test(record.taskId) && UUID.test(requestId) ? `${context.client.baseUrl}/review/${record.taskId.toLowerCase()}/task/people/confirm/${requestId.toLowerCase()}` : undefined;
}

/** Sends one change to Code and shapes its answer: done (the list now), or pending (where to confirm). */
async function change(context: RouteContext, record: WorkSession, suffix: string, body: PeopleBody): Promise<{ answer: RouteAnswer; committed: boolean }> {
  const raw = await context.client.json<unknown>(context.session, peoplePath(record, suffix), { method: "POST", body });
  const result = isObj(raw) && isObj(raw["change"]) ? raw["change"] : undefined;
  if (result?.["status"] === "COMMITTED") {
    const view = projectView(result["view"]);
    return view === undefined ? { answer: unreadable, committed: false } : { answer: { status: 200, body: { status: "COMMITTED", people: view } }, committed: true };
  }
  // The proposal answered must be the one asked for; where to confirm it is Cloud's own build.
  if (result?.["status"] === "PENDING" && isUuid(result["requestId"]) && result["requestId"].toLowerCase() === body.requestId.toLowerCase()
    && typeof result["expiresAt"] === "string" && !Number.isNaN(Date.parse(result["expiresAt"]))) {
    const address = confirmAddress(context, record, result["requestId"]);
    if (address !== undefined) return { answer: { status: 202, body: { status: "PENDING", requestId: result["requestId"], confirmUrl: address, expiresAt: result["expiresAt"] } }, committed: false };
  }
  return { answer: unreadable, committed: false };
}

/**
 * The task's readers (a Share made them, spec 067), as `{developerId, name, role}`. Only the owner may read them from Code, so this asks only when the People view says the
 * person manages People. Any refusal or unreadable answer gives none: the list is still the People list (a reader is an addition to it, never a reason it fails). A sign-in
 * that ended is not swallowed.
 */
async function sharedReaders(context: RouteContext, record: WorkSession): Promise<Obj[]> {
  let raw: unknown;
  try {
    raw = await context.client.json<unknown>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}/readers`);
  } catch (error) {
    if (error instanceof CodeError) return [];
    throw error;
  }
  const list = isObj(raw) ? raw["readers"] : undefined;
  if (!Array.isArray(list)) return [];
  const readers: Obj[] = [];
  for (const entry of list.slice(0, CANDIDATES_MAX) as unknown[]) {
    if (!isObj(entry) || typeof entry["developerId"] !== "string" || !DEVELOPER_ID.test(entry["developerId"]) || !isName(entry["name"]) || !oneOf(ADD_ROLES, entry["role"])) continue;
    readers.push({ developerId: entry["developerId"], name: entry["name"], role: entry["role"] });
  }
  return readers;
}

/**
 * Whether this person is a co-owner of the session's task by Code's People list now (DEC 254zzz39 (6), 254zzz44 (3)): an `owner` entry that is them (`you`). Asked only for someone
 * who is not the session's owner, before an owner's move Code itself checks again. A refusal or an answer that does not read is "no"; an ended sign-in is not swallowed.
 */
export async function coOwnerOf(context: RouteContext, record: WorkSession): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await context.client.json<unknown>(context.session, peoplePath(record));
  } catch (error) {
    if (error instanceof CodeError) return false;
    throw error;
  }
  const view = isObj(raw) ? projectView(raw["view"]) : undefined;
  return view !== undefined && view.people.some((person) => person["you"] === true && person["role"] === "owner");
}

export const PEOPLE_ROUTES: Route[] = [
  {
    // GET /v1/app/sessions/{id}/people: who is on the task, their roles, and what this person may do (Code's People view).
    method: "GET", path: new RegExp(`^/sessions/${SESSION}/people$`, "u"),
    answer: async (context) => {
      const record = await recordOf(context);
      if (record === undefined) return sessionNotFound;
      const raw = await context.client.json<unknown>(context.session, peoplePath(record));
      const view = isObj(raw) ? projectView(raw["view"]) : undefined;
      if (view === undefined) return unreadable;
      // D8: the people a Share made readers (Code's task readers) join the owner's list as viewers: one list of who is on the task.
      const sharedWith = view.canManage ? await sharedReaders(context, record) : [];
      return { status: 200, body: { people: view, ...(sharedWith.length === 0 ? {} : { sharedWith }) } };
    },
  },
  {
    // GET /v1/app/sessions/{id}/people/candidates: the people the owner may add (names and opaque ids, at most 200). Code answers only the owner.
    method: "GET", path: new RegExp(`^/sessions/${SESSION}/people/candidates$`, "u"),
    answer: async (context) => {
      const record = await recordOf(context);
      if (record === undefined) return sessionNotFound;
      const raw = await context.client.json<unknown>(context.session, peoplePath(record, "/candidates"));
      const found = isObj(raw) && isObj(raw["candidates"]) ? raw["candidates"] : undefined;
      const list = found?.["candidates"];
      if (found === undefined || typeof found["complete"] !== "boolean" || !Array.isArray(list) || list.length > CANDIDATES_MAX) return unreadable;
      const candidates: Array<{ developerId: string; name: string }> = [];
      for (const entry of list as unknown[]) {
        if (!isObj(entry) || typeof entry["developerId"] !== "string" || !DEVELOPER_ID.test(entry["developerId"]) || !isName(entry["name"])) return unreadable;
        candidates.push({ developerId: entry["developerId"], name: entry["name"] });
      }
      return { status: 200, body: { candidates, complete: found["complete"] } };
    },
  },
  {
    // POST /v1/app/sessions/{id}/people/role {requestId, expectedPeopleRevision, personId, role}: change a person's role (`denied` removes them).
    method: "POST", path: new RegExp(`^/sessions/${SESSION}/people/role$`, "u"),
    answer: async (context) => {
      const record = await recordOf(context);
      if (record === undefined) return sessionNotFound;
      const body = readBody(context.body, [["personId", isUuid], ["role", (role) => oneOf(ROLES, role)]]);
      if (body === undefined) return badBody;
      return (await change(context, record, "/role", body)).answer;
    },
  },
  {
    // POST /v1/app/sessions/{id}/people/add {requestId, expectedPeopleRevision, developerId, role}: add a person from the candidates list.
    method: "POST", path: new RegExp(`^/sessions/${SESSION}/people/add$`, "u"),
    answer: async (context) => {
      const record = await recordOf(context);
      if (record === undefined) return sessionNotFound;
      const body = readBody(context.body, [["developerId", (id) => typeof id === "string" && DEVELOPER_ID.test(id)], ["role", (role) => oneOf(ADD_ROLES, role)]]);
      if (body === undefined) return badBody;
      return (await change(context, record, "/add", body)).answer;
    },
  },
  {
    // POST /v1/app/sessions/{id}/people/take-ownership {requestId, expectedPeopleRevision}: the person becomes the task's owner once Code commits it.
    // A change still waiting for the person's confirmation in Code leaves Cloud's record of the owner as it is.
    method: "POST", path: new RegExp(`^/sessions/${SESSION}/people/take-ownership$`, "u"),
    answer: async (context) => {
      const record = await recordOf(context);
      if (record === undefined) return sessionNotFound;
      const body = readBody(context.body, []);
      if (body === undefined) return badBody;
      const result = await change(context, record, "/take-ownership", body);
      if (result.committed) {
        await context.work.put({ ...record, owner: { developerId: context.session.access.developerId, name: context.session.access.displayName }, revision: record.revision + 1 });
      }
      return result.answer;
    },
  },
];
