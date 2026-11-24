// DEC 254zzz84 (1): the company's per-step AI models (the "AI models" card in setup's "AI and spending" step and in Company settings). Rovara Code holds the setting and
// chooses each step's model with it (Code core-host/agent-model-routes.ts, core-host/gateway-model-selection.ts); Cloud passes the signed-in person's request on:
//
//   GET  /v1/app/org/agent-models    -> Code GET  /v1/app/agent-models (any member)      { revision, steps: [...], offered: [...], canChange }
//   POST /v1/app/org/agent-models    -> Code POST /v1/app/agent-models (owner or admin)  { action: "set", stage, model, expectedRevision } | { action: "clear", stage, expectedRevision }
//
// Rules:
//   - The browser never names a company: Code takes it from the person's live membership. Only the checked members below reach Code.
//   - Cloud refuses a plain member's change first (Code is not asked); Code then decides itself (live role, the gateway's live offered list for THIS company, the revision).
//     Cloud adds no rule that could widen Code's. No step-up (DEC 254zzz73).
//   - A step's model is named the way the gateway names it (`claude-...` for Anthropic's models, the Bedrock id for the rest); Cloud turns it into Code's model identity.
//   - Code's answer is projected to what the card needs and checked (shape) before it reaches the app; anything else is "couldn't be read". Code's refusals reach the app as the
//     fixed sentences below (AGENT_MODELS_WORDS), never Code's or the browser's text.
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const AGENT_MODELS_CODE_PATH = "/v1/app/agent-models";
/** The steps Code routes separately, in the order a task runs them (Code's STAGE_IDS). Understand shares the plan's setting, and the security review the code review's. */
export const AGENT_MODEL_STAGES = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"] as const;
export type AgentModelStage = typeof AGENT_MODEL_STAGES[number];
/** The gateway's model names (Code's AGENT_MODEL_NAME). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const OFFERED_MAX = 64;
const BODY_BYTES_MAX = 1_024;
/** The reasons that mean "the step follows the company's model" (no step setting: the company's engine model, else the install's). */
const COMPANY_MODEL_REASONS = new Set(["BUILTIN_DEFAULT", "INSTALL_MODEL"]);
/** The reasons Code gives for a step's model (Code's MODEL_STEP_REASONS); anything else is not Code's answer. */
const REASONS = new Set(["COMPANY_LOCK", "PROJECT_CHOICE", "COMPANY_DEFAULT", "PROJECT_SELECTION", "PROJECT_DEFAULT", "BUILTIN_DEFAULT", "PERSONAL_PLAN_DEFAULT", "RECIPE_DEFAULT", "APPROVED_SAME_MODEL", "DEFAULT_DIFFERENT_COMPANY", "INSTALL_MODEL"]);

export const AGENT_MODELS_WORDS = Object.freeze({
  notAdmin: "Only a company owner or admin can change the models the company's tasks use.",
  invalid: "Pick a step and a model from the list.",
  notOffered: "That model isn't offered to this company now, or this change isn't allowed. Reload and pick from the list.",
  sameModel: "A checking step must use a different model than the step it checks. Choose another model.",
  secondPerson: "This change needs another owner or admin to approve it, so it wasn't made.",
  stale: "The models changed since this page was opened. Reload and try again.",
  stepUp: "Confirm it's you again, then try once more.",
  listUnreadable: "The AI models this company can use couldn't be read just now. Nothing was changed. Try again in a moment.",
  notYet: "Choosing a model for each step isn't available on this Rovara yet.",
  unavailable: "The step models couldn't be read or saved just now. Try again.",
  stepRefused: "No model this company is offered can run this step now. Pick another model for it.",
});
const W = AGENT_MODELS_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const AGENT_MODELS_ANSWERS = Object.freeze({
  notAdmin: answer(403, "FORBIDDEN", W.notAdmin),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notOffered: answer(400, "MODEL_NOT_OFFERED", W.notOffered),
  sameModel: answer(400, "SAME_MODEL", W.sameModel),
  secondPerson: answer(403, "SECOND_PERSON_REQUIRED", W.secondPerson),
  stale: answer(409, "CHANGE_STALE", W.stale),
  stepUp: answer(403, "STEP_UP_REQUIRED", W.stepUp),
  listUnreadable: answer(503, "RUNTIME_UNAVAILABLE", W.listUnreadable),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
});
const A = AGENT_MODELS_ANSWERS;

