// Lead 4 slice W6 (DEC 254zi, 254zza; designs-2026-11-17/project-wiki-ux.md section 4a): the wiki panel on the project's setup page, passed through to Rovara Code as the signed-in person.
// Code's routes are W0's file map (`wiki-map`, PR #893) and W4's build controls (`wiki-build`, local branch pr/l4-wiki-controls at fafd0ea13); the last two rows are a SEAM the nightly runner (L4-N1) supplies.
//
//   GET  /v1/app/projects/{p}/wiki-map                the file map last made (or none) and `canManage`
//   POST /v1/app/projects/{p}/wiki-map                make the map now (no model, nothing spent)
//   GET  /v1/app/projects/{p}/wiki-build              where the build stands and what the controls show
//   POST /v1/app/projects/{p}/wiki-build              Build the wiki      { requestId, notes?, chipsOn? }
//   POST /v1/app/projects/{p}/wiki-build/continue     { requestId }
//   POST /v1/app/projects/{p}/wiki-build/stop         { requestId }
//   POST /v1/app/projects/{p}/wiki-build/refresh      { requestId }       Refresh now
//   POST /v1/app/projects/{p}/wiki-build/agents       { requestId, on }   "Give the wiki to agents"
//   POST /v1/app/projects/{p}/wiki-build/delete       { requestId }       Delete wiki
//   GET  /v1/app/projects/{p}/upkeep                  { enabled, canManage, available?, systemRunsOn?, canEnableSystemRuns?, cap?, spend? }  (Code L4-N1 + L4-P2 + L4-SR1; spend: managers only)
//   PUT  /v1/app/projects/{p}/upkeep                  { requestId, on, allowSystemRuns? }                                       (allowSystemRuns: the company's consent, Code decides who may)
//
// Rules:
//   - Code decides who may do each: the person's LIVE company and project standing, read on every call. Cloud adds no rule that could widen it and sends no person, company, role, limit, commit or goal:
//     each body is rebuilt here from known fields. Cloud refuses earlier only what cannot be valid (a malformed project name, an unreadable body, a query).
//   - Every answer is rebuilt from known fields; one that does not read is refused whole ("unreadable is refusal"). NO DOLLAR FIGURE crosses Cloud: W4's `budgetCents` and `spentCents` (placeholders until the
//     first measured build) and W0's price are dropped or refused, and no task id or commit reaches the browser. The page shows pages.
//   - A refusal reaches the app in the words Code fixed (an exact member of a known list), else in Cloud's own fixed words; never an echo of the browser's input, never other text of Code's. Until Code serves a
//     route, its fixed unknown-route 404 reads "isn't available on this Rovara yet" (501 NOT_ON_CODE_YET).
//   - The logs say what was done and where (action, project), never what the person wrote.
//   - AI key (L4-CW): hosted Code cannot see the company's AI choice and answers `aiKey: "unknown"`. For a person Code says manages the project, Cloud replaces it with its own yes/no (agent-ai-presence.ts:
//     the saved "AI for your agents" choice and its connection), and refuses Build/Continue/Refresh now with Code's fixed "Connect an AI key" sentence before Code is asked when it knows there is none.
//     Code's own connected/missing wins; a reader keeps "unknown"; a fact Cloud cannot read stays "unknown". Only the enum and that sentence leave (no key, provider, source or model).
// cloud-server takes no package dependency, so the shapes are checked here by hand against contracts app-wiki-setup.ts (its limits and words are repeated and a unit test pins them).
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { agentAiConnected } from "./agent-ai-presence.js";
import { Unreadable, list, need, oneOf, plain, prose, rec, scope, text, when, whole } from "./wiki-routes.js";

