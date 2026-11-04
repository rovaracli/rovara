// Part of the broker (split out of ../broker.ts): the AWS client configuration, DynamoDB client, Step Functions client and EC2 session manager.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SessionManager } from "../sessions.js";
import { requiredEnvironment } from "../lambda.js";

export const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
export const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), {
  marshallOptions: { removeUndefinedValues: true },
});

export const stepFunctions = new SFNClient(awsClientConfiguration);

// The broker only deletes ec2-ebs sessions when a workspace closes (#84).
// Built on first use, not when this module loads: STATE_TABLE_NAME and DELETER_ARN are not in the Lambda's environment as such, they arrive inside AGENTX_NAMES and are put back by
// broker-environment-init.ts, and the developer-routes import chain reaches this module before that runs. Read at load, they were empty, and every close of a task's compute failed.
let ec2SessionManager: SessionManager | undefined;
export function ec2Sessions(): SessionManager {
  ec2SessionManager ??= new SessionManager({
    documentClient,
    tableName: requiredEnvironment("STATE_TABLE_NAME"),
    executions: {
      provisionerArn: process.env.PROVISIONER_ARN ?? "",
      deleterArn: requiredEnvironment("DELETER_ARN"),
      async start(input) {
        return (await stepFunctions.send(new StartExecutionCommand(input))).executionArn!;
      },
    },
  });
  return ec2SessionManager;
}
