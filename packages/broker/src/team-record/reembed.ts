// The re-embed job (reviews H1, M3, R2 and R3 of lane self-hosted-embeddings): gives a vector to every row that should have one and does not.
//
// Which rows: rows that still hold their raw text (the sparse text-due index, `gsi5`: the same index the text-expiry job reads, soonest-to-expire first) and either
//   - are marked `embedPending` (the embedder could not be reached when they were written, or the vector could not be put), or
//   - have a vector (`embeddingRef`) that was not made with the current embedding spec (`embeddingSpec` missing or different): the Titan-era vectors, and those of any later model change.
// A row whose raw text has expired (30 days, text-expiry.ts) keeps no text to embed. It stays without a vector and is found by keyword only (and by its structured fields): that is the
// documented limit of changing the model, not a failure.
//
// EVERY ROW IS REACHED (R2). The filter is applied after DynamoDB reads each page of the index, so a run that always started at the first row would read the same rows over and over once the
// oldest ones are current. Instead each workspace keeps a CURSOR (the index's own LastEvaluatedKey, in a small state row of the org directory partition: `REEMBED#<org>`): a run continues where
// the last one stopped, and when it reaches the end it starts the next pass from the beginning. A pass over a workspace with no work at all marks it idle for an hour, so a quiet
// workspace costs one read of its state per run and a full pass only once an hour. The cursor moves past a page only when every row of it was handled, so a stopped run repeats at most one page.
//
// FAIR BETWEEN WORKSPACES (R2). A run serves the workspaces in the order of the time each was last served (never served first): each gets a share of what is left of the run
// (`remaining / workspaces still to serve`, at least `MIN_SHARE_MS`) to START calls in, and a workspace that had its turn goes to the back. One workspace with a large backlog therefore
// cannot hold every run.
//
// ONE DEADLINE FOR THE RUN (R3). The scheduled invoke must end inside the broker's 30 s. `ReembedRun.deadline` is an absolute time for the whole run, all workspaces together, measured from the
// start of the job. A call is started only if its whole wait fits before the deadline (the first call of a run, which may be a cold start, needs `callMs`; later ones, the function being warm,
// `warmCallMs`), and each call is handed the deadline, so the client's wait is cut to what is left: nothing in the run outlives it, whatever the function does.
//
// A CURSOR HAS A SHELF LIFE (N1). The index is read for rows due AFTER now, so a stored cursor whose own due time has passed lies outside the query's range and DynamoDB refuses it
// (ValidationException: the start key is outside the query boundaries). Such a cursor is dropped before the first query (the pass starts again), and a refusal that still comes is answered the same way:
// the workspace's state is reset and the turn goes on from the beginning. Without this the workspace would fail the same way in every later run and never be served again.
//
// NOT FOR A WORKSPACE THAT IS CLOSING (N5). `reembedRun` skips a workspace with a whole-workspace erase job or a close in progress (it must not write vectors or state that the erase would then leave behind);
// the hourly job deletes leftover `REEMBED#` rows (`sweepReembedState`).
//
// Quiet: two failures in a row stop the run (the embedder is down or cold: the next run tries again). It never logs text or an error message, only counts.
// Order of writes per row: embed, put the vector, mark the row. A row that was erased or lost its text meanwhile refuses the mark (condition on the text and on no tombstone), and the vector
// just put is deleted again, so a vector never outlives its row because of this job.
import { GetCommand, PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, TEAM_RECORD_GSI5, TEAM_RECORD_ORG_DIRECTORY_PK, recordTextDueIndexValue, type OrgId } from "@agentx/contracts";
import { errorName, type Item } from "../agents/table-writes.js";
import { embedWithFlag, eventVectorItem, eventVectorKey, markRowEmbedded } from "./ingest.js";
import { eventFromItem } from "./store.js";
import type { RecordEmbedder, RecordLog, RecordVectorPort, TeamRecordTable } from "./types.js";

