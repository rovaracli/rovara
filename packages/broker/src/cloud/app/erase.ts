// Convergence S0 follow-up: erasing a removed person's evidence for the tasks the core ran.
//
// Cloud erases a person's evidence with `createEvidenceErase(...).person` (rovara-code/evidence-erase.ts), which reads Cloud's own task records. Code's core has no
// walk by person by design (vendor core/proof/evidence-erase.ts, decision 41): it erases per task (`eraseTaskEvidence`) on the object-storage point. After the
// combined switch a person's core-stamped tasks keep their evidence in the core's layout, so the removal of a person needs this walk as well:
//   the person's task index (`DEVELOPER#<id>` / `TASK#...`) -> for each task whose engine stamp is `core`, its owner key and workspace -> the per-task erase.
//
// Rules held here:
//  - It does NOT depend on the switch or on the registry. A task keeps its engine after the switch is turned off, so a removed person's core-stamped tasks can exist
//    whether or not any switch is on; the walk takes the two ports it needs (the State table's store and the artifact bucket's object storage) and runs on every
//    person erase. With no core-stamped task it reads the person's index and each task's stamp, and deletes nothing.
//  - Cloud's own walk cannot do this work: it keeps a task only when the task record's `orgId` equals the company, and a core task record carries `companyId` only
//    (vendor core task-flow/start.ts), and it stops at once for a company with no `EVIDENCE_STORED#<org>` marker, which nothing on the core path writes.
//  - Same rule as Cloud's walk for whose tasks: every task in the person's index (`DEVELOPER#<id>`), which holds the tasks they created, own, or took over.
//  - A Cloud-stamped task (no stamp, or `cloud`) is left to Cloud's own erase; another company's task and another person's task are never read for erasure.
//  - The walk is idempotent: it writes nothing, and the per-task erase is a prefix delete, so a second run changes nothing. It reports counts, never names or ids.
//  - A task whose id is not a plain id is REFUSED (counted apart, logged as counts): it can never be erased, so it must not hold the request open. A task whose erase did not
//    finish (or threw) is `incomplete`: the walk goes on, then `corePersonEraseOf(...).person` throws `CorePersonEraseUnfinished`, so the erasure request is repeated.
//    There is no scheduled resume for the core walk (Cloud's EVIDENCE_ERASE_PENDING records resume Cloud's walk only); it relies on that repeated request
//    (DEFERRED-CHECKS S0-PERSON-ERASE-RESUME).
//  - The per-task erase is the core's: the same two prefixes under the task's workspace (`evidence-pack/<task>/` and `evidence/<task>/`), from `evidencePrefixesOf`,
//    which Code and Cloud both hold until the deletion lane deletes Cloud's copy. Code's `core/proof` has no index file, so `@rovara-code/broker` does not export
//    its `eraseTaskEvidence`; tests/unit/cloud-app-erase.test.ts holds the two copies to the same prefixes.
import { createDynamoStoreFromSettings } from "@rovara-code/aws-adapters/dynamodb";
import { S3ObjectStorage, type S3ObjectClient } from "@rovara-code/aws-adapters/s3";
import { queryAll, type DocumentStore, type ObjectStorage } from "@rovara-code/contracts";
import { taskKey } from "../../developer/task-records.js";
import { evidencePrefixesOf } from "../../rovara-code/evidence-erase.js";
import { engineOfStoredTask } from "./engine-stamp.js";

/** What one walk found, as counts only. */
export interface PersonEraseOnCoreReport {
  /** Rows of the person's task index that were read. */
  tasks: number;
  /** Tasks whose evidence was erased (nothing of it is left). */
  erased: number;
  /** Tasks stamped Cloud (or unstamped): left to Cloud's own erase. */
  cloudStamped: number;
  /** Rows that name no task, a task of another company, or a task with no owner key or workspace: nothing was erased for them. */
  skipped: number;
  /** Core tasks whose ids are not plain ids (an owner key, workspace or task id that cannot name a prefix): never erasable, so they do not hold the request open. */
  refused: number;
  /** Core tasks whose erase did not finish or failed: the walk must be repeated. */
  incomplete: number;
}

export const EMPTY_PERSON_ERASE_REPORT: PersonEraseOnCoreReport = Object.freeze({ tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, refused: 0, incomplete: 0 });

