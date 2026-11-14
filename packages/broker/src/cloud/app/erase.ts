// Convergence S0 follow-up: erasing a removed person's evidence for the tasks the core ran.
//
// Cloud erases a person's evidence with `createEvidenceErase(...).person` (rovara-code/evidence-erase.ts), which reads Cloud's own task records. Code's core has no
// walk by person by design (vendor core/proof/evidence-erase.ts, decision 41): it erases per task (`eraseTaskEvidence`) on the object-storage point. After the
// combined switch a person's core-stamped tasks keep their evidence in the core's layout, so the removal of a person needs this walk as well:
//   the person's task index (`DEVELOPER#<id>` / `TASK#...`) -> for each core task, its owner key and workspace -> the per-task erase.
//
// Rules held here:
//  - It does NOT depend on the switch or on the registry. A task keeps its engine after the switch is turned off, so a removed person's core tasks can exist
//    whether or not any switch is on; the walk takes the two ports it needs (the State table's store and the artifact bucket's object storage) and runs on every
//    person erase. With no core task it reads the person's index, the stamps and the records of the tasks a stamp does not name as Cloud's, and deletes nothing.
//  - What is a core task: the task's engine stamp says `core`; or it has NO stamp and its record names the company as `companyId` with no `orgId` (the shape of the
//    core's start, vendor core task-flow/start.ts; Cloud's records name `orgId`). The second rule is for a record whose stamp is missing, so no gap in the start path
//    can leave evidence behind. A stamp that says `cloud` is Cloud's whatever the record looks like.
//  - Cloud's own walk cannot do this work: it keeps a task only when the task record's `orgId` equals the company, and a core task record carries `companyId` only,
//    and it stops at once for a company with no `EVIDENCE_STORED#<org>` marker, which nothing on the core path writes.
//  - Same rule as Cloud's walk for whose tasks: every task in the person's index (`DEVELOPER#<id>`), which holds the tasks they created, own, or took over.
//  - A Cloud task is left to Cloud's own erase; another company's task and another person's task are never read for erasure.
//  - Owed from the first moment. A PENDING item (`CORE_EVIDENCE_ERASE_PENDING`, written with `attribute_not_exists`, so a saved cursor is never overwritten) is put FIRST: by
//    `beginCoreEvidenceErase`, the first thing the person-erasure step does, before the Team record's erase and Cloud's walk (any of which may fail or run the Lambda out of time),
//    and again by the walk itself. From then on `resumeCoreEvidenceErase` (the every-minute run, wired in aws/broker/handler.ts) finishes the walk whatever happens to the request.
//  - Bounded and resumable. The reads are batched (`getMany`, one page of the index at a time), the prefix deletes run a few at a time, and the walk stops at its deadline: the
//    smaller of its own budget and what is left of the Lambda's time minus a margin (`noteRequestEnd`, set by the handler), checked before every page, every batch, every prefix and
//    between the delete rounds of one prefix. The pending item holds two things: the last index sort key the walk has gone past (`cursor`; the query is bounded on both sides, after
//    the cursor and inside `TASK#`) and the index rows of the tasks whose erase failed (`retry`, at most `CORE_ERASE_RETRY_MAX`). A failing task does not hold the cursor: it is kept
//    in `retry` and tried again on every later run, after the main walk, so a task that fails for good never keeps the person's later evidence. Once the cursor has reached the end of
//    the index (`scanned`), a run only retries. A walk that has gone through the whole index with `retry` empty deletes its pending item; one that stopped early, or has a task left in
//    `retry`, or met a fault, is NEVER reported complete.
//  - Fair in the every-minute run (`resumeCoreEvidenceErase`): the walks are taken in the order they were last tried (`triedAt`, oldest first; never tried first), each gets a fixed
//    small share (`CORE_ERASE_RESUME_SHARE_MS`), and a walk with only failing tasks left that was tried in the last `CORE_ERASE_RETRY_GAP_MS` waits, so stuck walks cannot starve
//    another person's erase.
//  - Beyond that, the walk writes nothing, and the per-task erase is a prefix delete, so a second run changes nothing. It reports counts, never names or ids.
//  - A task whose id is not a plain id is REFUSED (counted apart, logged as counts): it can never be erased, so it must not hold the request open. A core task whose
//    record is missing (deleted) is counted `missingRecord` and logged: there is nothing left to say where its evidence is. A record the store could not READ is not missing: it
//    counts as incomplete, so the walk is never reported complete with evidence possibly left.
//  - The per-task erase is the core's: the same two prefixes under the task's workspace (`evidence-pack/<task>/` and `evidence/<task>/`), from `evidencePrefixesOf`,
//    which Code and Cloud both hold until the deletion lane deletes Cloud's copy. Code's `core/proof` has no index file, so `@rovara-code/broker` does not export
//    its `eraseTaskEvidence`; tests/unit/cloud-app-erase.test.ts holds the two copies to the same prefixes.
import { DynamoDocumentStore } from "@rovara-code/aws-adapters";
import { type S3ObjectClient } from "@rovara-code/aws-adapters/s3";
import { when, type DocumentKey, type DocumentStore, type StoredDocument } from "@rovara-code/contracts";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { taskKey } from "../../developer/task-records.js";
import { evidencePrefixesOf } from "../../rovara-code/evidence-erase.js";
import { engineStampKey, stampOf } from "./engine-stamp.js";

