// Lead 4 slice J3 (DEC 254z-amend, 254z-amend2, DEC 173; designs-2026-11-17/wiki-and-just-answer-plan.md sections 1.3 and 3): the web door of the smart Just answer, answered from Rovara Code's answer service
// (slice J1) and its start-box suggestion (lane pr/l4-answer-web) as the signed-in person, with their own token.
//
//   POST /v1/app/projects/{p}/answers         -> Code POST /v1/app/projects/{p}/answers         { requestId, question, threadId?, channel: "web", context? }   (AnswerResponse)
//   POST /v1/app/projects/{p}/code/suggest    -> Code POST /v1/app/projects/{p}/code/suggest    { requestId, text }                                             (StartSuggestResponse)
//
// Rules:
//   - OFF unless the deployment says so (`answersEnabled`, from ROVARA_ANSWERS_ENABLED): both routes then answer "not available on this Rovara yet" without asking Code, and the nav tells the app to draw no
//     Ask box (DEC 254z-amend2: hidden until the gateway's answers purpose is merged AND deployed; a setting, not the presence of this code).
//   - Code decides who may ask: its live company and project role, on every call (any project role asks; anyone else, another company's project, a missing project and a malformed name all get Code's one 404).
//     Cloud adds no rule that could widen that. It only refuses earlier: a person Code names no company for gets NOT_IN_COMPANY; a malformed project name or body is refused without asking Code.
//   - The browser never names a company, a person, a channel or a Code id. The project name goes only into Code's path; the body is rebuilt from known fields (`channel` is always "web").
//   - Every answer is rebuilt from known fields and must read (bounds, no control or format characters, sources numbered 1..n at a commit pattern, every `[n]` in the text names a source, one fixed action only
//     when the outcome allows it). One that does not read is refused whole: "unreadable is refusal".
//   - The answer text is untrusted: it is kept to plain characters here and drawn as text, never as markup.
//   - Code's refusals reach the app as Cloud's fixed sentences, never Code's own text and never an echo of the browser's input or the cause.
// cloud-server takes no package dependency, so the shapes are checked here by hand against contracts app-answers.ts (its limits are repeated and a unit test pins them).
import { CodeError } from "./code-client.js";
import { companyCaller, refused } from "./company-caller.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const ANSWERS_WORDS = Object.freeze({
  notFound: "project not found",
  invalid: "the request is not valid",
  notYet: "Answers aren't available on this Rovara yet.",
  notSetUp: "Answers are not set up here yet.",
  forbidden: "You can't ask about this project.",
  unavailable: "Couldn't answer that just now.",
  rate: "You've asked a lot of questions lately. Try again a little later.",
  limitReached: "This project has reached its spending limit for now.",
  paused: "Answers are paused for this month.",
  suggestUnavailable: "Couldn't suggest a path just now.",
  suggestRate: "You've asked for a lot of suggestions lately. Try again a little later.",
  answerGone: "That answer is not there.",
  notRightFailed: "Couldn't save that just now. Try again.",
});
const W = ANSWERS_WORDS;
const TASK_BUTTON = "Start a Quick task";
/** What a Code whose core engine does not serve a route yet says (core-host/dev-routes.ts NOT_ON_THE_CORE_YET): the same as an unknown route, "not available on this Rovara yet". */
const CORE_NOT_YET = "That is not on the core engine on this install yet.";
const answer = (status: number, code: string, message: string): RouteAnswer => Object.freeze({ status, body: Object.freeze({ error: Object.freeze({ code, message }) }) });
export const ANSWERS_ANSWERS = Object.freeze({
  notFound: answer(404, "NOT_FOUND", W.notFound),
  invalid: answer(400, "CONFIG_INVALID", W.invalid),
  notYet: answer(501, "NOT_ON_CODE_YET", W.notYet),
  forbidden: answer(403, "FORBIDDEN", W.forbidden),
  signIn: answer(401, "AUTH_REQUIRED", "Your Rovara sign-in ended. Sign in again."),
  unavailable: answer(503, "RUNTIME_UNAVAILABLE", W.unavailable),
  rate: answer(429, "TOO_MANY_REQUESTS", W.rate),
  limitReached: answer(429, "TOO_MANY_REQUESTS", W.limitReached),
  paused: answer(429, "TOO_MANY_REQUESTS", W.paused),
  suggestUnavailable: answer(503, "RUNTIME_UNAVAILABLE", W.suggestUnavailable),
  suggestRate: answer(429, "TOO_MANY_REQUESTS", W.suggestRate),
  answerGone: answer(404, "NOT_FOUND", W.answerGone),
  notRightFailed: answer(503, "RUNTIME_UNAVAILABLE", W.notRightFailed),
});
const A = ANSWERS_ANSWERS;

