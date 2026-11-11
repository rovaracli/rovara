// The real AWS side of team-record-preflight.ts: one read-only DescribeTable on the record's fixed table name, and (when given the clients) one read-only DescribeRepositories on the embedder's
// repository and one ListStackResources on the access stack. No other call, no write.
import { ListStackResourcesCommand, type CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DescribeTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DescribeRepositoriesCommand, type ECRClient } from "@aws-sdk/client-ecr";
import type { TeamRecordProbe } from "./team-record-preflight.js";

export function dynamoTeamRecordProbe(client: Pick<DynamoDBClient, "send">, extra: { ecr?: Pick<ECRClient, "send">; cloudFormation?: Pick<CloudFormationClient, "send"> } = {}): TeamRecordProbe {
  const { ecr, cloudFormation } = extra;
  return {
    ...(ecr === undefined || cloudFormation === undefined ? {} : {
      async embedderRepositoryState(repository: string, accessStackName: string) {
        try {
          try {
            await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repository] }));
          } catch (error) {
            if ((error as { name?: string }).name === "RepositoryNotFoundException") return { exists: false, inAccessStack: false };
            return undefined;
          }
          const ids: string[] = [];
          let token: string | undefined;
          do {
            const page = (await cloudFormation.send(new ListStackResourcesCommand({ StackName: accessStackName, ...(token === undefined ? {} : { NextToken: token }) }))) as { StackResourceSummaries?: Array<{ PhysicalResourceId?: string }>; NextToken?: string };
            for (const summary of page.StackResourceSummaries ?? []) if (summary.PhysicalResourceId !== undefined) ids.push(summary.PhysicalResourceId);
            token = page.NextToken;
          } while (token !== undefined);
          return { exists: true, inAccessStack: ids.includes(repository) };
        } catch {
          return undefined;
        }
      },
    }),
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
