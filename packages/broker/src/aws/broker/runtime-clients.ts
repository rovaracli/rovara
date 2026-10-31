// Part of the broker (split out of ../broker.ts): the AWS client configuration, DynamoDB client, Step Functions client and EC2 session manager.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SessionManager } from "../sessions.js";

export const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
export const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), {
  marshallOptions: { removeUndefinedValues: true },
});

export const stepFunctions = new SFNClient(awsClientConfiguration);

// The broker only deletes ec2-ebs sessions when a workspace closes (#84).
export const ec2Sessions = new SessionManager({
  documentClient,
  tableName: process.env.STATE_TABLE_NAME ?? "",
  executions: {
    provisionerArn: process.env.PROVISIONER_ARN ?? "",
    deleterArn: process.env.DELETER_ARN ?? "",
    async start(input) {
      return (await stepFunctions.send(new StartExecutionCommand(input))).executionArn!;
    },
  },
});
