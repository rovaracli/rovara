// Guided onboarding PR 17 (DEC 254n item 3): a project's archive and restore, preview first, answered from Rovara Code (PrepLabsAI/Rovara #839) as
// the signed-in person, with their own token.
//
//   GET  /v1/app/projects/{p}/archive-preview   -> Code GET  /v1/dev/client/projects/{p}/archive-preview
//   POST /v1/app/projects/{p}/reviewed-archive  -> Code POST /v1/dev/client/projects/{p}/archive
//   GET  /v1/app/projects/{p}/restore-preview   -> Code GET  /v1/dev/client/projects/{p}/restore-preview
//   POST /v1/app/projects/{p}/reviewed-restore  -> Code POST /v1/dev/client/projects/{p}/restore
//   GET  /v1/app/projects/{p}/lifecycle         -> the project's state and the one action the person may take now, from those previews
//
// Rules:
//   - Code decides who may see and change a project (a live company owner or admin, or the project's admin; anyone else "project not found").
//     Cloud adds no rule of its own that could widen that; it only refuses earlier.
//   - The browser never names a company. The project name goes only into Code's path. The company a change is pinned to (`expectedOrgId`) is the
//     one Code's access check names for the person now; a different one from the browser is a stale review, and the browser's is never forwarded.
//   - A change's body is rebuilt from its checked fields only (strict: no other member; the acknowledgement literally true); nothing else passes.
//   - Code's answers are checked (shape, the person's company, the project asked for) before they reach the app; Code's refusals reach the app as
//     Cloud's fixed sentences (LIFECYCLE_WORDS, the same as @agentx/contracts PROJECT_LIFECYCLE_WORDS), never Code's or the browser's text.
//   - Until Code serves the routes, its fixed unknown-route 404 reads "Archiving isn't available yet." (501 NOT_ON_CODE_YET).
// cloud-server takes no package dependency, so the shapes are checked here by hand against Code's contract (reviewed-project-archive.ts, -restore.ts).
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import { companyCaller, refused } from "./company-caller.js";
import { COMPANY_ID } from "./company-store.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const LIFECYCLE_WORDS = Object.freeze({
  notFound: "project not found",
  notAllowed: "Only company owners and admins, or this project's admins, can archive or restore it.",
  invalid: "the request is not valid",
  stale: "The project changed. Review it again before you archive or restore it.",
  notOnEngine: "Archiving isn't available for this company yet: its tasks don't run on the engine that stops work on an archived project.",
  notYet: "Archiving isn't available yet.",
  unavailable: "The project's state couldn't be checked just now. Try again.",
});
const W = LIFECYCLE_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const LIFECYCLE_ANSWERS = Object.freeze({
  notFound: answer(404, "NOT_FOUND", W.notFound),
  notAllowed: answer(403, "FORBIDDEN", W.notAllowed),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  stale: answer(409, "CHANGE_STALE", W.stale),
  notOnEngine: answer(503, "ARCHIVE_NOT_AVAILABLE", W.notOnEngine),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
});

/** Code's project names (AGENTX_NAME_PATTERN). */
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const MAX = Number.MAX_SAFE_INTEGER;
const codePath = (project: string, action: string) => `/v1/dev/client/projects/${encodeURIComponent(project)}/${action}`;

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
/** Exactly these members: every required one, any of the optional ones, nothing else. */
const only = (value: Plain, required: readonly string[], optional: readonly string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const whole = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const iso = (value: unknown) => typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value));

type Kind = "archive" | "restore";
const ACK: Record<Kind, string> = { archive: "acknowledgeNewWorkStops", restore: "acknowledgeNewWorkAllowed" };

export interface LifecycleBody { requestId: string; expectedOrgId?: string; expectedRevision: number; expectedProjectRevision: number }
/** The browser's change, strictly (Code's Reviewed*BodySchema): undefined when anything is off, including a missing or non-true acknowledgement. */
export function lifecycleBody(kind: Kind, value: unknown): LifecycleBody | undefined {
  if (!plain(value) || !only(value, ["requestId", "expectedRevision", "expectedProjectRevision", ACK[kind]], ["expectedOrgId"])) return undefined;
  const { requestId, expectedOrgId, expectedRevision, expectedProjectRevision } = value;
  if (value[ACK[kind]] !== true || typeof requestId !== "string" || !UUID.test(requestId)) return undefined;
  if (!whole(expectedRevision, 0, MAX - 1) || !whole(expectedProjectRevision, 1, MAX)) return undefined;
  if (expectedOrgId !== undefined && (typeof expectedOrgId !== "string" || !COMPANY_ID.test(expectedOrgId))) return undefined;
  return { requestId, ...(expectedOrgId === undefined ? {} : { expectedOrgId }), expectedRevision, expectedProjectRevision };
}

