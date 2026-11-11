// Org-scoped Slack thread records. Old rows are reachable only through their checked workspace.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { installOrgIdFromEnvironment } from "../org/resolve.js";
import { orgScoped, type OrgId } from "@rovara-code/contracts";

type Key = { pk: string; sk: string };
type Table = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string };
export const slackThreadKey = (orgId: OrgId, ownerKey: string): Key => ({ pk: orgScoped(orgId, `SLACK_THREAD#${ownerKey}`), sk: "META" });

/** Prefer new rows; preserve pre-scoping records only when both the row and its workspace belong to this org. Never writes. */
export async function resolveSlackThreadKey(table: Table, orgId: OrgId, ownerKey: string, installOrg: OrgId = installOrgIdFromEnvironment()): Promise<Key> {
  const get = async (key: Key) => ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  const scoped = slackThreadKey(orgId, ownerKey);
  if (await get(scoped) !== undefined) return scoped;
  const legacy = { pk: `SLACK_THREAD#${ownerKey}`, sk: "META" };
  const row = await get(legacy);
  if (row === undefined || (row.orgId !== undefined && row.orgId !== orgId) || typeof row.workspaceId !== "string") return scoped;
  const workspace = await get({ pk: `WORKSPACE#${row.workspaceId}`, sk: "META" });
  return workspace !== undefined && (workspace.orgId ?? installOrg) === orgId && workspace.ownerKey === ownerKey ? legacy : scoped;
}