export const WIKI_SETUP_CODE_WORDS = Object.freeze({
  busy: "Rovara is already building this project's wiki.",
  connectKey: "Connect an AI key to build the wiki.",
  notAllowed: "Only company owners and admins, or this project's admins, can build the wiki.",
  noRepositories: "This project has no repository Rovara can read, so there is nothing to build.",
  noMap: "Map the project's files first, then build the wiki.",
  nothingToContinue: "There is no stopped wiki build to continue.",
  raiseCap: "This wiki build already used its spending limit. Raise the limit, then continue.",
  built: "Wiki built.",
  budget_used: "The wiki build reached its spending limit. It kept the pages it finished.",
  pages_used: "The wiki build reached its page limit. It kept the pages it finished.",
  time_used: "The wiki build ran out of time. It kept the pages it finished.",
  stopped_by_person: "The wiki build was stopped. It kept the pages it finished.",
  needs_ai_key: "Connect an AI key to build the wiki. The pages already written are kept.",
  repo_unreadable: "Rovara could not read a repository at the commit it started from. It kept the pages it finished.",
  access_lost: "The person who started the wiki build can no longer build it. It kept the pages it finished.",
  infrastructure: "The wiki build could not go on. Try again; finished pages are kept.",
  projectNotFound: "project not found",
  unreadable: "The project's wiki could not be read just now. Try again.",
  unavailable: "Building the wiki isn't available for this company yet.",
  auditUnavailable: "The record of this change could not be written, so nothing was done. Try again.",
  nothingToRefresh: "Every page is up to date, so there is nothing to refresh.",
  buildFirst: "Build the wiki first, then refresh it.",
  deleteWhileRunning: "Stop the wiki build, then delete the wiki.",
  deleted: "The wiki was deleted.",
  mapNotAllowed: "Only company owners and admins, or this project's admins, can map a project's files.",
  mapUnavailable: "The project's files could not be mapped just now. Try again.",
  archived: "This project is archived. Restore it to start new work.",
});
export const WIKI_SETUP_WORDS = Object.freeze({
  invalid: "the request is not valid",
  notYet: "Building the wiki isn't available on this Rovara yet.",
  unavailable: "The wiki build could not be read just now. Try again.",
  notSetUp: "Building the wiki isn't set up for this company yet.",
  upkeepNotAllowed: "Only company owners and admins, or this project's admins, can change nightly upkeep.",
  upkeepNotYet: "Nightly upkeep isn't available on this Rovara yet.",
  upkeepUnavailable: "Nightly upkeep could not be read or changed just now. Try again.",
  upkeepNeedsConsent: "A company admin must allow nightly upkeep first.",
  upkeepConsentNotAllowed: "Only company owners and admins can allow nightly upkeep for the company.",
  needsSignIn: "Confirm it's you again, then try once more.",
  systemRunsNotAllowed: "Only company owners and admins can see or change nightly upkeep for the company.",
});
const C = WIKI_SETUP_CODE_WORDS;
const W = WIKI_SETUP_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const WIKI_SETUP_ANSWERS = Object.freeze({
  notFound: answer(404, "NOT_FOUND", C.projectNotFound),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
  notAllowed: answer(403, "FORBIDDEN", C.notAllowed),
  notSetUp: answer(503, "RUNTIME_UNAVAILABLE", W.notSetUp),
  upkeepNotAllowed: answer(403, "FORBIDDEN", W.upkeepNotAllowed),
  upkeepNotYet: answer(501, "NOT_ON_CODE_YET", W.upkeepNotYet),
  upkeepUnavailable: answer(503, "RUNTIME_UNAVAILABLE", W.upkeepUnavailable),
  upkeepNeedsConsent: answer(403, "FORBIDDEN", W.upkeepNeedsConsent),
  upkeepConsentNotAllowed: answer(403, "FORBIDDEN", W.upkeepConsentNotAllowed),
  needsSignIn: answer(403, "REAUTH_REQUIRED", W.needsSignIn),
  systemRunsNotAllowed: answer(403, "FORBIDDEN", W.systemRunsNotAllowed),
});
const A = WIKI_SETUP_ANSWERS;

/** Words Code fixed: an answer of Code's that says exactly one of these (with a known code and status) is passed on; anything else is Cloud's own words. */
const PASS_WORDS: ReadonlySet<string> = new Set(Object.values(C));
const PASS_CODES: ReadonlySet<string> = new Set(["NOT_FOUND", "PROJECT_NOT_FOUND", "FORBIDDEN", "CONFIG_INVALID", "WORKSPACE_BUSY", "BUDGET_EXCEEDED", "MODEL_PROXY_UNAVAILABLE", "AUDIT_UNAVAILABLE", "RUNTIME_UNAVAILABLE", "PROJECT_ARCHIVED", "IDEMPOTENCY_CONFLICT"]);
const PASS_STATUSES: ReadonlySet<number> = new Set([400, 402, 403, 404, 409, 503]);
/** Code's answer when it has no starter wired: not one of the sentences above, so it is named here and answered in Cloud's words. */
const NOT_SET_UP = "building the wiki is not set up in this deployment";

