// L4-B5: "Decisions and answers" on a session (`GET /v1/app/sessions/{ses}/log`), answered from Rovara Code's task log as the signed-in person. Cloud is a pass-through: Code decides who may read the log (the task's
// readers) and its refusals reach the app unchanged. What Cloud adds is only this:
//   - the task id comes from Cloud's own record of the session (`ses_...` in the path), never from the browser, and the Code session id comes from Code's own task read for that record (the person must be able to read
//     the task there first); a task Code has no session for has an empty log;
//   - Code's answer is read against the shape Cloud expects and projected to the fields the page reads: the questions, the answers and the decisions, each in the fields named and no others (the plan summary, the
//     milestones and the pull requests, and anything a newer Code adds, are dropped); an entry that does not read is left out, a list that does not read is a fixed refusal;
//   - every text is made one plain line again (control characters become spaces) and cut at the bound.
// Cloud's server keeps no runtime dependency on zod or the contracts package, so the checks are written out; the app's reader is packages/contracts/src/app-session-log.ts (a test reads every answer through it).
import type { Route, RouteAnswer } from "./routes.js";

const SESSION = "(ses_[0-9a-z]{20})";
const CODE_SESSION = /^ses_[0-9a-z]{20}$/u;
const TASK_VIEW = { "x-agentx-task-view": "2" };
const ENTRIES_MAX = 200;
const TEXT_MAX = 500;
const PERSON_MAX = 80;
const KEY = /^[a-z_]{2,20}:[A-Za-z0-9._#:-]{1,120}$/u;
const ID = /^[A-Za-z0-9._-]{1,40}$/u;
const SURFACES = ["web", "slack", "linear", "jira", "github", "cli", "mcp"] as const;
const WHATS = ["plan", "requirements", "design", "pull_request"] as const;
const OUTCOMES = ["approved", "changes_requested", "rejected"] as const;

const sessionNotFound: RouteAnswer = { status: 404, body: { error: { code: "SESSION_NOT_FOUND", message: "That session doesn't exist, or you can't see it." } } };
/** Code answered something Cloud cannot read as a task log: fixed words, nothing echoed. */
const unreadable: RouteAnswer = { status: 502, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent a task log Cloud couldn't read." } } };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/** One plain line of at most `max` characters, or undefined when nothing is left. */
function line(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const cut = [...flat].slice(0, max).join("").trimEnd();
  return cut === "" ? undefined : cut;
}
const instant = (value: unknown): string | undefined => (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10) ? value : undefined);
const round = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);

/** One of Code's entries as the page reads it, or undefined for an entry Cloud does not show or cannot read. */
function projectEntry(value: unknown): Obj | undefined {
  if (!isObj(value) || typeof value["key"] !== "string" || !KEY.test(value["key"])) return undefined;
  const at = instant(value["at"]);
  if (at === undefined) return undefined;
  const base = { key: value["key"], at };
  if (value["kind"] === "question") {
    const text = line(value["text"], TEXT_MAX), questionRound = round(value["round"]);
    if (text === undefined || questionRound === undefined || typeof value["questionId"] !== "string" || !ID.test(value["questionId"])) return undefined;
    const choices = Array.isArray(value["choices"]) ? (value["choices"] as unknown[]).slice(0, 4).flatMap((choice) => line(choice, 80) ?? []) : [];
    return { ...base, kind: "question", questionId: value["questionId"], round: questionRound, text, ...(choices.length === 0 ? {} : { choices }) };
  }
  if (value["kind"] === "answer") {
    const text = line(value["text"], TEXT_MAX), by = line(value["by"], PERSON_MAX), answerRound = round(value["round"]);
    if (text === undefined || by === undefined || answerRound === undefined || typeof value["questionId"] !== "string" || !ID.test(value["questionId"]) || !oneOf(SURFACES, value["surface"])) return undefined;
    return { ...base, kind: "answer", questionId: value["questionId"], round: answerRound, text, by, surface: value["surface"] };
  }
  if (value["kind"] === "approval") {
    const by = line(value["by"], PERSON_MAX);
    if (by === undefined || !oneOf(WHATS, value["what"]) || !oneOf(OUTCOMES, value["outcome"]) || !oneOf(SURFACES, value["surface"])) return undefined;
    return { ...base, kind: "approval", what: value["what"], outcome: value["outcome"], by, surface: value["surface"] };
  }
  return undefined;
}

/** Code's log as the app reads it (the questions, answers and decisions, oldest first), or undefined when it is not a list of entries. */
export function projectLog(value: unknown): { entries: Obj[] } | undefined {
  if (!isObj(value) || !Array.isArray(value["entries"]) || value["entries"].length > ENTRIES_MAX) return undefined;
  return { entries: (value["entries"] as unknown[]).flatMap((entry): Obj[] => { const kept = projectEntry(entry); return kept === undefined ? [] : [kept]; }) };
}

export const TASK_LOG_ROUTES: Route[] = [
  {
    // GET /v1/app/sessions/{id}/log: the decisions and answers of the session's task.
    method: "GET", path: new RegExp(`^/sessions/${SESSION}/log$`, "u"),
    answer: async (context) => {
      const record = await context.work.get(context.params[0]!);
      if (record === undefined) return sessionNotFound;
      // Code lets the person read the task first (its refusal passes through), and says which Code session the task has.
      const read = await context.client.json<unknown>(context.session, `/v1/dev/tasks/${encodeURIComponent(record.taskId)}?events=0`, { headers: TASK_VIEW });
      const task = isObj(read) && isObj(read["task"]) ? read["task"] : undefined;
      if (task === undefined) return unreadable;
      const codeSession = task["sessionId"];
      if (codeSession === undefined) return { status: 200, body: { entries: [] } };
      if (typeof codeSession !== "string" || !CODE_SESSION.test(codeSession)) return unreadable;
      const raw = await context.client.json<unknown>(context.session, `/v1/app/sessions/${encodeURIComponent(codeSession)}/log`);
      const projected = projectLog(raw);
      return projected === undefined ? unreadable : { status: 200, body: projected };
    },
  },
];
