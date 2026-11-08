// Lessons capture lane: three small table-backed ports the code-host tap needs to read a human edit and to remember a merge. None holds free text or a diff.
//  - `tableOnceClaims`: "at most once" for a human-edit read (a redelivery, or two deliveries, of the same merge). Holds a hash and an expiry only.
//  - `tablePushIndex`: who put which range of commits on a branch, for the authorship proof of a human edit (the push chain). The sender is kept as the company's canonical developer id, not as the
//    host's account id, so the person's erase reaches it (it is on the person's actor index; `erase.ts` deletes it) and a company member is all it can name. 30 days.
//  - `tableMergeIndex`: a Rovara pull request's merge commit, in both directions (pull request to commit for the task's lessons, commit to task for a revert named by commit). Task ids and shas only.
import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { TEAM_RECORD_GSI2, OrgIdSchema, recordActorIndexValue, teamRecordPk, type OrgId } from "@agentx/contracts";
import type { ActorResolverPort, OnceClaimPort, PushIndexPort, PushRecord, RovaraPullRequest } from "./sources/ports.js";
import type { TeamRecordTable } from "./types.js";

export const ONCE_CLAIM_PK = "TRCLAIM";
export const PUSH_INDEX_SK_PREFIX = "PUSHIDX#";
export const MERGE_INDEX_SK_PREFIX = "MERGEIDX#";
const DAY = 86_400;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const errorName = (error: unknown): string | undefined => (error as { name?: string } | null)?.name;
const SHA = /^[0-9a-f]{40}$/;

export function tableOnceClaims(table: TeamRecordTable, now: () => number = Date.now, ttlDays = 90): OnceClaimPort {
  const keyOf = (key: string): { pk: string; sk: string } => ({ pk: ONCE_CLAIM_PK, sk: `ONCE#${sha256(key)}` });
  return {
    async claim(key) {
      try {
        await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...keyOf(key), entityType: "TEAM_RECORD_ONCE_CLAIM", at: new Date(now()).toISOString(), indexExpiresAt: Math.floor(now() / 1000) + ttlDays * DAY }, ConditionExpression: "attribute_not_exists(pk)" }));
        return true;
      } catch (error) {
        if (errorName(error) === "ConditionalCheckFailedException") return false;
        throw error;
      }
    },
    async release(key) {
      await table.documentClient.send(new DeleteCommand({ TableName: table.tableName, Key: keyOf(key) }));
    },
  };
}

export const PUSH_INDEX_ENTITY = "TEAM_RECORD_PUSH";
const pushKey = (orgId: OrgId, host: string, repo: string, after: string): { pk: string; sk: string } => ({ pk: teamRecordPk(orgId), sk: `${PUSH_INDEX_SK_PREFIX}${sha256(`${host}\u0000${repo}\u0000${after}`)}` });

export function tablePushIndex(table: TeamRecordTable, actors: Pick<ActorResolverPort, "resolve">, now: () => number = Date.now): PushIndexPort {
  return {
    async record({ workspaceId, host, push, ttlSeconds }) {
      const orgId = OrgIdSchema.parse(workspaceId);
      if (!SHA.test(push.before) || !SHA.test(push.after)) return;
      // The sender is looked up now. A bot is kept as a bot; a member as their developer id; anyone else as nobody (the chain then fails closed at this push).
      let developerId: string | undefined;
      if (!push.senderIsBot) {
        const who = await actors.resolve({ workspaceId, project: undefined, system: host, sourceId: push.senderId, isBot: false });
        if (who.trust === "member" && who.developerId !== undefined) developerId = who.developerId;
      }
      await table.documentClient.send(new PutCommand({
        TableName: table.tableName,
        Item: {
          ...pushKey(orgId, host, push.repo, push.after), entityType: PUSH_INDEX_ENTITY, repo: push.repo, ref: push.ref, before: push.before, after: push.after, senderIsBot: push.senderIsBot, at: push.at,
          ...(developerId === undefined ? {} : { senderDeveloperId: developerId, [TEAM_RECORD_GSI2.partition]: recordActorIndexValue(orgId, developerId) }),
          indexExpiresAt: Math.floor(now() / 1000) + ttlSeconds,
        },
      }));
    },
    async byAfter({ workspaceId, host, repo, after }) {
      const orgId = OrgIdSchema.parse(workspaceId);
      const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: pushKey(orgId, host, repo, after), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
      if (item?.entityType !== PUSH_INDEX_ENTITY || item.repo !== repo || typeof item.ref !== "string" || typeof item.before !== "string" || typeof item.after !== "string") return undefined;
      const found: PushRecord = {
        repo, ref: item.ref, before: item.before, after: item.after, senderId: "", senderIsBot: item.senderIsBot === true, at: typeof item.at === "string" ? item.at : "",
        ...(typeof item.senderDeveloperId === "string" ? { senderDeveloperId: item.senderDeveloperId } : {}),
      };
      return found;
    },
  };
}

