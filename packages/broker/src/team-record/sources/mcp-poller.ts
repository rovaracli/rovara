// R7: read-only MCP pollers, and backfill. Any tracker, wiki or ticket system that has an MCP server (an Enterprise customer's own, or
// Linear and Jira through their connectors) is read the same way: an admin registers a source with the tools it may call, and an adapter says
// how that server's answers become `TicketItem`s. The adapter is data (`createJsonListAdapter`), so a new server needs a mapping, not code.
//
// Safety:
//  - only tools in the source's read-only allow-list are ever called (the same list the K2 read-only MCP sources use: field `readOnlyTools`),
//    and a tool the server itself annotates as not read-only (`readOnlyHint: false` or `destructiveHint: true`) is refused even if listed;
//  - every answer is data: it is parsed, never obeyed, and a text body goes through `cleanText`;
//  - bounded: 500 items and 20 pages and a time budget per run; a cursor resumes the next run;
//  - the ACL comes from the server when the adapter finds one; else the source row's `audienceDefault`, and by default "project maintainers
//    only" (fail closed) until an admin sets "visible to all project members".
import { gate, isoOrUndefined } from "./common.js";
import type { SourceConfigPort, CaptureModePort, TapLog } from "./ports.js";
import type { TicketItem, TicketRecorder } from "./tickets.js";

export interface PollToolResult {
  isError?: boolean | undefined;
  content?: Array<{ type: string; text?: string | undefined }> | undefined;
  structuredContent?: unknown;
}

/** The part of an MCP connection the poller uses (`McpConnection` from the gateway satisfies it). */
export interface PollConnection {
  tools: ReadonlyArray<{ name: string; annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown } | undefined }>;
  call(name: string, args: Record<string, unknown>): Promise<PollToolResult>;
  close(): Promise<void>;
}

export interface McpPollAdapter {
  listArgs(input: { cursor?: string; since?: string; limit: number }): Record<string, unknown>;
  /** `undefined`: the answer could not be read. */
  parseList(result: PollToolResult): { items: TicketItem[]; nextCursor?: string } | undefined;
  existsArgs(id: string): Record<string, unknown>;
  /** `forbidden`: the server refused the credential or the item (401, 403, "no permission"). It is never "missing": many servers also hide what a credential may not see. */
  classifyExists(result: PollToolResult): "exists" | "missing" | "forbidden" | "unknown";
}

export interface McpPollSource {
  workspaceId: string;
  project?: string;
  /** The server's id: `sourceRef.system` of everything it gives. */
  serverId: string;
  source: TicketItem["source"];
  /** The `SOURCE#` scope. */
  scope: string;
  /** Tools the admin marked read-only on this server. */
  readOnlyTools: readonly string[];
  listTool: string;
  existsTool?: string;
  /** The record kinds the exists tool can fetch (default: tickets, not comments). */
  existsKinds?: readonly string[];
  adapterId: string;
}

export interface PollState {
  /** The poll's and the backfill's own cursors: one never resumes under the other's `since`. */
  pollCursor?: string;
  backfillCursor?: string;
  /** The newest `occurredAt` seen when a run reached the end of the list; the next run lists from there. */
  watermark?: string;
  failures: number;
  health: "ok" | "failing";
  backfilled: number;
  backfillDone: boolean;
  lastError?: string;
}

/** `SOURCE#` state (R2 store). */
export interface PollStatePort {
  load(workspaceId: string, serverId: string, scope: string): Promise<PollState>;
  save(workspaceId: string, serverId: string, scope: string, state: PollState): Promise<void>;
}

export interface McpPollerDependencies {
  mode: CaptureModePort;
  config: SourceConfigPort;
  recorder: TicketRecorder;
  state: PollStatePort;
  /** Opens a connection to the registered server with its stored credential. Server-owned endpoint and credentials only. */
  connect(source: McpPollSource): Promise<PollConnection>;
  adapters: Readonly<Record<string, McpPollAdapter>>;
  now?: () => number;
  budget?: Partial<PollBudget>;
  log?: TapLog;
}

