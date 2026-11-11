// Plan 3 Task 14b: what one run looks up and keeps for its own length. The repository scan (comment-trigger-scan.ts) and the label names
// (label-names.ts) are read from GitHub or a connector once per run, not once per call. A cache holds nothing across runs: the task id is part of
// every key, and the next run reads again, so a changed workflow or a renamed label is seen by the next run.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, runCacheKey, type OrgId } from "@rovara-code/contracts";

/** A place to keep a JSON value for the length of one run, by kind and name. */
export interface RunCache {
  get(kind: string, name: string): Promise<unknown>;
  set(kind: string, name: string, value: unknown): Promise<void>;
}

/** A cache that lives as long as the object: for a caller that makes all of a run's calls in one process, and for tests. */
export function memoryRunCache(): RunCache {
  const held = new Map<string, unknown>();
  return {
    async get(kind, name) { return held.has(`${kind}#${name}`) ? structuredClone(held.get(`${kind}#${name}`)) : undefined; },
    async set(kind, name, value) { held.set(`${kind}#${name}`, structuredClone(value)); },
  };
}

/** A cache item outlives the longest run by a wide margin, and the State table's TTL removes it. */
export const RUN_CACHE_DAYS = 30;

/** The name a repository or connector is kept under: a hash, so no name from outside reaches a key. */
export const cacheNameOf = (...parts: string[]): string => createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 40);

export interface TaskRunCacheDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
}

/**
 * The cache of one task's run, kept in the State table under the org and the task: `get` reads consistently and answers nothing for an item
 * that names another org, so a task id from elsewhere reads as empty.
 */
export function taskRunCache(deps: TaskRunCacheDependencies, scope: { orgId: OrgId; taskId: string }): RunCache {
  return {
    async get(kind, name) {
      const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: runCacheKey(scope.orgId, scope.taskId, kind, name), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      const item = response.Item;
      if (item === undefined || item["orgId"] !== scope.orgId || item["taskId"] !== scope.taskId) return undefined;
      return item["value"];
    },
    async set(kind, name, value) {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: {
          ...runCacheKey(scope.orgId, scope.taskId, kind, name), entityType: "RUN_CACHE", orgId: scope.orgId, taskId: scope.taskId, kind, value,
          [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + RUN_CACHE_DAYS * 86_400,
        },
      }));
    },
  };
}
