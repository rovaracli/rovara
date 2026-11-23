// Browser testing in a project's setup (owner decisions 417, 420, 421), passed to Rovara Code as the signed-in person. Code serves (core-host/browser-testing-routes.ts):
//
//   GET  /v1/app/projects/{p}/browser-testing            the page's read
//   POST /v1/app/projects/{p}/browser-testing/refresh    { requestId }
//   PUT  /v1/app/projects/{p}/browser-testing/draft      { requestId, expectedDraftRevision, proof?, runTimeoutMs? }
//   POST /v1/app/projects/{p}/browser-testing/check      { requestId, expectedDraftRevision }
//   POST /v1/app/projects/{p}/browser-testing/decision   { requestId, outcome, seen: { revision, artifactDigest } }
//   POST /v1/app/projects/{p}/browser-testing/discard, /pause, /resume   { requestId }
//
// Rules (the eval check's, and one stricter):
//   - Nothing is typed here: no password, secret, address or account is in any body or answer, and a member no schema lists is refused, never passed on.
//   - Code decides who may: the person's LIVE company standing on every call (a change is for a company owner or admin only; the project's own administrator may NOT). Cloud refuses earlier only a person who is not a
//     company owner or admin on a change, and what cannot be valid (a malformed project name, a body that is not exactly the listed members, a query). It sends no person, company, role or payer.
//   - Every answer is read with the strict schema of @agentx/contracts/web and must name THIS project; one that does not read is refused whole.
//   - A refusal reaches the app in the words Code fixed (an exact member of a known list), else in Cloud's own fixed words; never an echo of the browser's input. A change whose answer did not arrive is the one
//     "outcome is unknown" answer: it says the change may or may not have been made, and the app never repeats it by itself. Code's unknown-route 404 reads 501 NOT_ON_CODE_YET.
//   - The logs say what was done and where (action, project), never what the person chose.
import {
  BROWSER_TESTING_CLOUD_SENTENCES, BROWSER_TESTING_CODE_SENTENCES, BROWSER_TESTING_SENTENCES, BrowserTestingChoicesBodySchema, BrowserTestingCheckBodySchema, BrowserTestingDecisionAnswerSchema, BrowserTestingDecisionBodySchema,
  BrowserTestingSimpleBodySchema, BrowserTestingViewSchema,
} from "@agentx/contracts/web";
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import { companyOf, isCompanyAdmin } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { plain, scope } from "./wiki-routes.js";

const W = BROWSER_TESTING_CLOUD_SENTENCES;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const BROWSER_TESTING_ANSWERS = Object.freeze({
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notFound: answer(404, "NOT_FOUND", W.notFound),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
  notAllowed: answer(403, "FORBIDDEN", BROWSER_TESTING_CODE_SENTENCES.notAllowed),
  outcomeUnknown: answer(503, "RUNTIME_UNAVAILABLE", W.outcomeUnknown),
  stale: answer(409, "CHANGE_STALE", BROWSER_TESTING_CODE_SENTENCES.stale),
});
/** What a Code whose core engine does not serve the route yet says (core-host/dev-routes.ts NOT_ON_THE_CORE_YET); same as an older Code's "route not found". */
const CORE_NOT_YET = "That is not on the core engine on this install yet.";
const A = BROWSER_TESTING_ANSWERS;
const BEFORE_ANY_CHANGE: ReadonlySet<string> = new Set([BROWSER_TESTING_CODE_SENTENCES.sandboxUnavailable, BROWSER_TESTING_CODE_SENTENCES.auditUnavailable]);

const CODES = new Set(["NOT_FOUND", "FORBIDDEN", "CONFIG_INVALID", "CHANGE_STALE", "WORKSPACE_BUSY", "RUNTIME_UNAVAILABLE", "AUDIT_UNAVAILABLE", "IDEMPOTENCY_CONFLICT", "REAUTH_REQUIRED", "PROJECT_ARCHIVED"]);
/** Code's refusal in fixed words: its own sentence only when it is exactly one of the known ones; else Cloud's. Only Code's exact unknown-route 404 (or the core host's "not on the core engine yet") means "not on Code yet"; a 409 in unknown words is the "changed while you were looking" sentence. */
export function browserTestingRefusal(error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return A.outcomeUnknown;
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const message = typeof body?.["message"] === "string" ? body["message"] : undefined, code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  if (error.status === 404 && ((code === "NOT_FOUND" && message === "route not found") || message === CORE_NOT_YET)) return A.notYet;
  if (error.status === 404) return A.notFound;
  if (code !== undefined && message !== undefined && CODES.has(code) && BROWSER_TESTING_SENTENCES.has(message) && error.status >= 400 && error.status < 600 && error.status !== 502) return answer(error.status, code, message);
  if (error.status === 403) return A.notAllowed;
  if (error.status === 409) return A.stale;
  if (error.status === 400) return A.invalid;
  return A.unavailable;
}