/** What one walk found, as counts only. */
export interface PersonEraseOnCoreReport {
  /** Rows of the person's task index that were read. */
  tasks: number;
  /** Tasks whose evidence was erased (nothing of it is left). */
  erased: number;
  /** Tasks that are Cloud's (stamp `cloud`, or no stamp and a Cloud-shaped record): left to Cloud's own erase. */
  cloudStamped: number;
  /** Rows that name no task, a task of another company, or a task with no owner key or workspace: nothing was erased for them. */
  skipped: number;
  /** Core tasks whose record is missing (deleted): nothing says where their evidence is. */
  missingRecord: number;
  /** Core tasks whose ids are not plain ids (an owner key, workspace or task id that cannot name a prefix): never erasable, so they do not hold the request open. */
  refused: number;
  /** Core tasks whose erase did not finish or failed: the walk must be repeated. */
  incomplete: number;
  /** True only when the whole index was walked and nothing is incomplete. False: the deadline passed or a task did not finish; the saved cursor moves the next run forward. */
  complete: boolean;
}

export const EMPTY_PERSON_ERASE_REPORT: PersonEraseOnCoreReport = Object.freeze({ tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, missingRecord: 0, refused: 0, incomplete: 0, complete: true });


/** What one prefix's delete answered: true when nothing is left under it, false when it could not finish (rounds used up), `out_of_time` when the deadline came between its rounds. */
export type PrefixDeleteOutcome = boolean | "out_of_time";

/** The ports the walk needs. Not the registry: the walk must run whether or not a switch is on. */
export interface CoreErasePorts {
  /** The State table's store: reads, and the one pending item of an unfinished walk. */
  store: Pick<DocumentStore, "get" | "getMany" | "query" | "put" | "delete">;
  /**
   * The artifact bucket's objects (the evidence). `deletePrefix` is the object storage's (true when none is left), with one addition: given `stopAt` (epoch ms) it stops between its
   * rounds once that time has passed and answers `out_of_time`. An object storage without it (the folder one in tests) still fits: it runs its rounds.
   */
  objects: { deletePrefix(prefix: string, stopAt?: number): Promise<PrefixDeleteOutcome> };
  /** One line per walk that refused or skipped something, and per item the store could not read; counts only. */
  log?: (entry: Record<string, unknown>) => void;
  /** The clock (milliseconds). Default `Date.now`. */
  now?: () => number;
  /** How many items the store has reported as unreadable so far (a record it cannot represent is left out of a read, which looks like a missing one). */
  unreadable?: () => number;
}

/** Rounds of one prefix's delete (a list of up to 1,000 keys and one batch delete each), as the vendored object storage. */
const DELETE_ROUNDS = 100;

/**
 * The artifact bucket's prefix delete, as the vendored S3 object storage does it (list up to 1,000 keys under the prefix, delete them in one batch, until none is left), with two rules
 * added: the deadline is checked between rounds (the first round always runs), and a batch delete that reports per-key errors is a failure, not a round to repeat. The fault's text is
 * never kept (it may carry a key).
 */
