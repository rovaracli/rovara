// Convergence lane A4: whose a workspace is, for the EC2 machines adapter and the core dispatch host. Read on every call, strongly consistent.
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, type OrgId } from "@rovara-code/contracts";

/**
 * The company of `WORKSPACE#<id>/META`: the core's `companyId` when the core wrote the record, else Cloud's `orgId`, else the install's single org
 * (the rule every Cloud reader of a record without an org follows, ruling R3). Undefined (nobody's, never the install's) when there is no such
 * workspace, when either field is present but is not a company id, or when both are present and differ.
 */
export function workspaceCompanyReader(documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string, installOrg: OrgId): (workspaceId: string) => Promise<OrgId | undefined> {
  return async (workspaceId) => {
    const item = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true }))).Item;
    if (item === undefined) return undefined;
    const named = (field: "companyId" | "orgId"): OrgId | undefined | null => {
      if (item[field] === undefined) return undefined;
      const parsed = OrgIdSchema.safeParse(item[field]);
      return parsed.success ? parsed.data : null;
    };
    const companyId = named("companyId");
    const orgId = named("orgId");
    if (companyId === null || orgId === null) return undefined;
    if (companyId !== undefined && orgId !== undefined && companyId !== orgId) return undefined;
    return companyId ?? orgId ?? installOrg;
  };
}