export interface PollBudget {
  itemsPerRun: number;
  pagesPerRun: number;
  millisPerRun: number;
  pageSize: number;
}

export const DEFAULT_POLL_BUDGET: PollBudget = { itemsPerRun: 500, pagesPerRun: 20, millisPerRun: 120_000, pageSize: 100 };
export const BACKFILL_MAX_DAYS = 180;
export const BACKFILL_MAX_ITEMS = 5_000;
export const POLL_INTERVAL_MS = 15 * 60_000;
export const FAILING_AFTER_RUNS = 3;

/** The delay to the next run: every 15 minutes, jittered by up to 10% either way so sources do not all fire together. */
export function nextPollDelayMs(random: () => number = Math.random): number {
  return Math.round(POLL_INTERVAL_MS * (0.9 + 0.2 * random()));
}

export type ToolCheck = { ok: true } | { ok: false; reason: "not_allow_listed" | "not_listed_by_server" | "annotated_not_read_only" };

/** The one gate in front of every call a poller or sweep makes. */
export function checkReadOnlyTool(source: Pick<McpPollSource, "readOnlyTools">, connection: Pick<PollConnection, "tools">, tool: string): ToolCheck {
  if (!source.readOnlyTools.includes(tool)) return { ok: false, reason: "not_allow_listed" };
  const listed = connection.tools.find((candidate) => candidate.name === tool);
  if (listed === undefined) return { ok: false, reason: "not_listed_by_server" };
  if (listed.annotations?.readOnlyHint === false || listed.annotations?.destructiveHint === true) return { ok: false, reason: "annotated_not_read_only" };
  return { ok: true };
}

export interface PollOutcome {
  status: "skipped" | "ok" | "failed";
  reason?: string;
  fetched: number;
  recorded: number;
  done: boolean;
}