function bucketPrefixDelete(client: S3ObjectClient, bucket: string, now: () => number): CoreErasePorts["objects"] {
  return {
    async deletePrefix(prefix, stopAt) {
      if (prefix === "") throw new Error("a prefix delete names a prefix");
      for (let round = 0; round < DELETE_ROUNDS; round += 1) {
        if (round > 0 && stopAt !== undefined && now() >= stopAt) return "out_of_time";
        let listed: { Contents?: Array<{ Key?: string }> } | undefined;
        try {
          listed = (await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1_000 }))) as typeof listed;
        } catch { throw new Error("the bucket could not list the evidence to delete"); }
        const keys = (listed?.Contents ?? []).map((item) => item.Key).filter((key): key is string => typeof key === "string" && key.startsWith(prefix));
        if (keys.length === 0) return true;
        let answer: { Errors?: unknown[] } | undefined;
        try {
          answer = (await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true } }))) as typeof answer;
        } catch { throw new Error("the bucket could not delete the evidence"); }
        if ((answer?.Errors?.length ?? 0) > 0) throw new Error("the bucket reported errors deleting evidence");
      }
      return false;
    },
  };
}

/**
 * The ports over the broker's own clients: the State table through the vendored DynamoDB store (base-table reads, plus the one pending item) and the artifact bucket through the
 * prefix delete above (the keys are unchanged, no prefix is added). The table has no time-to-live here: the walk reads items, it does not write any that expire. The store's report of an
 * item it cannot read names the key (a person and a task), so it is replaced by a line that names nothing.
 */