export interface ReembedDependencies {
  table: TeamRecordTable;
  embedder: RecordEmbedder & { readonly spec: string };
  vectors: RecordVectorPort;
  now?: (() => number) | undefined;
  log?: RecordLog | undefined;
}

/** One workspace's turn. */
export interface ReembedBudget {
  /** The most rows embedded in one turn. */
  maxRows: number;
  /** The most entries of the text-due index read in one turn (the filter is applied after the read, so rows that need nothing still cost a read). */
  maxScanned: number;
  /** The longest the FIRST call of a run can take (the client's wait: it may be a cold start). It is started only when this much of the run is left. */
  callMs: number;
  /** What a later call needs left in the run: the function is warm by then, and a call takes a second or two. A long text can take longer; a call cut at the deadline leaves the data consistent. */
  warmCallMs: number;
  /** No call is started after this (absolute time; the workspace's share of the run). Absent: the run's deadline. */
  turnEnd?: number | undefined;
}

/** The state shared by every workspace's turn in one run. */
export interface ReembedRun {
  /** The end of the whole run (absolute time). Nothing waits past it. */
  deadline: number;
  /** True once a call of this run was answered: the function is loaded, so a later call needs only `warmCallMs`. */
  warm: boolean;
  /** Failed calls since the last good one, over all workspaces: two stop the run. */
  failuresInARow: number;
}

export const DEFAULT_REEMBED_BUDGET: ReembedBudget = { maxRows: 100, maxScanned: 1_000, callMs: 20_000, warmCallMs: 8_000 };
/**
 * The whole run's time, measured from the start of the job. The broker's timeout is 30 s: this leaves the rest for what happens after the last call (the vector put, the row's mark, the
 * cursor) and for the answer. The first call of a run must start within `REEMBED_RUN_MS - callMs` of the job's start, which is more than the listing, the session and the index checks take.
 */
export const REEMBED_RUN_MS = 25_000;
/** The least a workspace gets of the run to start calls in. */
export const MIN_SHARE_MS = 3_000;
/** A workspace whose whole pass found nothing to do is not read again for this long. */
export const REEMBED_IDLE_MS = 60 * 60_000;
const MAX_ORGS = 5_000;

export interface ReembedResult {
  embedded: number;
  /** Calls the embedder or the index refused. */
  failed: number;
  /** Rows that were erased or lost their text while their vector was being made (the vector was removed again). */
  skipped: number;
  scanned: number;
  /** True when a budget ended the turn with rows left, or the embedder stopped it: the next run continues. */
  more: boolean;
}

// ---- the per-workspace state (cursor, last turn, idle)

export interface ReembedState {
  /** Where the next turn resumes in the workspace's text-due index (its LastEvaluatedKey); absent: from the beginning. */
  cursor?: Record<string, unknown> | undefined;
  /** When the workspace last had a turn (ms); 0 = never. The least recently served goes first. */
  servedAt: number;
  /** Not read again before this time (ms); 0 = not idle. */
  idleUntil: number;
  /** Rows embedded, failed or skipped so far in the pass in progress. */
  passWork: number;
}

export const reembedStateKey = (orgId: OrgId): { pk: string; sk: string } => ({ pk: TEAM_RECORD_ORG_DIRECTORY_PK, sk: `REEMBED#${orgId}` });
const FRESH: ReembedState = { servedAt: 0, idleUntil: 0, passWork: 0 };