const base = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/browser-testing`;
const logged = (action: string, project: string): void => { console.log(JSON.stringify({ event: "cloud.browser_testing", action, project })); };

async function target(context: RouteContext): Promise<{ project: string } | { refusal: RouteAnswer }> {
  const at = await scope(context);
  if ("refusal" in at) return at;
  if ([...context.query.keys()].length > 0) return { refusal: A.invalid };
  return at;
}

/** A company owner or admin. Cloud refuses everyone else before Code is asked; Code decides again, live. The project's own administrator is NOT enough. */
function mayChange(context: RouteContext): boolean {
  const membership = companyOf(context.session.access);
  return membership !== undefined && isCompanyAdmin(membership.companyRole);
}

async function viaCode(context: RouteContext, project: string, tail: string, init: { method?: string; body?: unknown }, parse: (value: unknown) => RouteAnswer): Promise<RouteAnswer> {
  let value: unknown;
  try {
    value = await context.client.json<unknown>(context.session, base(project) + tail, init);
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) {
      const refusal = browserTestingRefusal(error);
      // A change Code may have made: a 5xx that is not one of the refusals Code makes BEFORE any change is the one unknown-outcome answer.
      if (init.method !== undefined && error.status >= 500 && !BEFORE_ANY_CHANGE.has((refusal.body as { error: { message: string } }).error.message)) return A.outcomeUnknown;
      return refusal;
    }
    throw error;
  }
  return parse(value);
}
const viewAnswer = (project: string) => (value: unknown): RouteAnswer => {
  const parsed = BrowserTestingViewSchema.safeParse(value);
  return parsed.success && parsed.data.project === project ? { status: 200, body: parsed.data } : A.unavailable;
};
const decisionAnswer = (project: string) => (value: unknown): RouteAnswer => {
  const parsed = BrowserTestingDecisionAnswerSchema.safeParse(value);
  return parsed.success && parsed.data.project === project && parsed.data.view.project === project ? { status: 200, body: parsed.data } : A.outcomeUnknown;
};

const PATH = (tail: string) => new RegExp(`^/projects/([^/]+)/browser-testing${tail}$`, "u");
/** One change: owner/admin only, the body strictly parsed and rebuilt, the answer the page's read again. A change answered with something unreadable is "unknown": it may have been made. */
function change(method: "POST" | "PUT", tail: string, action: string, schema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false } }): Route {
  return {
    method, path: PATH(tail),
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      if (!mayChange(context)) return A.notAllowed;
      const sent = schema.safeParse(context.body);
      if (!sent.success) return A.invalid;
      const out = await viaCode(context, at.project, tail, { method, body: sent.data }, action === "decision" ? decisionAnswer(at.project) : (value) => { const view = viewAnswer(at.project)(value); return view.status === 200 ? view : A.outcomeUnknown; });
      if (out.status === 200) logged(action, at.project);
      return out;
    },
  };
}

export const BROWSER_TESTING_ROUTES: Route[] = [
  {
    method: "GET", path: PATH(""),
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      return viaCode(context, at.project, "", {}, viewAnswer(at.project));
    },
  },
  change("POST", "/refresh", "refresh", BrowserTestingSimpleBodySchema),
  change("PUT", "/draft", "choices", BrowserTestingChoicesBodySchema),
  change("POST", "/check", "check", BrowserTestingCheckBodySchema),
  change("POST", "/decision", "decision", BrowserTestingDecisionBodySchema),
  change("POST", "/discard", "discard", BrowserTestingSimpleBodySchema),
  change("POST", "/pause", "pause", BrowserTestingSimpleBodySchema),
  change("POST", "/resume", "resume", BrowserTestingSimpleBodySchema),
];