export const WIKI_SETUP_LIMITS = { notesChars: 2_000, chips: 200, chipChars: 80, repos: 20, areas: 200, skippedFolders: 20, pages: 10_000 } as const;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROJECT_FOR_PATH = /^[a-z][a-z0-9-]{0,62}$/u;

/** Code's fixed sentences of the consent step (its `SYSTEM_RUNS_CONSENT_WORDS`); matched exactly, never passed on. */
export const CODE_CONSENT_WORDS = Object.freeze({
  notAllowed: "Only company owners and admins can allow or stop Rovara's automatic runs for the company.",
  needsConsent: "A company owner or admin has to allow Rovara's automatic runs for the company first.",
});
type Kind = "map" | "build" | "upkeep";
/** Code's refusal in fixed words. Only Code's exact unknown-route 404 means "not on Code yet". */
export function wikiSetupRefusal(kind: Kind, error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const message = typeof body?.["message"] === "string" ? body["message"] : undefined, code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  if (error.status === 404 && code === "NOT_FOUND" && message === "route not found") return kind === "upkeep" ? A.upkeepNotYet : A.notYet;
  if (kind === "upkeep") {
    // Code's fixed words of the consent step (its SYSTEM_RUNS_CONSENT_WORDS) and its "not available here" (the ceiling is off) are matched exactly and answered in Cloud's own words.
    if (code === "NOT_AVAILABLE_HERE") return A.upkeepNotYet;
    if (error.status === 403 && code === "REAUTH_REQUIRED") return A.needsSignIn;
    if (error.status === 403 && message === CODE_CONSENT_WORDS.needsConsent) return A.upkeepNeedsConsent;
    if (error.status === 403 && message === CODE_CONSENT_WORDS.notAllowed) return A.upkeepConsentNotAllowed;
  }
  if (kind === "upkeep") return error.status === 404 ? A.notFound : error.status === 400 ? A.invalid : error.status === 403 ? A.upkeepNotAllowed : A.upkeepUnavailable;
  if (message === NOT_SET_UP) return A.notSetUp;
  if (message !== undefined && code !== undefined && PASS_WORDS.has(message) && PASS_CODES.has(code) && PASS_STATUSES.has(error.status)) return answer(error.status, code, message);
  if (error.status === 404) return A.notFound;
  if (error.status === 400) return A.invalid;
  if (error.status === 403) return kind === "map" ? answer(403, "FORBIDDEN", C.mapNotAllowed) : A.notAllowed;
  return A.unavailable;
}

type Got = { value: unknown } | { refusal: RouteAnswer };
async function fromCode(context: RouteContext, kind: Kind, path: string, init: { method?: string; body?: unknown } = {}): Promise<Got> {
  try {
    return { value: await context.client.json<unknown>(context.session, path, init) };
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) return { refusal: wikiSetupRefusal(kind, error) };
    throw error;
  }
}
const base = (project: string, tail: string) => `/v1/app/projects/${encodeURIComponent(project)}/${tail}`;
const rebuilt = (build: () => Record<string, unknown>, kind: Kind): RouteAnswer => {
  try { return { status: 200, body: build() }; } catch (error) { if (error instanceof Unreadable) return kind === "upkeep" ? A.upkeepUnavailable : A.unavailable; throw error; }
};
const flag = (value: unknown): boolean => need(typeof value === "boolean", value) as boolean;
const logged = (action: string, project: string): void => { console.log(JSON.stringify({ event: "cloud.wiki_setup", action, project })); };