/** The stored cursor, only if it is a key of THIS workspace's text-due index; anything else is dropped (the pass starts again). */
function cursorOf(value: unknown, orgId: OrgId): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const key = value as Record<string, unknown>;
  if (typeof key.pk !== "string" || typeof key.sk !== "string" || key[TEAM_RECORD_GSI5.partition] !== recordTextDueIndexValue(orgId) || typeof key[TEAM_RECORD_GSI5.sort] !== "string") return undefined;
  return { pk: key.pk, sk: key.sk, [TEAM_RECORD_GSI5.partition]: key[TEAM_RECORD_GSI5.partition], [TEAM_RECORD_GSI5.sort]: key[TEAM_RECORD_GSI5.sort] };
}
const numberOr0 = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
function stateFrom(item: Item | undefined, orgId: OrgId): ReembedState {
  if (item === undefined) return { ...FRESH };
  const cursor = cursorOf(item.cursor, orgId);
  return { ...(cursor === undefined ? {} : { cursor }), servedAt: numberOr0(item.servedAt), idleUntil: numberOr0(item.idleUntil), passWork: numberOr0(item.passWork) };
}

/** Every workspace's state, by workspace. A workspace without a row has never been served. */
export async function readReembedStates(table: TeamRecordTable): Promise<Map<OrgId, ReembedState>> {
  const states = new Map<OrgId, ReembedState>();
  let after: Record<string, unknown> | undefined;
  do {
    const page = (await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": TEAM_RECORD_ORG_DIRECTORY_PK, ":prefix": "REEMBED#" }, ...(after === undefined ? {} : { ExclusiveStartKey: after }),
    }))) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = OrgIdSchema.safeParse(typeof item.sk === "string" ? item.sk.slice("REEMBED#".length) : undefined);
      if (parsed.success) states.set(parsed.data, stateFrom(item, parsed.data));
    }
    after = page.LastEvaluatedKey;
  } while (after !== undefined);
  return states;
}

async function readState(table: TeamRecordTable, orgId: OrgId): Promise<ReembedState> {
  const read = (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: reembedStateKey(orgId), ConsistentRead: true }))) as { Item?: Item };
  return stateFrom(read.Item, orgId);
}

async function saveState(table: TeamRecordTable, orgId: OrgId, state: ReembedState): Promise<void> {
  // A plain put: two overlapping runs (one overran the 15 minutes) can only repeat a page, never skip one that was not handled.
  await table.documentClient.send(new PutCommand({
    TableName: table.tableName,
    Item: { ...reembedStateKey(orgId), entityType: "TEAM_RECORD_REEMBED_STATE", orgId, servedAt: state.servedAt, idleUntil: state.idleUntil, passWork: state.passWork, ...(state.cursor === undefined ? {} : { cursor: state.cursor }) },
  }));
}

/** Removes a workspace's state with its directory entry (the workspace's record was erased). */
export async function dropReembedState(table: TeamRecordTable, orgId: OrgId): Promise<void> {
  await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: reembedStateKey(orgId) }));
}

/** Rows that need a vector: pending, or with a vector of another spec. Evaluated by DynamoDB after it reads each page of the index. */
function filterFor(spec: string): { FilterExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown> } {
  return {
    FilterExpression: "attribute_not_exists(#tombstone) AND (#pending = :yes OR (attribute_exists(#ref) AND (attribute_not_exists(#spec) OR #spec <> :spec)))",
    ExpressionAttributeNames: { "#tombstone": "tombstone", "#pending": "embedPending", "#ref": "embeddingRef", "#spec": "embeddingSpec" },
    ExpressionAttributeValues: { ":yes": true, ":spec": spec },
  };
}

