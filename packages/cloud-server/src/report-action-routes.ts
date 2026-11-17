// The Cost and time page's actions (Feature A, lane L4-CR4): New feature, Rename, Merge into, Mark done or reopen, and Move to feature. Five routes that pass the change to Rovara Code's own routes
// (Code PR #913, packages/contracts/src/cost-report.ts there) as the signed-in person, with their own token:
//
//   POST /v1/app/org/report/features                      { name }            company owner or admin
//   POST /v1/app/org/report/features/{featureId}/rename   { name }            company owner or admin
//   POST /v1/app/org/report/features/{featureId}/merge    { into }            company owner or admin
//   POST /v1/app/org/report/features/{featureId}/state    { state }           company owner or admin
//   POST /v1/app/tasks/{taskId}/feature                   { feature: id|null }  the task's starter files it once; a project maintainer, owner or admin moves it
//
// Cloud is a pass-through. CODE DECIDES who may and which company: the company is the one Code's access check names for the person's token, never a body member, query, header or cookie, and Code
// re-checks the role and the company on its own route. What Cloud adds:
//   - the feature routes are refused for a person who is not a company owner or admin without asking Code (the same check the reads make); the move route is Code's to decide (a task's starter and a
//     project maintainer may move a task, and Cloud does not know either);
//   - each body is checked at runtime against its exact shape (no other member is forwarded, so no company, person or tracker link goes through) and a bad one gets fixed words and never reaches Code;
//   - a path id is checked against Code's own id shapes, so nothing else can be put in the path Cloud calls;
//   - Code's answer is read strictly and only the fields the page draws are sent on (a feature's id, name and state; a task's id and feature);
//   - Code's refusals are worded here, never echoed: the five sentences Code fixes (name taken, too many features, feature is done, cannot merge, changed while saving) and the maintainer rule
//     each get Cloud's own fixed sentence; anything else Code says is one generic sentence. An ended sign-in is the handler's.
// Every write is a non-GET under /v1/web, so the handler's CSRF check covers it already. Code writes the audit record of each change (who and when); Cloud keeps none of its own.
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import { FEATURE_ID, FEATURE_NAME_MAX, NAME_UNSAFE, REPORT_WORDS, TASK_ID, readFeature } from "./report-routes.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

const word = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
/** Every answer these routes give other than success. Fixed words: nothing the request carried and nothing Code worded is echoed. */
export const ACTION_WORDS = Object.freeze({
  notAdmin: word(403, "FORBIDDEN", "Only a company owner or admin can change features."),
  badBody: word(400, "CONFIG_INVALID", "That change isn't in the shape this page sends."),
  taskGone: word(404, "NOT_FOUND", "That task doesn't exist, or you can't move it."),
  needsMaintainer: word(403, "FORBIDDEN", "Only a project maintainer, owner or admin can move a task that already has a feature."),
  nameTaken: word(400, "CONFIG_INVALID", "A feature with that name already exists."),
  limit: word(400, "CONFIG_INVALID", "The company has as many features as it can hold. Merge or reuse one."),
  isDone: word(400, "CONFIG_INVALID", "That feature is done. Reopen it first."),
  cannotMerge: word(400, "CONFIG_INVALID", "A feature can't be merged into itself or into one already merged away."),
  conflict: word(409, "CONFIG_INVALID", "The feature changed while you were saving. Try again."),
  refused: word(400, "CONFIG_INVALID", "Rovara Code didn't accept that change."),
  notConnected: word(501, "NOT_ON_CODE_YET", "Changing features isn't connected to Rovara Code yet."),
  unavailable: word(503, "RUNTIME_UNAVAILABLE", "That change couldn't be made just now. Try again."),
  unreadable: word(502, "RUNTIME_UNAVAILABLE", "Rovara Code sent an answer Cloud couldn't read."),
});

/** Code's own sentences (cost-report.ts there), matched exactly: any other text from Code is not one of them. */
const CODE_SENTENCES: ReadonlyArray<readonly [string, RouteAnswer]> = [
  ["A feature with that name already exists.", ACTION_WORDS.nameTaken],
  ["The company has as many features as it can hold. Merge or reuse one.", ACTION_WORDS.limit],
  ["That feature is done. Reopen it first.", ACTION_WORDS.isDone],
  ["A feature cannot be merged into itself or into one already merged away.", ACTION_WORDS.cannotMerge],
  ["The feature changed while you were saving. Try again.", ACTION_WORDS.conflict],
];
const CODE_FEATURE_NOT_FOUND = "That feature does not exist.";
const CODE_TASK_NOT_FOUND = "task not found";
const CODE_NEEDS_MAINTAINER = "Only a project maintainer, owner or admin can move a task that already has a feature.";

type Obj = Record<string, unknown>;
const plain = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
/** True when `value` is a plain object holding exactly these keys. */
const exactly = (value: unknown, keys: readonly string[]): value is Obj => plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const featureName = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && Array.from(value).length <= FEATURE_NAME_MAX && !NAME_UNSAFE.test(value);

function messageOf(error: CodeError): string | undefined {
  const body = error.body;
  if (!plain(body) || !plain(body["error"])) return undefined;
  const message = body["error"]["message"];
  return typeof message === "string" ? message : undefined;
}

