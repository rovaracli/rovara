// The inbox's routes (web task channel K5, plan section 5): `GET /v1/app/inbox` (the signed-in person's own rows, newest first, one page with a cursor) and
// `POST /v1/app/inbox/read` (`{ requestId, ids }`, marks the person's own rows read). Each one asks Rovara Code's in-app inbox (C7) as the signed-in person.
// Cloud is a pass-through: Code decides whose rows these are (the company from the person's live membership, the person from the verified sign-in) and
// checks every row against the person's access again before it shows it, and its refusals reach the app unchanged (the handler passes every CodeError on).
// What Cloud adds is only this:
//   - nothing about who or which company is ever read from the browser: the query takes `limit` and `cursor` only, the read body exactly `requestId` and `ids`,
//     each checked at runtime, and anything else gets fixed words that echo nothing and reaches Code never;
//   - when Code answers 404 or 501 (this install's Code has no inbox) the app gets one fixed 501 (the badge hides, the screen says so in fixed words);
//   - Code's answer is read against the shape Cloud expects and projected to the fields the app draws (Code's own `link` is never passed on);
//   - where a row opens is Cloud's own: the session Cloud has for the person's task (`/s/<ses>`), otherwise the task by its id (`/t/<id>`, K2), read from Code's
//     session of the task, never taken from the browser. A row Cloud cannot place is left out.
// Every write is a non-GET under /v1/web, so the handler's CSRF check (the `x-rovara-csrf` header against the sign-in's token) covers it already.
import { createHash } from "node:crypto";
import { softenSetupRepairWords } from "@agentx/contracts/web";
import { CodeError } from "./code-client.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";

export const INBOX_NOT_AVAILABLE = "Your inbox isn't available on this install yet.";
/** Code's kinds today are needs_you, paused, ready, failed and done; a kind a newer Code adds is passed on (the app reads it as a plain update), so one new kind never fails the whole page. */
const KIND = /^[a-z_]{1,20}$/u;
/** Code's page and read-mark bounds (core/notify/inbox.ts). */
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
const READ_IDS_MAX = 50;
/** How many of the person's own sessions are looked at to place a row, and how many Code session reads run at once. */
const OWN_SESSIONS_LOOKED_AT = 200;
const READS_AT_ONCE = 5;
/** A session of Code never changes its task, so a placed row is remembered (per company, person and session; bounded) and the next poll does not read the session again. */
const TASKS_KEPT_MAX = 2000;
const taskOfSessionKept = new Map<string, string>();

const ID = /^[0-9a-z_]{1,64}\.[a-z_]{1,20}\.[0-9]{1,16}$/u;
const CODE_SESSION = /^ses_[0-9a-z]{20}$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/u;
/** The same shape as the task id Cloud opens by (open-by-task): a version 1 to 8 UUID with an RFC variant. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const notAvailable: RouteAnswer = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: INBOX_NOT_AVAILABLE } } };
const badRequest: RouteAnswer = { status: 400, body: { error: { code: "CONFIG_INVALID", message: "That request isn't in the shape this page sends." } } };
/** Code answered something Cloud cannot read as an inbox answer: fixed words, nothing echoed. */
const unreadable: RouteAnswer = { status: 502, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Rovara Code sent an inbox answer Cloud couldn't read." } } };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** For tests: forget the rows already placed. */
export const forgetPlacedRows = (): void => { taskOfSessionKept.clear(); };

/** The session id Code gives a task (core/sessions/create.ts `taskSessionId`): `ses_` and the first 20 hex digits of the SHA-256 of `task-session\n<task id>`. */
export const codeSessionIdOf = (taskId: string): string => `ses_${createHash("sha256").update(`task-session\n${taskId}`, "utf8").digest("hex").slice(0, 20)}`;

interface Row { id: string; sessionId: string; kind: string; title: string; status: string; at: string; read: boolean }

/** One of Code's rows in the shape Cloud expects, or undefined. Only the named fields are kept (Code's `link` is dropped). */
function projectRow(value: unknown): Row | undefined {
  if (!isObj(value)) return undefined;
  const { id, sessionId, kind, title, status, at, read } = value;
  if (typeof id !== "string" || !ID.test(id) || typeof sessionId !== "string" || !CODE_SESSION.test(sessionId) || !id.startsWith(`${sessionId}.`) || typeof kind !== "string" || !KIND.test(kind)) return undefined;
  if (typeof title !== "string" || title.length < 1 || title.length > 200 || typeof status !== "string" || status.length > 300 || typeof read !== "boolean") return undefined;
  const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) return undefined;
  return { id, sessionId, kind, title, status, at: new Date(time).toISOString(), read };
}