/** The two ports the walk needs. Not the registry: the walk must run whether or not a switch is on. */
export interface CoreErasePorts {
  /** The State table's store (task index rows, task records, engine stamps). Reads only. */
  store: Pick<DocumentStore, "get" | "query">;
  /** The artifact bucket's object storage (the evidence). */
  objects: Pick<ObjectStorage, "deletePrefix">;
  /** One line per walk that refused something; counts only. */
  log?: (entry: Record<string, unknown>) => void;
}

/** The ports over the broker's own clients: the State table through the vendored DynamoDB store (base-table reads only, so no index is declared) and the artifact bucket through the vendored S3 store (the keys are unchanged, no prefix is added). */
export function coreErasePortsOf(input: { dynamo: NonNullable<Parameters<typeof createDynamoStoreFromSettings>[1]>; tableName: string; s3: S3ObjectClient; bucket: string; log?: CoreErasePorts["log"] }): CoreErasePorts {
  return {
    store: createDynamoStoreFromSettings({ tableName: input.tableName, ttlAttribute: "indexExpiresAt" }, input.dynamo),
    objects: new S3ObjectStorage({ client: input.s3, bucket: input.bucket }),
    ...(input.log === undefined ? {} : { log: input.log }),
  };
}

export interface ErasePersonOnCoreInput {
  ports: CoreErasePorts;
  companyId: string;
  developerId: string;
}

const companyOf = (record: Readonly<Record<string, unknown>> | undefined): unknown => record?.companyId ?? record?.orgId;

/** Erases the evidence of every core-stamped task of one person in one company. Never throws for one task's failure: it counts it. */
export async function erasePersonOnCore(input: ErasePersonOnCoreInput): Promise<PersonEraseOnCoreReport> {
  const { companyId, developerId } = input;
  const { store, objects } = input.ports;
  if (companyId === "" || developerId === "") throw new Error("a person's erase names a company and a person");
  const counts = { tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, refused: 0, incomplete: 0 };
  for (const row of await queryAll(store, { pk: `DEVELOPER#${developerId}`, sk: { op: "beginsWith", prefix: "TASK#" } })) {
    counts.tasks += 1;
    const taskId = typeof row.taskId === "string" ? row.taskId : undefined;
    // An index row names its company as `orgId` (both engines write it); a task record names it as `companyId` (core) or `orgId` (Cloud).
    const rowCompany = companyOf(row);
    if (taskId === undefined || (rowCompany !== undefined && rowCompany !== companyId)) { counts.skipped += 1; continue; }
    if ((await engineOfStoredTask(store, taskId, "flow")) !== "core") { counts.cloudStamped += 1; continue; }
    const task = await store.get(taskKey(taskId));
    if (task === undefined || companyOf(task) !== companyId || typeof task.ownerKey !== "string" || typeof task.workspaceId !== "string") { counts.skipped += 1; continue; }
    const prefixes = evidencePrefixesOf({ ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId });
    if (prefixes === undefined) { counts.refused += 1; continue; }
    try {
      let finished = true;
      for (const prefix of prefixes) finished = (await objects.deletePrefix(prefix)) && finished;
      counts[finished ? "erased" : "incomplete"] += 1;
    } catch {
      // The fault's text is not kept (it may carry a key); the count is what the caller acts on.
      counts.incomplete += 1;
    }
  }
  if (counts.refused > 0) input.ports.log?.({ component: "broker", event: "core_person_erase.refused", tasks: counts.tasks, refused: counts.refused });
  return counts;
}

/** The core's person erase as the person-erasure step calls it. */
export interface CorePersonErase {
  person(companyId: string, developerId: string): Promise<PersonEraseOnCoreReport>;
}

/** Thrown when a core task's evidence was not all erased. The erasure request is repeated; the walk is idempotent. Carries counts only. */
export class CorePersonEraseUnfinished extends Error {
  constructor(readonly report: PersonEraseOnCoreReport) {
    super(`the core's evidence erase did not finish for ${String(report.incomplete)} of ${String(report.tasks)} tasks`);
    this.name = "CorePersonEraseUnfinished";
  }
}

/** The core's person erase over the two ports. Always on: whether a task is the core's is read from its own stamp, never from a switch. */
export function corePersonEraseOf(ports: CoreErasePorts): CorePersonErase {
  return {
    async person(companyId, developerId) {
      const report = await erasePersonOnCore({ ports, companyId, developerId });
      if (report.incomplete > 0) throw new CorePersonEraseUnfinished(report);
      return report;
    },
  };
}