const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/u;
const THREAD_ID = /^[A-Za-z0-9_.:-]{1,100}$/u;
const ANSWER_ID = /^[A-Za-z0-9_-]{4,64}$/u;
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,119}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/u;
const NEWLINES_OK = /^(?:[^\p{Cc}\p{Cf}]|\n)*$/u;
const OUTCOMES = ["answered", "partly", "not_found", "not_set_up"] as const;
const KINDS = ["small_talk", "unknown", "question", "small_change", "large_change", "unclear"] as const;
const CLASSIFIERS = ["ok", "unavailable", "failed"] as const;
const PICKS = ["answer", "quick", "full"] as const;
const SMALL_TALK = ["greeting", "thanks", "help", "ack"] as const;
const PICK_OF: Record<string, string> = { question: "answer", unclear: "answer", small_change: "quick", large_change: "full" };
const LIMITS = { question: 1_000, text: 4_000, context: 300, answer: 6_000, sources: 8, wikiPages: 20, unconfirmed: 3 } as const;

type Plain = Record<string, unknown>;
const plain = (value: unknown): value is Plain => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const whole = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = <T extends string>(value: unknown, words: readonly T[]): value is T => typeof value === "string" && (words as readonly string[]).includes(value);
const line = (value: unknown, max: number, min = 1): value is string => typeof value === "string" && value.length >= min && value.length <= max && !CONTROL.test(value);
const prose = (value: unknown, max: number, min = 1): value is string => typeof value === "string" && value.length >= min && value.length <= max && NEWLINES_OK.test(value);
const safePath = (value: unknown): value is string => line(value, 256) && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "." || part === "");

/** Not a readable answer: the whole read is refused, never a part of it. */
export class Unreadable extends Error {}
function need<T>(ok: boolean, value: T): T { if (!ok) throw new Unreadable(); return value; }
const rec = (value: unknown): Plain => need(plain(value), value as Plain);
const keysOnly = (value: Plain, allowed: readonly string[]): void => { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Unreadable(); };

/** Code's answer object, rebuilt from its known fields only; throws Unreadable on anything off. */
export function answerObject(value: unknown): Plain {
  const v = rec(value);
  keysOnly(v, ["answerId", "threadId", "outcome", "text", "honesty", "unconfirmed", "sources", "wikiPages", "action"]);
  const outcome = need(oneOf(v["outcome"], OUTCOMES), v["outcome"]);
  let text = need(typeof v["text"] === "string" && (v["text"] === "" || prose(v["text"], LIMITS.answer)), v["text"] as string);
  // A repeat of a question whose answer was "not found" comes from Code's record as words in `text` (older Code; today's Code says them as `honesty`): the same one fixed line, kept as the honesty it always was
  // (B8). Nothing else about "not found" is relaxed: no sources, no other words, no second line.
  let words = v["honesty"];
  if (outcome === "not_found" && text !== "" && words === undefined && prose(text, 300)) { words = text; text = ""; }
  const rawSources = need(Array.isArray(v["sources"]) && v["sources"].length <= LIMITS.sources, v["sources"] as unknown[]);
  const sources = rawSources.map((one, index) => {
    const s = rec(one);
    keysOnly(s, ["n", "repo", "path", "line", "lineEnd", "commit"]);
    const first = need(whole(s["line"], 1, 10_000_000), s["line"]) as number;
    return {
      n: need(s["n"] === index + 1, s["n"]), repo: need(typeof s["repo"] === "string" && PROJECT_NAME.test(s["repo"]), s["repo"]), path: need(safePath(s["path"]), s["path"]),
      line: first, ...(s["lineEnd"] === undefined ? {} : { lineEnd: need(whole(s["lineEnd"], first, 10_000_000), s["lineEnd"]) }), commit: need(typeof s["commit"] === "string" && COMMIT.test(s["commit"]), s["commit"]),
    };
  });
  // Every `[n]` marker in the text names a source of this answer.
  for (const marker of `${text}\n${typeof words === "string" ? words : ""}`.matchAll(/\[(\d{1,3})\]/gu)) need(Number(marker[1]) >= 1 && Number(marker[1]) <= sources.length, undefined);
  const unconfirmed = need(Array.isArray(v["unconfirmed"]) && v["unconfirmed"].length <= LIMITS.unconfirmed, v["unconfirmed"] as unknown[]).map((one) => need(prose(one, 200), one));
  const rawPages = need(Array.isArray(v["wikiPages"]) && v["wikiPages"].length <= LIMITS.wikiPages, v["wikiPages"] as unknown[]);
  const wikiPages = rawPages.map((one) => { const p = rec(one); keysOnly(p, ["pageId", "title"]); return { pageId: need(typeof p["pageId"] === "string" && PAGE_ID.test(p["pageId"]), p["pageId"]), title: need(line(p["title"], 120), p["title"]) }; });
  let action: Plain | undefined;
  if (v["action"] !== undefined) {
    const a = rec(v["action"]);
    keysOnly(a, ["kind", "label", "title"]);
    // The one action's words are fixed in code; the model writes no button. `not_set_up` offers none.
    need(outcome !== "not_set_up" && a["kind"] === "quick_task" && a["label"] === TASK_BUTTON, undefined);
    action = { kind: "quick_task", label: TASK_BUTTON, title: need(line(a["title"], 120), a["title"]) };
  }
  if (outcome === "not_set_up" || outcome === "not_found") need(text === "" && sources.length === 0, undefined);
  return {
    ...(v["answerId"] === undefined ? {} : { answerId: need(typeof v["answerId"] === "string" && ANSWER_ID.test(v["answerId"]), v["answerId"]) }),
    threadId: need(typeof v["threadId"] === "string" && THREAD_ID.test(v["threadId"]), v["threadId"]), outcome, text,
    ...(words === undefined ? {} : { honesty: need(prose(words, 300), words) }), unconfirmed, sources, wikiPages, ...(action === undefined ? {} : { action }),
  };
}