/** The task a Code session is for, read from Code as the person (it checks the person may see the session), or undefined. */
async function taskOfSession(context: RouteContext, sessionId: string): Promise<string | undefined> {
  try {
    const raw = await context.client.json<unknown>(context.session, `/v1/app/sessions/${sessionId}`);
    const session = isObj(raw) && isObj(raw["session"]) ? raw["session"] : undefined;
    const body = session !== undefined && isObj(session["body"]) ? session["body"] : undefined;
    const task = body !== undefined && body["kind"] === "task" && isObj(body["task"]) ? body["task"] : undefined;
    const taskId = task?.["taskId"];
    // The task must be the one Code gives this session: its session id, worked out here, is the one asked for.
    return typeof taskId === "string" && UUID.test(taskId) && codeSessionIdOf(taskId) === sessionId ? taskId.toLowerCase() : undefined;
  } catch (error) {
    // Code's refusal or a failed read leaves the row out; the sign-in ending is the handler's to answer.
    if (error instanceof CodeError) return undefined;
    throw error;
  }
}

/** Where each of Code's sessions opens: Cloud's own session for the person's task, otherwise the task by its id. Undefined for one Cloud cannot place. */
async function placeSessions(context: RouteContext, sessionIds: string[]): Promise<Map<string, string>> {
  const places = new Map<string, string>();
  // The sessions the person started (their company's only): Code's session id of each one's task names Cloud's session.
  try {
    for (const record of (await context.work.startedBy(context.session.access.developerId)).slice(0, OWN_SESSIONS_LOOKED_AT)) {
      const code = codeSessionIdOf(record.taskId);
      if (!places.has(code)) places.set(code, `/s/${record.sessionId}`);
    }
  } catch { /* the rows still open by their task's id */ }
  const who = `${context.session.access.companyId ?? ""}/${context.session.access.developerId}/`;
  for (const id of sessionIds) { const kept = taskOfSessionKept.get(who + id); if (!places.has(id) && kept !== undefined) places.set(id, `/t/${kept}`); }
  const unplaced = sessionIds.filter((id) => !places.has(id));
  for (let index = 0; index < unplaced.length; index += READS_AT_ONCE) {
    const chunk = unplaced.slice(index, index + READS_AT_ONCE);
    const tasks = await Promise.all(chunk.map((id) => taskOfSession(context, id)));
    chunk.forEach((id, position) => {
      const taskId = tasks[position];
      if (taskId === undefined) return;
      places.set(id, `/t/${taskId}`);
      if (taskOfSessionKept.size >= TASKS_KEPT_MAX) taskOfSessionKept.delete(taskOfSessionKept.keys().next().value as string);
      taskOfSessionKept.set(who + id, taskId);
    });
  }
  return places;
}

/** `limit` and `cursor`, the only things the browser may send; undefined when either is not what the page sends. */
function readQuery(query: URLSearchParams): { limit: number; cursor?: string } | undefined {
  const limitText = query.get("limit");
  const limit = limitText === null ? PAGE_DEFAULT : /^[0-9]{1,2}$/u.test(limitText) ? Number(limitText) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) return undefined;
  const cursor = query.get("cursor");
  if (cursor !== null && !CURSOR.test(cursor)) return undefined;
  return { limit, ...(cursor === null ? {} : { cursor }) };
}

/** L4-U5b: one of Code's project notices, in the shape Cloud expects (only the named fields are kept), or undefined. */
const NOTICE_ID = /^[a-z_]{1,20}\.[0-9]{1,16}\.[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
function projectNotice(value: unknown): { id: string; kind: string; project: string; status: string; at: string } | undefined {
  if (!isObj(value)) return undefined;
  const { id, kind, project, status, at } = value;
  // A kind a newer Code adds is passed on (the app reads it as a plain update), so one new kind never fails the whole list.
  if (typeof kind !== "string" || !KIND.test(kind) || typeof id !== "string" || !NOTICE_ID.test(id) || typeof project !== "string" || !PROJECT_NAME.test(project) || !id.startsWith(`${kind}.`) || !id.endsWith(`.${project}`)) return undefined;
  if (typeof status !== "string" || status.length < 1 || status.length > 500) return undefined;
  const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(time)) return undefined;
  // DEC 254zzz447: a Code from before "don't block work" still says it cannot build; the person reads the new words (work continues).
  return { id, kind, project, status: softenSetupRepairWords(status), at: new Date(time).toISOString() };
}
/** The most project notices one read holds (Code checks at most 50 rows). */
const NOTICES_MAX = 50;

