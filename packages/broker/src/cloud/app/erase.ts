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
//    smaller of its own budget and what is left of the Lambda's time minus a margin (`noteRequestEnd`, set by the handler), checked before every page, every batch and every prefix.
//    It saves the last index sort key it finished in the pending item, so a repeat of the request moves forward; the query is bounded on both sides (after the cursor, inside
//    `TASK#`). A task whose erase did not finish does not stop the walk: the later tasks are still erased and the cursor stays before the first task that did not finish.
//    A walk that reaches the end of the index with nothing left deletes its pending item. A walk that stopped early, or met a fault, is NEVER reported complete.
//  - Beyond that, the walk writes nothing, and the per-task erase is a prefix delete, so a second run changes nothing. It reports counts, never names or ids.
//  - A task whose id is not a plain id is REFUSED (counted apart, logged as counts): it can never be erased, so it must not hold the request open. A core task whose
//    record is missing (deleted) is counted `missingRecord` and logged: there is nothing left to say where its evidence is. A record the store could not READ is not missing: it
//    counts as incomplete, so the walk is never reported complete with evidence possibly left.
//  - The per-task erase is the core's: the same two prefixes under the task's workspace (`evidence-pack/<task>/` and `evidence/<task>/`), from `evidencePrefixesOf`,
//    which Code and Cloud both hold until the deletion lane deletes Cloud's copy. Code's `core/proof` has no index file, so `@rovara-code/broker` does not export
//    its `eraseTaskEvidence`; tests/unit/cloud-app-erase.test.ts holds the two copies to the same prefixes.
import { DynamoDocumentStore } from "@rovara-code/aws-adapters";
import { S3ObjectStorage, type S3ObjectClient } from "@rovara-code/aws-adapters/s3";
import { when, type DocumentKey, type DocumentStore, type ObjectStorage } from "@rovara-code/contracts";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
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

/** The ports the walk needs. Not the registry: the walk must run whether or not a switch is on. */
export interface CoreErasePorts {
  /** The State table's store: reads, and the one pending item of an unfinished walk. */
  store: Pick<DocumentStore, "get" | "getMany" | "query" | "put" | "delete">;
  /** The artifact bucket's object storage (the evidence). */
  objects: Pick<ObjectStorage, "deletePrefix">;
  /** One line per walk that refused or skipped something, and per item the store could not read; counts only. */
  log?: (entry: Record<string, unknown>) => void;
  /** The clock (milliseconds). Default `Date.now`. */
  now?: () => number;
  /** How many items the store has reported as unreadable so far (a record it cannot represent is left out of a read, which looks like a missing one). */
  unreadable?: () => number;
}

/** The artifact bucket's S3 client as the vendored object storage sees it, with one rule added: a batch delete that reports per-key errors is a failure, not a round to repeat. */
function stoppingOnDeleteErrors(client: S3ObjectClient): S3ObjectClient {
  return {
    async send(command) {
      const answer = await client.send(command);
      if (command instanceof DeleteObjectsCommand && ((answer as { Errors?: unknown[] } | undefined)?.Errors?.length ?? 0) > 0) throw new Error("the bucket reported errors deleting evidence");
      return answer;
    },
  };
}

/**
 * The ports over the broker's own clients: the State table through the vendored DynamoDB store (base-table reads, plus the one pending item) and the artifact bucket through the
 * vendored S3 store (the keys are unchanged, no prefix is added). The table has no time-to-live here: the walk reads items, it does not write any that expire. The store's report of an
 * item it cannot read names the key (a person and a task), so it is replaced by a line that names nothing.
 */
