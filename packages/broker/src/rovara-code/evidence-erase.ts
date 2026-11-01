// Proof and evidence (wire-proof fix round 1): deleting what the evidence path stored, when a person is erased, a project is archived or a company closes. Two kinds of object live under a task's workspace:
//   private/<owner>/<workspace>/evidence-pack/<task>/<digest>.json   the pack (test names, check labels, paths)
//   private/<owner>/<workspace>/evidence/<task>/<sha256>            output tails (and any artifact the capture lane adds)
// The tails and the pack both carry the `evidence-std` retention tag (30 days by default), so they expire on their own on a stack whose bucket has the rule; this is the deletion that does not wait for it. It is
// NOT behind the proof switch: evidence kept while the switch was on is erased after it was turned off too, and with nothing stored the walk finds nothing (one list call per workspace).
//
// The same bounded, resumable shape as the Team record's erase: a call does what its budget allows and says whether it finished; the callers (the person erase, the project archive, the company close) throw
// when it did not, so the request that asked is repeated. Only keys under the exact prefixes above are ever listed or deleted; an owner or workspace id that is not a plain id is refused, so no id can widen a prefix.
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { WORKSPACE_PROJECT_INDEX, orgProjectCatalogPk, workspaceProjectIndexValue, type OrgId } from "@agentx/contracts";
import { taskKey } from "../developer/task-records.js";

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** The prefixes of one task's evidence in a workspace; `taskId` undefined is every task's in that workspace. Undefined when an id is not a plain id. */
export function evidencePrefixesOf(scope: { ownerKey: string; workspaceId: string; taskId?: string | undefined }): string[] | undefined {
  if (!PLAIN.test(scope.ownerKey) || !PLAIN.test(scope.workspaceId) || (scope.taskId !== undefined && !PLAIN.test(scope.taskId))) return undefined;
  const base = `private/${scope.ownerKey}/${scope.workspaceId}`;
  const tail = scope.taskId === undefined ? "/" : `/${scope.taskId}/`;
  return [`${base}/evidence-pack${tail}`, `${base}/evidence${tail}`];
}

export interface EvidenceErasePorts {
  s3: Pick<S3Client, "send">;
  artifactBucketName: string;
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now?: (() => number) | undefined;
  /** The most milliseconds one call spends (default 20 s). */
  maxMs?: number | undefined;
}

export interface EvidenceErase {
  /** The evidence of every task the person created or owns. */
  person(orgId: OrgId, developerId: string): Promise<void>;
  /** The evidence of every workspace of the project. */
  project(orgId: OrgId, project: string): Promise<void>;
  /** The evidence of every project of the company. */
  workspace(orgId: OrgId): Promise<void>;
}

const unfinished = (): Error => Object.assign(new Error("evidence erase did not finish"), { name: "EvidenceEraseUnfinished" });

/**
 * Deletes every key under `prefix`: a page is listed from the start, deleted, and listed again until a listing is empty. Returns whether it finished before `stop`; a delete the store reports an error for
 * is not finished. (A store that silently keeps what it was told to delete cannot loop: the time bound ends it as unfinished.)
 */
async function deletePrefix(ports: EvidenceErasePorts, prefix: string, stop: number): Promise<boolean> {
  const now = ports.now ?? Date.now;
  for (;;) {
    if (now() >= stop) return false;
    const page = await ports.s3.send(new ListObjectsV2Command({ Bucket: ports.artifactBucketName, Prefix: prefix })) as { Contents?: Array<{ Key?: string }> };
    const keys = (page.Contents ?? []).flatMap((object) => (object.Key !== undefined && object.Key.startsWith(prefix) ? [object.Key] : []));
    if (keys.length === 0) return true;
    const deleted = await ports.s3.send(new DeleteObjectsCommand({ Bucket: ports.artifactBucketName, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } })) as { Errors?: unknown[] };
    if ((deleted.Errors?.length ?? 0) > 0) return false;
  }
}

export function createEvidenceErase(ports: EvidenceErasePorts): EvidenceErase {
  const now = ports.now ?? Date.now;
  const budget = () => now() + (ports.maxMs ?? 20_000);
  async function eraseScopes(scopes: AsyncIterable<{ ownerKey: string; workspaceId: string; taskId?: string | undefined }>): Promise<void> {
    const stop = budget();
    let finished = true;
    for await (const scope of scopes) {
      const prefixes = evidencePrefixesOf(scope);
      if (prefixes === undefined) continue;
      for (const prefix of prefixes) if (!(await deletePrefix(ports, prefix, stop))) finished = false;
    }
    if (!finished) throw unfinished();
  }
  async function* pages(query: (start: Record<string, unknown> | undefined) => Promise<{ Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> }>, limit = 5_000): AsyncGenerator<Record<string, unknown>> {
    let start: Record<string, unknown> | undefined;
    let seen = 0;
    do {
      const page = await query(start);
      for (const item of page.Items ?? []) { seen += 1; yield item; }
      start = page.LastEvaluatedKey;
    } while (start !== undefined && seen < limit);
    if (start !== undefined) throw unfinished();
  }
  async function* workspacesOfProject(orgId: OrgId, project: string) {
    for await (const item of pages((start) => ports.documentClient.send(new QueryCommand({
      TableName: ports.tableName, IndexName: WORKSPACE_PROJECT_INDEX.name, KeyConditionExpression: "#project = :project", ExpressionAttributeNames: { "#project": WORKSPACE_PROJECT_INDEX.partitionKey },
      ExpressionAttributeValues: { ":project": workspaceProjectIndexValue(orgId, project) }, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as Promise<{ Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> }>)) {
      if (typeof item.ownerKey === "string" && typeof item.id === "string") yield { ownerKey: item.ownerKey, workspaceId: item.id };
    }
  }
  return {
    async person(orgId, developerId) {
      async function* tasksOfPerson() {
        for await (const row of pages((start) => ports.documentClient.send(new QueryCommand({
          TableName: ports.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": `DEVELOPER#${developerId}`, ":prefix": "TASK#" }, ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })) as Promise<{ Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> }>)) {
          if (row.orgId !== orgId || typeof row.taskId !== "string") continue;
          const task = ((await ports.documentClient.send(new GetCommand({ TableName: ports.tableName, Key: taskKey(row.taskId), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
          if (task !== undefined && task.orgId === orgId && typeof task.ownerKey === "string" && typeof task.workspaceId === "string") yield { ownerKey: task.ownerKey, workspaceId: task.workspaceId, taskId: row.taskId };
        }
      }
      await eraseScopes(tasksOfPerson());
    },
    async project(orgId, project) { await eraseScopes(workspacesOfProject(orgId, project)); },
    async workspace(orgId) {
      async function* everyProject() {
        for await (const item of pages((start) => ports.documentClient.send(new QueryCommand({
          TableName: ports.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgProjectCatalogPk(orgId), ":prefix": "PROJECT#" }, ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })) as Promise<{ Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> }>)) {
          if (typeof item.sk === "string") yield* workspacesOfProject(orgId, item.sk.slice("PROJECT#".length));
        }
      }
      await eraseScopes(everyProject());
    },
  };
}
