// SETUP-LIMITS: the project's setup-run limits, passed to Rovara Code as the signed-in person.
//
//   GET /v1/app/projects/{p}/setup-agent/limits   -> Code GET the same path    { revision, limits, companyLock, effective, defaults, maxima }   (any live role on the project reads)
//   PUT /v1/app/projects/{p}/setup-agent/limits   -> Code PUT the same path    { requestId, expectedRevision, limits }                          (a company owner or admin, or the project's administrator)
//
// Rules:
//   - Code decides who may read and who may change (its live company role and project grant), what a number may be (the contract's maxima and the company's cap), and whether the revision is current; Cloud adds no rule
//     that could widen or narrow that, and no step-up. Cloud refuses earlier only what cannot be valid: a person in no company, a malformed project name, a body that is not exactly its three keys.
//   - Only the three named keys are passed on, and only the five limit names inside `limits`; nothing that names a company, a role or a payer is ever forwarded. Code validates the values strictly.
//   - The answer is rebuilt field by field (an answer that does not read is "couldn't be read", never passed on). Code's refusals reach the app in their code with a one-line sentence of Code's (numbers and field names only).
//   - Code's fixed unknown-route 404 (an older Code) and its "not on the core yet" 404 read 501 NOT_ON_CODE_YET: the app hides the card then. A missing project is the one uniform 404. A write whose outcome is unknown is answered as such
//     (never "refused"): the page reads the limits again before the person tries once more (the same request id is safe to send again).
//   - The logs say what was done and where (action, project), never the numbers.
import { CodeError, isCodeOutcomeUnknown } from "./code-client.js";
import { NOT_IN_COMPANY, companyOf } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const SETUP_LIMIT_KEYS = ["commands", "sameStepTries", "wallClockMin", "budgetCents", "hostAsks"] as const;
export const SETUP_LIMITS_BODY_KEYS = ["requestId", "expectedRevision", "limits"] as const;
type Plain = Record<string, unknown>;

export const SETUP_LIMITS_WORDS = Object.freeze({
  invalid: "Send the limits as { requestId, expectedRevision, limits }.",
  notYet: "Setup limits aren't connected to this Rovara Code yet.",
  notFound: "That project doesn't exist, or you can't use it.",
  unreadable: "The project's setup limits could not be read just now. Try again.",
  unavailable: "The project's setup limits aren't available just now. Try again.",
});
const W = SETUP_LIMITS_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const SETUP_LIMITS_ANSWERS = Object.freeze({
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  notFound: answer(404, "NOT_FOUND", W.notFound),
  unreadable: answer(503, "RUNTIME_UNAVAILABLE", W.unreadable),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
});
const A = SETUP_LIMITS_ANSWERS;

const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;

class Unreadable extends Error {}

/** A setting (any subset of the five limits, each a whole number), rebuilt. */
function settingOf(value: unknown): Plain {
  if (!plain(value) || !Object.keys(value).every((key) => (SETUP_LIMIT_KEYS as readonly string[]).includes(key))) throw new Unreadable();
  const out: Plain = {};
  for (const key of SETUP_LIMIT_KEYS) {
    if (value[key] === undefined) continue;
    if (!count(value[key])) throw new Unreadable();
    out[key] = value[key];
  }
  return out;
}
/** All five limits, rebuilt. */
function fullOf(value: unknown): Plain {
  const out = settingOf(value);
  if (SETUP_LIMIT_KEYS.some((key) => out[key] === undefined)) throw new Unreadable();
  return out;
}

/** Code's view rebuilt into the app's reader (`ProjectLimitsReader`); throws `Unreadable` for anything that does not read. */
export function setupLimitsView(value: unknown): Plain {
  if (!plain(value) || !count(value["revision"])) throw new Unreadable();
  return { revision: value["revision"], limits: settingOf(value["limits"]), companyLock: settingOf(value["companyLock"]), effective: fullOf(value["effective"]), defaults: fullOf(value["defaults"]), maxima: fullOf(value["maxima"]) };
}

