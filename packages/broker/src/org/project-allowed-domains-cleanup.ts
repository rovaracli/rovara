import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AgentXError, AgentXNameSchema, OrgIdSchema, agentXError, orgMetaKey, orgProjectCatalogPk, projectPk } from "@agentx/contracts";
import type { TransactItem } from "../audit/outbox.js";
interface Dependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }
type Row = Record<string, unknown>;
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Website proposals could not be cleared. Retry company cleanup.");
const stale = () => agentXError("CHANGE_STALE", "Company cleanup authority changed. Retry company cleanup.");
const projectSk = z.string().refine(value => value.startsWith("PROJECT#") && AgentXNameSchema.safeParse(value.slice(8)).success);

/** Bounded, resumable erasure of every website and Slack proposal/receipt generation.
 * No automatic retry after ambiguous deletion. Every batch pins the same durable
 * closing/closed state; failure prevents teardown/final close in OrgStore. */
export async function clearProjectAllowedDomainProposals(deps: Dependencies, value: unknown): Promise<{ deleted: number }> {
 const parsed = OrgIdSchema.safeParse(value);if (!parsed.success) throw agentXError("CONFIG_INVALID", "Choose a valid company for website cleanup.");
 const orgId = parsed.data, metaKey = orgMetaKey(orgId), catalogPk = orgProjectCatalogPk(orgId);
 try {
  const org = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: metaKey, ConsistentRead: true })) as { Item?: Row }).Item;
  if (org?.orgId !== orgId || (org.closingAt === undefined && org.closedAt === undefined)
   || (org.closingAt !== undefined && !z.string().datetime().safeParse(org.closingAt).success) || (org.closedAt !== undefined && !z.string().datetime().safeParse(org.closedAt).success)) throw agentXError("FORBIDDEN", "Website proposals can be cleared only while this company is closing or closed.");
  const clauses = ["orgId = :org"], values: Row = { ":org": orgId };
  for (const field of ["closingAt", "closedAt"]) { if (org[field] === undefined) clauses.push(`attribute_not_exists(${field})`);else { clauses.push(`${field} = :${field}`);values[`:${field}`] = org[field]; } }
  const fence: TransactItem = { ConditionCheck: { TableName: deps.tableName, Key: metaKey, ConditionExpression: clauses.join(" AND "), ExpressionAttributeValues: values } };
  async function page(pk: string, prefix: string, cursor?: { pk: string; sk: string }) {
   const result = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix }, ConsistentRead: true, Limit: 25,
    ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) })) as { Items?: unknown[]; LastEvaluatedKey?: unknown };
   if (!Array.isArray(result.Items ?? []) || (result.Items?.length ?? 0) > 25) throw unavailable();return result;
  }
  function nextCursor(raw: unknown, pk: string, sk: z.ZodType<string>, seen: Set<string>) {
   if (raw === undefined) return undefined;
   const next = z.object({ pk: z.literal(pk), sk }).strict().safeParse(raw);if (!next.success || seen.has(next.data.sk)) throw unavailable();seen.add(next.data.sk);return next.data;
  }
  let catalogCursor: { pk: string; sk: string } | undefined, deleted = 0;
  const catalogSeen = new Set<string>(), projectsSeen = new Set<string>();
  for (let catalogPage = 0; catalogPage < 100; catalogPage += 1) {
   const catalog = await page(catalogPk, "PROJECT#", catalogCursor);
   const nextCatalog = nextCursor(catalog.LastEvaluatedKey, catalogPk, projectSk, catalogSeen);
   for (const raw of catalog.Items ?? []) {
    const checked = z.object({ pk: z.literal(catalogPk), sk: projectSk, name: AgentXNameSchema, orgId: z.literal(orgId).optional() }).passthrough().safeParse(raw);
    if (!checked.success || checked.data.sk !== `PROJECT#${checked.data.name}` || projectsSeen.has(checked.data.name)) throw unavailable();
    const project = checked.data.name, pk = projectPk(orgId, project);projectsSeen.add(project);
    for (const family of ["EGRESS_PROPOSAL", "SLACK_BINDING_PROPOSAL"] as const) {
    const liveType = `${family}_LIVE`;
    const proposalSk = z.string().refine(value => value === liveType || (value.startsWith(`${family}#`) && z.string().uuid().safeParse(value.slice(family.length + 1)).success));
    let cursor: { pk: string; sk: string } | undefined;const seen = new Set<string>();let complete = false;
    for (let proposalPage = 0; proposalPage < 100; proposalPage += 1) {
     const proposals = await page(pk, family, cursor), next = nextCursor(proposals.LastEvaluatedKey, pk, proposalSk, seen);
     const rows = (proposals.Items ?? []).map(item => {
      const row = z.object({ pk: z.literal(pk), sk: proposalSk, orgId: z.literal(orgId), project: z.literal(project), entityType: z.enum([family, liveType]) }).passthrough().safeParse(item);
      if (!row.success || row.data.entityType !== (row.data.sk === liveType ? liveType : family)) throw unavailable();return row.data;
     });
     if (new Set(rows.map(row => row.sk)).size !== rows.length || deleted + rows.length > 10000) throw unavailable();
     if (rows.length > 0) {
      const items: TransactItem[] = [fence, ...rows.map(row => ({ Delete: { TableName: deps.tableName, Key: { pk, sk: row.sk },
       ConditionExpression: "attribute_not_exists(pk) OR (orgId = :org AND #project = :project AND entityType = :type)", ExpressionAttributeNames: { "#project": "project" }, ExpressionAttributeValues: { ":org": orgId, ":project": project, ":type": row.entityType } } }))];
      try { await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items })); }
      catch (error) {
       if (error instanceof Error && error.name === "TransactionCanceledException") {
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;if (reasons?.[0]?.Code === "ConditionalCheckFailed") throw stale();
       }
       throw unavailable();
      }
      deleted += rows.length;
     }
     if (next === undefined) { complete = true;break; }cursor = next;
    }
    if (!complete) throw unavailable();
    }
   }
   if (nextCatalog === undefined) return { deleted };catalogCursor = nextCatalog;
  }
  throw unavailable();
 } catch (error) { if (error instanceof AgentXError) throw error;throw unavailable(); }
}
