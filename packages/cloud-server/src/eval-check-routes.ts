// L4-EVCI2 (Thursday fallback, the Influur pilot): the setup checklist's "Eval check from your CI", passed through to Rovara Code as the signed-in person. Code reads the project's workflow files, proposes the jobs that
// look like an eval, and keeps the one a maintainer confirms (its `CiEvidenceSettings.evalCheck`); Code then shows that check's result on its pull requests, chat and ticket. Code's routes (core-host/eval-check-routes.ts):
//
//   GET /v1/app/projects/{p}/ci-eval-check   { project, canManage, confirmed, proposals, explanation }: any role on the project reads the confirmed check; people who manage the setup also get the proposals
//   PUT /v1/app/projects/{p}/ci-eval-check   { requestId, check } with `check` one of the proposals just read, or null for none
//
// Rules (the wiki setup routes'):
//   - Code decides who may: the person's LIVE company and project standing on every call. Cloud adds no rule that could widen it (it only refuses earlier a person who is neither a company owner or admin nor the project's
//     administrator, as the eval confirm does) and sends no person, company, role or payer: the body is rebuilt here from the two known fields. Cloud refuses earlier only what cannot be valid (a malformed project name, an unreadable body, a query).
//   - Every answer is rebuilt from known fields; one that does not read is refused whole. No dollar figure, no run, no log and no text of a repository reaches the browser: a proposal is a check's name, the workflow file's
//     path and the repository's name, all checked for control characters and length.
//   - A refusal reaches the app in the words Code fixed (an exact member of a known list), else in Cloud's own fixed words; never an echo of the browser's input. Until Code serves the route, its fixed unknown-route 404
//     reads "isn't available on this Rovara yet" (501 NOT_ON_CODE_YET).
//   - The logs say what was done and where (action, project), never what the person chose.
import { CodeError } from "./code-client.js";
import { companyOf, isCompanyAdmin } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { Unreadable, list, need, oneOf, plain, rec, safePath, scope, text } from "./wiki-routes.js";

/** Code's fixed sentences of this card (core/ci-evidence/eval-check-card.ts `EVAL_CHECK_WORDS`); matched exactly, never anything else of Code's. */
export const EVAL_CHECK_CODE_WORDS = Object.freeze({
  notProposed: "That is not a check Rovara found in your workflow files. Open the setup again to see the list.",
  cannotRead: "Rovara could not read your workflow files just now, so it cannot confirm a check. Try again.",
});
export const EVAL_CHECK_WORDS = Object.freeze({
  invalid: "the request is not valid",
  notFound: "project not found",
  notYet: "Choosing the eval check isn't available on this Rovara yet.",
  unavailable: "The eval check could not be read just now. Try again.",
  notAllowed: "Only company owners and admins, or this project's admins, can choose the eval check.",
  auditUnavailable: "The record of this change could not be written, so nothing was done. Try again.",
  explanation: "Rovara shows this check's result on its pull requests.",
});
const W = EVAL_CHECK_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const EVAL_CHECK_ANSWERS = Object.freeze({
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notFound: answer(404, "NOT_FOUND", W.notFound),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
  notAllowed: answer(403, "FORBIDDEN", W.notAllowed),
  auditUnavailable: answer(503, "AUDIT_UNAVAILABLE", W.auditUnavailable),
  notProposed: answer(400, "CONFIG_INVALID", EVAL_CHECK_CODE_WORDS.notProposed),
  cannotRead: answer(503, "RUNTIME_UNAVAILABLE", EVAL_CHECK_CODE_WORDS.cannotRead),
});
const A = EVAL_CHECK_ANSWERS;

export const EVAL_CHECK_LIMITS = { name: 200, source: 200, items: 5, repository: 100, workflow: 256 } as const;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERDICTS = ["proposals", "none_found", "unknown"] as const;
const BASES = ["name", "commands"] as const;
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

/** Code's refusal in fixed words. Only Code's exact unknown-route 404 means "not on Code yet". */
export function evalCheckRefusal(error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const message = typeof body?.["message"] === "string" ? body["message"] : undefined, code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  if (error.status === 404 && code === "NOT_FOUND" && message === "route not found") return A.notYet;
  if (error.status === 404) return A.notFound;
  if (error.status === 403) return A.notAllowed;
  if (error.status === 400) return message === EVAL_CHECK_CODE_WORDS.notProposed ? A.notProposed : A.invalid;
  if (error.status === 503 && code === "AUDIT_UNAVAILABLE") return A.auditUnavailable;
  if (error.status === 503 && message === EVAL_CHECK_CODE_WORDS.cannotRead) return A.cannotRead;
  return A.unavailable;
}

