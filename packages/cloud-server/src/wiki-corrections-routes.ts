// Lead 4 slice C1 (DEC 254zh/254zi): the project wiki's CORRECTIONS, passed through to Rovara Code as the signed-in person (Code's `core-host/wiki-corrections-routes.ts`, branch pr/l4-wiki-corrections):
//
//   GET  /v1/app/projects/{p}/wiki/pages/{id}/corrections                           what this person may do on the page, and which notes need a look
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes                  { text, file? }    Add a note (pending: people see it now, agents only after a maintainer approves)
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes/{n}/approve      {}                 maintainer only
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes/{n}/delete       {}                 the note's author or a maintainer
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes/{n}/acknowledge  {}                 the note's author or a maintainer: clear the changed-file reminder
//   POST /v1/app/projects/{p}/wiki/pages/{id}/notes/{n}/suggest-lesson {}               a PENDING lesson an admin approves; never approved here
//   POST /v1/app/projects/{p}/wiki/pages/{id}/flags                  { claimId?, reason? }   Mark wrong
//   POST /v1/app/projects/{p}/wiki/pages/{id}/flags/resolve          {}                 maintainer only
//   GET  /v1/app/projects/{p}/wiki/disputed                                             maintainer only
//   GET  /v1/app/projects/{p}/wiki/gaps                                                 maintainer only: the questions the wiki could not answer, as topics (never who asked)
//
// Rules:
//   - Code decides who may do each: the person's LIVE role on the project, read on every call. Cloud adds no rule that could widen it and never sends a person, company, role or author (Code's bodies
//     are strict, and the body is rebuilt here from known fields only). Cloud refuses earlier only what cannot be valid: a malformed project, page or note id, an unreadable body.
//   - The browser never names a Code id beyond the page and note it is looking at (both pattern-checked, and they go only into Code's path). Nothing in the query goes on.
//   - Every answer is rebuilt from known fields and must name THIS project (and THIS page). An answer that does not read is refused whole ("unreadable is refusal").
//   - A refusal reaches the app in the words Code fixed (an exact member of a known list), else in Cloud's own fixed words; never an echo of the browser's input, never other text of Code's.
//     Until Code serves a route, its fixed unknown-route 404 reads "isn't available on this Rovara yet" (501 NOT_ON_CODE_YET).
//   - The logs say what was done and where (action, project), never what the person wrote.
// cloud-server takes no package dependency, so the shapes are checked here by hand against contracts app-wiki-corrections.ts (its limits and words are repeated and a unit test pins them).
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { WIKI_PAGE_ID, WIKI_WORDS, Unreadable, list, need, oneOf, plain, prose, rec, repoName, safePath, scope, text, when, whole, wikiId } from "./wiki-routes.js";

export const WIKI_CORRECTION_WORDS = Object.freeze({
  needsWorkingRole: "Only people with a working role on this project can do that.",
  needsMaintainer: "Only a project maintainer, or an owner or admin of the company, can do that.",
  noteNotYours: "Only the person who wrote a note, or a project maintainer, can do that.",
  noteNotFound: "That note is not there.",
  notARule: "That note is too long to be a lesson. Shorten it to a rule of a few lines first.",
  lessonRefused: "That note cannot be suggested as a lesson. Reword it as advice about the code.",
  lessonsOff: "Lessons are off for this project, so a note cannot be suggested as one.",
  badRequest: "That request is not valid.",
  tooMany: "This page has as many notes or marks as it can hold.",
  noSuchClaim: "That claim is not on the page.",
  actionFailed: "That could not be saved. Try again.",
  notYet: "Corrections aren't available on this Rovara yet.",
  unavailable: "That could not be done just now. Try again.",
});
const C = WIKI_CORRECTION_WORDS;
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const WIKI_CORRECTION_ANSWERS = Object.freeze({
  notFound: answer(404, "NOT_FOUND", WIKI_WORDS.notFound),
  noPage: answer(404, "NOT_FOUND", WIKI_WORDS.noPage),
  invalid: answer(400, "CONFIG_INVALID", C.badRequest),
  notYet: answer(501, "NOT_ON_CODE_YET", C.notYet),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", C.unavailable),
});
const A = WIKI_CORRECTION_ANSWERS;

/** Words Code fixed (the same texts, pinned by a test): an answer of Code's that says exactly one of these is passed on with its status; anything else is Cloud's own words. */
const PASS_WORDS: ReadonlySet<string> = new Set([
  ...Object.values(C).filter((word) => word !== C.notYet && word !== C.unavailable), WIKI_WORDS.notFound, WIKI_WORDS.noPage,
]);
const PASS_CODES: ReadonlySet<string> = new Set(["NOT_FOUND", "FORBIDDEN", "CONFIG_INVALID", "IDEMPOTENCY_CONFLICT", "RUNTIME_UNAVAILABLE"]);
const PASS_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 409, 503]);