/** One workspace's turn: continues its pass from the stored cursor, embeds what needs a vector within the budget, and stores where it stopped. */
export async function reembedRows(deps: ReembedDependencies, orgId: OrgId, budget: ReembedBudget = DEFAULT_REEMBED_BUDGET, sharedRun?: ReembedRun): Promise<ReembedResult> {
  const now = deps.now ?? Date.now;
  const run: ReembedRun = sharedRun ?? { deadline: now() + REEMBED_RUN_MS, warm: false, failuresInARow: 0 };
  const turnEnd = Math.min(budget.turnEnd ?? run.deadline, run.deadline);
  const result: ReembedResult = { embedded: 0, failed: 0, skipped: 0, scanned: 0, more: false };
  const { spec } = deps.embedder;
  let state: ReembedState;
  try {
    state = await readState(deps.table, orgId);
  } catch {
    // Without the cursor the pass starts at the beginning: still correct, only slower to reach the far rows.
    deps.log?.("record.reembed_state_unreadable", {});
    state = { ...FRESH };
  }
  // N1: a cursor whose due time has passed is outside the range of this turn's query (`textDueAt > now`): start the pass again.
  if (state.cursor !== undefined && String(state.cursor[TEAM_RECORD_GSI5.sort]) <= new Date(now()).toISOString()) state = { servedAt: state.servedAt, idleUntil: state.idleUntil, passWork: 0 };
  /** Where the next turn resumes: the start of the page being handled, moved forward only when every row of the page was handled. */
  let resumeAt = state.cursor;
  let completedPass = false;
  /** True once this turn started an embedder call: a turn that started none (no time left in the run for one) was not a turn, and the workspace keeps its place in the order (N4). */
  let calledEmbedder = false;
  const finish = async (): Promise<ReembedResult> => {
    const work = state.passWork + result.embedded + result.failed + result.skipped;
    const next: ReembedState = completedPass
      // The pass reached the end: the next one starts at the beginning, and a pass that found nothing to do at all lets the workspace rest for an hour.
      ? { servedAt: calledEmbedder ? now() : state.servedAt, idleUntil: work === 0 ? now() + REEMBED_IDLE_MS : 0, passWork: 0 }
      : { ...(resumeAt === undefined ? {} : { cursor: resumeAt }), servedAt: calledEmbedder ? now() : state.servedAt, idleUntil: 0, passWork: work };
    try {
      await saveState(deps.table, orgId, next);
    } catch {
      deps.log?.("record.reembed_state_unsaved", {});
    }
    if (result.embedded > 0 || result.failed > 0) deps.log?.("record.reembed", { embedded: result.embedded, failed: result.failed, skipped: result.skipped });
    return result;
  };

  for (;;) {
    if (result.scanned >= budget.maxScanned || now() >= turnEnd) { result.more = true; return finish(); }
    const filter = filterFor(spec);
    let page: { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown>; ScannedCount?: number };
    try {
      page = await deps.table.documentClient.send(new QueryCommand({
        TableName: deps.table.tableName,
        IndexName: TEAM_RECORD_GSI5.index,
        // Rows still holding text that is not yet due: the due ones are the text-expiry job's.
        KeyConditionExpression: `${TEAM_RECORD_GSI5.partition} = :pk AND ${TEAM_RECORD_GSI5.sort} > :now`,
        FilterExpression: filter.FilterExpression,
        ExpressionAttributeNames: filter.ExpressionAttributeNames,
        ExpressionAttributeValues: { ...filter.ExpressionAttributeValues, ":pk": recordTextDueIndexValue(orgId), ":now": new Date(now()).toISOString() },
        Limit: 100,
        ...(resumeAt === undefined ? {} : { ExclusiveStartKey: resumeAt }),
      })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown>; ScannedCount?: number };
    } catch (error) {
      // N1: the start key is refused (its time passed during the turn): reset this workspace's state and go on from the beginning. Only a query that HAD a start key is retried, once per reset.
      if (errorName(error) !== "ValidationException" || resumeAt === undefined) throw error;
      deps.log?.("record.reembed_cursor_reset", {});
      state = { servedAt: state.servedAt, idleUntil: 0, passWork: 0 };
      resumeAt = undefined;
      continue;
    }
    result.scanned += page.ScannedCount ?? (page.Items ?? []).length;
    for (const item of page.Items ?? []) {
      const needed = run.warm ? budget.warmCallMs : budget.callMs;
      // A call starts only if its whole wait fits in the run (and in this workspace's share of it); the rest of the page stays for the next turn.
      if (result.embedded >= budget.maxRows || now() >= turnEnd || now() + needed > run.deadline) { result.more = true; return finish(); }
      const event = eventFromItem(item, Math.floor(now() / 1000));
      if (event === undefined || event.text === undefined) continue;
      try {
        calledEmbedder = true;
        const { vector, truncated } = await embedWithFlag(deps.embedder, event.text, { deadline: run.deadline });
        run.warm = true;
        const put = await deps.vectors.put([eventVectorItem(event, vector)]);
        if (put.failed.length > 0) throw new Error("vector not put");
        try {
          await markRowEmbedded(deps.table, event, { spec, truncated, onlyWithText: true });
        } catch (error) {
          if (errorName(error) !== "ConditionalCheckFailedException") throw error;
          // The row is gone, hidden or without text: the vector must not outlive it.
          const key = eventVectorKey(event.id);
          const removed = await deps.vectors.delete([key]).then((response) => response.failed.length === 0, () => false);
          if (!removed) deps.log?.("record.reembed_vector_left", {});
          result.skipped += 1;
          continue;
        }
        if (truncated) deps.log?.("record.embed_truncated", { kind: event.kind });
        result.embedded += 1;
        run.failuresInARow = 0;
      } catch {
        // No message: an embedding error can echo the text. Two failures in a row (over all workspaces) mean the embedder (or the index) is not answering: stop and let the next run try.
        result.failed += 1;
        run.failuresInARow += 1;
        if (run.failuresInARow >= 2) { result.more = true; deps.log?.("record.reembed_stopped", { failed: result.failed }); return finish(); }
      }
    }
    // Every row of this page was handled: the next turn starts after it.
    resumeAt = cursorOf(page.LastEvaluatedKey, orgId);
    if (page.LastEvaluatedKey === undefined) { completedPass = true; break; }
    if (resumeAt === undefined) { completedPass = true; break; }
  }
  return finish();
}

