// The real AWS side of team-record-preflight.ts: one read-only DescribeTable on the record's fixed table name. No other call, no write.
import { DescribeTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { TeamRecordProbe } from "./team-record-preflight.js";

export function dynamoTeamRecordProbe(client: Pick<DynamoDBClient, "send">): TeamRecordProbe {
  return {
    async tableState(tableName) {
      try {
        const table = ((await client.send(new DescribeTableCommand({ TableName: tableName }))) as { Table?: { ItemCount?: number; DeletionProtectionEnabled?: boolean } }).Table;
        return { exists: true, ...(table?.ItemCount === undefined ? {} : { itemCount: table.ItemCount }), ...(table?.DeletionProtectionEnabled === undefined ? {} : { deletionProtected: table.DeletionProtectionEnabled }) };
      } catch (error) {
        if ((error as { name?: string }).name === "ResourceNotFoundException") return { exists: false };
        return undefined;
      }
    },
  };
}