/** Code's preview, strictly (Reviewed*PreviewSchema, with its optional `impact`), for this company and project. */
function previewOk(kind: Kind, value: unknown, company: string, project: string): value is Plain & { status: "active" | "archived"; access: { actions: string[] } } {
  if (!plain(value) || !only(value, ["orgId", "project", "status", "expectedRevision", "expectedProjectRevision", "checkedAt", "access", ...(kind === "restore" ? ["prerequisites"] : [])], ["impact"])) return false;
  if (value["orgId"] !== company || value["project"] !== project || (value["status"] !== "active" && value["status"] !== "archived")) return false;
  if (!whole(value["expectedRevision"], 0, MAX - 1) || !whole(value["expectedProjectRevision"], 1, MAX) || !iso(value["checkedAt"])) return false;
  if (kind === "restore" && value["prerequisites"] !== "checked" && value["prerequisites"] !== "not_required") return false;
  const access = value["access"];
  if (!plain(access) || !only(access, ["actions"]) || !Array.isArray(access["actions"]) || access["actions"].length > 1 || !access["actions"].every((action) => action === kind)) return false;
  const impact = value["impact"];
  if (impact === undefined) return true;
  if (!plain(impact)) return false;
  if (kind === "archive") {
    return only(impact, ["stopsNewWork", "stopsRunningTasksAtNextStep", "linkedSlackChannels", "slackChannelsStayLinked", "deletesNothing"]) && impact["stopsNewWork"] === true
      && impact["stopsRunningTasksAtNextStep"] === true && impact["slackChannelsStayLinked"] === true && impact["deletesNothing"] === true && whole(impact["linkedSlackChannels"], 0, 10_000);
  }
  return only(impact, ["allowsNewWork", "linkedSlackChannels"]) && impact["allowsNewWork"] === true && whole(impact["linkedSlackChannels"], 0, 10_000);
}

/** Code's outcome, strictly (Reviewed*OutcomeSchema), as this change of this project in this company. */
function outcomeOk(kind: Kind, value: unknown, company: string, project: string): boolean {
  if (!plain(value) || !only(value, ["receipt", "replayed", "current", "effects"]) || typeof value["replayed"] !== "boolean") return false;
  const receipt = value["receipt"], effects = value["effects"], at = kind === "archive" ? "archivedAt" : "restoredAt";
  if (!plain(receipt) || !only(receipt, ["project", "status", "revision", "projectRevision", at, "egressReconciliation"])) return false;
  if (receipt["project"] !== project || receipt["status"] !== (kind === "archive" ? "archived" : "active") || !whole(receipt["revision"], 1, MAX)
    || !whole(receipt["projectRevision"], 1, MAX) || !iso(receipt[at]) || receipt["egressReconciliation"] !== "pending") return false;
  if (!previewOk(kind, value["current"], company, project) || !plain(effects)) return false;
  const egress = ["synchronized", "pending", "not_attempted"].includes(effects["egress"] as string);
  if (kind === "restore") return only(effects, ["egress"]) && egress;
  const hook = ["completed", "pending", "not_configured", "not_attempted"];
  return only(effects, ["egress", "archiveHook"], ["evidenceClean"]) && egress && hook.includes(effects["archiveHook"] as string)
    && (effects["evidenceClean"] === undefined || hook.includes(effects["evidenceClean"] as string));
}

/** Code's refusal in Cloud's fixed words. Only Code's exact unknown-route 404 means "not on Code yet"; any other 404 is "project not found". */
export function lifecycleRefusal(error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  if (error.status === 404) return body?.["code"] === "NOT_FOUND" && body["message"] === "route not found" ? LIFECYCLE_ANSWERS.notYet : LIFECYCLE_ANSWERS.notFound;
  if (error.status === 403) return LIFECYCLE_ANSWERS.notAllowed;
  if (error.status === 400) return LIFECYCLE_ANSWERS.invalid;
  if (error.status === 409) return LIFECYCLE_ANSWERS.stale;
  if (error.status === 503 && body?.["message"] === W.notOnEngine) return LIFECYCLE_ANSWERS.notOnEngine;
  return LIFECYCLE_ANSWERS.unavailable;
}