// ---- a whole run: every workspace, in turn

export interface ReembedRunDependencies {
  table: TeamRecordTable;
  embedder: RecordEmbedder & { readonly spec: string };
  /** The workspace's vector index, or undefined where it cannot be opened (that workspace is skipped this run). */
  vectorsFor(orgId: OrgId): Promise<RecordVectorPort | undefined>;
  /** True while the workspace is closing or closed (N5): it is skipped. Absent: no such check. A failure of the check skips the workspace this run. */
  isClosing?(orgId: OrgId): Promise<boolean>;
  now?: (() => number) | undefined;
  log?: RecordLog | undefined;
}

export interface ReembedRunSummary { orgs: number; skippedOrgs: number; details: Record<string, number> }

/** The workspaces in the org directory (those that have written to the record). */
export async function listDirectoryOrgs(table: TeamRecordTable): Promise<OrgId[]> {
  const orgs: OrgId[] = [];
  let after: Record<string, unknown> | undefined;
  do {
    const page = (await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": TEAM_RECORD_ORG_DIRECTORY_PK }, ConsistentRead: true, Limit: 50,
      ...(after === undefined ? {} : { ExclusiveStartKey: after }),
    }))) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const parsed = OrgIdSchema.safeParse(item.sk);
      if (parsed.success) orgs.push(parsed.data);
    }
    after = page.LastEvaluatedKey;
  } while (after !== undefined && orgs.length < MAX_ORGS);
  return orgs;
}