export const WIKI_CORRECTION_LIMITS = { noteChars: 2_000, reasonChars: 500, notes: 50, disputed: 100, gaps: 50, topicChars: 160 } as const;
const GAP_KINDS = ["not_found", "partly", "wiki_empty", "not_right"] as const;
const GAP_DAY = /^\d{4}-\d\d-\d\d$/u;
const NOTE_ID = /^[A-Za-z0-9_-]{4,64}$/u;

/** Code's refusal in fixed words. Only Code's exact unknown-route 404 means "not on Code yet". */
export function wikiCorrectionRefusal(error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const message = typeof body?.["message"] === "string" ? body["message"] : undefined, code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  if (error.status === 404 && code === "NOT_FOUND" && message === "route not found") return A.notYet;
  if (message !== undefined && code !== undefined && PASS_WORDS.has(message) && PASS_CODES.has(code) && PASS_STATUSES.has(error.status)) return answer(error.status, code, message);
  if (error.status === 404) return A.notFound;
  if (error.status === 400) return A.invalid;
  return A.unavailable;
}

type Got = { value: unknown } | { refusal: RouteAnswer };
async function fromCode(context: RouteContext, path: string, init: { method?: string; body?: unknown } = {}): Promise<Got> {
  try {
    return { value: await context.client.json<unknown>(context.session, path, init) };
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) return { refusal: wikiCorrectionRefusal(error) };
    throw error;
  }
}

