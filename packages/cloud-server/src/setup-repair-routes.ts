// Lead 4 L4-U5 (setup-upkeep-plan.md step 3c): the "Setup needs repair" card on a project's setup page and its "Re-check setup" button, passed to Rovara Code as the signed-in person.
//
//   GET  /v1/app/projects/{p}/setup-repair           -> Code GET  /v1/app/projects/{p}/setup-check   { state, canManage, repair? }   (Code L4-P1 + L4-U5; any live role on the project reads)
//   POST /v1/app/projects/{p}/setup-repair/recheck   { requestId } -> Code POST /v1/app/projects/{p}/setup-check   (a person who manages the project's setup starts the plain check; no AI)
//
// Rules:
//   - Code decides who may read and who may start (its live company role and project grant); Cloud adds no rule that could widen that. Cloud refuses earlier only what cannot be valid: a malformed project name,
//     a query, a body that is not exactly `{ requestId }`.
//   - The answer is rebuilt field by field. The card's SENTENCE is rebuilt here from Code's exact template (`SETUP_REPAIR_SENTENCES.body`): only the check's own failing step is repository text, and it is taken from
//     Code's sentence only when that sentence matches the template exactly; anything else makes the whole read refused ("unreadable is refusal"). The actions are Code's two ids with Cloud's own labels, at most one,
//     and none for a person Code says may not act. NO DOLLAR FIGURE comes from Code; the cost words on the button are Cloud's own and are said on the page only.
//   - Code's refusals reach the app in Cloud's own fixed words, never Code's text or an echo of the browser's input. Until Code serves the read, its unknown-route 404 reads "isn't available yet" (501 NOT_ON_CODE_YET).
//   - The logs say what was done and where (action, project), never what the person wrote.
// cloud-server takes no package dependency, so the shapes are checked here by hand against contracts app-setup-repair.ts (a unit test pins the sentences against Code's).
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { Unreadable, need, plain, rec, scope, text, when } from "./wiki-routes.js";

export const SETUP_REPAIR_WORDS = Object.freeze({
  invalid: "the request is not valid",
  notFound: "project not found",
  notAllowed: "Only company owners and admins, or this project's admins, can re-check the project's setup.",
  notYet: "Setup repair isn't available on this Rovara yet.",
  unavailable: "The project's setup could not be read or checked just now. Try again.",
  busy: "A setup check is already running for this project. Wait for it to finish.",
  archivedOrOff: "Checking the project's setup isn't available for this company yet.",
});
const W = SETUP_REPAIR_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const SETUP_REPAIR_ANSWERS = Object.freeze({
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notFound: answer(404, "NOT_FOUND", W.notFound),
  notAllowed: answer(403, "FORBIDDEN", W.notAllowed),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
  busy: answer(409, "WORKSPACE_BUSY", W.busy),
  off: answer(503, "RUNTIME_UNAVAILABLE", W.archivedOrOff),
});
const A = SETUP_REPAIR_ANSWERS;

/** Code's card sentence (`setupRepairCardOf` body): the template Cloud matches, with the step in the middle. */
/** Code cuts the check's failing step at a fixed length, so it can end inside a bracket or hold a lone one: the step is whatever sits between the template's fixed words (one line, no control characters, at most 300 characters). */
const BODY_STEP = /^The project's setup stopped working after recent code changes \(([^\p{Cc}\p{Cf}]{1,300})\)\. Rovara cannot build on this project until it is fixed\.$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROJECT_FOR_PATH = /^[a-z][a-z0-9-]{0,62}$/u;
const STATES = ["unchecked", "outdated", "checking", "failed", "ready"] as const;
const ACTIONS: Readonly<Record<string, string>> = Object.freeze({ fix_setup: "Fix setup", approve_new_setup: "Approve new setup" });

const flag = (value: unknown): boolean => need(typeof value === "boolean", value) as boolean;

