// The audit outbox's runtime for a function other than the broker (Task 18: the sign-in function records a sign-in method linked or
// unlinked and an invite accepted). Its clients give up quickly (AUDIT_SDK_REQUEST_TIMEOUT_MS, two attempts) so that auditing can never
// hold an action for long; the action's own writes use the function's ordinary client. Set only where the control plane gives the
// function the intake queue (named environments): elsewhere there is no ledger and every audit function is a no-op.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AUDIT_SDK_REQUEST_TIMEOUT_MS } from "@agentx/cloud-contracts";
import type { AuditRuntime } from "./outbox.js";

export function auditRuntimeFromEnvironment(env: NodeJS.ProcessEnv, options: { component: string; now?: () => number }): AuditRuntime | undefined {
  const queueUrl = env.AUDIT_INTAKE_QUEUE_URL;
  if (queueUrl === undefined || queueUrl === "") return undefined;
  const tableName = env.STATE_TABLE_NAME;
  if (tableName === undefined || tableName === "") throw new Error("STATE_TABLE_NAME is required");
  const configuration = {
    ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }),
    maxAttempts: 2,
    requestHandler: { requestTimeout: AUDIT_SDK_REQUEST_TIMEOUT_MS, connectionTimeout: AUDIT_SDK_REQUEST_TIMEOUT_MS },
  };
  return {
    sqs: new SQSClient(configuration),
    queueUrl,
    documentClient: DynamoDBDocumentClient.from(new DynamoDBClient(configuration), { marshallOptions: { removeUndefinedValues: true } }),
    tableName,
    now: options.now ?? Date.now,
    log: (entry) => console.log(JSON.stringify({ component: options.component, ...entry })),
  };
}