export function coreErasePortsOf(input: { dynamo: ConstructorParameters<typeof DynamoDocumentStore>[0]["client"]; tableName: string; s3: S3ObjectClient; bucket: string; log?: CoreErasePorts["log"]; now?: () => number }): CoreErasePorts {
  let unreadable = 0;
  return {
    store: new DynamoDocumentStore({ client: input.dynamo, tableName: input.tableName, onUnreadable: () => { unreadable += 1; input.log?.({ component: "broker", event: "core_person_erase.unreadable_item" }); } }),
    objects: bucketPrefixDelete(input.s3, input.bucket, input.now ?? Date.now),
    unreadable: () => unreadable,
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
}

export const CORE_ERASE_PENDING_PK = "CORE_EVIDENCE_ERASE_PENDING";
const pendingKey = (companyId: string, developerId: string): DocumentKey => ({ pk: CORE_ERASE_PENDING_PK, sk: `${companyId}|${developerId}` });

/** Where an unfinished walk stands: the index sort key it has gone past, the index rows of the tasks that failed, whether the cursor reached the end, and when it was last tried. */
interface WalkState { cursor?: string; retry: string[]; scanned: boolean }
const pendingItem = (companyId: string, developerId: string, state?: WalkState, triedAt?: number): StoredDocument => ({
  ...pendingKey(companyId, developerId), entityType: "CORE_EVIDENCE_ERASE_PENDING", companyId, developerId,
  ...(state?.cursor === undefined ? {} : { cursor: state.cursor }),
  ...(state === undefined || state.retry.length === 0 ? {} : { retry: [...state.retry] }),
  ...(state?.scanned === true ? { scanned: true } : {}),
  ...(triedAt === undefined ? {} : { triedAt }),
});

/** Index rows read, and stamps or records fetched, at a time (the store's `getMany` takes at most 100 keys). */
const PAGE = 100;
/** Tasks whose prefixes are deleted at the same time. */
const PARALLEL = 10;
/** Failing tasks kept in one pending item to be tried again. With this many, the main walk stops before the next failure (the item stays small); the retries go on. */
export const CORE_ERASE_RETRY_MAX = 100;
/** What a person's erase gives the walk at most; the request's remaining time (below) can make it less. A repeat or the resume goes on from the cursor. */
export const CORE_ERASE_BUDGET_MS = 4_000;
/** What the every-minute run gives the unfinished walks (its own share, next to Cloud's 3 s). */
export const CORE_ERASE_RESUME_BUDGET_MS = 2_000;
/** What one walk gets of the every-minute run at most, so a few people are served each minute whatever their walks hold. */
export const CORE_ERASE_RESUME_SHARE_MS = 500;
/** Below this much time left, the every-minute run starts no other walk. */
const RESUME_MIN_MS = 250;
/** A walk with only failing tasks left waits this long after a try before the every-minute run tries it again. */
export const CORE_ERASE_RETRY_GAP_MS = 5 * 60_000;
/** What is kept back from the Lambda's remaining time: the response, and the step's own bookkeeping after the walk. */
export const CORE_ERASE_MARGIN_MS = 3_000;

/**
 * When the current request must be finished by (epoch milliseconds). The person-erase request runs after the learning walk (up to 20 s), the Team record's scrub (up to 20 s) and
 * Cloud's evidence walk (up to 20 s) inside one 30 s Lambda, so the core's walk may get little or nothing: the handler notes what the Lambda has left at the start of every
 * event (`context.getRemainingTimeInMillis`), and the walk takes at most what is left minus `CORE_ERASE_MARGIN_MS`. Undefined (no context): only the walk's own budget applies.
 */
let requestEndsAt: number | undefined;
export function noteRequestEnd(remainingMs: number | undefined, now: () => number = Date.now): void {
  requestEndsAt = remainingMs === undefined ? undefined : now() + remainingMs;
}

const companyOf = (record: Readonly<Record<string, unknown>> | undefined): unknown => record?.companyId ?? record?.orgId;

/**
 * Records that this person's core evidence is owed: the pending item, put only if there is none (a cursor saved by an earlier pass is never overwritten). Called FIRST, right after the
 * audit tombstone (audit/erase.ts) and again by the person-erasure step, so that whatever happens to the rest of the request, the every-minute run finishes the walk. A store that cannot
 * record it fails the request (the person is told to repeat it).
 */
export async function beginCoreEvidenceErase(ports: Pick<CoreErasePorts, "store">, companyId: string, developerId: string): Promise<void> {
  if (companyId === "" || developerId === "") throw new Error("a person's erase names a company and a person");
  await ports.store.put({ item: pendingItem(companyId, developerId), condition: when.absent() });
}

export interface ErasePersonOnCoreInput {
  ports: CoreErasePorts;
  companyId: string;
  developerId: string;
  /** The most milliseconds this call spends. Default `CORE_ERASE_BUDGET_MS`. */
  budgetMs?: number;
}

/** What became of one index row: nothing left to do for it, its erase failed (it is tried again), or the deadline came first. */
type RowOutcome = "done" | "failed" | "out_of_time";
type Counts = Omit<PersonEraseOnCoreReport, "complete">;

/**
 * Classifies one set of index rows of the person and erases the core tasks among them, a few at a time, up to the deadline. Answers one outcome per row, in the order of `rows`.
 * Throws only for a store fault (the caller reports it).
 */
async function eraseRows(
  context: { ports: CoreErasePorts; companyId: string; now: () => number; stopAt: number; counts: Counts },
  rows: readonly StoredDocument[],
): Promise<RowOutcome[]> {
  const { ports, companyId, now, stopAt, counts } = context;
  const { store, objects } = ports;
  const outcomes: RowOutcome[] = rows.map(() => "done");
  // Which rows name a task of this company (an index row names its company as `orgId`; both engines write it).
  const candidates = new Map<string, number>();
  for (const [at, row] of rows.entries()) {
    const rowCompany = companyOf(row);
    if (typeof row.taskId !== "string" || (rowCompany !== undefined && rowCompany !== companyId)) counts.skipped += 1;
    else candidates.set(row.taskId, at);
  }
  const taskIds = [...candidates.keys()];
  // The stamps of the rows, then the records of every task a stamp does not name as Cloud's.
  const stamps = taskIds.length === 0 ? [] : await store.getMany(taskIds.map(engineStampKey));
  const engineOf = (index: number): "core" | "cloud" | undefined => stampOf(stamps[index])?.areas.flow;
  const needRecord = taskIds.filter((_, index) => engineOf(index) !== "cloud");
  const unreadableBefore = ports.unreadable?.() ?? 0;
  const records = needRecord.length === 0 ? [] : await store.getMany(needRecord.map(taskKey));
  // A record the store could not read is left out of the answer like a missing one: when it reported any, no absent record counts as missing.
  const someUnreadable = (ports.unreadable?.() ?? 0) > unreadableBefore;
  const recordOf = new Map(needRecord.map((taskId, index) => [taskId, records[index]] as const));
  const erasable: Array<{ at: number; prefixes: string[] }> = [];
  for (const [index, taskId] of taskIds.entries()) {
    const at = candidates.get(taskId)!;
    const stamp = engineOf(index);
    if (stamp === "cloud") { counts.cloudStamped += 1; continue; }
    let record = recordOf.get(taskId);
    // No stamp: the core's start writes `companyId` and no `orgId` (it also writes the stamp, so this is the net under a start that did not); Cloud's records name `orgId`.
    const isCore = stamp === "core" || (stamp === undefined && record !== undefined && record.companyId !== undefined && record.orgId === undefined);
    if (!isCore && !(stamp === undefined && record === undefined && someUnreadable)) { counts.cloudStamped += 1; continue; }
    if (record === undefined) {
      // Absent from the batch read: deleted, or not readable. Only when the store reported an unreadable item is it asked again by itself, which throws for an unreadable one.
      let unreadable = false;
      if (someUnreadable) {
        try { record = await store.get(taskKey(taskId)); } catch { unreadable = true; }
      }
      // An unreadable record is not known to be Cloud's: evidence may be left, so it is tried again.
      if (unreadable) { counts.incomplete += 1; outcomes[at] = "failed"; continue; }
      if (record === undefined) { if (stamp === "core") counts.missingRecord += 1; else counts.skipped += 1; continue; }
      if (!(stamp === "core" || (stamp === undefined && record.companyId !== undefined && record.orgId === undefined))) { counts.cloudStamped += 1; continue; }
    }
    if (companyOf(record) !== companyId || typeof record.ownerKey !== "string" || typeof record.workspaceId !== "string") { counts.skipped += 1; continue; }
    const prefixes = evidencePrefixesOf({ ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId });
    if (prefixes === undefined) counts.refused += 1;
    else erasable.push({ at, prefixes });
  }

  // The deletes, a few tasks at a time. The deadline is checked before every batch and every prefix, and the prefix delete checks it between its rounds, so a batch cannot run far past it.
  for (let start = 0; start < erasable.length; start += PARALLEL) {
    const batch = erasable.slice(start, start + PARALLEL);
    if (now() >= stopAt) { for (const { at } of erasable.slice(start)) outcomes[at] = "out_of_time"; break; }
    const results = await Promise.all(batch.map(async ({ prefixes }): Promise<RowOutcome> => {
      try {
        for (const prefix of prefixes) {
          if (now() >= stopAt) return "out_of_time";
          const result = await objects.deletePrefix(prefix, stopAt);
          if (result === "out_of_time") return "out_of_time";
          if (result !== true) return "failed";
        }
        return "done";
      } catch {
        // The fault's text is not kept (it may carry a key); the count is what the caller acts on.
        return "failed";
      }
    }));
    for (const [index, result] of results.entries()) {
      outcomes[batch[index]!.at] = result;
      if (result === "done") counts.erased += 1;
      else if (result === "failed") counts.incomplete += 1;
    }
    if (results.includes("out_of_time")) { for (const { at } of erasable.slice(start + PARALLEL)) outcomes[at] = "out_of_time"; break; }
  }
  return outcomes;
}

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.startsWith("TASK#")) : []);