/** The card inside Code's answer, rebuilt; throws `Unreadable` for anything that does not read. */
function repairAnswer(value: unknown): Record<string, unknown> {
  const r = rec(value);
  need(Object.keys(r).every((key) => ["title", "body", "changed", "at", "fixReady", "actions"].includes(key)), r);
  need(r["title"] === "Setup needs repair", r["title"]);
  const body = r["body"];
  const step = typeof body === "string" ? BODY_STEP.exec(body)?.[1] : undefined;
  need(step !== undefined && text(step, 300), body);
  need(r["changed"] === undefined || text(r["changed"], 160), r["changed"]);
  need(when(r["at"]), r["at"]);
  const fixReady = flag(r["fixReady"]);
  need(Array.isArray(r["actions"]) && r["actions"].length <= 1, r["actions"]);
  const actions = (r["actions"] as unknown[]).map((one) => {
    const a = rec(one);
    need(Object.keys(a).length === 2 && typeof a["id"] === "string" && a["id"] in ACTIONS && a["label"] === ACTIONS[a["id"]], a);
    // The action must fit the state: a fix waiting is approved, anything else is fixed.
    need(a["id"] === (fixReady ? "approve_new_setup" : "fix_setup"), a["id"]);
    return { id: a["id"], label: ACTIONS[a["id"] as string] };
  });
  return { step, ...(r["changed"] === undefined ? {} : { changed: r["changed"] }), at: new Date(Date.parse(r["at"] as string)).toISOString(), fixReady, actions };
}

/** Code's `GET setup-check` answer rebuilt into the app's view. The rest of Code's setup state (commit, failing step of a person's own check) is not passed on. */
export function setupRepairView(value: unknown): Record<string, unknown> {
  const v = rec(value);
  need(typeof v["status"] === "string" && (STATES as readonly string[]).includes(v["status"]), v["status"]);
  const canManage = flag(v["canManage"]);
  const repair = v["repair"] === undefined ? undefined : repairAnswer(v["repair"]);
  // A card without the right to act carries no action (Code never sends one; a contradiction is refused).
  need(repair === undefined || canManage || (repair["actions"] as unknown[]).length === 0, v["repair"]);
  return { state: v["status"], canManage, ...(repair === undefined ? {} : { repair }) };
}

/** Code's refusal in Cloud's words. Only Code's exact unknown-route 404 means "not on Code yet"; a missing project (or one the person cannot see) is the one uniform 404. */
export function setupRepairRefusal(error: CodeError): RouteAnswer {
  if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const message = typeof body?.["message"] === "string" ? body["message"] : undefined, code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  if (error.status === 404 && code === "NOT_FOUND" && message === "route not found") return A.notYet;
  if (error.status === 404) return A.notFound;
  if (error.status === 400) return A.invalid;
  if (error.status === 403) return A.notAllowed;
  if (error.status === 409) return A.busy;
  if (error.status === 503 || error.status === 501) return A.off;
  return A.unavailable;
}

const base = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/setup-check`;
const logged = (action: string, project: string): void => { console.log(JSON.stringify({ event: "cloud.setup_repair", action, project })); };

/** The recheck body: exactly a request id; nothing else is sent on. */
export function recheckBody(body: unknown): { requestId: string } | undefined {
  if (!plain(body)) return undefined;
  const keys = Object.keys(body);
  const id = body["requestId"];
  return keys.length === 1 && typeof id === "string" && REQUEST_ID.test(id) ? { requestId: id } : undefined;
}

async function target(context: RouteContext): Promise<{ project: string } | { refusal: RouteAnswer }> {
  const at = await scope(context);
  if ("refusal" in at) return at;
  if ([...context.query.keys()].length > 0 || !PROJECT_FOR_PATH.test(at.project)) return { refusal: A.invalid };
  return at;
}

export const SETUP_REPAIR_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/setup-repair$/u,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      let got: unknown;
      try { got = await context.client.json<unknown>(context.session, base(at.project)); } catch (error) { if (error instanceof CodeError) return setupRepairRefusal(error); throw error; }
      try { return { status: 200, body: setupRepairView(got) }; } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; }
    },
  },
  {
    method: "POST", path: /^\/projects\/([^/]+)\/setup-repair\/recheck$/u,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      const sent = recheckBody(context.body);
      if (sent === undefined) return A.invalid;
      try { await context.client.json<unknown>(context.session, base(at.project), { method: "POST", body: sent }); } catch (error) { if (error instanceof CodeError) return setupRepairRefusal(error); throw error; }
      logged("recheck", at.project);
      return { status: 200, body: { started: true } };
    },
  },
];