// ---- Bodies: rebuilt from known fields; nothing else is sent ---------------------------------------------------------------------------------------------------------------------

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const requestId = (value: unknown): value is string => typeof value === "string" && REQUEST_ID.test(value);
export function startBody(body: unknown): Record<string, unknown> | undefined {
  if (!plain(body) || !hasOnly(body, ["requestId", "notes", "chipsOn"]) || !requestId(body["requestId"])) return undefined;
  const out: Record<string, unknown> = { requestId: body["requestId"] };
  if (body["notes"] !== undefined) {
    if (!prose(body["notes"], WIKI_SETUP_LIMITS.notesChars)) return undefined;
    if (body["notes"].trim() !== "") out["notes"] = body["notes"];
  }
  if (body["chipsOn"] !== undefined) {
    const chips = body["chipsOn"];
    if (!Array.isArray(chips) || chips.length > WIKI_SETUP_LIMITS.chips || !chips.every((chip) => text(chip, WIKI_SETUP_LIMITS.chipChars)) || new Set(chips).size !== chips.length) return undefined;
    out["chipsOn"] = [...chips];
  }
  return out;
}
export function idBody(body: unknown): Record<string, unknown> | undefined {
  return plain(body) && hasOnly(body, ["requestId"]) && requestId(body["requestId"]) ? { requestId: body["requestId"] } : undefined;
}
export function switchBody(body: unknown): Record<string, unknown> | undefined {
  return plain(body) && hasOnly(body, ["requestId", "on"]) && requestId(body["requestId"]) && typeof body["on"] === "boolean" ? { requestId: body["requestId"], on: body["on"] } : undefined;
}
/** The upkeep switch (L4-W6b): the id and the choice, plus `allowSystemRuns` only when the page sent it. Nothing else is forwarded; `allowSystemRuns: false` with `on: true` is not a request (Code refuses it too). */
export function upkeepBody(body: unknown): Record<string, unknown> | undefined {
  if (!plain(body) || !hasOnly(body, ["requestId", "on", "allowSystemRuns"]) || !requestId(body["requestId"]) || typeof body["on"] !== "boolean") return undefined;
  const allow = body["allowSystemRuns"];
  if (allow !== undefined && typeof allow !== "boolean") return undefined;
  if (allow === false && body["on"]) return undefined;
  return { requestId: body["requestId"], on: body["on"], ...(allow === undefined ? {} : { allowSystemRuns: allow }) };
}
/** The map is made with no body (or an empty one). */
const emptyBody = (body: unknown): Record<string, unknown> | undefined => (body === undefined || (plain(body) && Object.keys(body).length === 0) ? {} : undefined);

// ---- Answers: rebuilt, no dollar figure ----------------------------------------------------------------------------------------------------------------------------------------

const KNOWN_SENTENCES: ReadonlySet<string> = new Set(Object.values(C));
const END_WORDS = ["built", "budget_used", "pages_used", "time_used", "stopped_by_person", "needs_ai_key", "repo_unreadable", "access_lost", "infrastructure"] as const;
const AI_KEYS = ["connected", "missing", "unknown"] as const;
const REPO_STATUSES = ["ok", "partial", "unavailable"] as const;
const CHIP_KINDS = ["write_first", "skip_old", "skip_generated"] as const;
const count = (value: unknown): number => need(whole(value, 0, 10_000_000), value) as number;
const sentence = (value: unknown): string => need(typeof value === "string" && KNOWN_SENTENCES.has(value), value) as string;

function mapRepo(value: unknown): Record<string, unknown> {
  const r = rec(value);
  const status = need(oneOf(r["status"], REPO_STATUSES), r["status"]);
  const partial = r["partial"] === undefined ? undefined : need(text(r["partial"], 300), r["partial"]);
  const unavailable = r["unavailable"] === undefined ? undefined : need(text(r["unavailable"], 200), r["unavailable"]);
  need((status === "partial") === (partial !== undefined) && (status === "unavailable") === (unavailable !== undefined), undefined);
  const skipped = rec(r["skipped"]), pages = rec(r["pages"]);
  return {
    name: need(text(r["name"], 100), r["name"]), status, ...(partial === undefined ? {} : { partial }), ...(unavailable === undefined ? {} : { unavailable }), files: count(r["files"]),
    skipped: { generated: count(skipped["generated"]), vendored: count(skipped["vendored"]), lockfiles: count(skipped["lockfiles"]), assets: count(skipped["assets"]), secret: count(skipped["secret"]) },
    skippedFolders: list(r["skippedFolders"], WIKI_SETUP_LIMITS.skippedFolders).map((folder) => need(text(folder, 300), folder)),
    pages: { modules: count(pages["modules"]), modulesCapped: flag(pages["modulesCapped"]) },
  };
}