/** Code's suggestion, rebuilt from its known fields only; throws Unreadable on anything off. */
export function suggestObject(value: unknown): Plain {
  const v = rec(value);
  keysOnly(v, ["kind", "classifier", "pick", "smallTalk"]);
  const kind = need(oneOf(v["kind"], KINDS), v["kind"]) as string, classifier = need(oneOf(v["classifier"], CLASSIFIERS), v["classifier"]) as string, pick = need(oneOf(v["pick"], PICKS), v["pick"]) as string;
  if (kind === "small_talk") need(classifier === "ok" && pick === "answer" && oneOf(v["smallTalk"], SMALL_TALK), undefined);
  else need(v["smallTalk"] === undefined, undefined);
  // A classification is `ok` and suggests exactly the path its kind names; no other kind is ever `ok`, and an unusable one never guesses Quick or Full.
  if (kind === "unknown") need(classifier !== "ok" && pick === "answer", undefined);
  else if (kind !== "small_talk") need(classifier === "ok" && PICK_OF[kind] === pick, undefined);
  return { kind, classifier, pick, ...(kind === "small_talk" ? { smallTalk: v["smallTalk"] } : {}) };
}

/** Code's answer to "Not right", rebuilt from its known fields only; throws Unreadable on anything off. */
export function notRightObject(value: unknown): Plain {
  const v = rec(value);
  keysOnly(v, ["answerId", "state", "claims"]);
  return { answerId: need(typeof v["answerId"] === "string" && ANSWER_ID.test(v["answerId"]), v["answerId"]), state: need(oneOf(v["state"], ["queued", "noted", "already"] as const), v["state"]), claims: need(whole(v["claims"], 0, 100), v["claims"]) };
}

type Kind = "answer" | "suggest" | "notRight";
/** Code's refusal in Cloud's fixed words. Only Code's exact unknown-route 404 means "not on Code yet"; any other 404 is "not found". */
export function answersRefusal(kind: Kind, error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  if (error.status === 404) return body?.["code"] === "NOT_FOUND" && (body["message"] === "route not found" || body["message"] === CORE_NOT_YET) ? A.notYet : kind === "notRight" ? A.answerGone : A.notFound;
  if (kind === "notRight") return error.status === 403 ? A.forbidden : error.status === 400 ? A.invalid : A.notRightFailed;
  if (error.status === 401) return A.signIn;
  if (error.status === 403) return A.forbidden;
  if (error.status === 400) return A.invalid;
  // Code's three 429s for an answer, each in Cloud's own fixed words: the project's limit, the company's month paused (B8: it is not "you've asked a lot"), and the person's real rate limit (anything else).
  if (error.status === 429) return kind === "suggest" ? A.suggestRate : body?.["message"] === W.limitReached ? A.limitReached : body?.["message"] === W.paused ? A.paused : A.rate;
  return kind === "suggest" ? A.suggestUnavailable : A.unavailable;
}

/** The project in the path, after Code's access check names the person's company now; or the route's refusal. */
async function scope(context: RouteContext, kind: Kind): Promise<{ project: string } | { refusal: RouteAnswer }> {
  const project = context.params[0];
  if (project === undefined || !PROJECT_NAME.test(project)) return { refusal: A.notFound };
  let who: Awaited<ReturnType<typeof companyCaller>>;
  try {
    who = await companyCaller(context);
  } catch (error) {
    if (error instanceof CodeError) return { refusal: kind === "suggest" ? A.suggestUnavailable : kind === "notRight" ? A.notRightFailed : A.unavailable };
    throw error;
  }
  return refused(who) ? { refusal: who } : { project };
}