/** Code's own sentences this module recognises (Code service.ts, gateway-model-selection.ts). Matched exactly; never shown. */
const CODE_SAME_MODEL = "A checking step must use a different model than the step it checks. Choose another model.";
const CODE_SECOND_PERSON = "This change needs a different person to confirm it, and this install has no second person. It was not made.";
const CODE_LIST_UNAVAILABLE = "The models Rovara's AI offers this company could not be read just now, so no model was chosen.";

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactly = (value: Plain, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const whole = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const money = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
const isStage = (value: unknown): value is AgentModelStage => typeof value === "string" && (AGENT_MODEL_STAGES as readonly string[]).includes(value);

/**
 * Code's `isOpenAiAgentModel` (Rovara#1389): an OpenAI model by OpenAI's own name (`gpt-5`, `gpt-5.4-mini`, `o4-mini`), served on a company's own OpenAI key. A Bedrock id is
 * never one: Bedrock names a vendor first (`openai.gpt-oss-120b-1:0`).
 */
const OPENAI_AGENT_MODEL = /^(?:gpt-[0-9]|o[1-9])[a-z0-9.-]*$/u;
/** A Claude model is named by Anthropic's engine name, an OpenAI model by OpenAI's own name, and every other model by its Bedrock id (Code's agentModelIdentity). */
export const modelIdentityOf = (name: string) => name.startsWith("claude-") ? { provider: "anthropic", modelId: name }
  : OPENAI_AGENT_MODEL.test(name) ? { provider: "openai", modelId: name } : { provider: "amazon-bedrock", modelId: name };
/** The gateway name of Code's model identity, or undefined when it is not one the gateway names (Code's agentModelName). */
export function modelNameOf(value: unknown): string | undefined {
  if (!plain(value) || !exactly(value, ["provider", "modelId"]) || typeof value["modelId"] !== "string" || !MODEL_NAME.test(value["modelId"])) return undefined;
  return modelIdentityOf(value["modelId"]).provider === value["provider"] ? value["modelId"] : undefined;
}

export interface AgentModelStep {
  stage: AgentModelStage;
  /** The model the company set for this step (null: none; it follows the company's model). */
  setting: string | null;
  /** The model the step runs on now, why, and its list price per million tokens when Code knows it. Null when no model can run it (`refused`). */
  effective: { model: string; companyDefault: boolean; priceUsdPerMillion?: { input: number; output: number } } | null;
  refused: boolean;
}
export interface AgentModelsAnswer { revision: number; steps: AgentModelStep[]; offered: string[] }

function stepOf(value: unknown): AgentModelStep | undefined {
  if (!plain(value) || !isStage(value["stage"])) return undefined;
  const settingRaw = value["setting"];
  let setting: string | null = null;
  if (settingRaw !== null && settingRaw !== undefined) {
    if (!plain(settingRaw)) return undefined;
    if (settingRaw["model"] !== undefined) {
      const name = modelNameOf(settingRaw["model"]);
      if (name === undefined) return undefined;
      setting = name;
    }
  }
  let effective: AgentModelStep["effective"] = null;
  const raw = value["effective"];
  if (raw !== undefined) {
    if (!plain(raw)) return undefined;
    const model = modelNameOf(raw["model"]);
    if (model === undefined || typeof raw["reason"] !== "string" || !REASONS.has(raw["reason"])) return undefined;
    const price = raw["priceUsdPerMillion"];
    let priceUsdPerMillion: { input: number; output: number } | undefined;
    if (price !== undefined) {
      if (!plain(price) || !money(price["input"]) || !money(price["output"])) return undefined;
      priceUsdPerMillion = { input: price["input"], output: price["output"] };
    }
    effective = { model, companyDefault: COMPANY_MODEL_REASONS.has(raw["reason"]), ...(priceUsdPerMillion === undefined ? {} : { priceUsdPerMillion }) };
  }
  const refusal = value["refusal"];
  if (refusal !== undefined && !plain(refusal)) return undefined;
  return { stage: value["stage"], setting, effective, refused: refusal !== undefined };
}

/** Code's AgentModelPage, projected to what the card needs: undefined when anything is off (the card then says "couldn't be read"). */
export function agentModelsView(value: unknown): AgentModelsAnswer | undefined {
  if (!plain(value)) return undefined;
  const keys = Object.keys(value).filter((key) => key !== "requestId");
  if (keys.length !== 2 || !Object.hasOwn(value, "state") || !Object.hasOwn(value, "offered")) return undefined;
  const { state, offered } = value;
  if (!plain(state) || !whole(state["revision"], Number.MAX_SAFE_INTEGER - 1) || !Array.isArray(state["steps"]) || state["steps"].length > AGENT_MODEL_STAGES.length) return undefined;
  if (!plain(offered) || offered["version"] !== 1 || !Array.isArray(offered["models"]) || offered["models"].length === 0 || offered["models"].length > OFFERED_MAX) return undefined;
  const names: string[] = [];
  // DEC 254zzz96 (2): the gateway's list price of an offered model, when it published one (Code passes it through untouched).
  const listPrices = new Map<string, { input: number; output: number }>();
  for (const entry of offered["models"] as unknown[]) {
    if (!plain(entry) || typeof entry["model"] !== "string" || !MODEL_NAME.test(entry["model"])) return undefined;
    const price = entry["price"];
    if (price !== undefined) {
      if (!plain(price) || !exactly(price, ["inputUsdPerMillion", "outputUsdPerMillion"]) || !money(price["inputUsdPerMillion"]) || !money(price["outputUsdPerMillion"])) return undefined;
      listPrices.set(entry["model"], { input: price["inputUsdPerMillion"], output: price["outputUsdPerMillion"] });
    }
    names.push(entry["model"]);
  }
  if (new Set(names).size !== names.length) return undefined;
  const steps: AgentModelStep[] = [];
  for (const raw of state["steps"] as unknown[]) {
    const step = stepOf(raw);
    if (step === undefined || steps.some((seen) => seen.stage === step.stage)) return undefined;
    // Code's own price for the step wins; else the gateway's list price of the model the step runs on.
    const listed = step.effective === null || step.effective.priceUsdPerMillion !== undefined ? undefined : listPrices.get(step.effective.model);
    steps.push(listed === undefined ? step : { ...step, effective: { ...step.effective!, priceUsdPerMillion: listed } });
  }
  steps.sort((a, b) => AGENT_MODEL_STAGES.indexOf(a.stage) - AGENT_MODEL_STAGES.indexOf(b.stage));
  return { revision: state["revision"], steps, offered: names };
}

const errorOf = (error: CodeError): Plain | undefined => (plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined);

/** Code's refusal of /v1/app/agent-models, in Cloud's fixed words. A 404 means this Code does not serve the step models (the choice switch is off, or not on the core yet). */
export function agentModelsRefusal(error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const said = errorOf(error);
  const code = said?.["code"], message = said?.["message"];
  if (error.status === 404) return A.notYet;
  if (code === "REAUTH_REQUIRED" || code === "STEP_UP_REQUIRED") return A.stepUp;
  if (code === "CHANGE_STALE" || error.status === 409) return A.stale;
  if (error.status === 403) return message === CODE_SECOND_PERSON ? A.secondPerson : A.notAdmin;
  if (error.status === 400) return message === CODE_SAME_MODEL ? A.sameModel : A.notOffered;
  if (error.status === 503 && message === CODE_LIST_UNAVAILABLE) return A.listUnreadable;
  return A.unavailable;
}

type Got = { value: unknown } | { refusal: RouteAnswer };
async function askCode(context: RouteContext, init: { method: string; body?: unknown }): Promise<Got> {
  try {
    return { value: await context.client.json<unknown>(context.session, AGENT_MODELS_CODE_PATH, init) };
  } catch (error) {
    if (error instanceof CodeError) return { refusal: agentModelsRefusal(error) };
    throw error;
  }
}

async function readAgentModels(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  const got = await askCode(context, { method: "GET" });
  if ("refusal" in got) return got.refusal;
  const view = agentModelsView(got.value);
  return view === undefined ? A.unavailable : { status: 200, body: { ...view, canChange: isCompanyAdmin(who.companyRole) } };
}

/** The browser's change, checked, as Code's ModelSelectionBody; undefined when it is not a change this card makes. */
export function agentModelsChange(body: unknown): Plain | undefined {
  if (!plain(body) || Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") > BODY_BYTES_MAX) return undefined;
  const { action, stage, expectedRevision } = body;
  if (!isStage(stage) || !whole(expectedRevision, Number.MAX_SAFE_INTEGER - 1)) return undefined;
  if (action === "clear" && exactly(body, ["action", "stage", "expectedRevision"])) return { action, stage, expectedRevision };
  const model = body["model"];
  if (action === "set" && exactly(body, ["action", "stage", "model", "expectedRevision"]) && typeof model === "string" && MODEL_NAME.test(model)) {
    return { action, stage, choice: { model: modelIdentityOf(model) }, expectedRevision };
  }
  return undefined;
}

async function changeAgentModels(context: RouteContext): Promise<RouteAnswer> {
  const who = await companyCaller(context);
  if (refused(who)) return who;
  // The role first (as Code does): a plain member learns nothing more, and Code is not asked.
  if (!isCompanyAdmin(who.companyRole)) return A.notAdmin;
  const change = agentModelsChange(context.body);
  if (change === undefined) return A.invalid;
  const got = await askCode(context, { method: "POST", body: change });
  if ("refusal" in got) return got.refusal;
  const saved = got.value;
  if (!plain(saved) || saved["ok"] !== true || !whole(saved["revision"])) return A.unavailable;
  return { status: 200, body: { ok: true, revision: saved["revision"] } };
}

/** Added to the route table (routes.ts): Code answers them, so they need no company backend in Cloud. */
export const AGENT_MODELS_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/agent-models$/u, answer: readAgentModels },
  { method: "POST", path: /^\/org\/agent-models$/u, answer: changeAgentModels },
];