/** Erases the evidence of every core task of one person in one company, as far as the budget goes. Never throws for one task's failure or a store fault after the walk is recorded as owed: it reports them. */
export async function erasePersonOnCore(input: ErasePersonOnCoreInput): Promise<PersonEraseOnCoreReport> {
  const { companyId, developerId } = input;
  const { store } = input.ports;
  const now = input.ports.now ?? Date.now;
  if (companyId === "" || developerId === "") throw new Error("a person's erase names a company and a person");
  const stopAt = now() + (input.budgetMs ?? CORE_ERASE_BUDGET_MS);
  const counts: Counts = { tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, missingRecord: 0, refused: 0, incomplete: 0 };
  const context = { ports: input.ports, companyId, now, stopAt, counts };
  const pendingAt = pendingKey(companyId, developerId);
  const indexPk = `DEVELOPER#${developerId}`;
  // Owed first, then read: the walk is on record before anything else can go wrong. A failure here is the caller's (nothing is owed yet).
  await beginCoreEvidenceErase(input.ports, companyId, developerId);
  const pending = await store.get(pendingAt);
  const state: WalkState = {
    ...(typeof pending?.cursor === "string" ? { cursor: pending.cursor } : {}),
    retry: stringsOf(pending?.retry),
    scanned: pending?.scanned === true,
  };
  /** The failing tasks as this run found them: only these are retried in this run (a task that failed in the main walk just now is not tried twice). */
  const retryAtStart = [...state.retry];
  const save = async (): Promise<void> => { await store.put({ item: pendingItem(companyId, developerId, state, now()) }); };
  const range = (from: string | undefined) => (from === undefined ? { op: "beginsWith" as const, prefix: "TASK#" } : { op: "between" as const, low: `${from}\u0000`, high: "TASK#￿" });

  let outOfTime = false;
  let fault = false;
  try {
    // The main walk: from the cursor to the end of the index. The cursor goes past a failing task (kept in `retry`), and stops before a task the deadline came first for.
    while (!state.scanned) {
      if (now() >= stopAt) { outOfTime = true; break; }
      const page = await store.query({ pk: indexPk, sk: range(state.cursor), limit: PAGE });
      const rows = page.items.filter((row) => typeof row.sk === "string" && row.sk.startsWith("TASK#"));
      counts.tasks += rows.length;
      const outcomes = await eraseRows(context, rows);
      let stopped = false;
      for (const [at, row] of rows.entries()) {
        const outcome = outcomes[at]!;
        if (outcome === "out_of_time") { outOfTime = true; stopped = true; break; }
        if (outcome === "failed") {
          if (state.retry.length >= CORE_ERASE_RETRY_MAX) { stopped = true; input.ports.log?.({ component: "broker", event: "core_person_erase.retry_full", retry: state.retry.length }); break; }
          if (!state.retry.includes(row.sk)) state.retry.push(row.sk);
        }
        state.cursor = row.sk;
      }
      if (stopped) break;
      if (page.cursor === undefined) { state.scanned = true; break; }
      const last = page.items.at(-1)?.sk;
      if (typeof last === "string" && last.startsWith("TASK#") && (state.cursor === undefined || last > state.cursor)) state.cursor = last;
      await save();
    }

    // The retries: the tasks that failed before this run, by their index rows. One that erases now leaves `retry`; one whose index row is gone has nothing left to name.
    const toRetry = retryAtStart.slice(0, PAGE);
    if (toRetry.length > 0 && !outOfTime && now() < stopAt) {
      const found = await store.getMany(toRetry.map((sk) => ({ pk: indexPk, sk })));
      const rows: StoredDocument[] = [];
      for (const [index, sk] of toRetry.entries()) {
        const row = found[index];
        if (row === undefined) state.retry = state.retry.filter((entry) => entry !== sk);
        else rows.push(row);
      }
      counts.tasks += rows.length;
      const outcomes = await eraseRows(context, rows);
      for (const [at, row] of rows.entries()) {
        if (outcomes[at] === "done") state.retry = state.retry.filter((entry) => entry !== row.sk);
        else if (outcomes[at] === "out_of_time") outOfTime = true;
      }
    }
  } catch {
    // A store fault (the next page, a record, the cursor): the walk is already owed (pending), so the resume finishes it. Nothing of the fault is kept.
    fault = true;
    input.ports.log?.({ component: "broker", event: "core_person_erase.store_fault", tasks: counts.tasks });
  }

  const complete = state.scanned && state.retry.length === 0 && !outOfTime && !fault && counts.incomplete === 0;
  try {
    if (complete) await store.delete({ key: pendingAt });
    else await save();
  } catch {
    // Complete but the pending item stayed: the resume finds nothing to do and clears it. Not complete and the state not saved: the item still stands, from where it was.
  }
  if (counts.refused > 0) input.ports.log?.({ component: "broker", event: "core_person_erase.refused", tasks: counts.tasks, refused: counts.refused });
  if (counts.missingRecord > 0) input.ports.log?.({ component: "broker", event: "core_person_erase.skipped", tasks: counts.tasks, missingRecord: counts.missingRecord });
  if (state.retry.length > 0) input.ports.log?.({ component: "broker", event: "core_person_erase.retry_left", retry: state.retry.length });
  return { ...counts, complete };
}