type Got = { value: unknown } | { refusal: RouteAnswer };
/** A call to Code as the person. An ended sign-in still reaches the handler (it signs the person out). */
async function fromCode(context: RouteContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<Got> {
  try {
    return { value: await context.client.json<unknown>(context.session, path, init) };
  } catch (error) {
    if (error instanceof CodeError) return { refusal: lifecycleRefusal(error) };
    throw error;
  }
}

/** The project in the path and the person's company now (Code's access check), or the route's refusal. */
async function scope(context: RouteContext): Promise<{ project: string; company: string } | { refusal: RouteAnswer }> {
  const project = context.params[0];
  // Not a project name: answered as Code would (not found), without asking Code.
  if (project === undefined || !PROJECT_NAME.test(project)) return { refusal: LIFECYCLE_ANSWERS.notFound };
  let who: Awaited<ReturnType<typeof companyCaller>>;
  try {
    who = await companyCaller(context);
  } catch (error) {
    // Code's access check refused or failed: Cloud's fixed words, never Code's text (an ended sign-in still reaches the handler).
    if (error instanceof CodeError) return { refusal: LIFECYCLE_ANSWERS.unavailable };
    throw error;
  }
  return refused(who) ? { refusal: who } : { project, company: who.companyId };
}

async function preview(context: RouteContext, kind: Kind, project: string, company: string): Promise<Got> {
  const got = await fromCode(context, codePath(project, `${kind}-preview`));
  if ("refusal" in got) return got;
  return previewOk(kind, got.value, company, project) ? got : { refusal: LIFECYCLE_ANSWERS.unavailable };
}

function previewRoute(kind: Kind): Route {
  return {
    method: "GET", path: new RegExp(`^/projects/([^/]+)/${kind}-preview$`, "u"),
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      const got = await preview(context, kind, at.project, at.company);
      return "refusal" in got ? got.refusal : { status: 200, body: got.value };
    },
  };
}

function changeRoute(kind: Kind): Route {
  return {
    method: "POST", path: new RegExp(`^/projects/([^/]+)/reviewed-${kind}$`, "u"),
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      const given = lifecycleBody(kind, context.body);
      if (given === undefined) return LIFECYCLE_ANSWERS.invalid;
      // The browser's company pin is only compared, never forwarded: a different company is a stale review.
      if (given.expectedOrgId !== undefined && given.expectedOrgId !== at.company) return LIFECYCLE_ANSWERS.stale;
      const body = { requestId: given.requestId, expectedOrgId: at.company, expectedRevision: given.expectedRevision, expectedProjectRevision: given.expectedProjectRevision, [ACK[kind]]: true };
      const got = await fromCode(context, codePath(at.project, kind), { method: "POST", body });
      if ("refusal" in got) return got.refusal;
      // An answer that doesn't read as this change of this project is not confirmed (the app then checks current state).
      if (!outcomeOk(kind, got.value, at.company, at.project)) return LIFECYCLE_ANSWERS.unavailable;
      console.log(JSON.stringify({ event: `cloud.project_${kind}`, companyId: at.company, project: at.project, replayed: (got.value as Plain)["replayed"] }));
      return { status: 200, body: got.value };
    },
  };
}

/** The project page's one read: the state, and the action the person may take now (none for a person who only uses the project). */
const lifecycleRoute: Route = {
  method: "GET", path: /^\/projects\/([^/]+)\/lifecycle$/u,
  answer: async (context) => {
    const at = await scope(context);
    if ("refusal" in at) return at.refusal;
    const archive = await preview(context, "archive", at.project, at.company);
    if ("refusal" in archive) return archive.refusal;
    const seen = archive.value as { status: "active" | "archived"; access: { actions: string[] } };
    if (seen.status === "active") return { status: 200, body: { status: "active", actions: seen.access.actions.includes("archive") ? ["archive"] : [] } };
    const restore = await preview(context, "restore", at.project, at.company);
    if ("refusal" in restore) return restore.refusal;
    const now = restore.value as { status: "active" | "archived"; access: { actions: string[] } };
    return { status: 200, body: { status: now.status, actions: now.status === "archived" && now.access.actions.includes("restore") ? ["restore"] : [] } };
  },
};

export const PROJECT_LIFECYCLE_ROUTES: Route[] = [previewRoute("archive"), previewRoute("restore"), changeRoute("archive"), changeRoute("restore"), lifecycleRoute];