/** One bounded run of one source: `poll` lists changes since the watermark; `backfill` lists history (180 days, 5,000 items at most) in resumable pieces. */
export async function runMcpPoll(deps: McpPollerDependencies, source: McpPollSource, mode: "poll" | "backfill"): Promise<PollOutcome> {
  const now = deps.now ?? Date.now;
  const log: TapLog = deps.log ?? (() => undefined);
  const budget = { ...DEFAULT_POLL_BUDGET, ...deps.budget };
  const started = now();
  const empty = (status: PollOutcome["status"], reason?: string): PollOutcome => ({ status, ...(reason === undefined ? {} : { reason }), fetched: 0, recorded: 0, done: false });
  const config = await gate(deps, { workspaceId: source.workspaceId, ...(source.project === undefined ? {} : { project: source.project }), source: source.source, scope: source.scope });
  if (config === undefined) return empty("skipped", "no_source_row");
  const adapter = deps.adapters[source.adapterId];
  let state = await deps.state.load(source.workspaceId, source.serverId, source.scope);
  if (mode === "backfill" && state.backfillDone) return { ...empty("skipped", "backfill_done"), done: true };
  const fail = async (reason: string): Promise<PollOutcome> => {
    const failures = state.failures + 1;
    state = { ...state, failures, health: failures >= FAILING_AFTER_RUNS ? "failing" : state.health, lastError: reason };
    await deps.state.save(source.workspaceId, source.serverId, source.scope, state).catch(() => undefined);
    log("record.poll_failed", { source: source.source, reason, failures });
    return { ...empty("failed", reason) };
  };
  if (adapter === undefined) return fail("adapter_missing");
  let connection: PollConnection | undefined;
  try {
    connection = await deps.connect(source);
  } catch {
    return fail("connect_failed");
  }
  let fetched = 0;
  let recorded = 0;
  let done = false;
  try {
    const check = checkReadOnlyTool(source, connection, source.listTool);
    if (!check.ok) return await fail(check.reason);
    const floor = new Date(now() - BACKFILL_MAX_DAYS * 86_400_000).toISOString();
    const startIso = new Date(started).toISOString();
    let cursor = mode === "backfill" ? state.backfillCursor : state.pollCursor;
    let newest = state.watermark;
    let backfilled = state.backfilled;
    let pages = 0;
    // A poll with no watermark starts at "now": history is the backfill's job (bounded to 180 days and 5,000 items), never a poll's.
    const since = mode === "backfill" ? floor : (state.watermark ?? startIso);
    for (;;) {
      const remaining = Math.min(budget.itemsPerRun - fetched, mode === "backfill" ? BACKFILL_MAX_ITEMS - backfilled : budget.itemsPerRun);
      if (remaining <= 0 || pages >= budget.pagesPerRun || now() - started > budget.millisPerRun) break;
      const result = await connection.call(source.listTool, adapter.listArgs({ ...(cursor === undefined ? {} : { cursor }), since, limit: Math.min(budget.pageSize, remaining) }));
      pages += 1;
      if (result.isError === true) return await fail("tool_error");
      const page = adapter.parseList(result);
      if (page === undefined) return await fail("unreadable_answer");
      for (const item of page.items.slice(0, remaining)) {
        fetched += 1;
        if (mode === "backfill") backfilled += 1;
        // The history cap: older than 180 days is never recorded, whatever the server returns.
        if (item.occurredAt < floor) continue;
        if (newest === undefined || item.occurredAt > newest) newest = item.occurredAt;
        const outcome = await deps.recorder.record({ workspaceId: source.workspaceId, ...(source.project === undefined ? {} : { project: source.project }) }, item, config);
        if (outcome === "stored" || outcome === "queued") recorded += 1;
      }
      cursor = page.nextCursor;
      if (cursor === undefined) { done = true; break; }
    }
    const next: PollState = { ...state, failures: 0, health: "ok", backfilled, backfillDone: mode === "backfill" ? (done || backfilled >= BACKFILL_MAX_ITEMS) : state.backfillDone };
    delete next.lastError;
    const cursorKey = mode === "backfill" ? "backfillCursor" : "pollCursor";
    if (cursor === undefined) delete next[cursorKey]; else next[cursorKey] = cursor;
    // The list was read to its end: the next poll starts from the newest change seen (or from this run's start when nothing was seen).
    if (done && mode === "poll") next.watermark = newest ?? startIso;
    state = next;
    await deps.state.save(source.workspaceId, source.serverId, source.scope, state);
    return { status: "ok", fetched, recorded, done };
  } catch {
    return await fail("call_failed");
  } finally {
    await connection.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// A mapping-driven adapter: most servers answer a list tool with JSON (structured, or as the text of the first content block).

export interface JsonListMapping {
  /** Dotted path to the array of items in the answer; empty for a bare array. */
  itemsPath: string;
  idField: string;
  kind: TicketItem["kind"];
  titleField?: string;
  bodyField?: string;
  stateField?: string;
  urlField?: string;
  /** The field naming who WROTE the text (creator, reporter, comment author). Trust follows this person; never map "last modified by" here, or an outsider's text is credited to whoever edited it. */
  authorField?: string;
  /** The field naming who last changed the item. Kept as data and can only lower the row's trust. */
  updaterField?: string;
  /** Item field holding the last-change time (ISO text or epoch). Required: an item without one is dropped. */
  updatedField: string;
  parentField?: string;
  /** Item fields that carry the server's own ACL (arrays of ids). */
  aclPrincipalsField?: string;
  aclGroupsField?: string;
  /** Dotted path to the next-page cursor in the answer. */
  cursorPath?: string;
  /** Names of the list tool's arguments. Absent: the argument is not sent. */
  args: { cursor?: string; since?: string; limit?: string; extra?: Record<string, unknown> };
  /** `notFoundText`: lower-case phrases that mean the item is really gone. Plain text, matched as substrings (no patterns). */
  exists: { tool: "same"; idArg: string; notFoundText?: string[] };
  source: TicketItem["source"];
  system: string;
  scope: string;
}

const DEFAULT_NOT_FOUND = ["not found", "not_found", "notfound", "does not exist", "no such", "404"];
const FORBIDDEN_TEXT = ["forbidden", "permission", "unauthorized", "unauthorised", "access denied", "not authorized", "not authorised", "401", "403", "insufficient"];
const pathOf = (value: unknown, path: string): unknown => (path === "" ? value : path.split(".").reduce<unknown>((current, key) => (current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value));

function answerJson(result: PollToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const first = result.content?.find((block) => block.type === "text" && typeof block.text === "string");
  const raw = first?.text;
  if (raw === undefined || raw.length > 2_000_000) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function createJsonListAdapter(mapping: JsonListMapping): McpPollAdapter {
  const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 500) : []);
  return {
    listArgs({ cursor, since, limit }) {
      return {
        ...(mapping.args.extra ?? {}),
        ...(mapping.args.limit === undefined ? {} : { [mapping.args.limit]: limit }),
        ...(mapping.args.since === undefined || since === undefined ? {} : { [mapping.args.since]: since }),
        ...(mapping.args.cursor === undefined || cursor === undefined ? {} : { [mapping.args.cursor]: cursor }),
      };
    },
    parseList(result) {
      const answer = answerJson(result);
      const list = pathOf(answer, mapping.itemsPath);
      if (!Array.isArray(list)) return undefined;
      const items: TicketItem[] = [];
      for (const raw of list.slice(0, 1000)) {
        if (raw === null || typeof raw !== "object") continue;
        const record = raw as Record<string, unknown>;
        const idValue = record[mapping.idField];
        const id = typeof idValue === "string" || typeof idValue === "number" ? String(idValue).slice(0, 200) : undefined;
        const updated = isoOrUndefined(record[mapping.updatedField]);
        if (id === undefined || updated === undefined) continue;
        const field = (name: string | undefined): string | undefined => {
          const value = name === undefined ? undefined : record[name];
          return typeof value === "string" && value !== "" ? value : undefined;
        };
        const principals = mapping.aclPrincipalsField === undefined ? [] : ids(record[mapping.aclPrincipalsField]);
        const groups = mapping.aclGroupsField === undefined ? [] : ids(record[mapping.aclGroupsField]);
        const title = field(mapping.titleField);
        const body = field(mapping.bodyField);
        const state = field(mapping.stateField);
        const url = field(mapping.urlField);
        const author = field(mapping.authorField);
        const updater = field(mapping.updaterField);
        const parent = field(mapping.parentField);
        items.push({
          source: mapping.source, system: mapping.system, id, kind: mapping.kind, scope: mapping.scope, occurredAt: updated, version: `u:${updated}`,
          ...(title === undefined ? {} : { title: title.slice(0, 500) }), ...(body === undefined ? {} : { body: body.slice(0, 70_000) }), ...(state === undefined ? {} : { state: state.slice(0, 100) }),
          ...(url === undefined ? {} : { url }), ...(author === undefined ? {} : { authorId: author.slice(0, 200) }), ...(updater === undefined ? {} : { updaterId: updater.slice(0, 200) }), nativeId: id, ...(mapping.kind === "ticket.updated" ? { edit: true } : {}), ...(parent === undefined ? {} : { parentId: parent.slice(0, 200) }),
          ...(principals.length > 0 || groups.length > 0 ? { acl: { principals, groups, strict: true } } : {}),
        });
      }
      const next = mapping.cursorPath === undefined ? undefined : pathOf(answer, mapping.cursorPath);
      return { items, ...(typeof next === "string" && next !== "" ? { nextCursor: next.slice(0, 500) } : {}) };
    },
    existsArgs: (id) => ({ ...(mapping.args.extra ?? {}), [mapping.exists.idArg]: id }),
    classifyExists(result) {
      if (result.isError !== true) return answerJson(result) === undefined && (result.content ?? []).length === 0 ? "unknown" : "exists";
      const message = (result.content ?? []).map((block) => block.text ?? "").join(" ").slice(0, 2000).toLowerCase();
      // A refusal is checked first: "403 not found for this user" is the server hiding the item, not the item being gone.
      if (FORBIDDEN_TEXT.some((phrase) => message.includes(phrase))) return "forbidden";
      const phrases = (mapping.exists.notFoundText ?? DEFAULT_NOT_FOUND).slice(0, 20).map((phrase) => phrase.toLowerCase());
      return phrases.some((phrase) => phrase !== "" && message.includes(phrase)) ? "missing" : "unknown";
    },
  };
}

