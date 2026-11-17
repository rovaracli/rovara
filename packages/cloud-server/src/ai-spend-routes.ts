// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1): the "AI and spending" step's routes that Rovara Code answers, as the signed-in person
// with their own token.
//
//   GET /v1/app/org/engine-model               -> Code GET /v1/dev/company/engine-model (any member)        {model, source, offered, preselect, canChange}
//   PUT /v1/app/org/engine-model {model}       -> Code PUT /v1/dev/company/engine-model (owner or admin)    the same answer
//   GET /v1/app/projects/{p}/spend-limits      -> Code GET /v1/dev/projects/{p}/settings                    {project, revision, perTask, canChange}
//   PUT /v1/app/projects/{p}/spend-limits      -> Code GET, then PUT /v1/dev/projects/{p}/settings           {expectedRevision, perTaskUsd: number | null}
//
// The company's monthly limit and "Rovara's AI or your own provider" are NOT here: the step saves them through Cloud's own routes (PUT /org/settings,
// PUT /org/agent-ai), so their existing authorization (company owner or admin from Code's access answer, a fresh step-up, the company's decision rules)
// and their audit records apply unchanged.
//
// Rules:
//   - The browser never names a company. Code takes the company from the person's live membership; nothing a request carries (query, header, body)
//     reaches Code except the checked body members below. The project name goes only into Code's path.
//   - Cloud refuses first where it can tell (no company; a change by a plain member), so Code is not asked. Code then decides itself (live role,
//     the gateway's live offered list, the project's administrator, the fresh step-up for a cost setting). Cloud adds no rule that could widen Code's.
//   - Code's answers are checked (shape) before they reach the app; anything else is "couldn't be read". Code's refusals reach the app as the fixed
//     sentences below (AI_SPEND_WORDS), never Code's or the browser's text.
//   - A project's per-task limit is Code's per-project cost setting `model_budget_usd` (US dollars a task; absent: the company's limit applies, "Same as
//     company"). Cloud reads the project's settings as the person and writes back the same overrides with only that member changed, naming the
//     revision it read; a revision that moved since the browser read it is refused before anything is written.
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused, type CompanyCaller } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const AI_SPEND_WORDS = Object.freeze({
  notAdmin: "Only a company owner or admin can change the company's AI model.",
  notOffered: "That model isn't offered to this company now. Pick one from the list.",
  listUnreadable: "The AI models this company can use couldn't be read just now. Nothing was changed. Try again in a moment.",
  invalid: "Pick a model from the list.",
  notYet: "Choosing the company's AI model isn't available on this Rovara yet.",
  unavailable: "The company's AI model couldn't be read or saved just now. Try again.",
  projectNotFound: "project not found",
  projectNotAllowed: "Only this project's admins can change its spending limits.",
  projectInvalid: "The per-task limit must be an amount in dollars, like 5 or 12.50, up to 1,000,000. Or choose Same as company.",
  projectAboveCompany: "That's above your company's per-task limit. Pick a lower amount.",
  projectStale: "This project's settings changed since you opened them. Refresh and try again.",
  stepUp: "Confirm it's you again, then try once more.",
  projectUnavailable: "The project's spending limits couldn't be read or saved just now. Try again.",
});
const W = AI_SPEND_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const AI_SPEND_ANSWERS = Object.freeze({
  notAdmin: answer(403, "FORBIDDEN", W.notAdmin),
  notOffered: answer(400, "MODEL_NOT_OFFERED", W.notOffered),
  listUnreadable: answer(503, "RUNTIME_UNAVAILABLE", W.listUnreadable),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
  projectNotFound: answer(404, "NOT_FOUND", W.projectNotFound),
  projectNotAllowed: answer(403, "FORBIDDEN", W.projectNotAllowed),
  projectInvalid: answer(400, "CONFIG_INVALID", W.projectInvalid),
  projectAboveCompany: answer(403, "FORBIDDEN", W.projectAboveCompany),
  projectStale: answer(409, "CONFLICT", W.projectStale),
  stepUp: answer(403, "STEP_UP_REQUIRED", W.stepUp),
  projectUnavailable: answer(503, "RUNTIME_UNAVAILABLE", W.projectUnavailable),
});
const A = AI_SPEND_ANSWERS;

/** Code's own sentences this module recognises (Code #835 company-engine-model-routes.ts, M4a project-settings.ts). Matched exactly; never shown. */
const CODE_NOT_OFFERED = "That model isn't offered to this company now. Pick one from the list.";
const CODE_LIST_UNAVAILABLE = "The AI models this company can use could not be read just now; nothing was changed. Try again in a moment.";
const CODE_ABOVE_COMPANY = "model_budget_usd: company limit cannot be crossed";

