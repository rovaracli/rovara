// The company's lessons LEARNING model (DEC 254zzz58/63, Code #1075): the model the company's lessons learn with, separate from the engine model the tasks use. Company settings, AI,
// shows it beside the engine model card. Cloud answers from Rovara Code as the signed-in person with their own token.
//
//   GET /v1/app/org/learning-model             -> Code GET /v1/dev/company/learning-model (any member)       {model, source, offered, preselect, canChange}
//   PUT /v1/app/org/learning-model {model}     -> Code PUT /v1/dev/company/learning-model (owner or admin)   the same answer (model: null puts the install default back)
//
// Rules (as the engine-model routes, ai-spend-routes.ts):
//   - The browser never names a company. Code takes the company from the person's live membership; nothing a request carries (query, header, body) reaches Code except the checked
//     `model` below.
//   - Cloud refuses first where it can tell (no company; a change by a plain member), so Code is not asked. Code then decides itself (live role, the gateway's live list of Claude models
//     for THIS company). Cloud adds no rule that could widen Code's.
//   - Code's answer is checked strictly (shape and the preselect rule) before it reaches the app; anything else is "couldn't be read". `offered` may be empty and `preselect` may be
//     null here (no Claude model offered), unlike the engine model.
//   - Code's refusals reach the app as the fixed sentences below, never Code's or the browser's text.
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const LEARNING_MODEL_WORDS = Object.freeze({
  notAdmin: "Only a company owner or admin can change the model lessons learn with.",
  notOffered: "That model isn't offered to this company now. Pick one from the list.",
  listUnreadable: "The AI models this company can use couldn't be read just now. Nothing was changed. Try again in a moment.",
  settingUnavailable: "The model lessons learn with couldn't be read or saved just now. Try again.",
  invalid: "Pick a model from the list.",
  notYet: "Choosing the model lessons learn with isn't available on this Rovara yet.",
  unavailable: "The model lessons learn with couldn't be read or saved just now. Try again.",
});
const W = LEARNING_MODEL_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const LEARNING_MODEL_ANSWERS = Object.freeze({
  notAdmin: answer(403, "FORBIDDEN", W.notAdmin),
  notOffered: answer(400, "MODEL_NOT_OFFERED", W.notOffered),
  listUnreadable: answer(503, "RUNTIME_UNAVAILABLE", W.listUnreadable),
  settingUnavailable: answer(503, "RUNTIME_UNAVAILABLE", W.settingUnavailable),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
});
const A = LEARNING_MODEL_ANSWERS;

/** Code's own sentences this module recognises (Code #1075 company-learning-model-routes.ts). Matched exactly; never shown. */
const CODE_NOT_OFFERED = "That model isn't a Claude model offered to this company now. Pick one from the list.";
const CODE_LIST_UNAVAILABLE = "The AI models this company can use could not be read just now; nothing was changed. Try again in a moment.";
const CODE_SETTING_UNAVAILABLE = "The company's learning model setting could not be read or saved just now; try again.";

export const LEARNING_MODEL_CODE_PATH = "/v1/dev/company/learning-model";
/** The gateway's model ids (Code's AGENT_MODEL_NAME). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** The longest offered list Cloud passes on; a longer one is not Code's answer. */
const OFFERED_MAX = 200;
const BODY_BYTES_MAX = 1_024;

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactly = (value: Plain, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const tooLarge = (body: unknown) => Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") > BODY_BYTES_MAX;

export interface LearningModelAnswer { model: string | null; source: "company" | "install"; offered: string[]; preselect: string | null }
/** Code's learning-model view, strictly (Code's CompanyLearningModelViewSchema and its preselect rule): undefined when anything is off. */
export function learningModelView(value: unknown): LearningModelAnswer | undefined {
  if (!plain(value) || !exactly(value, ["model", "source", "offered", "preselect"])) return undefined;
  const { model, source, offered, preselect } = value;
  if (!(model === null || (typeof model === "string" && MODEL_ID.test(model)))) return undefined;
  if (source !== "company" && source !== "install") return undefined;
  if (!Array.isArray(offered) || offered.length > OFFERED_MAX || !offered.every((id) => typeof id === "string" && MODEL_ID.test(id)) || new Set(offered).size !== offered.length) return undefined;
  // Code preselects the model when it is offered, else the gateway's first Claude model, else nothing.
  const expected = model !== null && offered.includes(model) ? model : (offered[0] as string | undefined) ?? null;
  if (preselect !== expected) return undefined;
  return { model, source, offered: (offered as string[]).slice(), preselect: expected };
}

const errorOf = (error: CodeError): Plain | undefined => (plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined);

/** Code's refusal of the learning-model routes, in Cloud's fixed words. Code answers this path's 404 only when it doesn't serve it (no gateway wired, or not on Code yet): "not available yet". */
export function learningModelRefusal(error: CodeError): RouteAnswer {
  const said = errorOf(error);
  if (error.status === 404) return A.notYet;
  if (error.status === 403) return A.notAdmin;
  if (error.status === 400) return said?.["message"] === CODE_NOT_OFFERED ? A.notOffered : A.invalid;
  if (error.status === 503 && said?.["message"] === CODE_LIST_UNAVAILABLE) return A.listUnreadable;
  if (error.status === 503 && said?.["message"] === CODE_SETTING_UNAVAILABLE) return A.settingUnavailable;
  return A.unavailable;
}

type Got = { value: unknown } | { refusal: RouteAnswer };
/** A call to Code as the person. Anything but Code's own refusal (an ended sign-in, an outage) reaches the handler. */
async function askCode(context: RouteContext, init: { method: string; body?: unknown }): Promise<Got> {
  try {
    return { value: await context.client.json<unknown>(context.session, LEARNING_MODEL_CODE_PATH, init) };
  } catch (error) {
    if (error instanceof CodeError) return { refusal: learningModelRefusal(error) };
    throw error;
  }
}

async function readLearningModel(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  const got = await askCode(context, { method: "GET" });
  if ("refusal" in got) return got.refusal;
  const view = learningModelView(got.value);
  return view === undefined ? A.unavailable : { status: 200, body: { ...view, canChange: isCompanyAdmin(who.companyRole) } };
}

async function changeLearningModel(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  // The role first (as Code does): a plain member learns nothing more, and Code is not asked.
  if (!isCompanyAdmin(who.companyRole)) return A.notAdmin;
  const body = context.body;
  if (tooLarge(body) || !plain(body) || !exactly(body, ["model"])) return A.invalid;
  const model = body["model"];
  if (!(model === null || (typeof model === "string" && MODEL_ID.test(model)))) return A.invalid;
  const got = await askCode(context, { method: "PUT", body: { model } });
  if ("refusal" in got) return got.refusal;
  const view = learningModelView(got.value);
  // Saved at Code, but its answer doesn't read: the page reads the model again.
  return view === undefined ? A.unavailable : { status: 200, body: { ...view, canChange: true } };
}

/** Added to the route table (routes.ts): Code answers them, so they need no company backend in Cloud. */
export const LEARNING_MODEL_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/learning-model$/u, answer: readLearningModel },
  { method: "PUT", path: /^\/org\/learning-model$/u, answer: changeLearningModel },
];
