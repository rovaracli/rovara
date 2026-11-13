// Area 39 (erasure), compared on the part both paths have: a person's task evidence (the evidence pack and the output tails kept under the task's workspace).
//   Cloud: its person erase (`createEvidenceErase(...).person`, packages/broker/src/rovara-code/evidence-erase.ts), which walks the person's task index and deletes
//          each task's evidence prefixes in the artifact bucket;
//   core:  Code's core has no walk by person (decision 41: vendor core/proof/evidence-erase.ts:6-7). Its counterpart is per task (`eraseTaskEvidence`). The walk
//          below is the S0 adapter the composition root owes, written test-side: the person's task index rows in the core's store, each task's owner key and
//          workspace, then `eraseTaskEvidence` on the object-storage point. The product adapter is proposed in the lane report.
// The same objects are put on both sides: two for the erased person's task, two for another person's task (which must stay). Each is reported `<family>:erased|kept`.
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { queryAll, type DocumentStore, type ObjectStorage } from "@rovara-code/contracts";
import { eraseTaskEvidence } from "../../../../vendor/rovara-code/packages/broker/src/core/proof/evidence-erase.js";
import { createEvidenceErase, markEvidenceStored } from "../../../../packages/broker/src/rovara-code/evidence-erase.js";

export interface EvidenceScope { ownerKey: string; workspaceId: string; taskId: string }

/** The objects put for the erased person's task and for another person's task, by family. */
export function seededObjects(own: EvidenceScope, other: EvidenceScope): Record<string, string> {
  const pack = (scope: EvidenceScope) => `private/${scope.ownerKey}/${scope.workspaceId}/evidence-pack/${scope.taskId}/${"a".repeat(64)}.json`;
  const tail = (scope: EvidenceScope) => `private/${scope.ownerKey}/${scope.workspaceId}/evidence/${scope.taskId}/${"b".repeat(64)}`;
  return { "own-pack": pack(own), "own-tail": tail(own), "other-pack": pack(other), "other-tail": tail(other) };
}

export const OTHER_SCOPE: EvidenceScope = { ownerKey: "0".repeat(64), workspaceId: "11111111-2222-4333-8444-555555555555", taskId: "66666666-7777-4888-8999-aaaaaaaaaaaa" };

const wordsOf = async (objects: Record<string, string>, exists: (key: string) => Promise<boolean>): Promise<string[]> =>
  Promise.all(Object.entries(objects).map(async ([family, key]) => `${family}:${(await exists(key)) ? "kept" : "erased"}`));

/** The journey harness's artifact bucket is a map: this answers the two S3 commands the erase sends that the harness's own fake does not (list and batch delete). */
export function bucketOver(objects: Map<string, string>, binary: Map<string, Buffer>, fallback: { send(command: unknown): Promise<unknown> }) {
  return {
    async send(command: { constructor: { name: string }; input: { Prefix?: string; Delete?: { Objects?: Array<{ Key?: string }> } } }): Promise<unknown> {
      if (command.constructor.name === "ListObjectsV2Command") {
        const prefix = command.input.Prefix ?? "";
        return { Contents: [...objects.keys(), ...binary.keys()].filter((key) => key.startsWith(prefix)).map((Key) => ({ Key })) };
      }
      if (command.constructor.name === "DeleteObjectsCommand") {
        for (const entry of command.input.Delete?.Objects ?? []) if (entry.Key !== undefined) { objects.delete(entry.Key); binary.delete(entry.Key); }
        return { Errors: [] };
      }
      return await fallback.send(command);
    },
  };
}

/** Cloud: puts the objects, marks the company as one that kept evidence (Cloud's own write does), and runs its person erase. */
export async function cloudErase(input: { s3: { send(command: unknown): Promise<unknown>; objects: Map<string, string>; binary: Map<string, Buffer> }; db: { send(command: unknown): Promise<unknown> }; orgId: string; developerId: string; own: EvidenceScope }): Promise<string[]> {
  const objects = seededObjects(input.own, OTHER_SCOPE);
  for (const key of Object.values(objects)) await input.s3.send(new PutObjectCommand({ Bucket: "artifacts", Key: key, Body: "{}" }));
  const ports = { s3: bucketOver(input.s3.objects, input.s3.binary, input.s3) as never, artifactBucketName: "artifacts", documentClient: input.db, tableName: "state" };
  await markEvidenceStored(ports, input.orgId);
  await createEvidenceErase(ports).person(input.orgId, input.developerId);
  return wordsOf(objects, async (key) => input.s3.objects.has(key) || input.s3.binary.has(key));
}

/** The S0 adapter the composition root owes (test-side): a person's tasks from their task index, each task's evidence erased with the core's own per-task erase. */
export async function erasePersonOnCore(store: DocumentStore, objects: ObjectStorage, companyId: string, developerId: string): Promise<number> {
  let erased = 0;
  for (const row of await queryAll(store, { pk: `DEVELOPER#${developerId}`, sk: { op: "beginsWith", prefix: "TASK#" } })) {
    const taskId = typeof row.taskId === "string" ? row.taskId : undefined;
    if (taskId === undefined) continue;
    const task = await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" });
    const company = task?.companyId ?? task?.orgId;
    if (task === undefined || company !== companyId || typeof task.ownerKey !== "string" || typeof task.workspaceId !== "string") continue;
    await eraseTaskEvidence(objects, { ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId });
    erased += 1;
  }
  return erased;
}

/** Core: puts the same objects on the object-storage point and runs the adapter above. */
export async function coreErase(input: { store: DocumentStore; objects: ObjectStorage; companyId: string; developerId: string; own: EvidenceScope }): Promise<string[]> {
  const objects = seededObjects(input.own, OTHER_SCOPE);
  for (const key of Object.values(objects)) await input.objects.put(key, new TextEncoder().encode("{}"), { contentType: "application/json", metadata: {}, retention: "evidence-std" });
  await erasePersonOnCore(input.store, input.objects, input.companyId, input.developerId);
  return wordsOf(objects, async (key) => (await input.objects.stat(key)) !== undefined);
}