/** The core's person erase as the person-erasure step calls it. */
export interface CorePersonErase {
  /** Records the walk as owed (see `beginCoreEvidenceErase`): called first, before anything that can fail. */
  begin(companyId: string, developerId: string): Promise<void>;
  person(companyId: string, developerId: string): Promise<PersonEraseOnCoreReport>;
}

/** Thrown when a core task's evidence was not all erased, the budget ran out first, or the store failed. The erasure request is repeated (it goes on from the saved cursor); the walk is idempotent. Carries counts only. */
export class CorePersonEraseUnfinished extends Error {
  constructor(readonly report: PersonEraseOnCoreReport, options?: { cause?: unknown }) {
    super(`the core's evidence erase did not finish (${String(report.incomplete)} of ${String(report.tasks)} tasks incomplete this run)`, options);
    this.name = "CorePersonEraseUnfinished";
  }
}

/** The core's person erase over the two ports. Always on: whether a task is the core's is read from its own stamp and record, never from a switch. */
export function corePersonEraseOf(ports: CoreErasePorts, budgetMs: number = CORE_ERASE_BUDGET_MS): CorePersonErase {
  const now = ports.now ?? Date.now;
  return {
    begin: (companyId, developerId) => beginCoreEvidenceErase(ports, companyId, developerId),
    async person(companyId, developerId) {
      // At most what the request has left minus the margin; none left means the walk does not start (it is owed, and the request fails to be repeated).
      const left = requestEndsAt === undefined ? Infinity : requestEndsAt - now() - CORE_ERASE_MARGIN_MS;
      let report: PersonEraseOnCoreReport;
      try {
        report = await erasePersonOnCore({ ports, companyId, developerId, budgetMs: Math.max(0, Math.min(budgetMs, left)) });
      } catch (error) {
        // Whatever failed, the person is told the evidence step did not finish (not another step's words), and the request is repeated. The cause is kept for the log, never in the message.
        throw new CorePersonEraseUnfinished({ ...EMPTY_PERSON_ERASE_REPORT, complete: false }, { cause: error });
      }
      if (!report.complete || report.incomplete > 0) throw new CorePersonEraseUnfinished(report);
      return report;
    },
  };
}