/** Workspaces with a whole-workspace erase job in the org directory (`ERASE#<org>#workspace#all`): being erased, so not served (N5). */
export async function listErasingOrgs(table: TeamRecordTable): Promise<Set<OrgId>> {
  const erasing = new Set<OrgId>();
  let after: Record<string, unknown> | undefined;
  do {
    const page = (await table.documentClient.send(new QueryCommand({
      TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": TEAM_RECORD_ORG_DIRECTORY_PK, ":prefix": "ERASE#" }, ...(after === undefined ? {} : { ExclusiveStartKey: after }),
    }))) as { Items?: Array<{ sk?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const [, org, kind] = typeof item.sk === "string" ? item.sk.split("#") : [];
      const parsed = OrgIdSchema.safeParse(org);
      if (parsed.success && kind === "workspace") erasing.add(parsed.data);
    }
    after = page.LastEvaluatedKey;
  } while (after !== undefined);
  return erasing;
}

/**
 * The hourly clean-up (N5): deletes the `REEMBED#` state of every workspace that has left the org directory (its erase finished while a re-embed run was still holding its state) and of every one that is
 * closing or closed (it is not served, so the row is only left over). Returns how many were deleted.
 */
export async function sweepReembedState(table: TeamRecordTable, isClosing?: (orgId: OrgId) => Promise<boolean>): Promise<number> {
  const [directory, states] = await Promise.all([listDirectoryOrgs(table), readReembedStates(table)]);
  const listed = new Set(directory);
  let deleted = 0;
  for (const orgId of states.keys()) {
    if (listed.has(orgId) && !(await isClosing?.(orgId))) continue;
    await dropReembedState(table, orgId);
    deleted += 1;
  }
  return deleted;
}

/**
 * One scheduled run over all workspaces, inside ONE deadline (`REEMBED_RUN_MS` from `started`, the job's start). The least recently served workspace goes first; each gets a share of what is left.
 * The caller's listing, sessions and index checks count against the deadline because it is measured from the job's start.
 */
export async function reembedRun(deps: ReembedRunDependencies, started: number, budget: ReembedBudget = DEFAULT_REEMBED_BUDGET, runMs: number = REEMBED_RUN_MS): Promise<ReembedRunSummary> {
  const now = deps.now ?? Date.now;
  const summary: ReembedRunSummary = { orgs: 0, skippedOrgs: 0, details: { embedded: 0, failed: 0, skipped: 0, more: 0 } };
  const add = (key: string, value: number): void => { summary.details[key] = (summary.details[key] ?? 0) + value; };
  const [listedOrgs, states, erasing] = await Promise.all([listDirectoryOrgs(deps.table), readReembedStates(deps.table).catch(() => new Map<OrgId, ReembedState>()), listErasingOrgs(deps.table)]);
  // N5: a workspace being erased is not served (a vector or a state row written now would outlive the erase).
  const orgs = listedOrgs.filter((orgId) => !erasing.has(orgId));
  if (orgs.length < listedOrgs.length) summary.details.closing = listedOrgs.length - orgs.length;
  const due = orgs
    .filter((orgId) => (states.get(orgId)?.idleUntil ?? 0) <= now())
    .sort((left, right) => (states.get(left)?.servedAt ?? 0) - (states.get(right)?.servedAt ?? 0) || (left < right ? -1 : 1));
  const idle = orgs.length - due.length;
  if (idle > 0) summary.details.idle = idle;
  const run: ReembedRun = { deadline: started + runMs, warm: false, failuresInARow: 0 };
  let left = due.length;
  for (const orgId of due) {
    const remaining = run.deadline - now();
    if (remaining < 1_000 || run.failuresInARow >= 2) { summary.skippedOrgs += left; break; }
    const share = Math.max(MIN_SHARE_MS, remaining / left);
    left -= 1;
    try {
      if (await deps.isClosing?.(orgId)) { add("closing", 1); summary.skippedOrgs += 1; continue; }
      const vectors = await deps.vectorsFor(orgId);
      if (vectors === undefined) { add("unavailable", 1); summary.skippedOrgs += 1; continue; }
      const done = await reembedRows({ table: deps.table, embedder: deps.embedder, vectors, now, log: deps.log }, orgId, { ...budget, turnEnd: now() + share }, run);
      add("embedded", done.embedded);
      add("failed", done.failed);
      add("skipped", done.skipped);
      add("more", done.more ? 1 : 0);
      summary.orgs += 1;
    } catch {
      // One workspace's failure never stops the others; a fixed line, no text.
      add("orgFailures", 1);
      deps.log?.("record.job_org_failed", {});
    }
  }
  return summary;
}
