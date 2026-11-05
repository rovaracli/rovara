// S2: whether a person can really take a task over right now, read from the stored rows alone (no Slack): a writer company role (the Auditor is not one), and either a company owner or admin (a maintainer of
// every project) or a direct project grant whose role may start tasks (a viewer may not). Task take-over needs the session level `edit` for a co-owner, a project role that may start tasks, and a writer
// company role (agent-sessions/access.ts); a person whose project access is only through a Slack channel cannot be confirmed here and is left out (nobody is told something that may not be true).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, orgMemberKey, projectAllows, projectMemberKey, type OrgId, type Payer } from "@agentx/contracts";
import { isRovaraCodeAgent } from "../agents/rovara-code-task.js";
import type { TaskAgentRef } from "../agents/roster.js";
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

/** Plan 3's budget check for the person who would pay from now on (`SessionTakeOverDependencies.admitPayer`): throws that budget's own refusal when they have no room. */
export type AdmitTaker = (input: { orgId: OrgId; project: string; payer: Payer; agentId: string; agentName: string; path: "TASK" | "AGENT" }) => Promise<void>;

/**
 * Whether the budget check of a real Take over (`admitTaker`, agent-sessions/take-over.ts) would let `developerId` take the task over: only when a member pays does the taker's own budget count, and a
 * budget refusal means the Take over would be refused. A check that cannot be made (no `admitPayer`, the proxy down, any fault that is not a refusal) says yes: the Take over itself is a retry away, and
 * the notice makes no promise beyond "you can take it over".
 */
export async function takerBudgetAllows(
  admitPayer: AdmitTaker | undefined, task: { orgId?: string | undefined; project: string; developerId: string; payer?: Payer | undefined; agent?: TaskAgentRef | undefined }, developerId: string,
): Promise<boolean> {
  if (admitPayer === undefined || task.orgId === undefined) return true;
  if ((task.payer ?? { kind: "member", developerId: task.developerId }).kind !== "member") return true;
  const agent = task.agent;
  try {
    await admitPayer({ orgId: task.orgId, project: task.project, payer: { kind: "member", developerId },
      agentId: agent?.agentId ?? "rovara-code", agentName: agent?.name ?? "Rovara Code", path: agent === undefined || isRovaraCodeAgent(agent) ? "TASK" : "AGENT" });
    return true;
  } catch (error) {
    return !(error instanceof AgentXError) || error.code === "MODEL_PROXY_UNAVAILABLE" || error.code === "RUNTIME_UNAVAILABLE";
  }
}