export function coreErasePortsOf(input: { dynamo: ConstructorParameters<typeof DynamoDocumentStore>[0]["client"]; tableName: string; s3: S3ObjectClient; bucket: string; log?: CoreErasePorts["log"]; now?: () => number }): CoreErasePorts {
  let unreadable = 0;
  return {
    store: new DynamoDocumentStore({ client: input.dynamo, tableName: input.tableName, onUnreadable: () => { unreadable += 1; input.log?.({ component: "broker", event: "core_person_erase.unreadable_item" }); } }),
    objects: new S3ObjectStorage({ client: stoppingOnDeleteErrors(input.s3), bucket: input.bucket }),
    unreadable: () => unreadable,
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
}

export const CORE_ERASE_PENDING_PK = "CORE_EVIDENCE_ERASE_PENDING";
const pendingKey = (companyId: string, developerId: string): DocumentKey => ({ pk: CORE_ERASE_PENDING_PK, sk: `${companyId}|${developerId}` });
const pendingItem = (companyId: string, developerId: string, cursor?: string) => ({ ...pendingKey(companyId, developerId), entityType: "CORE_EVIDENCE_ERASE_PENDING", companyId, developerId, ...(cursor === undefined ? {} : { cursor }) });

/** Index rows read, and stamps or records fetched, at a time (the store's `getMany` takes at most 100 keys). */
const PAGE = 100;
/** Tasks whose prefixes are deleted at the same time. */
const PARALLEL = 10;
/** What a person's erase gives the walk at most; the request's remaining time (below) can make it less. A repeat or the resume goes on from the cursor. */
export const CORE_ERASE_BUDGET_MS = 4_000;
/** What the every-minute run gives the unfinished walks (its own share, next to Cloud's 3 s). */
export const CORE_ERASE_RESUME_BUDGET_MS = 2_000;
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
 * Records that this person's core evidence is owed: the pending item, put only if there is none (a cursor saved by an earlier pass is never overwritten). Called FIRST by the person-erasure
 * step, so that whatever happens to the rest of the request, the every-minute run finishes the walk. A store that cannot record it fails the request (the person is told to repeat it).
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

type TaskOutcome = "done" | "failed" | "out_of_time";

/** Erases the evidence of every core task of one person in one company, as far as the budget goes. Never throws for one task's failure or a store fault after the walk is recorded as owed: it reports them. */
export async function erasePersonOnCore(input: ErasePersonOnCoreInput): Promise<PersonEraseOnCoreReport> {
  const { companyId, developerId } = input;
  const { store, objects } = input.ports;
  const now = input.ports.now ?? Date.now;
  if (companyId === "" || developerId === "") throw new Error("a person's erase names a company and a person");
  const stopAt = now() + (input.budgetMs ?? CORE_ERASE_BUDGET_MS);
  const counts = { tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, missingRecord: 0, refused: 0, incomplete: 0 };
  const pendingAt = pendingKey(companyId, developerId);
  // Owed first, then read: the walk is on record before anything else can go wrong. A failure here is the caller's (nothing is owed yet).
  await beginCoreEvidenceErase(input.ports, companyId, developerId);
  const pending = await store.get(pendingAt);
  /** The last index sort key finished (the next page starts after it). Never moves past a task that did not finish. */
  let finishedTo = typeof pending?.cursor === "string" ? pending.cursor : undefined;
  let saved: string | undefined = finishedTo;
  const save = async (cursor: string | undefined): Promise<void> => {
    if (cursor === saved) return;
    await store.put({ item: pendingItem(companyId, developerId, cursor) });
    saved = cursor;
  };

  const range = (from: string | undefined) => (from === undefined ? { op: "beginsWith" as const, prefix: "TASK#" } : { op: "between" as const, low: `${from}\u0000`, high: "TASK#￿" });
  let complete = true;
  /** True once a task did not finish: the cursor stops there, and the rest of the walk only erases. */
  let blocked = false;
  const pageFrom = finishedTo;
  try {
    let storeCursor: string | undefined;
    for (;;) {
      if (now() >= stopAt) { complete = false; break; }
      const page = await store.query({ pk: `DEVELOPER#${developerId}`, sk: range(pageFrom), limit: PAGE, ...(storeCursor === undefined ? {} : { cursor: storeCursor }) });
      const rows = page.items.filter((row) => typeof row.sk === "string" && row.sk.startsWith("TASK#"));
      counts.tasks += rows.length;

      // Which rows name a task of this company (an index row names its company as `orgId`; both engines write it).
      const candidates = new Map<string, string>();
      for (const row of rows) {
        const rowCompany = companyOf(row);
        if (typeof row.taskId !== "string" || (rowCompany !== undefined && rowCompany !== companyId)) counts.skipped += 1;
        else candidates.set(row.taskId, row.sk);
      }
      const taskIds = [...candidates.keys()];
      // The stamps of the page, then the records of every task a stamp does not name as Cloud's.
      const stamps = taskIds.length === 0 ? [] : await store.getMany(taskIds.map(engineStampKey));
      const engineOf = (index: number): "core" | "cloud" | undefined => stampOf(stamps[index])?.areas.flow;
      const needRecord = taskIds.filter((_, index) => engineOf(index) !== "cloud");
      const unreadableBefore = input.ports.unreadable?.() ?? 0;
      const records = needRecord.length === 0 ? [] : await store.getMany(needRecord.map(taskKey));
      // A record the store could not read is left out of the answer like a missing one: when it reported any, no absent record counts as missing.
      const someUnreadable = (input.ports.unreadable?.() ?? 0) > unreadableBefore;
      const recordOf = new Map(needRecord.map((taskId, index) => [taskId, records[index]] as const));
      const erasable: Array<{ sk: string; prefixes: string[] }> = [];
      for (const [index, taskId] of taskIds.entries()) {
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
          // An unreadable record is not known to be Cloud's: evidence may be left, so the walk is not complete.
          if (unreadable) { counts.incomplete += 1; blocked = true; complete = false; continue; }
          if (record === undefined) { if (stamp === "core") counts.missingRecord += 1; else counts.skipped += 1; continue; }
          if (!(stamp === "core" || (stamp === undefined && record.companyId !== undefined && record.orgId === undefined))) { counts.cloudStamped += 1; continue; }
        }
        if (companyOf(record) !== companyId || typeof record.ownerKey !== "string" || typeof record.workspaceId !== "string") { counts.skipped += 1; continue; }
        const prefixes = evidencePrefixesOf({ ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId });
        if (prefixes === undefined) counts.refused += 1;
        else erasable.push({ sk: candidates.get(taskId)!, prefixes });
      }

      // The deletes, a few tasks at a time. The deadline is checked before every prefix, so a batch cannot run past it. The cursor moves with each batch that finished (to that batch's last
      // index row) until a task does not finish; after that the later tasks are still erased, and the cursor stays where it was.
      let outOfTime = false;
      for (let at = 0; at < erasable.length; at += PARALLEL) {
        if (now() >= stopAt) { outOfTime = true; break; }
        const batch = erasable.slice(at, at + PARALLEL);
        const outcomes = await Promise.all(batch.map(async ({ prefixes }): Promise<TaskOutcome> => {
          try {
            for (const prefix of prefixes) {
              if (now() >= stopAt) return "out_of_time";
              if (!(await objects.deletePrefix(prefix))) return "failed";
            }
            return "done";
          } catch {
            // The fault's text is not kept (it may carry a key); the count is what the caller acts on.
            return "failed";
          }
        }));
        for (const outcome of outcomes) {
          if (outcome === "done") counts.erased += 1;
          else if (outcome === "failed") { counts.incomplete += 1; blocked = true; }
          else outOfTime = true;
        }
        if (outcomes.some((outcome) => outcome !== "done")) blocked = true;
        else if (!blocked) finishedTo = batch.at(-1)!.sk;
        if (outOfTime) break;
      }
      if (outOfTime || counts.incomplete > 0) complete = false;
      if (outOfTime) break;

      // The page is finished: the cursor moves to its last row (unless a task is still owed), and the walk goes on, or ends.
      if (page.cursor === undefined) break;
      storeCursor = page.cursor;
      const last = rows.at(-1);
      if (last !== undefined && !blocked) { finishedTo = last.sk; await save(finishedTo); }
    }
  } catch {
    // A store fault (the next page, a record, the cursor): the walk is already owed (pending), so the resume finishes it. Nothing of the fault is kept.
    complete = false;
    input.ports.log?.({ component: "broker", event: "core_person_erase.store_fault", tasks: counts.tasks });
  }

  try {
    if (complete) await store.delete({ key: pendingAt });
    else await save(finishedTo);
  } catch {
    // Complete but the pending item stayed: the resume finds nothing to do and clears it. Not complete and the cursor not saved: the item still stands, from where it was.
  }
  if (counts.refused > 0) input.ports.log?.({ component: "broker", event: "core_person_erase.refused", tasks: counts.tasks, refused: counts.refused });
  if (counts.missingRecord > 0) input.ports.log?.({ component: "broker", event: "core_person_erase.skipped", tasks: counts.tasks, missingRecord: counts.missingRecord });
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
 * The walks a request left unfinished, continued from their cursors within `millis` (the every-minute run, next to `resumeEvidenceErase`). Each pending item is paged
 * through, and each walk gets at most half of the time that is left, so one slow person cannot take the whole run.
 */
export async function resumeCoreEvidenceErase(ports: CoreErasePorts, limits: { millis: number; max?: number }): Promise<{ pending: number; finished: number }> {
  const now = ports.now ?? Date.now;
  const stop = now() + limits.millis;
  let seen = 0;
  let finished = 0;
  let cursor: string | undefined;
  for (let pages = 0; pages < 50; pages += 1) {
    const page = await ports.store.query({ pk: CORE_ERASE_PENDING_PK, limit: limits.max ?? 20, ...(cursor === undefined ? {} : { cursor }) });
    seen += page.items.length;
    for (const item of page.items) {
      const left = stop - now();
      if (left < 500) return { pending: seen, finished };
      if (typeof item.companyId !== "string" || typeof item.developerId !== "string") continue;
      try {
        const report = await erasePersonOnCore({ ports, companyId: item.companyId, developerId: item.developerId, budgetMs: Math.max(500, Math.floor(left / 2)) });
        if (report.complete && report.incomplete === 0) finished += 1;
      } catch { /* the next run goes on from the cursor */ }
    }
    cursor = page.cursor;
    if (cursor === undefined) break;
  }
  return { pending: seen, finished };
}
