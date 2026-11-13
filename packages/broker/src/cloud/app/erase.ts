// Convergence S0 follow-up: erasing a removed person's evidence for the tasks the core ran.
//
// Cloud erases a person's evidence with `createEvidenceErase(...).person` (rovara-code/evidence-erase.ts), which reads Cloud's own task records. Code's core has no
// walk by person by design (vendor core/proof/evidence-erase.ts, decision 41): it erases per task (`eraseTaskEvidence`) on the object-storage point. After the
// combined switch a person's core-stamped tasks keep their evidence in the core's layout, so the removal of a person needs this walk as well:
//   the person's task index (`DEVELOPER#<id>` / `TASK#...`) -> for each task whose engine stamp is `core`, its owner key and workspace -> the per-task erase.
//
// Rules held here:
//  - A Cloud-stamped task (no stamp, or `cloud`) is left to Cloud's own erase; another company's task and another person's task are never read for erasure.
//  - The walk is idempotent: it writes nothing, and the per-task erase is a prefix delete, so a second run changes nothing. It reports counts, never names or ids.
//  - A task whose erase did not finish (or threw) is counted and the walk goes on; `corePersonEraseOf(...).person` then throws, so the erasure request is repeated
//    (the same contract as Cloud's own person erase).
//  - The per-task erase is the core's: the same two prefixes under the task's workspace (`evidence-pack/<task>/` and `evidence/<task>/`), from `evidencePrefixesOf`,
//    which Code and Cloud both hold until the deletion lane deletes Cloud's copy. Code's `core/proof` has no index file, so `@rovara-code/broker` does not export
//    its `eraseTaskEvidence`; tests/unit/cloud-app-erase.test.ts holds the two copies to the same prefixes.
import { queryAll, type AdapterRegistry, type DocumentStore, type ObjectStorage } from "@rovara-code/contracts";
import { taskKey } from "../../developer/task-records.js";
import { evidencePrefixesOf } from "../../rovara-code/evidence-erase.js";
import type { CloudApp } from "./app.js";
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
  /** Core tasks whose erase did not finish or failed: the walk must be repeated. */
  incomplete: number;
}

export const EMPTY_PERSON_ERASE_REPORT: PersonEraseOnCoreReport = Object.freeze({ tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, incomplete: 0 });

export interface ErasePersonOnCoreInput {
  /** The sealed registry: its `storage` point holds the task records and stamps, its `object-storage` point holds the evidence. */
  registry: Pick<AdapterRegistry, "require">;
  companyId: string;
  developerId: string;
}

const companyOf = (record: Readonly<Record<string, unknown>> | undefined): unknown => record?.companyId ?? record?.orgId;

/** Erases the evidence of every core-stamped task of one person in one company. Never throws for one task's failure: it counts it. */
export async function erasePersonOnCore(input: ErasePersonOnCoreInput): Promise<PersonEraseOnCoreReport> {
  const { companyId, developerId } = input;
  if (companyId === "" || developerId === "") throw new Error("a person's erase names a company and a person");
  const store: DocumentStore = input.registry.require("storage");
  const objects: ObjectStorage = input.registry.require("object-storage");
  const counts = { tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, incomplete: 0 };
  for (const row of await queryAll(store, { pk: `DEVELOPER#${developerId}`, sk: { op: "beginsWith", prefix: "TASK#" } })) {
    counts.tasks += 1;
    const taskId = typeof row.taskId === "string" ? row.taskId : undefined;
    const rowCompany = companyOf(row);
    if (taskId === undefined || (rowCompany !== undefined && rowCompany !== companyId)) { counts.skipped += 1; continue; }
    if ((await engineOfStoredTask(store, taskId, "flow")) !== "core") { counts.cloudStamped += 1; continue; }
    const task = await store.get(taskKey(taskId));
    if (task === undefined || companyOf(task) !== companyId || typeof task.ownerKey !== "string" || typeof task.workspaceId !== "string") { counts.skipped += 1; continue; }
    const prefixes = evidencePrefixesOf({ ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId });
    if (prefixes === undefined) { counts.incomplete += 1; continue; }
    try {
      let finished = true;
      for (const prefix of prefixes) finished = (await objects.deletePrefix(prefix)) && finished;
      counts[finished ? "erased" : "incomplete"] += 1;
    } catch {
      // The fault's text is not kept (it may carry a key); the count is what the caller acts on.
      counts.incomplete += 1;
    }
  }
  return counts;
}

/** The core's person erase as the person-erasure step calls it. */
export interface CorePersonErase {
  /** Whether any core switch is on. False: `person` does nothing and never builds the registry. */
  readonly active: boolean;
  person(companyId: string, developerId: string): Promise<PersonEraseOnCoreReport>;
}

/** Thrown when a core task's evidence was not all erased. The erasure request is repeated; the walk is idempotent. Carries counts only. */
export class CorePersonEraseUnfinished extends Error {
  constructor(readonly report: PersonEraseOnCoreReport) {
    super(`the core's evidence erase did not finish for ${String(report.incomplete)} of ${String(report.tasks)} tasks`);
    this.name = "CorePersonEraseUnfinished";
  }
}

/** The core's person erase over a composition root. With every switch off it does nothing at all (no registry, no read, no write). */
export function corePersonEraseOf(app: Pick<CloudApp, "active" | "registry">): CorePersonErase {
  return {
    get active() { return app.active; },
    async person(companyId, developerId) {
      if (!app.active) return EMPTY_PERSON_ERASE_REPORT;
      const report = await erasePersonOnCore({ registry: await app.registry(), companyId, developerId });
      if (report.incomplete > 0) throw new CorePersonEraseUnfinished(report);
      return report;
    },
  };
}
