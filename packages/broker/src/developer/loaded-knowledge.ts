// K1 C5a: "what the agent loaded", on the broker.
//
// Stores the worker's loaded-knowledge records (references only: no rule text, no skill text, no quote) beside the task, and answers two
// reads: the records of a task, and the text of one listed rule file on demand.
//
// Who sees what (S2 11.4):
// - anyone who can see the task sees the records;
// - an Auditor (enterprise) sees the records without the conversation, but never the text;
// - the text of a rule file is fetched only for a viewer who can read that repository, only for a file the record lists, only from the commit
//   the stage read, and only while the file still hashes to the digest the worker recorded.
// Nothing here is a hot-file edit: `routeLoadedKnowledge` is the one function `developer-routes.ts` calls (see the report's wiring section).
import { createHash } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  INDEX_EXPIRY_ATTRIBUTE, LOADED_KNOWLEDGE_STAGES, LoadedKnowledgeManifestSchema, agentXError, loadedKnowledgeOfProgress, type LoadedKnowledgeManifest, type OrgId,
} from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { resolveTaskAccess } from "./task-access.js";
import { taskKey, type DeveloperTaskRecord } from "./task-records.js";

type Table = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName">;

/** Records are kept as long as the task's other records (about 13 months); they hold no text. */
const RETENTION_SECONDS = 400 * 86_400;
/** At most this many records are read for one task (a task runs a handful of stages, some more than once). */
const MAX_RECORDS_PER_TASK = 100;
const PREFIX = "LOADEDKNOW#";
const OPERATION_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const TEXT_MAX_BYTES = 64 * 1024;

const sortKey = (stage: string, operationId: string, role?: string): string => `${PREFIX}${stage}#${operationId}${role === undefined ? "" : `#${role}`}`;

export interface StoredLoadedKnowledge {
  stage: LoadedKnowledgeManifest["stage"];
  operationId: string;
  recordedAt: string;
  role?: "CRITIC" | "SECURITY";
  manifest: LoadedKnowledgeManifest;
}

/**
 * Stores the record a worker progress payload carries, if it carries one: a malformed record is dropped whole, never partly stored. The same
 * stage of the same operation overwrites its earlier record (the worker reports at the start and again at the end). Returns whether it stored.
 * A failed write never fails the caller: this is information, and it can never set a verdict.
 */
export async function recordLoadedKnowledgeFromProgress(
  deps: Table & Pick<DeveloperTaskRouteDependencies, "now" | "log">,
  input: { taskId: string; operationId: string; payload: unknown },
): Promise<boolean> {
  const manifest = loadedKnowledgeOfProgress(input.payload);
  if (manifest === undefined || !OPERATION_ID.test(input.operationId)) return false;
  const recordedAt = new Date((deps.now ?? Date.now)()).toISOString();
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk: taskKey(input.taskId).pk, sk: sortKey(manifest.stage, input.operationId, manifest.role), entityType: "LOADED_KNOWLEDGE",
        taskId: input.taskId, stage: manifest.stage, operationId: input.operationId, recordedAt, ...(manifest.role === undefined ? {} : { role: manifest.role }), manifest,
        [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(recordedAt) / 1000) + RETENTION_SECONDS,
      },
    }));
    return true;
  } catch {
    (deps.log ?? ((entry) => console.log(JSON.stringify({ component: "broker", ...entry }))))({ event: "developer.loaded_knowledge_not_stored", taskId: input.taskId });
    return false;
  }
}

export async function listLoadedKnowledge(deps: Table, taskId: string): Promise<StoredLoadedKnowledge[]> {
  const found: StoredLoadedKnowledge[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": taskKey(taskId).pk, ":prefix": PREFIX }, ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of response.Items ?? []) {
      const manifest = LoadedKnowledgeManifestSchema.safeParse(item.manifest);
      // A record that no longer parses (an older shape) is left out, never shown half-read.
      if (manifest.success && typeof item.operationId === "string" && typeof item.recordedAt === "string") {
        found.push({ stage: manifest.data.stage, operationId: item.operationId, recordedAt: item.recordedAt, ...(manifest.data.role === undefined ? {} : { role: manifest.data.role }), manifest: manifest.data });
      }
    }
    start = response.LastEvaluatedKey;
  } while (start !== undefined && found.length < MAX_RECORDS_PER_TASK);
  return found.slice(0, MAX_RECORDS_PER_TASK).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.stage.localeCompare(right.stage));
}

export interface LoadedKnowledgeRouteDependencies extends Table, Pick<DeveloperTaskRouteDependencies, "now" | "log"> {
  /** Everything `resolveTaskAccess` needs; the caller passes the route dependencies it already has. */
  access: Parameters<typeof resolveTaskAccess>[0];
  /** Enterprise: whether the caller holds the Auditor role. Auditors read the records, never the text. */
  isAuditor?: (caller: DeveloperCaller) => Promise<boolean>;
  /** Whether the caller can read this repository of the task's project, judged live (not from the task page's own role). Absent: no text is served. */
  canReadRepository?: (caller: DeveloperCaller, input: { project: string; repo: string }) => Promise<boolean>;
  /** The file at `path` of `repo` as stored at `commit`; undefined when it cannot be read. Absent: no text is served. */
  readRuleFile?: (input: { orgId: OrgId; project: string; repo: string; path: string; commit: string }) => Promise<string | undefined>;
}

