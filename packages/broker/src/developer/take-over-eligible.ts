// S2: whether a person can really take a task over right now, read from the stored rows alone (no Slack): a writer company role (the Auditor is not one), and either a company owner or admin (a maintainer of
// every project) or a direct project grant whose role may start tasks (a viewer may not). Task take-over needs the session level `edit` for a co-owner, a project role that may start tasks, and a writer
// company role (agent-sessions/access.ts); a person whose project access is only through a Slack channel cannot be confirmed here and is left out (nobody is told something that may not be true).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { orgMemberKey, projectAllows, projectMemberKey } from "@agentx/contracts";
import { grantRoleOf } from "./project-roles.js";

export async function canTakeOverNow(
  table: { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }, task: { orgId?: string | undefined; project: string }, developerId: string,
): Promise<boolean> {
  if (task.orgId === undefined) return false;
  const orgId = task.orgId;
  const read = async (key: { pk: string; sk: string }) => (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  const member = await read(orgMemberKey(orgId, developerId));
  const role = member?.role;
  if (role !== "owner" && role !== "admin" && role !== "member") return false;
  if (role === "owner" || role === "admin") return true;
  const grant = grantRoleOf(await read(projectMemberKey(orgId, developerId, task.project)));
  return grant !== undefined && projectAllows(grant, "start_tasks");
}