/** Code's file-map view, rebuilt. The map names THIS project; a forecast that carries a price is refused (there is no price yet). */
export function mapViewAnswer(value: unknown, project: string): Record<string, unknown> {
  const v = rec(value);
  const canManage = flag(v["canManage"]);
  const status = need(oneOf(v["status"], ["none", "ready"] as const), v["status"]);
  if (status === "none") { need(v["map"] === undefined, undefined); return { status, canManage }; }
  const m = rec(v["map"]);
  need(m["project"] === project, undefined);
  const forecast = rec(m["forecast"]);
  need(forecast["price"] === "not_priced_yet", undefined);
  const chipIds = new Set<string>();
  return {
    status, canManage,
    map: {
      computedAt: need(when(m["computedAt"]), m["computedAt"]),
      complete: flag(m["complete"]), repositoriesOmitted: count(m["repositoriesOmitted"]),
      repositories: list(m["repositories"], WIKI_SETUP_LIMITS.repos).map(mapRepo),
      chips: list(m["chips"], WIKI_SETUP_LIMITS.chips).map((one) => {
        const c = rec(one);
        need(text(c["id"], 80) && !chipIds.has(c["id"]), undefined);
        chipIds.add(c["id"] as string);
        return { id: c["id"], kind: need(oneOf(c["kind"], CHIP_KINDS), c["kind"]), repo: need(text(c["repo"], 100), c["repo"]), path: need(text(c["path"], 300), c["path"]), label: need(text(c["label"], 200), c["label"]), defaultOn: flag(c["defaultOn"]) };
      }),
      forecast: { repositories: count(forecast["repositories"]), files: count(forecast["files"]), pages: count(forecast["pages"]), pagesCapped: flag(forecast["pagesCapped"]), complete: flag(forecast["complete"]) },
    },
  };
}

/** Code's build state, rebuilt. Dropped on purpose: the task id, the dollar members (`budgetCents`, `pageReserveCents`, `spentCents`), the clock limit and who pays (always the project). */
export function buildAnswer(value: unknown): Record<string, unknown> {
  const v = rec(value);
  const limits = rec(v["limits"]);
  need(whole(limits["pages"], 1, 300) && whole(limits["budgetCents"], 1, 10_000) && whole(limits["wallClockMin"], 1, 480) && whole(limits["pageReserveCents"], 10, 500), undefined);
  need(v["payer"] === "project", undefined);
  const stoppedBy = v["stoppedBy"] === undefined ? undefined : rec(v["stoppedBy"]);
  const summary = v["summary"] === undefined ? undefined : rec(v["summary"]);
  // The spend is read (an answer that does not read is refused) and then dropped: no dollar figure reaches the app.
  if (summary !== undefined) need(whole(summary["spentCents"], 0, 1_000_000), undefined);
  const agents = rec(v["agents"]), wiki = rec(v["wiki"]);
  const aiKey = need(oneOf(v["aiKey"], AI_KEYS), v["aiKey"]);
  if (v["connectKey"] !== undefined) need(v["connectKey"] === C.connectKey, undefined);
  return {
    status: need(oneOf(v["status"], ["none", "running", "built", "stopped"] as const), v["status"]),
    limits: { pages: limits["pages"] },
    ...(v["startedAt"] === undefined ? {} : { startedAt: need(when(v["startedAt"]), v["startedAt"]) }),
    ...(v["stop"] === undefined ? {} : { stop: need(oneOf(v["stop"], END_WORDS), v["stop"]) }),
    ...(v["message"] === undefined ? {} : { message: sentence(v["message"]) }),
    ...(summary === undefined ? {} : {
      summary: {
        pagesPlanned: need(whole(summary["pagesPlanned"], 0, 10_000), summary["pagesPlanned"]), pagesWritten: need(whole(summary["pagesWritten"], 0, 10_000), summary["pagesWritten"]),
        pagesKeptFromEarlier: need(whole(summary["pagesKeptFromEarlier"], 0, 10_000), summary["pagesKeptFromEarlier"]), claimsKept: count(summary["claimsKept"]), claimsDropped: count(summary["claimsDropped"]),
      },
    }),
    ...(v["canContinue"] === undefined ? {} : { canContinue: flag(v["canContinue"]) }),
    // A name is display only: one that does not read is shown as W2's own word, never a refusal of the state.
    ...(stoppedBy === undefined ? {} : { stoppedBy: { name: text(stoppedBy["name"], 200) ? stoppedBy["name"] : "a former member", at: need(when(stoppedBy["at"]), stoppedBy["at"]) } }),
    canManage: flag(v["canManage"]), aiKey,
    ...(v["connectKey"] === undefined ? {} : { connectKey: C.connectKey }),
    agents: { on: flag(agents["on"]) }, wiki: { pages: need(whole(wiki["pages"], 0, 10_000), wiki["pages"]), refreshPages: need(whole(wiki["refreshPages"], 0, 10_000), wiki["refreshPages"]) },
  };
}
export function deleteAnswer(value: unknown): Record<string, unknown> {
  const v = rec(value);
  need(v["deleted"] === true && v["message"] === C.deleted, undefined);
  return { deleted: true, message: C.deleted, view: buildAnswer(v["view"]) };
}
/** Code's cap, field by field: a number from 0 to 1,000,000 (never invented: `null` stays `null`) and who may raise it. */
function capAnswer(value: unknown): Record<string, unknown> {
  const c = rec(value);
  const usd = c["monthlyUsd"];
  need(usd === null || (typeof usd === "number" && Number.isFinite(usd) && usd >= 0 && usd <= 1_000_000), usd);
  return { monthlyUsd: usd, canRaise: flag(c["canRaise"]) };
}
/**
 * L4-CAPR: what nightly upkeep spent on the project this UTC month (Code's `UpkeepSpendSchema`), field by field: the month, a dollar figure that is never negative, and two counts. `unknownRuns` are runs whose
 * cost Code could not state (they add nothing to `spentUsd`, so with any the figure is "at least"); nothing is made up here and no other member passes.
 */