const notFound = () => agentXError("TASK_NOT_FOUND", "no task here that you can see");

async function recordsFor(deps: LoadedKnowledgeRouteDependencies, caller: DeveloperCaller, taskId: string): Promise<{ task: DeveloperTaskRecord; viaAuditor: boolean }> {
  try {
    return { task: (await resolveTaskAccess(deps.access, caller, taskId, "read")).task, viaAuditor: false };
  } catch (error) {
    // An Auditor of the same org reads the records of any of its tasks; anything that cannot be checked reads as no task.
    const auditor = await (deps.isAuditor?.(caller) ?? Promise.resolve(false)).catch(() => false);
    if (!auditor) throw error;
    const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true })) as { Item?: DeveloperTaskRecord };
    if (response.Item === undefined || response.Item.orgId !== caller.orgId) throw notFound();
    return { task: response.Item, viaAuditor: true };
  }
}

export const LOADED_KNOWLEDGE_PATH = /^\/v1\/app\/tasks\/([0-9a-f-]{36})\/loaded-knowledge(?:\/([A-Za-z0-9_-]{1,80})\/([a-z_]{1,20}(?:\.[A-Z]{1,10})?)\/items\/(\d{1,3})\/text)?$/u;

/**
 * `GET /v1/app/tasks/{taskId}/loaded-knowledge` and `GET /v1/app/tasks/{taskId}/loaded-knowledge/{operationId}/{stage}/items/{n}/text`.
 * Returns undefined for any other request, so the caller can try its next route.
 */
export async function routeLoadedKnowledge(
  deps: LoadedKnowledgeRouteDependencies,
  caller: DeveloperCaller,
  request: { method: string; path: string },
): Promise<object | undefined> {
  const match = LOADED_KNOWLEDGE_PATH.exec(request.path);
  if (match === null || request.method !== "GET") return undefined;
  const [, taskId, operationId, stage, index] = match;
  const { task, viaAuditor } = await recordsFor(deps, caller, taskId!);
  const records = await listLoadedKnowledge(deps, taskId!);
  if (operationId === undefined) return { stages: records };

  // The text of one listed file.
  if (viaAuditor) throw agentXError("FORBIDDEN", "Auditors see which rules a task loaded, not their text.");
  // The stage segment is the stage, or `stage.ROLE` for one of the two reviewers.
  const [stageName, roleName] = stage!.split(".");
  if (!(LOADED_KNOWLEDGE_STAGES as readonly string[]).includes(stageName!)) throw notFound();
  const record = records.find((entry) => entry.operationId === operationId && entry.stage === stageName && entry.role === roleName);
  const item = record?.manifest.items[Number(index)];
  if (record === undefined || item === undefined || item.status === "available" || item.repo === undefined || item.path === undefined || item.fileDigest === undefined) throw notFound();
  // Defence in depth: the record is worker-written, so what it names is checked before it goes to a reader.
  const knownRepo = record.manifest.metaRepo?.name === item.repo || record.manifest.repos.some((repository) => repository.name === item.repo);
  if (!knownRepo || item.path.startsWith("/") || item.path.includes("\0") || item.path.split("/").some((part) => part === ".." || part === "")) throw notFound();
  if (deps.canReadRepository === undefined || deps.readRuleFile === undefined) {
    throw agentXError("FORBIDDEN", "The text of this rule is not available here.");
  }
  const allowed = await deps.canReadRepository(caller, { project: task.project, repo: item.repo }).catch(() => false);
  if (!allowed) throw agentXError("FORBIDDEN", "You can't read this repository, so you can't read its rule text.");
  const commit = record.manifest.metaRepo?.name === item.repo
    ? record.manifest.metaRepo.knowledgeCommit
    : item.readAt === "working" ? undefined : record.manifest.repos.find((repository) => repository.name === item.repo)?.commit;
  if (commit === undefined) return { available: false, reason: "not_kept" as const };
  let text: string | undefined;
  try { text = await deps.readRuleFile({ orgId: caller.orgId, project: task.project, repo: item.repo, path: item.path, commit }); } catch { text = undefined; }
  if (text === undefined) return { available: false, reason: "unreadable" as const };
  // The file at a commit cannot change; a different hash means the wrong file was fetched, and it is not shown.
  if (createHash("sha256").update(text, "utf8").digest("hex") !== item.fileDigest) return { available: false, reason: "changed" as const };
  const bytes = Buffer.byteLength(text, "utf8");
  return { available: true, repo: item.repo, path: item.path, commit, truncated: bytes > TEXT_MAX_BYTES, text: bytes > TEXT_MAX_BYTES ? Buffer.from(text, "utf8").subarray(0, TEXT_MAX_BYTES).toString("utf8") : text };
}