const base = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/wiki`;
const rebuilt = (build: () => Record<string, unknown>): RouteAnswer => { try { return { status: 200, body: build() }; } catch (error) { if (error instanceof Unreadable) return A.unavailable; throw error; } };
const flag = (value: unknown): boolean => need(typeof value === "boolean", value) as boolean;

// ---- Bodies: rebuilt from known fields; nothing else is sent -------------------------------------------------------------------------------------------------------------------------------

/** No body, or an empty object. */
const emptyBody = (body: unknown): boolean => body === undefined || (plain(body) && Object.keys(body).length === 0);
const hasOnly = (value: Plain, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
type Plain = Record<string, unknown>;
/** Words of the person's: bounded, new lines allowed, no control or format character, not only blanks. */
const words = (value: unknown, max: number): value is string => prose(value, max) && value.trim() !== "";

function noteBody(body: unknown): Record<string, unknown> | undefined {
  if (!plain(body) || !hasOnly(body, ["text", "file"]) || !words(body["text"], WIKI_CORRECTION_LIMITS.noteChars)) return undefined;
  if (body["file"] === undefined) return { text: body["text"] };
  const file = body["file"];
  if (!plain(file) || !hasOnly(file, ["repo", "path"]) || !repoName(file["repo"]) || !safePath(file["path"])) return undefined;
  return { text: body["text"], file: { repo: file["repo"], path: file["path"] } };
}
function markBody(body: unknown): Record<string, unknown> | undefined {
  if (body === undefined) return {};
  if (!plain(body) || !hasOnly(body, ["claimId", "reason"])) return undefined;
  if (body["claimId"] !== undefined && !wikiId(body["claimId"])) return undefined;
  if (body["reason"] !== undefined && !words(body["reason"], WIKI_CORRECTION_LIMITS.reasonChars)) return undefined;
  return { ...(body["claimId"] === undefined ? {} : { claimId: body["claimId"] }), ...(body["reason"] === undefined ? {} : { reason: body["reason"] }) };
}

// ---- Answers: rebuilt for THIS project and page -----------------------------------------------------------------------------------------------------------------------------------------

const ROLES = ["maintainer", "contributor", "viewer"] as const;
export function correctionsAnswer(value: unknown, project: string, id: string): Record<string, unknown> {
  const v = rec(value);
  need(v["project"] === project && v["pageId"] === id, undefined);
  const you = rec(v["you"]);
  const ids = new Set<string>();
  return {
    project, pageId: id,
    you: { role: need(oneOf(you["role"], ROLES), you["role"]), addNote: flag(you["addNote"]), markWrong: flag(you["markWrong"]), approveNotes: flag(you["approveNotes"]), resolveMarks: flag(you["resolveMarks"]), seeDisputed: flag(you["seeDisputed"]) },
    notes: list(v["notes"], WIKI_CORRECTION_LIMITS.notes).map((one) => {
      const n = rec(one);
      need(wikiId(n["noteId"]) && !ids.has(n["noteId"]), undefined);
      ids.add(n["noteId"] as string);
      return { noteId: n["noteId"], mine: flag(n["mine"]), canDelete: flag(n["canDelete"]), canApprove: flag(n["canApprove"]), canSuggestLesson: flag(n["canSuggestLesson"]), mayBeOutOfDate: flag(n["mayBeOutOfDate"]) };
    }),
  };
}

export function noteAddedAnswer(value: unknown): Record<string, unknown> {
  const n = rec(rec(value)["note"]);
  const file = n["file"] === undefined ? undefined : rec(n["file"]);
  return {
    note: {
      noteId: need(wikiId(n["noteId"]), n["noteId"]), text: need(prose(n["text"], WIKI_CORRECTION_LIMITS.noteChars), n["text"]), author: text(n["author"], 200) ? n["author"] : "a former member",
      createdAt: need(when(n["createdAt"]), n["createdAt"]),
      ...(file === undefined ? {} : { file: { repo: need(repoName(file["repo"]), file["repo"]), path: need(safePath(file["path"]), file["path"]) } }),
      approval: need(oneOf(n["approval"], ["pending", "approved"] as const), n["approval"]),
    },
  };
}
export const approvedAnswer = (value: unknown, note: string): Record<string, unknown> => { const v = rec(value); need(v["noteId"] === note && v["approval"] === "approved", undefined); return { noteId: note, approval: "approved" }; };
export const deletedAnswer = (value: unknown): Record<string, unknown> => { need(rec(value)["deleted"] === true, undefined); return { deleted: true }; };
export function markedAnswer(value: unknown, id: string): Record<string, unknown> {
  const v = rec(value);
  need(wikiId(v["flagId"]) && v["pageId"] === id, undefined);
  return { flagId: v["flagId"], pageId: id, ...(v["claimId"] === undefined ? {} : { claimId: need(wikiId(v["claimId"]), v["claimId"]) }) };
}
export const resolvedAnswer = (value: unknown): Record<string, unknown> => ({ resolved: need(whole(rec(value)["resolved"], 0, 100_000), rec(value)["resolved"]) });
export function suggestedAnswer(value: unknown): Record<string, unknown> {
  const v = rec(value);
  return { state: need(oneOf(v["state"], ["proposed", "already_proposed"] as const), v["state"]), lessonId: need(text(v["lessonId"], 100), v["lessonId"]) };
}
export const acknowledgedAnswer = (value: unknown, note: string): Record<string, unknown> => { const v = rec(value); need(v["noteId"] === note && v["acknowledged"] === true, undefined); return { noteId: note, acknowledged: true }; };
/** The questions the wiki could not answer, for THIS project: topics and counts only (Code never sends an asker, and nothing else is kept even if it did). */
export function gapsAnswer(value: unknown, project: string): Record<string, unknown> {
  const v = rec(value);
  need(v["project"] === project, undefined);
  return {
    project, more: flag(v["more"]),
    items: list(v["items"], WIKI_CORRECTION_LIMITS.gaps).map((one) => {
      const i = rec(one);
      return {
        topic: need(text(i["topic"], WIKI_CORRECTION_LIMITS.topicChars), i["topic"]), kind: need(oneOf(i["kind"], GAP_KINDS), i["kind"]),
        people: need(whole(i["people"], 1, 1_000_000), i["people"]), questions: need(whole(i["questions"], 1, 1_000_000), i["questions"]),
        lastAskedAt: need(typeof i["lastAskedAt"] === "string" && GAP_DAY.test(i["lastAskedAt"]), i["lastAskedAt"]),
      };
    }),
  };
}
export function disputedAnswer(value: unknown, project: string): Record<string, unknown> {
  const v = rec(value);
  need(v["project"] === project, undefined);
  return {
    project, more: flag(v["more"]),
    items: list(v["items"], WIKI_CORRECTION_LIMITS.disputed).map((one) => {
      const i = rec(one);
      return {
        flagId: need(wikiId(i["flagId"]), i["flagId"]), pageId: need(typeof i["pageId"] === "string" && WIKI_PAGE_ID.test(i["pageId"]), i["pageId"]), pageTitle: need(text(i["pageTitle"], 120), i["pageTitle"]),
        ...(i["claimId"] === undefined ? {} : { claimId: need(wikiId(i["claimId"]), i["claimId"]) }), ...(i["claimText"] === undefined ? {} : { claimText: need(text(i["claimText"], 600), i["claimText"]) }),
        markedBy: text(i["markedBy"], 200) ? i["markedBy"] : "a former member", markedAt: need(when(i["markedAt"]), i["markedAt"]),
        ...(i["reason"] === undefined ? {} : { reason: need(prose(i["reason"], WIKI_CORRECTION_LIMITS.reasonChars), i["reason"]) }),
      };
    }),
  };
}

// ---- The routes --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Spec = { project: string; page: string; note?: string };
/** The project (after Code's access check names the person's company now), the page and the note of the path; or the route's refusal. Nothing in the query goes on. */
async function target(context: RouteContext, withNote: boolean): Promise<Spec | { refusal: RouteAnswer }> {
  const at = await scope(context);
  if ("refusal" in at) return at;
  const page = context.params[1];
  if (page === undefined || !WIKI_PAGE_ID.test(page) || [...context.query.keys()].length > 0) return { refusal: A.invalid };
  if (!withNote) return { project: at.project, page };
  const note = context.params[2];
  if (note === undefined || !NOTE_ID.test(note)) return { refusal: A.invalid };
  return { project: at.project, page, note };
}
const pageBase = (spec: Spec): string => `${base(spec.project)}/pages/${encodeURIComponent(spec.page)}`;
const logged = (action: string, project: string): void => { console.log(JSON.stringify({ event: "cloud.wiki_correction", action, project })); };

function postRoute(tail: RegExp, action: string, withNote: boolean, send: (spec: Spec) => string, body: (given: unknown) => Record<string, unknown> | undefined, answerOf: (value: unknown, spec: Spec) => Record<string, unknown>): Route {
  return {
    method: "POST", path: tail,
    answer: async (context) => {
      const at = await target(context, withNote);
      if ("refusal" in at) return at.refusal;
      const sent = body(context.body);
      if (sent === undefined) return A.invalid;
      const got = await fromCode(context, send(at), { method: "POST", body: sent });
      if ("refusal" in got) return got.refusal;
      const out = rebuilt(() => answerOf(got.value, at));
      if (out.status === 200) logged(action, at.project);
      return out;
    },
  };
}
const none = (given: unknown): Record<string, unknown> | undefined => (emptyBody(given) ? {} : undefined);

export const WIKI_CORRECTION_ROUTES: Route[] = [
  {
    method: "GET", path: /^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/corrections$/u,
    answer: async (context) => {
      const at = await target(context, false);
      if ("refusal" in at) return at.refusal;
      const got = await fromCode(context, `${pageBase(at)}/corrections`);
      if ("refusal" in got) return got.refusal;
      return rebuilt(() => correctionsAnswer(got.value, at.project, at.page));
    },
  },
  postRoute(/^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/notes$/u, "add_note", false, (s) => `${pageBase(s)}/notes`, noteBody, (value) => noteAddedAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/notes\/([^/]+)\/approve$/u, "approve_note", true, (s) => `${pageBase(s)}/notes/${encodeURIComponent(s.note!)}/approve`, none, (value, s) => approvedAnswer(value, s.note!)),
  postRoute(/^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/notes\/([^/]+)\/delete$/u, "delete_note", true, (s) => `${pageBase(s)}/notes/${encodeURIComponent(s.note!)}/delete`, none, (value) => deletedAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/notes\/([^/]+)\/acknowledge$/u, "acknowledge_note", true, (s) => `${pageBase(s)}/notes/${encodeURIComponent(s.note!)}/acknowledge`, none, (value, s) => acknowledgedAnswer(value, s.note!)),
  postRoute(/^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/notes\/([^/]+)\/suggest-lesson$/u, "suggest_lesson", true, (s) => `${pageBase(s)}/notes/${encodeURIComponent(s.note!)}/suggest-lesson`, none, (value) => suggestedAnswer(value)),
  postRoute(/^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/flags$/u, "mark_wrong", false, (s) => `${pageBase(s)}/flags`, markBody, (value, s) => markedAnswer(value, s.page)),
  postRoute(/^\/projects\/([^/]+)\/wiki\/pages\/([^/]+)\/flags\/resolve$/u, "resolve_marks", false, (s) => `${pageBase(s)}/flags/resolve`, none, (value) => resolvedAnswer(value)),
  {
    method: "GET", path: /^\/projects\/([^/]+)\/wiki\/disputed$/u,
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      if ([...context.query.keys()].length > 0) return A.invalid;
      const got = await fromCode(context, `${base(at.project)}/disputed`);
      if ("refusal" in got) return got.refusal;
      return rebuilt(() => disputedAnswer(got.value, at.project));
    },
  },
  {
    method: "GET", path: /^\/projects\/([^/]+)\/wiki\/gaps$/u,
    answer: async (context) => {
      const at = await scope(context);
      if ("refusal" in at) return at.refusal;
      if ([...context.query.keys()].length > 0) return A.invalid;
      const got = await fromCode(context, `${base(at.project)}/gaps`);
      if ("refusal" in got) return got.refusal;
      return rebuilt(() => gapsAnswer(got.value, at.project));
    },
  },
];