function spendAnswer(value: unknown): Record<string, unknown> {
  const s = rec(value);
  const spent = s["spentUsd"];
  need(typeof s["month"] === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(s["month"]), s["month"]);
  need(typeof spent === "number" && Number.isFinite(spent) && spent >= 0 && spent <= 100_000_000, spent);
  return { month: s["month"], spentUsd: spent, runs: count(s["runs"]), unknownRuns: count(s["unknownRuns"]) };
}
export function upkeepAnswer(value: unknown): Record<string, unknown> {
  const v = rec(value);
  const canManage = flag(v["canManage"]);
  return {
    enabled: flag(v["enabled"]), canManage,
    ...(v["available"] === undefined ? {} : { available: flag(v["available"]) }),
    ...(v["systemRunsOn"] === undefined ? {} : { systemRunsOn: flag(v["systemRunsOn"]) }),
    ...(v["canEnableSystemRuns"] === undefined ? {} : { canEnableSystemRuns: flag(v["canEnableSystemRuns"]) }),
    ...(v["cap"] === undefined ? {} : { cap: capAnswer(v["cap"]) }),
    // Only a person who manages the project is shown the spend (Code sends it to no one else; a copy that reaches a reader anyway is dropped here).
    ...(v["spend"] === undefined || !canManage ? {} : { spend: spendAnswer(v["spend"]) }),
  };
}

// ---- The routes ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The project (after Code's access check names the person's company now), or the route's refusal. A query is never forwarded. */
async function target(context: RouteContext): Promise<{ project: string; company: string } | { refusal: RouteAnswer }> {
  const at = await scope(context);
  if ("refusal" in at) return at;
  if ([...context.query.keys()].length > 0 || !PROJECT_FOR_PATH.test(at.project)) return { refusal: A.invalid };
  return at;
}

/** The routes that start a task (and so spend): Build, Continue and Refresh now. */
const STARTS: ReadonlySet<string> = new Set(["build", "continue", "refresh"]);
const CONNECT_KEY_ANSWER = answer(503, "MODEL_PROXY_UNAVAILABLE", C.connectKey);

/**
 * L4-CW: Code on a hosted Rovara cannot see the gateway's per-company choice and answers `aiKey: "unknown"`. Cloud can, so for a person Code says manages the project it is replaced by the company's yes/no
 * (`connected`/`missing`, with Code's fixed sentence beside `missing`). Code's own `connected`/`missing` is never overridden, a person who only reads keeps `unknown` (and costs no read), and a fact Cloud cannot read
 * leaves `unknown`. The company is Code's live answer for the person; only the enum and the fixed sentence leave: no key, provider, source or model.
 */
async function withAiKey(context: RouteContext, company: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (body["canManage"] !== true || body["aiKey"] !== "unknown") return body;
  const fact = await agentAiConnected(context, company);
  if (fact === null) return body;
  const rest = { ...body };
  delete rest["connectKey"];
  return fact ? { ...rest, aiKey: "connected" } : { ...rest, aiKey: "missing", connectKey: C.connectKey };
}
async function withAiKeyAnswer(context: RouteContext, company: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const view = body["view"];
  return plain(view) ? { ...body, view: await withAiKey(context, company, view) } : withAiKey(context, company, body);
}