/** The PUT body, rebuilt from its two known fields: a request id, and a check (its name and optional reporting app) or null. Undefined: not a request. */
export function evalCheckBody(body: unknown): Record<string, unknown> | undefined {
  if (!plain(body) || !hasOnly(body, ["requestId", "check"]) || typeof body["requestId"] !== "string" || !REQUEST_ID.test(body["requestId"])) return undefined;
  const check = body["check"];
  if (check === null) return { requestId: body["requestId"], check: null };
  if (!plain(check) || !hasOnly(check, ["name", "source"]) || !text(check["name"], EVAL_CHECK_LIMITS.name) || (check["source"] !== undefined && !text(check["source"], EVAL_CHECK_LIMITS.source))) return undefined;
  return { requestId: body["requestId"], check: { name: check["name"], ...(check["source"] === undefined ? {} : { source: check["source"] }) } };
}

/** Code's answer for THIS project, rebuilt from its known fields only; throws Unreadable on anything off. */
export function evalCheckAnswer(value: unknown, project: string): Record<string, unknown> {
  const v = rec(value);
  need(v["project"] === project && typeof v["canManage"] === "boolean", undefined);
  const confirmed = v["confirmed"] === null ? null : rec(v["confirmed"]);
  const proposals = v["proposals"] === null ? null : rec(v["proposals"]);
  // Only a manager is shown the proposals (Code sends them to no one else): a reader's answer that carries any is not a reading.
  need(v["canManage"] === true || proposals === null, undefined);
  return {
    project, canManage: v["canManage"],
    confirmed: confirmed === null ? null : { name: need(text(confirmed["name"], EVAL_CHECK_LIMITS.name), confirmed["name"]), ...(confirmed["source"] === undefined ? {} : { source: need(text(confirmed["source"], EVAL_CHECK_LIMITS.source), confirmed["source"]) }) },
    proposals: proposals === null ? null : (() => {
      const verdict = need(oneOf(proposals["verdict"], VERDICTS), proposals["verdict"]);
      const items = list(proposals["items"], EVAL_CHECK_LIMITS.items).map((one) => {
        const item = rec(one);
        return {
          name: need(text(item["name"], EVAL_CHECK_LIMITS.name), item["name"]), ...(item["source"] === undefined ? {} : { source: need(text(item["source"], EVAL_CHECK_LIMITS.source), item["source"]) }),
          workflow: need(safePath(item["workflow"]) && (item["workflow"] as string).length <= EVAL_CHECK_LIMITS.workflow, item["workflow"]),
          repository: need(text(item["repository"], EVAL_CHECK_LIMITS.repository), item["repository"]), basis: need(oneOf(item["basis"], BASES), item["basis"]),
        };
      });
      need((verdict === "proposals") === (items.length > 0) && typeof proposals["cut"] === "boolean", undefined);
      return { verdict, items, cut: proposals["cut"] };
    })(),
    explanation: W.explanation,
  };
}

const base = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/ci-eval-check`;
const logged = (action: string, project: string): void => { console.log(JSON.stringify({ event: "cloud.eval_check", action, project })); };

async function target(context: RouteContext): Promise<{ project: string } | { refusal: RouteAnswer }> {
  const at = await scope(context);
  if ("refusal" in at) return at;
  if ([...context.query.keys()].length > 0) return { refusal: A.invalid };
  return at;
}

/** A company owner or admin (Code's company role), or the project's administrator (its maintainer). Cloud refuses everyone else before Code is asked; Code decides again, live. */
function mayConfirm(context: RouteContext, project: string): boolean {
  const membership = companyOf(context.session.access);
  if (membership === undefined) return false;
  return isCompanyAdmin(membership.companyRole) || context.session.access.projects.some((one) => one.name === project && one.access === "administrator");
}

async function viaCode(context: RouteContext, project: string, init: { method?: string; body?: unknown } = {}): Promise<RouteAnswer> {
  let value: unknown;
  try {
    value = await context.client.json<unknown>(context.session, base(project), init);
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) return evalCheckRefusal(error);
    throw error;
  }
  try { return { status: 200, body: evalCheckAnswer(value, project) }; } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
}

export const EVAL_CHECK_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/ci-eval-check$/u,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      return viaCode(context, at.project);
    },
  },
  {
    method: "PUT", path: /^\/projects\/([^/]+)\/ci-eval-check$/u,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      if (!mayConfirm(context, at.project)) return A.notAllowed;
      const sent = evalCheckBody(context.body);
      if (sent === undefined) return A.invalid;
      const out = await viaCode(context, at.project, { method: "PUT", body: sent });
      if (out.status === 200) logged(sent["check"] === null ? "eval_check_cleared" : "eval_check_confirmed", at.project);
      return out;
    },
  },
];
