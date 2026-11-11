// Member removal (v1.1), task 3: the checks that make authority that was cached or stored elsewhere (a Slack identity link, a stored task person, a decision judged earlier, a
// realtime token) notice a removal. Each reads the member record live and consistently.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { orgMemberKey, orgRemovedKey, type OrgRole } from "@agentx/cloud-contracts";
import { REMOVED_FROM_ORG_MESSAGE } from "../sign-in.js";

export interface GuardDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

async function read(deps: GuardDeps, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
}

/** Whether the person was a member of the org and is not now: no member record, and the removal's tombstone is there. A person who never joined is not removed. */
export async function isRemovedFromOrg(deps: GuardDeps, orgId: OrgId, developerId: string): Promise<boolean> {
  if (await read(deps, orgMemberKey(orgId, developerId)) !== undefined) return false;
  return await read(deps, orgRemovedKey(orgId, developerId)) !== undefined;
}

/** Refuses (REMOVED_FROM_ORG, 403) a person who was removed from the org. A member, and a person who never joined (a Slack user who has not signed in yet), pass. */
export async function requireNotRemoved(deps: GuardDeps, orgId: OrgId, developerId: string): Promise<void> {
  if (await isRemovedFromOrg(deps, orgId, developerId)) throw agentXError("REMOVED_FROM_ORG", REMOVED_FROM_ORG_MESSAGE);
}

/**
 * The ConditionCheck that a decision's claim carries: the decider is still a member of the org and still holds the role their authority was judged under (a demoted admin must not
 * decide, and a removed person cannot).
 */
export function deciderStillMemberCheck(tableName: string, orgId: OrgId, developerId: string, role: OrgRole) {
  return {
    ConditionCheck: {
      TableName: tableName, Key: orgMemberKey(orgId, developerId), ConditionExpression: "attribute_exists(pk) AND orgId = :org AND developerId = :decider AND #role = :seenRole",
      ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":decider": developerId, ":seenRole": role },
    },
  };
}
