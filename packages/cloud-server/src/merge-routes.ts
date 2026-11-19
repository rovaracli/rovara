// Owner DEC 254zzz94: the in-Rovara Merge button for a finished task, passed to Rovara Code as the signed-in person with their own token (the Rovara website's own sign-in client, which Code
// recognises as the web app: DEC 254zzz91).
//
//   GET  /v1/app/sessions/{id}/merge   -> Code GET  /v1/app/tasks/{taskId}/merge   { mayMerge, ready, message?, risk?, heads?, pullRequests }
//   POST /v1/app/sessions/{id}/merge   { requestId, expectedHeads?, risk? } -> Code POST /v1/app/tasks/{taskId}/merge   { status: "MERGED", pullRequests }
//   (DEC 254zzz104: the heads and risk level the person was shown go back with the press, so Code merges only what they saw.)
//
// Rules:
//   - The task id is Cloud's own session record's, never the request's. A session this Cloud does not hold is "not found" and Code is not asked.
//   - Code decides everything: who may merge (owner, co-owner, project admin, company admin), the website-only rule, Rovara's checks, GitHub's mergeable state, one merge at a time and the
//     request id. Cloud adds no rule that could widen it. The press sends a request id (a UUID) and, optionally, the heads and risk level it was shown, each checked; any other field, a malformed body or a query is refused without asking Code.
//   - Code's answers are rebuilt field by field and checked (an answer that does not read is refused whole). Code's refusals are its own fixed words; they reach the app only as a bounded, single-line
//     sentence under Code's error code, and anything else reads as Cloud's fixed words. Code's unknown-route 404 (a Code without the route) reads "not available on this Rovara yet".
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SESSION_PATH = /^\/sessions\/(ses_[0-9a-z]{20})\/merge$/u;
const REPOSITORY = /^[A-Za-z0-9._/-]{1,200}$/u;
const MAX_PULLS = 32;
const SHA = /^[a-f0-9]{40}$/u;
const RISKS = new Set(["low", "medium", "high"]);

/** The heads a person was shown: exactly repository, number and a 40-hex head each. Throws `Unreadable` for anything else. */
function headsOf(value: unknown): Array<{ repositoryId: string; number: number; headSha: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PULLS) throw new Unreadable();
  return value.map((head: unknown) => {
    if (!plain(head) || Object.keys(head).length !== 3) throw new Unreadable();
    const { repositoryId, number } = pullOf({ repositoryId: head["repositoryId"], number: head["number"] }, false);
    const headSha = head["headSha"];
    if (typeof headSha !== "string" || !SHA.test(headSha)) throw new Unreadable();
    return { repositoryId, number, headSha };
  });
}

export const MERGE_WORDS = {
  sessionNotFound: "That session doesn't exist, or you can't see it.",
  invalid: "Send a request id and, if you were shown them, the heads and the risk level; nothing else.",
  notYet: "Merging from Rovara isn't available on this Rovara yet. Merge the pull request on GitHub.",
  unreadable: "Rovara answered Merge in an unexpected way. Reload this page.",
  /** An answer Cloud cannot read as Code's own refusal (a fault, a timeout): it does not say what GitHub did, so the words never say "nothing was merged". */
  failed: "We couldn't confirm the result yet; checking GitHub. Reload this page in a moment.",
} as const;

const answer = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
class Unreadable extends Error {}
const need = <T>(ok: boolean, value: T): T => { if (!ok) throw new Unreadable(); return value; };

/** One pull request as Code lists it: repository, number and (for the readiness read) a github.com link. */
function pullOf(value: unknown, withUrl: boolean): { repositoryId: string; number: number; url?: string } {
  need(plain(value), value);
  const pull = value as Record<string, unknown>;
  const repositoryId = need(typeof pull["repositoryId"] === "string" && REPOSITORY.test(pull["repositoryId"]), pull["repositoryId"]) as string;
  const number = need(typeof pull["number"] === "number" && Number.isSafeInteger(pull["number"]) && pull["number"] > 0, pull["number"]) as number;
  if (!withUrl) return { repositoryId, number };
  const raw = pull["url"];
  need(typeof raw === "string" && raw.length <= 2048, raw);
  let url: URL;
  try { url = new URL(raw as string); } catch { throw new Unreadable(); }
  need(url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "", raw);
  return { repositoryId, number, url: url.toString() };
}

function pullsOf(value: unknown, withUrl: boolean): Array<{ repositoryId: string; number: number; url?: string }> {
  if (!Array.isArray(value) || value.length > MAX_PULLS) throw new Unreadable();
  return value.map((pull) => pullOf(pull, withUrl));
}

/** Code's readiness answer, rebuilt: exactly mayMerge, ready, an optional sentence, and the pull requests. A press that may not happen is never `ready`. */
export function mergeReadinessAnswer(value: unknown): { mayMerge: boolean; ready: boolean; message?: string; risk?: string; heads?: Array<{ repositoryId: string; number: number; headSha: string }>; pullRequests: Array<{ repositoryId: string; number: number; url?: string }> } {
  need(plain(value), value);
  const f = value as Record<string, unknown>;
  const mayMerge = need(typeof f["mayMerge"] === "boolean", f["mayMerge"]) as boolean;
  const ready = need(typeof f["ready"] === "boolean" && (mayMerge || f["ready"] === false), f["ready"]) as boolean;
  const message = f["message"] === undefined ? undefined : need(sentence(f["message"]) !== undefined, f["message"]) as string;
  const risk = f["risk"] === undefined ? undefined : need(typeof f["risk"] === "string" && RISKS.has(f["risk"]), f["risk"]) as string;
  const heads = f["heads"] === undefined || (Array.isArray(f["heads"]) && f["heads"].length === 0) ? undefined : headsOf(f["heads"]);
  return { mayMerge, ready, ...(message === undefined ? {} : { message }), ...(risk === undefined ? {} : { risk }), ...(heads === undefined ? {} : { heads }), pullRequests: pullsOf(f["pullRequests"], true) };
}

