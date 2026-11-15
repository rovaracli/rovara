// The company audit list (migration plan v3.2, 7.5 "Audit"): Cloud's own records (audit-log.ts) and Code's engine records read as one list, newest first across
// both, filtered by time, person, action and project, one page at a time with a cursor that stays good while records are added.
//
// Order. A line is placed by its time, then by its id (`cloud:<id>` or `engine:<eventId>`, higher first): the same total order in every page, in both sources.
// A cursor is the position of the last line handed out (and the company and filters it was made for); the next page is everything strictly after it.
//
// Cloud's records are read newest first from a time-ordered store, so a page needs only the newest of them. Code's audit read has NO time index yet (Rovara PR #649,
// AU-EV-1): it reads a company's rows in key order and sorts newest first within one call's page only. So the only way to place an engine line is to read every page of
// the filtered range (at most ENGINE_CALLS_MAX calls of up to 200 lines), sort them here, and take the page. If Code has more than that, the engine lines shown are not all of them:
// the answer says `incomplete`, and the page shows what was read (an older page may miss engine lines). When Code gets a time index this stays correct and gets cheaper.
//
// Cloud's scan is bounded too (CLOUD_SCAN_MAX rows a call, whatever the filters): when it stops before it has found a page, nothing older than the last row it looked at is
// known, so the page holds only lines at or after that row, may be short or empty, and its cursor is that row. Ask again with it until there is no cursor.
import { createHash } from "node:crypto";
import { CodeError, SignInEnded, type CodeClient } from "./code-client.js";
import type { CodeSession } from "./sessions.js";
import {
  AUDIT_EARLIEST_MS, checkedCompany, isOlderThan, newestFirst, type AuditStorePosition, type CloudAuditRecord, type CloudAuditStore,
} from "./audit-log.js";

export const COMPANY_AUDIT = Object.freeze({
  PAGE_DEFAULT: 50,
  PAGE_MAX: 200,
  /** The most Cloud rows one list call looks at, matching or not. */
  CLOUD_SCAN_MAX: 2_000,
  CLOUD_CHUNK: 300,
  /** The most pages one list call asks Code for. */
  ENGINE_CALLS_MAX: 8,
  /** The page size asked of Code (its most). */
  ENGINE_PAGE: 200,
});

