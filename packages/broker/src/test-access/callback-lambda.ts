// Customer test AWS account, lane TA2: the Lambda entry of the SNS callback (`<prefix>-test-access-callback-handler`, the function the per-Region topics subscribe to: infra/lib/test-access-callback.ts). It builds the handler's dependencies from the
// function's environment and runs `handleCallbackEvent`. NOT deployed by TA2: the function, its role and its environment are a wiring step (see the lane's open questions); with the environment incomplete it throws at once, so a
// misconfigured function fails loudly (SNS redelivers, then the dead-letter queue keeps the message 14 days) and never answers a customer's stack wrongly.
//
// Environment (all required): `TEST_ACCESS_TABLE_NAME` (the State table), `TEST_ACCESS_TOPIC_ARNS` (comma-separated: exactly this deployment's callback topics, one per Region), `TEST_ACCESS_ROVARA_ACCOUNT_IDS` (comma-separated: Rovara's own
// accounts, which a stack may not report), and the `ta` switch (`TEST_ACCOUNTS_ENABLED`). The function needs DynamoDB on the State table (get, query, put, update, delete, transact) and outbound HTTPS to `sns.<region>.amazonaws.com` (signing
// certificates) and to CloudFormation's response bucket; it needs no access to any customer account.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { OrgIdSchema } from "@rovara-code/contracts";
import { readApprovedTestEnvironment } from "../org/test-environment.js";
import { testAccountsEnabled } from "../test-env/test-services-switch.js";
import { handleCallbackEvent, type CallbackDeps, type CallbackOutcomeWord } from "./callback.js";
import { dynamoTestAccessStore } from "./dynamo-store.js";
import { certificateLoader, createSnsVerifier, type SnsVerifierConfig } from "./sns-verify.js";
import type { AuditDeps } from "../audit/outbox.js";

export interface CallbackLambdaInput extends AuditDeps {
  env: NodeJS.ProcessEnv;
  documentClient: { send(command: unknown): Promise<unknown> };
  /** Test seams. */
  fetch?: typeof fetch;
  now?: () => number;
  publicKey?: SnsVerifierConfig["publicKey"];
  log?: (entry: Record<string, string | number | boolean>) => void;
}

const list = (text: string | undefined): string[] => (text ?? "").split(",").map((part) => part.trim()).filter((part) => part !== "");

/** The handler's dependencies, or undefined when the environment is incomplete. */
export function callbackLambdaDeps(input: CallbackLambdaInput): CallbackDeps | undefined {
  const tableName = input.env["TEST_ACCESS_TABLE_NAME"];
  const topics = list(input.env["TEST_ACCESS_TOPIC_ARNS"]);
  const accounts = list(input.env["TEST_ACCESS_ROVARA_ACCOUNT_IDS"]);
  if (tableName === undefined || tableName === "" || topics.length === 0 || accounts.length === 0 || !accounts.every((account) => /^\d{12}$/u.test(account))) return undefined;
  const now = input.now ?? Date.now;
  const fetchImpl = input.fetch ?? fetch;
  const log = input.log ?? ((entry) => console.log(JSON.stringify({ component: "test-access", ...entry })));
  const store = dynamoTestAccessStore({ documentClient: input.documentClient, tableName, ...(input.audit === undefined ? {} : { audit: input.audit }), log: (entry) => log(entry) });
  const publicKey = input.publicKey ?? certificateLoader({ now, fetch: (url, init) => fetchImpl(url, init) });
  return {
    store,
    now,
    enabled: () => testAccountsEnabled(input.env),
    verify: createSnsVerifier({ allowedTopicArns: new Set(topics), now, publicKey }),
    rovaraAccountIds: accounts,
    // The company's production list for the project: its approved environment's. An environment that cannot be read throws (the callback retries); none approved yet is an empty list.
    prodDeny: async (orgId, projectId) => (await readApprovedTestEnvironment({ documentClient: input.documentClient, tableName, now }, OrgIdSchema.parse(orgId), projectId))?.environment.prodDeny ?? { accountIds: [], hosts: [], arnPrefixes: [] },
    // CloudFormation's response URL is pre-signed; a redirect is never followed.
    fetch: (url, init) => fetchImpl(url, { ...init, redirect: "error" }),
    log,
  };
}

/** The Lambda handler's body: throws when the function is not configured. */
export async function runCallbackLambda(event: unknown, input: CallbackLambdaInput): Promise<CallbackOutcomeWord[]> {
  const deps = callbackLambdaDeps(input);
  if (deps === undefined) throw new Error("the test access callback function is not configured");
  return handleCallbackEvent(event as { Records?: unknown }, deps);
}

let cachedClient: DynamoDBDocumentClient | undefined;
/** The function's entry point (`callback-lambda.handler`). The audit sink writes PENDING items only: the broker's drain sends them, so this function needs no right to the audit queue. */
export async function handler(event: unknown): Promise<CallbackOutcomeWord[]> {
  cachedClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 3 }));
  const tableName = process.env["TEST_ACCESS_TABLE_NAME"] ?? "";
  const audit = { sqs: undefined as never, queueUrl: "", documentClient: cachedClient, tableName, now: Date.now, log: (entry: Record<string, unknown>) => console.log(JSON.stringify({ component: "test-access", ...entry })), pendingOnly: true as const };
  return runCallbackLambda(event, { env: process.env, documentClient: cachedClient, audit });
}