async function viaCode(context: RouteContext, kind: Kind, path: string, body: Plain, build: (value: unknown) => Plain): Promise<RouteAnswer> {
  let got: unknown;
  try {
    got = await context.client.json<unknown>(context.session, path, { method: "POST", body });
  } catch (error) {
    // An ended sign-in (SignInEnded) is not a CodeError: it reaches the handler, which signs the person out.
    if (error instanceof CodeError) {
      if (error.status >= 500) (context.log ?? ((event) => { console.log(JSON.stringify(event)); }))({ event: "cloud.answers_unavailable", status: error.status });
      return answersRefusal(kind, error);
    }
    throw error;
  }
  try { return { status: 200, body: build(got) }; } catch (error) { if (error instanceof Unreadable) { (context.log ?? ((event) => { console.log(JSON.stringify(event)); }))({ event: "cloud.answers_unreadable" });return kind === "suggest" ? A.suggestUnavailable : kind === "notRight" ? A.notRightFailed : A.unavailable; } throw error; }
}

const projectPath = (project: string, tail: string) => `/v1/app/projects/${encodeURIComponent(project)}${tail}`;
const bodyOf = (context: RouteContext): Plain | undefined => (plain(context.body) ? context.body : undefined);
const hasQuery = (context: RouteContext): boolean => [...context.query.keys()].length > 0;

export const ANSWERS_ROUTES: Route[] = [
  {
    // J5: the asker's "Not right" on an answer. Code decides who (only the asker, with a role now); Cloud passes the person's token with an EMPTY body and rebuilds the reply.
    method: "POST", path: /^\/projects\/([^/]+)\/answers\/([^/]+)\/not-right$/u,
    answer: async (context) => {
      if (context.answersEnabled !== true) return A.notYet;
      const at = await scope(context, "notRight");
      if ("refusal" in at) return at.refusal;
      const given = context.body;
      const answerId = context.params[1];
      if (hasQuery(context) || (given !== undefined && (!plain(given) || Object.keys(given).length > 0)) || answerId === undefined || !ANSWER_ID.test(answerId)) return A.invalid;
      return viaCode(context, "notRight", projectPath(at.project, `/answers/${encodeURIComponent(answerId)}/not-right`), {}, notRightObject);
    },
  },
  {
    method: "POST", path: /^\/projects\/([^/]+)\/answers$/u,
    answer: async (context) => {
      if (context.answersEnabled !== true) return A.notYet;
      const at = await scope(context, "answer");
      if ("refusal" in at) return at.refusal;
      const given = bodyOf(context);
      if (given === undefined || hasQuery(context) || Object.keys(given).some((key) => !["requestId", "question", "threadId", "context"].includes(key))) return A.invalid;
      const question = typeof given["question"] === "string" ? given["question"].trim() : "";
      const ok = typeof given["requestId"] === "string" && REQUEST_ID.test(given["requestId"]) && question.length >= 1 && prose(question, LIMITS.question)
        && (given["threadId"] === undefined || (typeof given["threadId"] === "string" && THREAD_ID.test(given["threadId"])))
        && (given["context"] === undefined || line(given["context"], LIMITS.context, 0));
      if (!ok) return A.invalid;
      const forwarded: Plain = { requestId: given["requestId"], question, channel: "web", ...(given["threadId"] === undefined ? {} : { threadId: given["threadId"] }), ...(typeof given["context"] === "string" && given["context"] !== "" ? { context: given["context"] } : {}) };
      return viaCode(context, "answer", projectPath(at.project, "/answers"), forwarded, answerObject);
    },
  },
  {
    method: "POST", path: /^\/projects\/([^/]+)\/code\/suggest$/u,
    answer: async (context) => {
      if (context.answersEnabled !== true) return A.notYet;
      const at = await scope(context, "suggest");
      if ("refusal" in at) return at.refusal;
      const given = bodyOf(context);
      if (given === undefined || hasQuery(context) || Object.keys(given).some((key) => !["requestId", "text"].includes(key))) return A.invalid;
      const text = typeof given["text"] === "string" ? given["text"].trim() : "";
      if (!(typeof given["requestId"] === "string" && REQUEST_ID.test(given["requestId"]) && text.length >= 1 && prose(text, LIMITS.text))) return A.invalid;
      return viaCode(context, "suggest", projectPath(at.project, "/code/suggest"), { requestId: given["requestId"], text }, suggestObject);
    },
  },
];