const SENTENCE = /^[^\p{Cc}\p{Cf}]{1,300}$/u;
/** Codes of Code's that reach the app as they are (each means the same on the page); anything else is "not available just now". */
const PASSED_ON = new Set(["CONFIG_INVALID", "FORBIDDEN", "CHANGE_STALE", "IDEMPOTENCY_CONFLICT", "AUDIT_UNAVAILABLE", "RUNTIME_UNAVAILABLE"]);

/** Code's refusal in the app's words. Only Code's exact unknown-route and not-on-the-core 404s mean "not on Code yet". */
export function setupLimitsRefusal(error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const refusal = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const code = typeof refusal?.["code"] === "string" ? refusal["code"] : undefined, message = typeof refusal?.["message"] === "string" ? refusal["message"] : undefined;
  if (error.status === 404 && code === "NOT_FOUND") {
    if (message === "route not found" || message === "That is not on the core engine on this install yet.") return A.notYet;
    return A.notFound;
  }
  if (error.status === 501) return A.notYet;
  if (code !== undefined && message !== undefined && PASSED_ON.has(code) && SENTENCE.test(message) && [400, 403, 409, 503].includes(error.status)) return answer(error.status, code, message);
  return A.unavailable;
}

const base = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/setup-agent/limits`;
const logged = (action: string, project: string): void => { console.log(JSON.stringify({ event: "cloud.setup_limits", action, project })); };

/** The body of a change: exactly the three keys (anything else is not sent on); `undefined` for a body that cannot be one. */
export function setupLimitsBody(body: unknown): { requestId: string; expectedRevision: number; limits: Plain } | undefined {
  if (!plain(body) || Object.keys(body).length !== SETUP_LIMITS_BODY_KEYS.length || !SETUP_LIMITS_BODY_KEYS.every((key) => key in body)) return undefined;
  const { requestId, expectedRevision, limits } = body;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId) || !count(expectedRevision) || !plain(limits)) return undefined;
  // Only the five names are passed on; an unknown one makes the body not valid (Code would refuse it too).
  if (!Object.keys(limits).every((key) => (SETUP_LIMIT_KEYS as readonly string[]).includes(key))) return undefined;
  return { requestId, expectedRevision, limits: Object.fromEntries(Object.entries(limits)) };
}

function target(context: RouteContext): { project: string } | { refusal: RouteAnswer } {
  if (companyOf(context.session.access) === undefined) return { refusal: NOT_IN_COMPANY };
  const project = context.params[0];
  if (project === undefined || !PROJECT.test(project) || [...context.query.keys()].length > 0) return { refusal: A.invalid };
  return { project };
}

export const SETUP_LIMITS_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/setup-agent\/limits$/u,
    answer: async (context) => {
      const at = target(context);
      if ("refusal" in at) return at.refusal;
      let got: unknown;
      try { got = await context.client.json<unknown>(context.session, base(at.project)); } catch (error) { if (error instanceof CodeError) return setupLimitsRefusal(error); throw error; }
      try { return { status: 200, body: setupLimitsView(got) }; } catch (error) { if (error instanceof Unreadable) return A.unreadable; throw error; }
    },
  },
  {
    method: "PUT", path: /^\/projects\/([^/]+)\/setup-agent\/limits$/u,
    answer: async (context) => {
      const at = target(context);
      if ("refusal" in at) return at.refusal;
      const sent = setupLimitsBody(context.body);
      if (sent === undefined) return A.invalid;
      let got: unknown;
      try { got = await context.client.json<unknown>(context.session, base(at.project), { method: "PUT", body: sent }); } catch (error) { if (error instanceof CodeError) return setupLimitsRefusal(error); throw error; }
      logged("changed", at.project);
      // The change is Code's, and made. An answer that does not read is not "failed": the page reads the limits again.
      try { return { status: 200, body: setupLimitsView(got) }; } catch (error) { if (error instanceof Unreadable) return A.unreadable; throw error; }
    },
  },
];