export const INBOX_ROUTES: Route[] = [
  {
    // GET /v1/app/inbox/project-notices: the notices about a project that Code keeps in the person's own inbox (an admin told by neither chat nor email still finds them here). Code shows one only while the person still
    // administers the project; Cloud sends no query and no body, keeps the named fields only, and reads a Code with no such route (or no inbox) as nothing to show.
    method: "GET", path: /^\/inbox\/project-notices$/u,
    answer: async (context) => {
      if ([...context.query.keys()].length > 0) return badRequest;
      let raw: unknown;
      try {
        raw = await context.client.json<unknown>(context.session, "/v1/app/inbox/project-notices");
      } catch (error) {
        if (error instanceof CodeError && (error.status === 404 || error.status === 501)) return { status: 200, body: { items: [] } };
        throw error;
      }
      if (!isObj(raw) || !Array.isArray(raw["items"]) || raw["items"].length > NOTICES_MAX) return unreadable;
      const items: NonNullable<ReturnType<typeof projectNotice>>[] = [];
      for (const entry of raw["items"] as unknown[]) {
        const notice = projectNotice(entry);
        if (notice === undefined) return unreadable;
        items.push(notice);
      }
      return { status: 200, body: { items } };
    },
  },
  {
    // GET /v1/app/inbox?limit=&cursor=: the person's own rows, newest first (Code's page), each with where it opens in this app.
    method: "GET", path: /^\/inbox$/u,
    answer: async (context) => {
      const asked = readQuery(context.query);
      if (asked === undefined) return badRequest;
      const forward = new URLSearchParams({ limit: String(asked.limit), ...(asked.cursor === undefined ? {} : { cursor: asked.cursor }) });
      let raw: unknown;
      try {
        raw = await context.client.json<unknown>(context.session, `/v1/app/inbox?${forward.toString()}`);
      } catch (error) {
        // Code has no inbox on this install (a route it does not serve): one fixed answer. Any other refusal is Code's own and passes through.
        if (error instanceof CodeError && (error.status === 404 || error.status === 501)) return notAvailable;
        throw error;
      }
      if (!isObj(raw) || !Array.isArray(raw["items"]) || raw["items"].length > PAGE_MAX) return unreadable;
      const rows: Row[] = [];
      for (const item of raw["items"] as unknown[]) {
        const row = projectRow(item);
        if (row === undefined) return unreadable;
        rows.push(row);
      }
      const cursor = raw["nextCursor"];
      if (cursor !== undefined && (typeof cursor !== "string" || !CURSOR.test(cursor))) return unreadable;
      const unread = raw["unread"];
      if (unread !== undefined && (typeof unread !== "number" || !Number.isInteger(unread) || unread < 0 || unread > 1000)) return unreadable;
      const places = await placeSessions(context, [...new Set(rows.map((row) => row.sessionId))]);
      const items = rows.flatMap((row) => {
        const open = places.get(row.sessionId);
        return open === undefined ? [] : [{ id: row.id, kind: row.kind, title: row.title, status: row.status, at: row.at, read: row.read, open }];
      });
      return { status: 200, body: { items, ...(cursor === undefined ? {} : { nextCursor: cursor }), ...(unread === undefined ? {} : { unread }) } };
    },
  },
  {
    // POST /v1/app/inbox/read {requestId, ids}: mark the person's own rows read. Code builds each key from the caller's own company and person.
    method: "POST", path: /^\/inbox\/read$/u,
    answer: async (context) => {
      const body = context.body;
      if (!isObj(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, "requestId") || !Object.hasOwn(body, "ids")) return badRequest;
      const { requestId, ids } = body;
      if (typeof requestId !== "string" || !REQUEST_ID.test(requestId) || !Array.isArray(ids) || ids.length < 1 || ids.length > READ_IDS_MAX) return badRequest;
      if (!ids.every((id) => typeof id === "string" && ID.test(id))) return badRequest;
      let raw: unknown;
      try {
        raw = await context.client.json<unknown>(context.session, "/v1/app/inbox/read", { method: "POST", body: { requestId, ids } });
      } catch (error) {
        if (error instanceof CodeError && (error.status === 404 || error.status === 501)) return notAvailable;
        throw error;
      }
      const marked = isObj(raw) ? raw["marked"] : undefined;
      if (typeof marked !== "number" || !Number.isInteger(marked) || marked < 0 || marked > READ_IDS_MAX) return unreadable;
      return { status: 200, body: { marked } };
    },
  },
];