export const MERGE_INDEX_ENTITY = "TEAM_RECORD_MERGE";
const byShaKey = (orgId: OrgId, host: string, repo: string, sha: string) => ({ pk: teamRecordPk(orgId), sk: `${MERGE_INDEX_SK_PREFIX}SHA#${sha256(`${host}\u0000${repo}\u0000${sha}`)}` });
const byPullRequestKey = (orgId: OrgId, host: string, repo: string, number: number) => ({ pk: teamRecordPk(orgId), sk: `${MERGE_INDEX_SK_PREFIX}PR#${sha256(`${host}\u0000${repo}\u0000${String(number)}`)}` });

export interface MergeNote { workspaceId: string; host: string; repo: string; number: number; taskId: string; project: string; url: string; mergeCommitSha: string }
export interface MergeIndex {
  record(input: MergeNote): Promise<void>;
  byMergeCommit(input: { workspaceId: string; host: string; repo: string; sha: string }): Promise<Pick<RovaraPullRequest, "taskId" | "project" | "number" | "url" | "mergeCommitSha"> | undefined>;
  /** The merge commit noted for a pull request, if any. */
  mergeCommitOf(input: { workspaceId: string; host: string; repo: string; number: number; taskId: string }): Promise<string | undefined>;
}

export function tableMergeIndex(table: TeamRecordTable, now: () => number = Date.now, ttlDays = 400): MergeIndex {
  const get = async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> => {
    const item = ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
    return item?.entityType === MERGE_INDEX_ENTITY ? item : undefined;
  };
  return {
    async record(input) {
      const orgId = OrgIdSchema.parse(input.workspaceId);
      if (!SHA.test(input.mergeCommitSha)) return;
      const body = { entityType: MERGE_INDEX_ENTITY, repo: input.repo, number: input.number, taskId: input.taskId, project: input.project, url: input.url, mergeCommitSha: input.mergeCommitSha, indexExpiresAt: Math.floor(now() / 1000) + ttlDays * DAY };
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...byShaKey(orgId, input.host, input.repo, input.mergeCommitSha), ...body } }));
      await table.documentClient.send(new PutCommand({ TableName: table.tableName, Item: { ...byPullRequestKey(orgId, input.host, input.repo, input.number), ...body } }));
    },
    async byMergeCommit({ workspaceId, host, repo, sha }) {
      const item = await get(byShaKey(OrgIdSchema.parse(workspaceId), host, repo, sha));
      if (item === undefined || item.repo !== repo || typeof item.taskId !== "string" || typeof item.project !== "string" || typeof item.number !== "number" || typeof item.url !== "string") return undefined;
      return { taskId: item.taskId, project: item.project, number: item.number, url: item.url, mergeCommitSha: sha };
    },
    async mergeCommitOf({ workspaceId, host, repo, number, taskId }) {
      const item = await get(byPullRequestKey(OrgIdSchema.parse(workspaceId), host, repo, number));
      // The note belongs to the task it was made for: a pull request number reused by another task's note is not this task's.
      return item !== undefined && item.repo === repo && item.taskId === taskId && typeof item.mergeCommitSha === "string" && SHA.test(item.mergeCommitSha) ? item.mergeCommitSha : undefined;
    },
  };
}