export const COMPANY_AUDIT_WORDS = Object.freeze({
  notConnected: "Engine records are not connected yet. This list shows Cloud's own records only.",
  unavailable: "Engine records could not be read just now. This list shows Cloud's own records only.",
  incomplete: "Code holds more engine records than this page can read, so the engine lines shown are not all of them.",
  unreadable: "Some engine records could not be read, so the engine lines shown are not all of them.",
  queryRefused: "the audit query is not valid",
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The shapes (the same as `CompanyAuditEntry`, `CompanyAuditPage` and `CompanyAuditEngineStatus` in contract v0; a test holds them to it)

export interface CompanyAuditEntry {
  id: string;
  source: "cloud" | "engine";
  at: string;
  actor: { developerId: string; name: string; type?: string };
  via?: string;
  action: string;
  subject: string;
  project?: string;
  outcome: string;
  detail?: string;
}
export interface CompanyAuditEngineStatus { state: "connected" | "not_connected" | "unavailable" | "incomplete"; message?: string }
export interface CompanyAuditPage { records: CompanyAuditEntry[]; next?: string; engine: CompanyAuditEngineStatus }

/** The request does not fit the query's rules (or its cursor is not one this list made for this company and these filters). Fixed words. */
export class CompanyAuditQueryRefused extends Error {
  constructor() {
    super(COMPANY_AUDIT_WORDS.queryRefused);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The query

export interface ParsedAuditQuery {
  fromMs?: number;
  toMs?: number;
  person?: string;
  project?: string;
  action?: string;
  limit: number;
  cursor?: string;
}

const KEYS = new Set(["from", "to", "person", "project", "action", "limit", "cursor"]);
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const PERSON = /^[A-Za-z0-9_.:@+-]{1,128}$/u;
const PROJECT = /^[a-z][a-z0-9-]{0,62}$/u;
const ACTION = /^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*(?:\.\*)?$/u;
const LIMIT = /^[1-9][0-9]{0,3}$/u;
const CURSOR_MAX = 1_024;

/** The query string as the list's filters: each parameter once, non-empty, named in the list above and in its allowed shape. Anything else is refused. */
export function parseCompanyAuditQuery(params: URLSearchParams): ParsedAuditQuery {
  const seen = new Map<string, string>();
  for (const [name, value] of params) {
    if (!KEYS.has(name) || seen.has(name) || value === "") throw new CompanyAuditQueryRefused();
    seen.set(name, value);
  }
  const instant = (name: string): number | undefined => {
    const value = seen.get(name);
    if (value === undefined) return undefined;
    const ms = Date.parse(value);
    if (!INSTANT.test(value) || Number.isNaN(ms)) throw new CompanyAuditQueryRefused();
    return ms;
  };
  const text = (name: string, pattern: RegExp, max: number): string | undefined => {
    const value = seen.get(name);
    if (value === undefined) return undefined;
    if (value.length > max || !pattern.test(value)) throw new CompanyAuditQueryRefused();
    return value;
  };
  const fromMs = instant("from"), toMs = instant("to");
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) throw new CompanyAuditQueryRefused();
  const person = text("person", PERSON, 128), project = text("project", PROJECT, 63), action = text("action", ACTION, 130);
  const rawLimit = seen.get("limit");
  if (rawLimit !== undefined && (!LIMIT.test(rawLimit) || Number(rawLimit) > COMPANY_AUDIT.PAGE_MAX)) throw new CompanyAuditQueryRefused();
  const cursor = seen.get("cursor");
  if (cursor !== undefined && cursor.length > CURSOR_MAX) throw new CompanyAuditQueryRefused();
  return {
    limit: rawLimit === undefined ? COMPANY_AUDIT.PAGE_DEFAULT : Number(rawLimit),
    ...(fromMs === undefined ? {} : { fromMs }), ...(toMs === undefined ? {} : { toMs }),
    ...(person === undefined ? {} : { person }), ...(project === undefined ? {} : { project }), ...(action === undefined ? {} : { action }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The cursor: a position, bound to the company and the filters it was made for (not a secret: it can only move within what the caller may read anyway)

interface Position { atMs: number; key: string }

const digestOf = (companyId: string, query: ParsedAuditQuery): string =>
  createHash("sha256").update(JSON.stringify([companyId, query.fromMs ?? null, query.toMs ?? null, query.person ?? null, query.project ?? null, query.action ?? null]), "utf8").digest("base64url").slice(0, 22);

const encodeCursor = (position: Position, digest: string): string => Buffer.from(JSON.stringify({ v: 1, t: position.atMs, k: position.key, d: digest }), "utf8").toString("base64url");

function decodeCursor(cursor: string, digest: string): Position {
  try {
    if (cursor.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new CompanyAuditQueryRefused();
    const body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; t?: unknown; k?: unknown; d?: unknown };
    const keys = Object.keys(body).sort().join(",");
    if (keys !== "d,k,t,v" || body.v !== 1 || body.d !== digest) throw new CompanyAuditQueryRefused();
    if (typeof body.t !== "number" || !Number.isSafeInteger(body.t) || body.t < AUDIT_EARLIEST_MS || body.t > 8_640_000_000_000_000) throw new CompanyAuditQueryRefused();
    // eslint-disable-next-line no-control-regex -- the control characters are what is refused
    if (typeof body.k !== "string" || body.k.length > 400 || !/^(?:cloud|engine):[^\u0000-\u0020\u007f]{1,390}$/u.test(body.k)) throw new CompanyAuditQueryRefused();
    return { atMs: body.t, key: body.k };
  } catch {
    throw new CompanyAuditQueryRefused();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The engine: Code's audit read

/** A record of Code's audit read, as Cloud checked it. */
export interface EngineRecord {
  eventId: string;
  at: string;
  actor: { developerId: string; name: string; type?: string };
  action: string;
  subject: string;
  outcome: string;
  via?: string;
}
export interface EngineAuditPageQuery { from?: string; to?: string; person?: string; project?: string; action?: string; limit: number; cursor?: string }
/** `not_served`: Code has no such route (yet). `unavailable`: Code did not answer, or answered something that is not a page. */
export type EnginePageResult = { kind: "page"; records: EngineRecord[]; next?: string; /** Records Code sent that Cloud could not read. */ unreadable?: number } | { kind: "not_served" } | { kind: "unavailable" };
export interface EngineAuditSource { page(query: EngineAuditPageQuery): Promise<EnginePageResult> }

/** An event id that a cursor can carry: printable ASCII without a space. */
const EVENT_ID = /^[!-~]{1,256}$/u;
const VIA = /^[a-z][a-z0-9_.:-]{0,63}$/u;
const str = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);

function engineRecord(value: unknown): EngineRecord | undefined {
  const row = value as { eventId?: unknown; at?: unknown; actor?: { developerId?: unknown; name?: unknown; type?: unknown } | null; action?: unknown; subject?: unknown; outcome?: unknown; via?: unknown } | null;
  if (row === null || typeof row !== "object") return undefined;
  const eventId = typeof row.eventId === "string" && EVENT_ID.test(row.eventId) ? row.eventId : undefined, at = str(row.at, 64), developerId = str(row.actor?.developerId, 256), name = str(row.actor?.name, 200), action = str(row.action, 128), outcome = str(row.outcome, 32);
  if (eventId === undefined || at === undefined || Number.isNaN(Date.parse(at)) || developerId === undefined || name === undefined || action === undefined || outcome === undefined) return undefined;
  const subject = row.subject === "" ? "" : str(row.subject, 600);
  if (subject === undefined) return undefined;
  const type = row.actor?.type;
  return {
    eventId, at, actor: { developerId, name, ...(type === "person" || type === "agent" || type === "system" ? { type } : {}) }, action, subject, outcome,
    ...(typeof row.via === "string" && VIA.test(row.via) ? { via: row.via } : {}),
  };
}

/**
 * Code's audit read as the signed-in person (`GET /v1/dev/client/company/audit/records`). A 404 or 501 is a Code that does not serve it yet; Code's 403 (the person
 * is not an administrator to Code) is passed on as Code's refusal; a sign-in that has ended ends the request; every other failure is "unavailable", with no cause.
 */
export function codeEngineAuditSource(client: CodeClient, session: CodeSession): EngineAuditSource {
  return {
    async page(query) {
      const params = new URLSearchParams();
      for (const name of ["from", "to", "person", "project", "action", "cursor"] as const) if (query[name] !== undefined) params.set(name, query[name]);
      params.set("limit", String(query.limit));
      let body: { records?: unknown; next?: unknown } | undefined;
      try {
        body = await client.json<{ records?: unknown; next?: unknown }>(session, `/v1/dev/client/company/audit/records?${params.toString()}`);
      } catch (error) {
        if (error instanceof SignInEnded) throw error;
        if (error instanceof CodeError) {
          if (error.status === 404 || error.status === 501) return { kind: "not_served" };
          if (error.status === 403) throw error;
        }
        return { kind: "unavailable" };
      }
      if (body === null || typeof body !== "object" || !Array.isArray(body.records) || (body.next !== undefined && str(body.next, 2_048) === undefined)) return { kind: "unavailable" };
      const records = body.records.flatMap((row) => { const one = engineRecord(row); return one === undefined ? [] : [one]; });
      return { kind: "page", records, ...(records.length < body.records.length ? { unreadable: body.records.length - records.length } : {}), ...(typeof body.next === "string" ? { next: body.next } : {}) };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The list

export interface CompanyAuditDeps {
  store: Pick<CloudAuditStore, "read">;
  engine: EngineAuditSource;
  now?: () => Date;
}

interface Candidate { entry: CompanyAuditEntry; atMs: number; id: string }

const entryOfCloud = (row: CloudAuditRecord): CompanyAuditEntry => ({
  id: `cloud:${row.id}`, source: "cloud", at: row.at, actor: { developerId: row.actor.developerId, name: row.actor.name, ...(row.actor.type === undefined ? {} : { type: row.actor.type }) },
  ...(row.via === undefined ? {} : { via: row.via }), action: row.action, subject: row.subject, ...(row.project === undefined ? {} : { project: row.project }), outcome: row.outcome,
  ...(row.detail === undefined ? {} : { detail: row.detail }),
});
const entryOfEngine = (row: EngineRecord): CompanyAuditEntry => ({
  id: `engine:${row.eventId}`, source: "engine", at: row.at, actor: row.actor, ...(row.via === undefined ? {} : { via: row.via }), action: row.action, subject: row.subject, outcome: row.outcome,
});

function actionMatches(action: string, wanted: string | undefined): boolean {
  if (wanted === undefined) return true;
  return wanted.endsWith(".*") ? action.startsWith(wanted.slice(0, -1)) : action === wanted;
}

/** The filters every line must meet, whichever source sent it. The project is Cloud's alone: engine lines carry it only in `subject`, and Code applies the filter itself. */
function fits(entry: CompanyAuditEntry, atMs: number, query: ParsedAuditQuery, low: number, upper: number | undefined): boolean {
  if (atMs < low || (upper !== undefined && atMs > upper)) return false;
  if (query.person !== undefined && entry.actor.developerId !== query.person) return false;
  if (!actionMatches(entry.action, query.action)) return false;
  return !(entry.source === "cloud" && query.project !== undefined && entry.project !== query.project);
}

const storePosition = (position: Position): AuditStorePosition =>
  // A Cloud line at the same instant as an engine position is older than it (`cloud:` sorts before `engine:`), so every id there is.
  (position.key.startsWith("cloud:") ? { atMs: position.atMs, id: position.key.slice("cloud:".length) } : { atMs: position.atMs, id: "\uffff" });

/**
 * One page of the company's audit list, for `companyId` only. `query` is what `parseCompanyAuditQuery` made. The caller has already checked that the person is an
 * administrator of that company. Throws CompanyAuditQueryRefused for a cursor that is not this company's and these filters'; a store failure is thrown as it is.
 */
export async function listCompanyAudit(deps: CompanyAuditDeps, companyId: string, query: ParsedAuditQuery): Promise<CompanyAuditPage> {
  checkedCompany(companyId);
  const digest = digestOf(companyId, query);
  const position = query.cursor === undefined ? undefined : decodeCursor(query.cursor, digest);
  const low = Math.max(query.fromMs ?? AUDIT_EARLIEST_MS, AUDIT_EARLIEST_MS);
  const upper = position === undefined ? query.toMs : Math.min(query.toMs ?? position.atMs, position.atMs);
  const after = (atMs: number, id: string) => position === undefined || isOlderThan(atMs, id, { atMs: position.atMs, id: position.key });

  // Cloud's records: newest first, looked through until a page and one more is found, or the scan cap, or the end.
  const cloud: Candidate[] = [];
  let horizon: Position | undefined;
  let scanned = 0;
  let olderThan: AuditStorePosition | undefined = position === undefined ? undefined : storePosition(position);
  for (;;) {
    const read = await deps.store.read(companyId, {
      ...(query.fromMs === undefined ? {} : { fromMs: query.fromMs }), ...(upper === undefined ? {} : { toMs: upper }), ...(olderThan === undefined ? {} : { olderThan }),
      max: Math.min(COMPANY_AUDIT.CLOUD_CHUNK, COMPANY_AUDIT.CLOUD_SCAN_MAX - scanned),
    });
    let last: Position | undefined;
    for (const row of read.rows) {
      scanned += 1;
      const atMs = Date.parse(row.at);
      last = { atMs, key: `cloud:${row.id}` };
      // The row is checked against the company again, whatever the store answered.
      if (row.companyId !== companyId) continue;
      const entry = entryOfCloud(row);
      if (fits(entry, atMs, query, low, upper) && after(atMs, entry.id)) cloud.push({ entry, atMs, id: entry.id });
    }
    if (!read.more || last === undefined) break;
    olderThan = { atMs: last.atMs, id: last.key.slice("cloud:".length) };
    if (scanned >= COMPANY_AUDIT.CLOUD_SCAN_MAX) {
      horizon = last;
      break;
    }
    if (cloud.length > query.limit) break;
  }

  // The engine's records: every page of the range, up to the budget.
  const engine: Candidate[] = [];
  let status: CompanyAuditEngineStatus = { state: "connected" };
  let cursor: string | undefined;
  const seen = new Set<string>();
  let unreadable = 0;
  for (let calls = 0; ; ) {
    if (calls >= COMPANY_AUDIT.ENGINE_CALLS_MAX) {
      status = { state: "incomplete", message: COMPANY_AUDIT_WORDS.incomplete };
      break;
    }
    const result = await deps.engine.page({
      limit: COMPANY_AUDIT.ENGINE_PAGE,
      ...(query.fromMs === undefined ? {} : { from: new Date(query.fromMs).toISOString() }), ...(upper === undefined ? {} : { to: new Date(upper).toISOString() }),
      ...(query.person === undefined ? {} : { person: query.person }), ...(query.project === undefined ? {} : { project: query.project }),
      ...(query.action === undefined ? {} : { action: query.action }), ...(cursor === undefined ? {} : { cursor }),
    });
    calls += 1;
    if (result.kind !== "page") {
      // Not serving the route is only "not connected" before anything was read from it.
      status = result.kind === "not_served" && calls === 1 ? { state: "not_connected", message: COMPANY_AUDIT_WORDS.notConnected } : { state: "unavailable", message: COMPANY_AUDIT_WORDS.unavailable };
      engine.length = 0;
      break;
    }
    unreadable += result.unreadable ?? 0;
    for (const row of result.records) {
      const entry = entryOfEngine(row);
      const atMs = Date.parse(row.at);
      if (!seen.has(entry.id) && fits(entry, atMs, query, low, upper) && after(atMs, entry.id)) {
        seen.add(entry.id);
        engine.push({ entry, atMs, id: entry.id });
      }
    }
    if (result.next === undefined) break;
    if (result.next === cursor) {
      status = { state: "unavailable", message: COMPANY_AUDIT_WORDS.unavailable };
      engine.length = 0;
      break;
    }
    cursor = result.next;
  }

  if (unreadable > 0 && status.state === "connected") status = { state: "incomplete", message: COMPANY_AUDIT_WORDS.unreadable };

  // Merged: newest first. Where Cloud's scan stopped early, only lines at or after the last row it looked at are known to be all of them.
  let merged = [...cloud, ...engine].sort(newestFirst);
  if (horizon !== undefined) {
    const known = horizon;
    merged = merged.filter((one) => one.atMs > known.atMs || (one.atMs === known.atMs && one.id >= known.key));
  }
  const records = merged.slice(0, query.limit);
  const last = records.at(-1);
  const next = merged.length > query.limit && last !== undefined ? { atMs: last.atMs, key: last.id } : horizon;
  return { records: records.map((one) => one.entry), ...(next === undefined ? {} : { next: encodeCursor(next, digest) }), engine: status };
}
