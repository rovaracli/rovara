import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, agentXError, type OrgId } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
export interface CompanyAuthorityDependencies { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; signInTableName: string }
export interface CompanyViewer { orgId: OrgId; developerId: string; browserSession?: true }
const forbidden = () => agentXError("FORBIDDEN", "Live company owner or admin access is required.");
/** No project grant or operator identity confers company administration. */
export async function requireLiveCompanyAdmin(deps: CompanyAuthorityDependencies, caller: CompanyViewer): Promise<void> {
 if (!OrgIdSchema.safeParse(caller.orgId).success || !/^[a-f0-9]{64}$/.test(caller.developerId)) throw forbidden();
 async function read(Key: { pk: string; sk: string }, TableName = deps.tableName) {
  const row = (await deps.documentClient.send(new GetCommand({ TableName, Key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (row !== undefined && Buffer.byteLength(JSON.stringify(row), "utf8") > 32768) throw forbidden();return row;
 }
 const member = await read(orgMemberKey(caller.orgId, caller.developerId));
 if (member?.orgId !== caller.orgId || member.developerId !== caller.developerId || (member.role !== "owner" && member.role !== "admin")) throw forbidden();
 // The identity row is keyed by the person: a sign-in writes no `developerId` attribute (store.ts getDeveloper), so only a row naming someone else refuses.
 const [pointer, identity, org] = await Promise.all([read(developerOrgKey(caller.developerId)), read({ pk: `DEVELOPER#${caller.developerId}`, sk: "META" }, deps.signInTableName), read(orgMetaKey(caller.orgId))]);
 if (pointer?.orgId !== caller.orgId || pointer.role !== member.role || identity === undefined || (identity.developerId !== undefined && identity.developerId !== caller.developerId) || identity.revoked === true || identity.mergedInto !== undefined || identity.provider === "operator" || identity.entityType === "ADMINISTRATOR" || org === undefined || org.orgId !== caller.orgId || org.closingAt !== undefined || org.closedAt !== undefined) throw forbidden();
}
