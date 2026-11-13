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
//  - Bounded and resumable. The reads are batched (`getMany`, one page of the index at a time), the prefix deletes run a few at a time, and the walk stops at its
//    deadline. Where it stops (the deadline, or a task whose erase did not finish) it saves the last index sort key it finished in a PENDING item
//    (`CORE_EVIDENCE_ERASE_PENDING`), so a repeat of the request moves forward, and `resumeCoreEvidenceErase` (the every-minute run, wired in aws/broker/handler.ts)
//    finishes it. A walk that reaches the end of the index deletes its pending item. A walk that stopped early is NEVER reported complete.
//  - Beyond that, the walk writes nothing, and the per-task erase is a prefix delete, so a second run changes nothing. It reports counts, never names or ids.
//  - A task whose id is not a plain id is REFUSED (counted apart, logged as counts): it can never be erased, so it must not hold the request open. A core task whose
//    record is missing or expired is counted `missingRecord` and logged: there is nothing left to say where its evidence is.
//  - The per-task erase is the core's: the same two prefixes under the task's workspace (`evidence-pack/<task>/` and `evidence/<task>/`), from `evidencePrefixesOf`,
//    which Code and Cloud both hold until the deletion lane deletes Cloud's copy. Code's `core/proof` has no index file, so `@rovara-code/broker` does not export
//    its `eraseTaskEvidence`; tests/unit/cloud-app-erase.test.ts holds the two copies to the same prefixes.
import { DynamoDocumentStore } from "@rovara-code/aws-adapters";
import { S3ObjectStorage, type S3ObjectClient } from "@rovara-code/aws-adapters/s3";
import type { DocumentKey, DocumentStore, ObjectStorage } from "@rovara-code/contracts";
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
  /** Core tasks whose record is missing or expired: nothing says where their evidence is. */
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
  return {
    store: new DynamoDocumentStore({ client: input.dynamo, tableName: input.tableName, onUnreadable: () => input.log?.({ component: "broker", event: "core_person_erase.unreadable_item" }) }),
    objects: new S3ObjectStorage({ client: stoppingOnDeleteErrors(input.s3), bucket: input.bucket }),
    ...(input.log === undefined ? {} : { log: input.log }),
    ...(input.now === undefined ? {} : { now: input.now }),
  };
}

export const CORE_ERASE_PENDING_PK = "CORE_EVIDENCE_ERASE_PENDING";
const pendingKey = (companyId: string, developerId: string): DocumentKey => ({ pk: CORE_ERASE_PENDING_PK, sk: `${companyId}|${developerId}` });

/** Index rows read, and stamps or records fetched, at a time (the store's `getMany` takes at most 100 keys). */
const PAGE = 100;
/** Tasks whose prefixes are deleted at the same time. */
const PARALLEL = 10;
/** What a person's erase gives the walk: the person-erase request runs inside a 30 s Lambda after Cloud's own walk (up to 20 s), so this is short; a repeat or the resume goes on from the cursor. */
export const CORE_ERASE_BUDGET_MS = 4_000;
/** What the every-minute run gives the unfinished walks (its own share, next to Cloud's 3 s). */
export const CORE_ERASE_RESUME_BUDGET_MS = 2_000;

const companyOf = (record: Readonly<Record<string, unknown>> | undefined): unknown => record?.companyId ?? record?.orgId;

export interface ErasePersonOnCoreInput {
  ports: CoreErasePorts;
  companyId: string;
  developerId: string;
  /** The most milliseconds this call spends. Default `CORE_ERASE_BUDGET_MS`. */
  budgetMs?: number;
}

