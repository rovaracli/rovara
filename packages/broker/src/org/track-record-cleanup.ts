// Track record: the company-close erasure of the outcome samples (`OUTCOME#`), their scored copies (`OUTCOME_SCORED#`), the run costs (`RUN_COST#`) and (SRL-3) the merge-commit index (`GITHUB_MERGE`).
// Web intake suggestion caches and per-person rates are also removed here (one-day TTL is only a backstop).
// Their partitions are named by project (and stage, or agent and path), so they are found from the project catalog and the agent directory, not by a
// prefix scan. Like the other close cleanups it runs only while the company is closing or closed, pins that state in every batch, never resends an
// ambiguous call, and a failure stops the close (`closingAt` stays, and the next close resumes). Their expiries (180 and 365 days) are the backstop.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, BUILTIN_AGENT_IDS, OUTCOME_STAGES, OrgIdSchema, agentXError, orgProjectCatalogPk, orgScoped, orgPk, projectPk } from "@rovara-code/contracts";
import { orgMetaKey } from "@agentx/cloud-contracts";
import type { TransactItem } from "../audit/outbox.js";
import type { EstimatePath } from "../spend/estimate.js";

interface Dependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
type Row = Record<string, unknown>;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Track record data could not be cleared. Retry company cleanup.");
const stale = () => agentXError("CHANGE_STALE", "Company cleanup authority changed. Retry company cleanup.");
/** The paths a run cost is kept for. The stages outcomes are kept under are the contract's own list, so the two cannot drift apart. */
const PATHS = ["QUICK", "FULL", "TASK", "AGENT"] as const satisfies readonly EstimatePath[];
/** Compile-time: a path added to `EstimatePath` and missing above stops the build, so its run costs can never be left out of the erasure. */
const ALL_PATHS_ERASED: Exclude<EstimatePath, (typeof PATHS)[number]> extends never ? true : never = true;
void ALL_PATHS_ERASED;
const PAGE = 25;
const MAX_PAGES = 1000;
const MERGE_INDEX_MAX_PAGES = 8000;

export async function clearTrackRecordData(deps: Dependencies, value: unknown): Promise<{ deleted: number }> {
  const parsed = OrgIdSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "Choose a valid company for track record cleanup.");
  const orgId = parsed.data, metaKey = orgMetaKey(orgId);
  try {
    const org = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: metaKey, ConsistentRead: true })) as { Item?: Row }).Item;
    const stamp = z.string().datetime();
    if (org?.orgId !== orgId || (org.closingAt === undefined && org.closedAt === undefined)
      || (org.closingAt !== undefined && !stamp.safeParse(org.closingAt).success) || (org.closedAt !== undefined && !stamp.safeParse(org.closedAt).success)) {
      throw agentXError("FORBIDDEN", "Track record data can be cleared only while this company is closing or closed.");
    }
    const clauses = ["orgId = :org"], values: Row = { ":org": orgId };
    for (const field of ["closingAt", "closedAt"]) {
      if (org[field] === undefined) clauses.push(`attribute_not_exists(${field})`);
      else { clauses.push(`${field} = :${field}`); values[`:${field}`] = org[field]; }
    }
    const fence: TransactItem = { ConditionCheck: { TableName: deps.tableName, Key: metaKey, ConditionExpression: clauses.join(" AND "), ExpressionAttributeValues: values } };
    const send = (command: unknown) => deps.documentClient.send(command);
    const query = async (pk: string, prefix: string | undefined, cursor: { pk: string; sk: string } | undefined) => {
      const result = await send(new QueryCommand({
        TableName: deps.tableName, ConsistentRead: true, Limit: PAGE,
        KeyConditionExpression: prefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ...(prefix === undefined ? {} : { ":prefix": prefix }) },
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
      })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
      if (!Array.isArray(result.Items ?? []) || (result.Items?.length ?? 0) > PAGE) throw unavailable();
      return result;
    };
    const cursorOf = (raw: unknown, pk: string): { pk: string; sk: string } | undefined => {
      if (raw === undefined) return undefined;
      const next = z.object({ pk: z.literal(pk), sk: z.string().min(1) }).strict().safeParse(raw);
      if (!next.success) throw unavailable();
      return next.data;
    };
    /** Every item of one partition, in batches that each pin the closing state. */
    let deleted = 0;
    const clearPartition = async (pk: string, maxPages: number = MAX_PAGES, prefix?: string): Promise<void> => {
      let cursor: { pk: string; sk: string } | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await query(pk, prefix, cursor);
        const keys = (result.Items ?? []).map((raw) => {
          const row = z.object({ pk: z.literal(pk), sk: z.string().min(1) }).passthrough().safeParse(raw);
          if (!row.success || (prefix !== undefined && !row.data.sk.startsWith(prefix))) throw unavailable();
          return { pk, sk: row.data.sk };
        });
        const next = cursorOf(result.LastEvaluatedKey, pk);
        if (keys.length > 0) {
          try {
            await send(new TransactWriteCommand({ TransactItems: [fence, ...keys.map((Key) => ({ Delete: { TableName: deps.tableName, Key } }))] }));
          } catch (error) {
            const reasons = error instanceof Error && error.name === "TransactionCanceledException" ? (error as { CancellationReasons?: Array<{ Code?: string } | null> }).CancellationReasons : undefined;
            if (reasons?.[0]?.Code === "ConditionalCheckFailed") throw stale();
            throw unavailable();
          }
          deleted += keys.length;
        }
        if (next === undefined) return;
        cursor = next;
      }
      throw unavailable();
    };
    /** The names under one prefix of a partition (project catalog entries, agent directory entries). */
    const names = async (pk: string, prefix: string | undefined, pick: (row: Row) => unknown): Promise<string[]> => {
      const found: string[] = [];
      let cursor: { pk: string; sk: string } | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await query(pk, prefix, cursor);
        for (const row of (result.Items ?? []) as Row[]) { const name = pick(row); if (typeof name === "string") found.push(name); }
        const next = cursorOf(result.LastEvaluatedKey, pk);
        if (next === undefined) return found;
        cursor = next;
      }
      throw unavailable();
    };
    // The merge-commit index is one partition for the company (no project or repository to find first); a busy company may hold many rows, so it is given more pages than the others.
    await clearPartition(orgScoped(orgId, "GITHUB_MERGE"), MERGE_INDEX_MAX_PAGES);
    // Web intake rates share the company partition; caches share project partitions.
    // Only these prefixes go, including the original request-id cache writer.
    await clearPartition(orgPk(orgId), MAX_PAGES, "CODE_SUGGEST_RATE#");
    const projects = await names(orgProjectCatalogPk(orgId), "PROJECT#", (row) => row.name);
    const agents = [...new Set([...BUILTIN_AGENT_IDS, ...await names(orgScoped(orgId, "AGENT_DIRECTORY"), undefined, (row) => row.agentId)])];
    for (const project of projects) {
      for (const prefix of ["CODE_SUGGEST_TEXT#", "CODE_SUGGEST#"]) await clearPartition(projectPk(orgId, project), MAX_PAGES, prefix);
      for (const stage of OUTCOME_STAGES) {
        await clearPartition(orgScoped(orgId, `OUTCOME#${project}#${stage}`));
        await clearPartition(orgScoped(orgId, `OUTCOME_SCORED#${project}#${stage}`));
      }
      for (const agent of agents) for (const path of PATHS) await clearPartition(orgScoped(orgId, `RUN_COST#${project}#${agent}#${path}`));
    }
    return { deleted };
  } catch (error) {
    if (error instanceof AgentXError) throw error;
    throw unavailable();
  }
}