/**
 * The walks a request left unfinished, continued from their cursors within `millis` (the every-minute run, next to `resumeEvidenceErase`). The pending items are read first (at most
 * 50 pages); the walks are then taken oldest try first (`triedAt`; never tried first), so the start point moves on every minute; a walk with only failing tasks left that was tried in the
 * last `CORE_ERASE_RETRY_GAP_MS` waits; and each walk gets at most `CORE_ERASE_RESUME_SHARE_MS`, so no walk, stuck or long, takes the run from another person's.
 */
export async function resumeCoreEvidenceErase(ports: CoreErasePorts, limits: { millis: number; max?: number }): Promise<{ pending: number; finished: number }> {
  const now = ports.now ?? Date.now;
  const stop = now() + limits.millis;
  const items: StoredDocument[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await ports.store.query({ pk: CORE_ERASE_PENDING_PK, limit: limits.max ?? 20, ...(cursor === undefined ? {} : { cursor }) });
    items.push(...page.items);
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  const triedAt = (item: StoredDocument): number => (typeof item.triedAt === "number" ? item.triedAt : 0);
  const startedAt = now();
  const due = items
    .filter((item) => typeof item.companyId === "string" && typeof item.developerId === "string")
    .filter((item) => !(item.scanned === true && startedAt - triedAt(item) < CORE_ERASE_RETRY_GAP_MS))
    .sort((a, b) => triedAt(a) - triedAt(b));
  let finished = 0;
  for (const item of due) {
    const left = stop - now();
    if (left < RESUME_MIN_MS) break;
    try {
      const report = await erasePersonOnCore({ ports, companyId: item.companyId as string, developerId: item.developerId as string, budgetMs: Math.min(CORE_ERASE_RESUME_SHARE_MS, left) });
      if (report.complete && report.incomplete === 0) finished += 1;
    } catch { /* the next run goes on from the cursor */ }
  }
  return { pending: items.length, finished };
}