/** Erases the evidence of every core task of one person in one company, as far as the budget goes. Never throws for one task's failure: it counts it. */
export async function erasePersonOnCore(input: ErasePersonOnCoreInput): Promise<PersonEraseOnCoreReport> {
  const { companyId, developerId } = input;
  const { store, objects } = input.ports;
  const now = input.ports.now ?? Date.now;
  if (companyId === "" || developerId === "") throw new Error("a person's erase names a company and a person");
  const stopAt = now() + (input.budgetMs ?? CORE_ERASE_BUDGET_MS);
  const counts = { tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, missingRecord: 0, refused: 0, incomplete: 0 };
  const pendingAt = pendingKey(companyId, developerId);
  const pending = await store.get(pendingAt);
  /** The last index sort key finished (the next page starts after it). */
  let finishedTo = typeof pending?.cursor === "string" ? pending.cursor : undefined;
  let saved: string | undefined = finishedTo;
  let hasPending = pending !== undefined;
  const save = async (cursor: string | undefined): Promise<void> => {
    if (hasPending && cursor === saved) return;
    await store.put({ item: { ...pendingAt, entityType: "CORE_EVIDENCE_ERASE_PENDING", companyId, developerId, ...(cursor === undefined ? {} : { cursor }) } });
    hasPending = true;
    saved = cursor;
  };

  const range = (from: string | undefined) => (from === undefined ? { op: "beginsWith" as const, prefix: "TASK#" } : { op: "gt" as const, value: from });
  let complete = true;
  let storeCursor: string | undefined;
  const pageFrom = finishedTo;
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
      else candidates.set(row.taskId, row.sk as string);
    }
    const taskIds = [...candidates.keys()];
    // The stamps of the page, then the records of every task a stamp does not name as Cloud's.
    const stamps = taskIds.length === 0 ? [] : await store.getMany(taskIds.map(engineStampKey));
    const engineOf = (index: number): "core" | "cloud" | undefined => stampOf(stamps[index])?.areas.flow;
    const needRecord = taskIds.filter((_, index) => engineOf(index) !== "cloud");
    const records = needRecord.length === 0 ? [] : await store.getMany(needRecord.map(taskKey));
    const recordOf = new Map(needRecord.map((taskId, index) => [taskId, records[index]] as const));
    const erasable: Array<{ sk: string; prefixes: string[] }> = [];
    taskIds.forEach((taskId, index) => {
      const stamp = engineOf(index);
      if (stamp === "cloud") { counts.cloudStamped += 1; return; }
      const record = recordOf.get(taskId);
      // No stamp: the core's start writes `companyId` and no `orgId` (it also writes the stamp, so this is the net under a start that did not); Cloud's records name `orgId`.
      const isCore = stamp === "core" || (record !== undefined && record.companyId !== undefined && record.orgId === undefined);
      if (!isCore) { counts.cloudStamped += 1; return; }
      if (record === undefined) { counts.missingRecord += 1; return; }
      if (companyOf(record) !== companyId || typeof record.ownerKey !== "string" || typeof record.workspaceId !== "string") { counts.skipped += 1; return; }
      const prefixes = evidencePrefixesOf({ ownerKey: record.ownerKey, workspaceId: record.workspaceId, taskId });
      if (prefixes === undefined) counts.refused += 1;
      else erasable.push({ sk: candidates.get(taskId)!, prefixes });
    });

    // The deletes, a few tasks at a time. The cursor moves with each batch that finished (to that batch's last index row), so a page the budget cannot hold is still got through
    // across repeats; a batch with a task that did not finish stops the walk and the cursor stays before it.
    let pageIncomplete = 0;
    let outOfTime = false;
    for (let at = 0; at < erasable.length; at += PARALLEL) {
      if (now() >= stopAt) { outOfTime = true; break; }
      const batch = erasable.slice(at, at + PARALLEL);
      const results = await Promise.all(batch.map(async ({ prefixes }) => {
        try {
          let finished = true;
          for (const prefix of prefixes) finished = (await objects.deletePrefix(prefix)) && finished;
          return finished;
        } catch {
          // The fault's text is not kept (it may carry a key); the count is what the caller acts on.
          return false;
        }
      }));
      for (const finished of results) { if (finished) counts.erased += 1; else pageIncomplete += 1; }
      if (pageIncomplete > 0) break;
      finishedTo = batch.at(-1)!.sk;
    }
    counts.incomplete += pageIncomplete;
    if (outOfTime || pageIncomplete > 0) { complete = false; break; }

    // The page is finished: the cursor moves to its last row, and the walk goes on, or ends.
    const last = rows.at(-1);
    if (page.cursor === undefined) break;
    storeCursor = page.cursor;
    if (last !== undefined) { finishedTo = last.sk; await save(finishedTo); }
  }

  if (complete) {
    if (hasPending) await store.delete({ key: pendingAt });
  } else {
    await save(finishedTo);
  }
  if (counts.refused > 0) input.ports.log?.({ component: "broker", event: "core_person_erase.refused", tasks: counts.tasks, refused: counts.refused });
  if (counts.missingRecord > 0) input.ports.log?.({ component: "broker", event: "core_person_erase.skipped", tasks: counts.tasks, missingRecord: counts.missingRecord });
  return { ...counts, complete };
}

/** The core's person erase as the person-erasure step calls it. */
export interface CorePersonErase {
  person(companyId: string, developerId: string): Promise<PersonEraseOnCoreReport>;
}

/** Thrown when a core task's evidence was not all erased, or the budget ran out first. The erasure request is repeated (it goes on from the saved cursor); the walk is idempotent. Carries counts only. */
export class CorePersonEraseUnfinished extends Error {
  constructor(readonly report: PersonEraseOnCoreReport) {
    super(`the core's evidence erase did not finish (${String(report.incomplete)} of ${String(report.tasks)} tasks incomplete this run)`);
    this.name = "CorePersonEraseUnfinished";
  }
}

/** The core's person erase over the two ports. Always on: whether a task is the core's is read from its own stamp and record, never from a switch. */
export function corePersonEraseOf(ports: CoreErasePorts, budgetMs: number = CORE_ERASE_BUDGET_MS): CorePersonErase {
  return {
    async person(companyId, developerId) {
      const report = await erasePersonOnCore({ ports, companyId, developerId, budgetMs });
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