/** Code's refusal as one of the fixed answers. `task`: the move route, whose 404 names a task, not a feature. */
function refusalOf(error: CodeError, task: boolean): RouteAnswer {
  const message = messageOf(error);
  if (error.status === 403) return task && message === CODE_NEEDS_MAINTAINER ? ACTION_WORDS.needsMaintainer : ACTION_WORDS.notAdmin;
  if (error.status === 404) {
    if (message === CODE_FEATURE_NOT_FOUND) return REPORT_WORDS.notFound;
    if (task && message === CODE_TASK_NOT_FOUND) return ACTION_WORDS.taskGone;
    return ACTION_WORDS.notConnected;
  }
  if (error.status === 501) return ACTION_WORDS.notConnected;
  if (error.status === 400 || error.status === 409) return CODE_SENTENCES.find(([sentence]) => sentence === message)?.[1] ?? ACTION_WORDS.refused;
  return ACTION_WORDS.unavailable;
}

/** The caller, or the fixed answer: Code's access check failing is Code's refusal too, worded here and never echoed (an ended sign-in is the handler's). */
async function callerOf(context: RouteContext, task: boolean): Promise<Awaited<ReturnType<typeof companyCaller>>> {
  try {
    return await companyCaller(context);
  } catch (error) {
    if (error instanceof CodeError) return refusalOf(error, task);
    throw error;
  }
}

/** One change: asks Code as the person and answers `read(Code's body)`, or the fixed refusal. */
async function ask(context: RouteContext, path: string, body: Obj, task: boolean, read: (answer: unknown) => unknown): Promise<RouteAnswer> {
  let answer: unknown;
  try {
    answer = await context.client.json<unknown>(context.session, path, { method: "POST", body });
  } catch (error) {
    if (error instanceof CodeError) return refusalOf(error, task);
    throw error;
  }
  const value = read(answer);
  return value === undefined ? ACTION_WORDS.unreadable : { status: 200, body: value };
}

/** `{ feature }` as the page draws it: the id, name and state only. */
function featureAnswer(answer: unknown): unknown {
  if (!plain(answer) || !Object.hasOwn(answer, "feature")) return undefined;
  const feature = readFeature(answer["feature"]);
  // A name Code stores can be up to four times what a person may type (it is cleaned where stored); one that does not read is refused whole.
  if (feature === undefined || (feature.state !== "open" && feature.state !== "done")) return undefined;
  return { feature: { id: feature.id, name: feature.name, state: feature.state } };
}

/** `{ task }` as the page draws it: the task's id and its feature (null: no feature). */
function taskAnswer(taskId: string) {
  return (answer: unknown): unknown => {
    if (!plain(answer) || !plain(answer["task"]) || typeof answer["task"]["taskId"] !== "string" || answer["task"]["taskId"].toLowerCase() !== taskId.toLowerCase()) return undefined;
    const feature = answer["task"]["feature"];
    if (feature === null) return { task: { taskId, feature: null } };
    if (!plain(feature) || typeof feature["id"] !== "string" || !FEATURE_ID.test(feature["id"]) || typeof feature["source"] !== "string" || !["moved", "chosen", "tracker", "inherited", "confirmed_at_plan"].includes(feature["source"])) return undefined;
    return { task: { taskId, feature: { id: feature["id"], source: feature["source"] } } };
  };
}

/** The feature routes: a company owner or admin (Code's access answer, made now), else fixed words and no ask. Then the body's shape, then Code. */
async function changeFeature(context: RouteContext, member: "name" | "into" | "state" | "new", path: string): Promise<RouteAnswer> {
  const who = await callerOf(context, false);
  if (refused(who)) return who;
  if (!isCompanyAdmin(who.companyRole)) return ACTION_WORDS.notAdmin;
  const key = member === "new" ? "name" : member;
  const body = context.body;
  if (!exactly(body, [key])) return ACTION_WORDS.badBody;
  const value = body[key];
  const good = key === "name" ? featureName(value) : key === "into" ? typeof value === "string" && FEATURE_ID.test(value) : value === "open" || value === "done";
  if (!good) return ACTION_WORDS.badBody;
  return ask(context, path, { [key]: value }, false, featureAnswer);
}

const FEATURE_PATH = "([A-Za-z0-9_-]{1,64})";
const featureRoute = (what: "rename" | "merge" | "state", member: "name" | "into" | "state"): Route => ({
  method: "POST", path: new RegExp(`^/org/report/features/${FEATURE_PATH}/${what}$`, "u"),
  answer: (context) => {
    const id = context.params[0]!;
    // Only an id of Code's own shape reaches Code: the path Cloud calls is built from nothing else.
    if (!FEATURE_ID.test(id)) return Promise.resolve(REPORT_WORDS.notFound);
    return changeFeature(context, member, `/v1/app/org/report/features/${id}/${what}`);
  },
});

export const REPORT_ACTION_ROUTES: Route[] = [
  // POST /v1/app/org/report/features: a new feature, { name }.
  { method: "POST", path: /^\/org\/report\/features$/u, answer: (context) => changeFeature(context, "new", "/v1/app/org/report/features") },
  featureRoute("rename", "name"),
  featureRoute("merge", "into"),
  featureRoute("state", "state"),
  // POST /v1/app/tasks/{taskId}/feature: file a task, or move it ({ feature: id } or { feature: null } for "No feature"). Code decides who may: the task's starter files it once, a maintainer, owner or admin moves it.
  {
    method: "POST", path: /^\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/feature$/iu,
    answer: async (context) => {
      const who = await callerOf(context, true);
      if (refused(who)) return who;
      const taskId = context.params[0]!;
      if (!TASK_ID.test(taskId)) return ACTION_WORDS.taskGone;
      const body = context.body;
      if (!exactly(body, ["feature"])) return ACTION_WORDS.badBody;
      const feature = body["feature"];
      if (feature !== null && !(typeof feature === "string" && FEATURE_ID.test(feature))) return ACTION_WORDS.badBody;
      return ask(context, `/v1/app/tasks/${taskId}/feature`, { feature }, true, taskAnswer(taskId));
    },
  },
];