/**
 * A start the company's own AI cannot serve is refused before Code is asked to start it, so no task is started that would end "needs an AI key". Code's state is read FIRST, as the person: only a person Code
 * says manages the project, with Code's own `aiKey` still "unknown", causes a read of the company's choice, and only for them is the sentence ever answered (a reader's start reaches Code and gets Code's own refusal,
 * in the same time and steps whatever the company's AI state is).
 */
async function startWouldDie(context: RouteContext, project: string, company: string): Promise<boolean> {
  const state = await fromCode(context, "build", base(project, "wiki-build"));
  if ("refusal" in state) return false;
  const seen = rebuilt(() => buildAnswer(state.value), "build");
  const body = seen.body as Record<string, unknown>;
  if (seen.status !== 200 || body["canManage"] !== true || body["aiKey"] !== "unknown") return false;
  return (await agentAiConnected(context, company)) === false;
}

function postRoute(tail: RegExp, action: string, codeTail: string, body: (given: unknown) => Record<string, unknown> | undefined, answerOf: (value: unknown, project: string) => Record<string, unknown>, kind: Kind = "build"): Route {
  return {
    method: "POST", path: tail,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      const sent = body(context.body);
      if (sent === undefined) return A.invalid;
      if (STARTS.has(action) && await startWouldDie(context, at.project, at.company)) return CONNECT_KEY_ANSWER;
      const got = await fromCode(context, kind, base(at.project, codeTail), { method: "POST", body: sent });
      if ("refusal" in got) return got.refusal;
      const out = rebuilt(() => answerOf(got.value, at.project), kind);
      if (out.status === 200) {
        logged(action, at.project);
        if (kind === "build") return { status: 200, body: await withAiKeyAnswer(context, at.company, out.body as Record<string, unknown>) };
      }
      return out;
    },
  };
}
function getRoute(tail: RegExp, codeTail: string, kind: Kind, answerOf: (value: unknown, project: string) => Record<string, unknown>): Route {
  return {
    method: "GET", path: tail,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      const got = await fromCode(context, kind, base(at.project, codeTail));
      if ("refusal" in got) return got.refusal;
      const out = rebuilt(() => answerOf(got.value, at.project), kind);
      return out.status === 200 && kind === "build" ? { status: 200, body: await withAiKey(context, at.company, out.body as Record<string, unknown>) } : out;
    },
  };
}

export const WIKI_SETUP_ROUTES: Route[] = [
  getRoute(/^\/projects\/([^/]+)\/wiki-map$/u, "wiki-map", "map", mapViewAnswer),
  postRoute(/^\/projects\/([^/]+)\/wiki-map$/u, "map_files", "wiki-map", emptyBody, mapViewAnswer, "map"),
  getRoute(/^\/projects\/([^/]+)\/wiki-build$/u, "wiki-build", "build", (value) => buildAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki-build$/u, "build", "wiki-build", startBody, (value) => buildAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki-build\/continue$/u, "continue", "wiki-build/continue", idBody, (value) => buildAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki-build\/stop$/u, "stop", "wiki-build/stop", idBody, (value) => buildAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki-build\/refresh$/u, "refresh", "wiki-build/refresh", idBody, (value) => buildAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki-build\/agents$/u, "agents_switch", "wiki-build/agents", switchBody, (value) => buildAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki-build\/delete$/u, "delete", "wiki-build/delete", idBody, (value) => deleteAnswer(value)),
  getRoute(/^\/projects\/([^/]+)\/upkeep$/u, "upkeep", "upkeep", (value) => upkeepAnswer(value)),
  {
    method: "PUT", path: /^\/projects\/([^/]+)\/upkeep$/u,
    answer: async (context) => {
      const at = await target(context);
      if ("refusal" in at) return at.refusal;
      const sent = upkeepBody(context.body);
      if (sent === undefined) return A.invalid;
      const got = await fromCode(context, "upkeep", base(at.project, "upkeep"), { method: "PUT", body: sent });
      if ("refusal" in got) return got.refusal;
      const out = rebuilt(() => upkeepAnswer(got.value), "upkeep");
      if (out.status === 200) logged(sent["allowSystemRuns"] === undefined ? "upkeep_switch" : "upkeep_setup", at.project);
      return out;
    },
  },
];