export const ENGINE_MODEL_CODE_PATH = "/v1/dev/company/engine-model";
const settingsPath = (project: string) => `/v1/dev/projects/${encodeURIComponent(project)}/settings`;
/** The per-task model budget among Code's project cost settings (Code's POLICY_FIELDS `model_budget_usd`, US dollars). */
export const PER_TASK_FIELD = "model_budget_usd";
/** The most a per-task limit may be, in US dollars (as the company budgets allow: $1,000,000). */
export const PER_TASK_USD_MAX = 1_000_000;
/** The gateway's model ids (Code's AGENT_MODEL_NAME). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** Code's project names (AGENTX_NAME_PATTERN). */
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
/** The longest offered list Cloud passes on; a longer one is not Code's answer. */
const OFFERED_MAX = 200;
const BODY_BYTES_MAX = 1_024;

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactly = (value: Plain, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const whole = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const tooLarge = (body: unknown) => Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") > BODY_BYTES_MAX;
/** A dollar amount the per-task limit may hold: 0 to PER_TASK_USD_MAX, at most two decimals. */
const dollars = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= PER_TASK_USD_MAX && Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

export interface EngineModelAnswer { model: string | null; source: "company" | "install"; offered: string[]; preselect: string }
/** Code's engine-model view, strictly (Code's CompanyEngineModelViewSchema): undefined when anything is off. */
export function engineModelView(value: unknown): EngineModelAnswer | undefined {
  if (!plain(value) || !exactly(value, ["model", "source", "offered", "preselect"])) return undefined;
  const { model, source, offered, preselect } = value;
  if (!(model === null || (typeof model === "string" && MODEL_ID.test(model)))) return undefined;
  if (source !== "company" && source !== "install") return undefined;
  if (!Array.isArray(offered) || offered.length === 0 || offered.length > OFFERED_MAX || !offered.every((id) => typeof id === "string" && MODEL_ID.test(id)) || new Set(offered).size !== offered.length) return undefined;
  if (typeof preselect !== "string" || !offered.includes(preselect)) return undefined;
  // Code preselects the company's model when it is offered, else the gateway's first.
  if (preselect !== (model !== null && offered.includes(model) ? model : offered[0])) return undefined;
  return { model, source, offered: (offered as string[]).slice(), preselect };
}

const errorOf = (error: CodeError): Plain | undefined => (plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined);

/** Code's refusal of the engine-model routes, in Cloud's fixed words. Only Code's exact unknown-route 404 (no gateway, or not on Code yet) means "not available yet". */
export function engineModelRefusal(error: CodeError): RouteAnswer {
  const said = errorOf(error);
  if (error.status === 404) return A.notYet;
  if (error.status === 403) return A.notAdmin;
  if (error.status === 400) return said?.["message"] === CODE_NOT_OFFERED ? A.notOffered : A.invalid;
  if (error.status === 503 && said?.["message"] === CODE_LIST_UNAVAILABLE) return A.listUnreadable;
  return A.unavailable;
}

/** Code's refusal of the project settings routes, in Cloud's fixed words. Any 404 is "project not found", whoever asks. */
export function projectSettingsRefusal(error: CodeError): RouteAnswer {
  const said = errorOf(error);
  if (error.status === 404) return A.projectNotFound;
  if (error.status === 403 && said?.["code"] === "REAUTH_REQUIRED") return A.stepUp;
  if (error.status === 403 && said?.["message"] === CODE_ABOVE_COMPANY) return A.projectAboveCompany;
  if (error.status === 403) return A.projectNotAllowed;
  if (error.status === 409) return A.projectStale;
  if (error.status === 400) return A.projectInvalid;
  return A.projectUnavailable;
}

type Got = { value: unknown } | { refusal: RouteAnswer };
/** A call to Code as the person. Anything but Code's own refusal (an ended sign-in, an outage) reaches the handler. */
async function askCode(context: RouteContext, path: string, init: { method: string; body?: unknown }, refusal: (error: CodeError) => RouteAnswer): Promise<Got> {
  try {
    return { value: await context.client.json<unknown>(context.session, path, init) };
  } catch (error) {
    if (error instanceof CodeError) return { refusal: refusal(error) };
    throw error;
  }
}

/** A company owner or admin (Code's company role, never its install administrator flag). */
const companyAdmin = (who: CompanyCaller) => isCompanyAdmin(who.companyRole);
/** The project's administrator by Code's access answer made now ("administrator" access). */
const projectAdmin = (who: CompanyCaller, project: string) => who.access.projects.some((entry) => entry.name === project && entry.access === "administrator");

// ---- The company's AI model ----

async function readEngineModel(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  const got = await askCode(context, ENGINE_MODEL_CODE_PATH, { method: "GET" }, engineModelRefusal);
  if ("refusal" in got) return got.refusal;
  const view = engineModelView(got.value);
  return view === undefined ? A.unavailable : { status: 200, body: { ...view, canChange: companyAdmin(who) } };
}

async function changeEngineModel(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  // The role first (as Code does): a plain member learns nothing more, and Code is not asked.
  if (!companyAdmin(who)) return A.notAdmin;
  const body = context.body;
  if (tooLarge(body) || !plain(body) || !exactly(body, ["model"])) return A.invalid;
  const model = body["model"];
  if (!(model === null || (typeof model === "string" && MODEL_ID.test(model)))) return A.invalid;
  const got = await askCode(context, ENGINE_MODEL_CODE_PATH, { method: "PUT", body: { model } }, engineModelRefusal);
  if ("refusal" in got) return got.refusal;
  const view = engineModelView(got.value);
  // Saved at Code, but its answer doesn't read: the page reads the model again.
  return view === undefined ? A.unavailable : { status: 200, body: { ...view, canChange: true } };
}

// ---- A project's per-task limit ----

interface ProjectSettings { revision: number; overrides: Plain; perTaskUsd: number | null | undefined; appliedUsd: number | null | undefined }
/** Code's project settings view, as much as this step needs, strictly: undefined when the revision, the overrides or the per-task member don't read. */
export function projectSettingsOf(value: unknown): ProjectSettings | undefined {
  if (!plain(value) || !whole(value["revision"], 0, Number.MAX_SAFE_INTEGER - 1) || !plain(value["overrides"])) return undefined;
  const overrides = value["overrides"];
  const own = overrides[PER_TASK_FIELD];
  if (Object.hasOwn(overrides, PER_TASK_FIELD) && !(own === null || (typeof own === "number" && Number.isFinite(own) && own >= 0))) return undefined;
  const values = plain(value["values"]) ? value["values"] : undefined;
  const entry = values !== undefined && plain(values[PER_TASK_FIELD]) ? values[PER_TASK_FIELD] : undefined;
  const applied = entry?.["value"];
  return {
    revision: value["revision"], overrides: { ...overrides }, perTaskUsd: Object.hasOwn(overrides, PER_TASK_FIELD) ? own as number | null : undefined,
    appliedUsd: applied === null || (typeof applied === "number" && Number.isFinite(applied) && applied >= 0) ? applied : undefined,
  };
}

/** What the app shows: "Same as company" when the project sets no per-task limit of its own, else its amount (null: it asked for no limit of its own). */
function projectView(project: string, settings: ProjectSettings, canChange: boolean) {
  return {
    project, revision: settings.revision,
    perTask: settings.perTaskUsd === undefined ? { sameAsCompany: true, usd: null } : { sameAsCompany: false, usd: settings.perTaskUsd },
    ...(settings.appliedUsd === undefined ? {} : { appliedUsd: settings.appliedUsd }),
    canChange,
  };
}

async function readSpendLimits(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  const project = context.params[0]!;
  if (!PROJECT_NAME.test(project)) return A.projectNotFound;
  const got = await askCode(context, settingsPath(project), { method: "GET" }, projectSettingsRefusal);
  if ("refusal" in got) return got.refusal;
  const settings = projectSettingsOf(got.value);
  return settings === undefined ? A.projectUnavailable : { status: 200, body: projectView(project, settings, companyAdmin(who) || projectAdmin(who, project)) };
}

async function changeSpendLimits(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  const project = context.params[0]!;
  if (!PROJECT_NAME.test(project)) return A.projectNotFound;
  // A company owner or admin, or the project's admin, may ask; Code decides (today: the project's administrator, with a fresh step-up).
  if (!companyAdmin(who) && !projectAdmin(who, project)) return A.projectNotAllowed;
  const body = context.body;
  if (tooLarge(body) || !plain(body) || !exactly(body, ["expectedRevision", "perTaskUsd"]) || !whole(body["expectedRevision"], 0, Number.MAX_SAFE_INTEGER - 1)) return A.projectInvalid;
  const perTask = body["perTaskUsd"];
  if (perTask !== null && !dollars(perTask)) return A.projectInvalid;
  const read = await askCode(context, settingsPath(project), { method: "GET" }, projectSettingsRefusal);
  if ("refusal" in read) return read.refusal;
  const current = projectSettingsOf(read.value);
  if (current === undefined) return A.projectUnavailable;
  if (current.revision !== body["expectedRevision"]) return A.projectStale;
  // Only the per-task member changes: null is "Same as company" (no limit of the project's own), a number is the project's own limit.
  const overrides: Plain = { ...current.overrides };
  if (perTask === null) delete overrides[PER_TASK_FIELD];
  else overrides[PER_TASK_FIELD] = perTask;
  if (current.perTaskUsd === (perTask === null ? undefined : perTask)) return { status: 200, body: projectView(project, current, true) };
  const wrote = await askCode(context, settingsPath(project), { method: "PUT", body: { expectedRevision: current.revision, overrides } }, projectSettingsRefusal);
  if ("refusal" in wrote) return wrote.refusal;
  const after = projectSettingsOf(wrote.value);
  return after === undefined ? A.projectUnavailable : { status: 200, body: projectView(project, after, true) };
}

const PROJECT = "([A-Za-z0-9][A-Za-z0-9._-]{0,99})";
/** Added to the route table (routes.ts): Code answers them, so they need no company backend in Cloud. */
export const AI_SPEND_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/engine-model$/u, answer: readEngineModel },
  { method: "PUT", path: /^\/org\/engine-model$/u, answer: changeEngineModel },
  { method: "GET", path: new RegExp(`^\\/projects\\/${PROJECT}\\/spend-limits$`, "u"), answer: readSpendLimits },
  { method: "PUT", path: new RegExp(`^\\/projects\\/${PROJECT}\\/spend-limits$`, "u"), answer: changeSpendLimits },
];
