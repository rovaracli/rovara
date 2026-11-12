// Convergence lane A4: whose a workspace is, for the EC2 machines adapter and the core dispatch host. Read on every call, strongly consistent.
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema, type OrgId } from "@rovara-code/contracts";
import { orgOf } from "../../org/resolve.js";

/**
 * The company of `WORKSPACE#<id>/META`: the core's `companyId` when the core wrote the record, else Cloud's `orgId`, else the install's single org
 * (the rule every Cloud reader of a record without an org follows, ruling R3). Undefined when there is no such workspace, or its `companyId` is not a
 * company id: a record that names one badly is never read as the install's.
 */
export function workspaceCompanyReader(documentClient: Pick<DynamoDBDocumentClient, "send">, tableName: string, installOrg: OrgId): (workspaceId: string) => Promise<OrgId | undefined> {
  return async (workspaceId) => {
    const item = (await documentClient.send(new GetCommand({ TableName: tableName, Key: { pk: `WORKSPACE#${workspaceId}`, sk: "META" }, ConsistentRead: true }))).Item;
    if (item === undefined) return undefined;
    if (item.companyId !== undefined) {
      const parsed = OrgIdSchema.safeParse(item.companyId);
      return parsed.success ? parsed.data : undefined;
    }
    return orgOf(installOrg, item);
  };
}
