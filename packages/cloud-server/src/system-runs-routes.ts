// Lead 4 L4-P3 (owner decision, 2026-11-17): the company's one control over nightly upkeep, passed to Rovara Code as the signed-in person, with their own token.
//
//   GET /v1/app/company/system-runs   -> Code GET /v1/app/company/system-runs   { available, allowed, systemRunsOn }
//   PUT /v1/app/company/system-runs   { requestId, allowed }  -> Code PUT /v1/app/company/system-runs   (allow: Code asks for a fresh step-up; withdraw: it does not)
//
// Rules:
//   - Only a company owner or administrator uses it. Cloud asks Code who the person is and their role NOW (the access check, never the stored sign-in, a cookie or the browser); anyone else gets one fixed 403 and
//     Code is not asked. Code checks the same rule again on its live membership and decides the fresh step-up itself: Cloud adds no rule that could widen it, and asks for no step-up on a withdrawal.
//   - The browser sends a request id and the one choice. Nothing else is forwarded (no company, person, role or query); an extra field, a malformed body or any query is refused without asking Code.
//   - The answer is rebuilt from the three booleans and must read (and agree: running is available AND allowed), else the whole read is refused.
//   - Code's refusals reach the app as Cloud's own fixed words, never Code's text and never an echo of the browser's input: the step-up answer keeps its code `REAUTH_REQUIRED`, which the app turns into the
//     sign-in step. Until Code serves the route, its fixed unknown-route 404 reads "isn't available on this Rovara yet" (501 NOT_ON_CODE_YET).
//   - The logs say what was done (allowed or withdrawn), never what the person wrote.
import { CodeError } from "./code-client.js";
import { companyCaller, isCompanyAdmin, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { CODE_CONSENT_WORDS, WIKI_SETUP_ANSWERS as A } from "./wiki-setup-routes.js";
import { Unreadable, need, plain, rec } from "./wiki-routes.js";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CODE_PATH = "/v1/app/company/system-runs";

/** The PUT body: exactly a request id and the choice, rebuilt (nothing else is passed on). */
export function systemRunsBody(body: unknown): { requestId: string; allowed: boolean } | undefined {
  if (!plain(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("requestId") || !keys.includes("allowed")) return undefined;
  const id = body["requestId"], allowed = body["allowed"];
  if (typeof id !== "string" || !REQUEST_ID.test(id) || typeof allowed !== "boolean") return undefined;
  return { requestId: id, allowed };
}

/** Code's answer rebuilt from its three booleans; throws `Unreadable` for anything else, or for an answer that contradicts itself. */
export function systemRunsAnswer(value: unknown): { available: boolean; allowed: boolean; systemRunsOn: boolean } {
  const f = rec(value);
  const flag = (one: unknown): boolean => need(typeof one === "boolean", one) as boolean;
  const available = flag(f["available"]), allowed = flag(f["allowed"]), systemRunsOn = flag(f["systemRunsOn"]);
  need(systemRunsOn === (available && allowed), systemRunsOn);
  return { available, allowed, systemRunsOn };
}

/** Code's refusal in Cloud's fixed words: the step-up answer keeps its code, a 404 (unknown route, not wired, or the operator's ceiling off) reads "not available yet", anything else is Cloud's own sentence. */
export function systemRunsRefusal(error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const message = typeof body?.["message"] === "string" ? body["message"] : undefined, code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  if (error.status === 403) return code === "REAUTH_REQUIRED" && message === CODE_CONSENT_WORDS.needsSignIn ? A.needsSignIn : A.systemRunsNotAllowed;
  if (error.status === 404) return A.upkeepNotYet;
  if (error.status === 400) return A.invalid;
  return A.upkeepUnavailable;
}

const logged = (action: string): void => { console.log(JSON.stringify({ event: "cloud.system_runs", action })); };

async function authorised(context: RouteContext): Promise<RouteAnswer | undefined> {
  if ([...context.query.keys()].length > 0) return A.invalid;
  let who: Awaited<ReturnType<typeof companyCaller>>;
  try {
    who = await companyCaller(context);
  } catch (error) {
    if (error instanceof CodeError) return A.upkeepUnavailable;
    throw error;
  }
  if (refused(who)) return who;
  // The role is Code's answer now. Anyone else is refused here without asking (Code refuses them too).
  return isCompanyAdmin(who.companyRole) ? undefined : A.systemRunsNotAllowed;
}

async function forward(context: RouteContext, init: { method?: string; body?: unknown } = {}): Promise<RouteAnswer> {
  let got: unknown;
  try {
    got = await context.client.json<unknown>(context.session, CODE_PATH, init);
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) return systemRunsRefusal(error);
    throw error;
  }
  try { return { status: 200, body: systemRunsAnswer(got) }; } catch (error) { if (error instanceof Unreadable) return A.upkeepUnavailable; throw error; }
}

export const SYSTEM_RUNS_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/company\/system-runs$/u,
    answer: async (context) => (await authorised(context)) ?? forward(context),
  },
  {
    method: "PUT", path: /^\/company\/system-runs$/u,
    answer: async (context) => {
      const refusal = await authorised(context);
      if (refusal !== undefined) return refusal;
      const sent = systemRunsBody(context.body);
      if (sent === undefined) return A.invalid;
      const out = await forward(context, { method: "PUT", body: sent });
      if (out.status === 200) logged(sent.allowed ? "allowed" : "withdrawn");
      return out;
    },
  },
];