/** Code's merged answer, rebuilt. */
export function mergeDoneAnswer(value: unknown): { status: "MERGED"; pullRequests: Array<{ repositoryId: string; number: number }> } {
  need(plain(value) && value["status"] === "MERGED", value);
  return { status: "MERGED", pullRequests: pullsOf((value as Record<string, unknown>)["pullRequests"], false) };
}

/** The longest sentence passed on; a longer one (a half merge naming many repositories) is cut, never dropped, so the person still reads what merged. */
const SENTENCE_MAX = 600;
/** A sentence of Code's own fixed words: one printable line, cut to SENTENCE_MAX. Anything with a control character or markup is not passed on. */
function sentence(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f || ch === "<" || ch === ">")) return undefined;
  return value.length <= SENTENCE_MAX ? value : value.slice(0, SENTENCE_MAX - 1) + "…";
}

/** The error codes Code's merge route answers with, and the HTTP status each keeps. */
const CODE_REFUSALS: Record<string, number> = { MERGE_NOT_READY: 409, IDEMPOTENCY_CONFLICT: 409, FORBIDDEN: 403, TASK_NOT_FOUND: 404, CONFIG_INVALID: 400, RUNTIME_UNAVAILABLE: 503 };

/** Code's refusal: its own fixed sentence under its own code for the codes this route answers with; Code's unknown-route 404 reads "not available yet"; anything else is Cloud's fixed words. */
export function mergeRefusal(error: CodeError): RouteAnswer {
  const body = plain(error.body) && plain(error.body["error"]) ? error.body["error"] : undefined;
  const code = typeof body?.["code"] === "string" ? body["code"] : undefined;
  const message = sentence(body?.["message"]);
  if (error.status === 404 && code === "NOT_FOUND") return answer(501, "NOT_ON_CODE_YET", message === undefined || message === "route not found" ? MERGE_WORDS.notYet : message);
  if (code !== undefined && CODE_REFUSALS[code] === error.status && message !== undefined) return answer(error.status, code, message);
  return answer(503, "MERGE_FAILED", MERGE_WORDS.failed);
}

async function forward(context: RouteContext, method: "GET" | "POST"): Promise<RouteAnswer> {
  if ([...context.query.keys()].length > 0) return answer(400, "CONFIG_INVALID", MERGE_WORDS.invalid);
  let press: { requestId: string; expectedHeads?: Array<{ repositoryId: string; number: number; headSha: string }>; risk?: string } | undefined;
  if (method === "POST") {
    const body = context.body;
    if (!plain(body) || typeof body["requestId"] !== "string" || !REQUEST_ID.test(body["requestId"]) || Object.keys(body).some((key) => key !== "requestId" && key !== "expectedHeads" && key !== "risk")) return answer(400, "CONFIG_INVALID", MERGE_WORDS.invalid);
    const risk = body["risk"];
    if (risk !== undefined && (typeof risk !== "string" || !RISKS.has(risk))) return answer(400, "CONFIG_INVALID", MERGE_WORDS.invalid);
    let expectedHeads: Array<{ repositoryId: string; number: number; headSha: string }> | undefined;
    try { expectedHeads = body["expectedHeads"] === undefined ? undefined : headsOf(body["expectedHeads"]); } catch { return answer(400, "CONFIG_INVALID", MERGE_WORDS.invalid); }
    press = { requestId: body["requestId"], ...(expectedHeads === undefined ? {} : { expectedHeads }), ...(typeof risk === "string" ? { risk } : {}) };
  }
  const record = await context.work.get(context.params[0]!);
  if (record === undefined) return answer(404, "SESSION_NOT_FOUND", MERGE_WORDS.sessionNotFound);
  const path = `/v1/app/tasks/${encodeURIComponent(record.taskId)}/merge`;
  let value: unknown;
  try {
    value = await context.client.json<unknown>(context.session, path, method === "GET" ? { method: "GET" } : { method: "POST", body: press });
  } catch (error) {
    if (error instanceof CodeError) return mergeRefusal(error);
    throw error;
  }
  try {
    const body = method === "GET" ? mergeReadinessAnswer(value) : mergeDoneAnswer(value);
    console.log(JSON.stringify({ event: "cloud.merge", action: method === "GET" ? "read" : "merged" }));
    return { status: 200, body };
  } catch (error) {
    if (error instanceof Unreadable) return answer(502, "INVALID_RESPONSE", MERGE_WORDS.unreadable);
    throw error;
  }
}

export const MERGE_ROUTES: Route[] = [
  { method: "GET", path: SESSION_PATH, answer: async (context) => forward(context, "GET") },
  { method: "POST", path: SESSION_PATH, answer: async (context) => forward(context, "POST") },
];
