// Lessons in production, lane 2 (M6): the LessonsWorker Lambda's own entry. It is NOT the broker: it loads no broker handler, builds no dependency learning does not read, and is given an explicit, small environment
// (infra/lib/team-record-wiring.ts#attachLessonsWorker): the install's names and settings it needs (packed the broker's way, hydrated by `broker-environment-init.ts`), the environment's name and account, the edition
// stamp and the GitHub App's key ARN. It has NO callback signing key, no OIDC settings, no queue other than the one it consumes, and no right to invoke itself.
//
// What it builds is exactly `LessonsHostDependencies` (aws/broker/definitions.ts): the State table, the artifacts bucket (plan text), the Team record, the model path (the in-VPC function, through the ordinary key
// lifecycle of the spend ledger), the code host (citations are checked at the commit) and an audit sink that writes PENDING items only (`AuditRuntime.pendingOnly`): the broker's drain sends them, so the worker needs no
// right to the audit queue and never tries one. The Team record is built without its durable queue, its dead-letter reader and its removal fallback: the worker neither removes nor drains anything, and a write that
// fails here is thrown to the caller (the lease, `reflect-worker.ts`) rather than sent to a queue the worker cannot reach.
//
// M4: the DynamoDB client is wrapped so that, once a reflection's deadline has passed, nothing more is written to the Team record's table (`lessons/deadline-guard.ts`). The State table (the lease, the spend ledger)
// is not guarded: the attempt's model keys must still be blocked and settled after the deadline.
import "./broker-environment-init.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EDITION_ENV_VAR } from "@agentx/contracts";
import type { AuditRuntime } from "../audit/outbox.js";
import { createCodeBuildGateway } from "../codebuild.js";
import { deadlineGuardedClient } from "../lessons/deadline-guard.js";
import { reflectQueueUrlOf, sqsReflectVisibility } from "../lessons/reflect-queue.js";
import { ModelAccessInvoker } from "../model-proxy/invoker.js";
import { installationBindingCheck } from "../org/github-connection.js";
import { createTeamRecordRuntime } from "../team-record/runtime.js";
import type { LessonsHostDependencies } from "./broker/definitions.js";
import { installEditionPolicy } from "./broker/edition-wiring.js";
import { createLessonsWorkerHandler } from "./broker/lessons-worker.js";
import { createBrokerPlugins } from "./broker/plugin-wiring.js";
import { recordAuditSinkOf } from "./broker/team-record-wiring.js";
import { createGitHubAppCredentials } from "./github-credentials.js";
import { requiredEnvironment } from "./lambda.js";

const logLine = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ component: "lessons_worker", ...entry }));

/** The worker's dependencies, built once, on the first message. Every read of the environment is by name, so a missing one is a named failure. */
export function lessonsWorkerDependencies(): LessonsHostDependencies {
  const env = process.env;
  const awsClientConfiguration = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const stateTableName = requiredEnvironment("STATE_TABLE_NAME");
  const recordTableName = requiredEnvironment("TEAM_RECORD_TABLE_NAME");
  const documentClient = deadlineGuardedClient(DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), { marshallOptions: { removeUndefinedValues: true } }), (tableName) => tableName === recordTableName);
  // A Team-record install is either the hosted cloud (the Public edition) or a private Enterprise one; the switch's own check refuses any other combination at synth.
  const cloud = env[EDITION_ENV_VAR] === "public";
  const secretsManager = new SecretsManagerClient(awsClientConfiguration);
  const github = createGitHubAppCredentials(secretsManager, cloud ? { requireInstallationBound: installationBindingCheck({ documentClient, tableName: stateTableName }) } : undefined);
  const editionPolicy = installEditionPolicy(env, cloud);
  const plugins = createBrokerPlugins({
    provider: github.provider, credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF"), codeBuild: createCodeBuildGateway(awsClientConfiguration), webhookSecret: github.webhookSecret,
    ...(editionPolicy === undefined ? {} : { policy: editionPolicy }),
  });
  const audit: AuditRuntime = {
    // Never used: the worker writes pending items only (`pendingOnly`), and has no right to the queue.
    sqs: new SQSClient(awsClientConfiguration), queueUrl: "", documentClient, tableName: stateTableName, now: Date.now, log: (entry) => logLine(entry), pendingOnly: true,
  };
  const teamRecord = createTeamRecordRuntime({ env, documentClient, stateTableName, log: logLine, audit: recordAuditSinkOf(audit, documentClient)! });
  const functionName = env.MODEL_ACCESS_FUNCTION_NAME;
  return {
    documentClient, s3: new S3Client(awsClientConfiguration), tableName: stateTableName, artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
    audit, cloud, codeHost: plugins.codeHost, githubPullRequests: github.provider,
    ...(editionPolicy === undefined ? {} : { editionPolicy }),
    ...(teamRecord === undefined ? {} : { teamRecord }),
    // The spend ledger exists where the install has agents and a model path: the worker's model path is the same in-VPC function the broker calls (it mints no key itself).
    agents: {},
    ...(functionName === undefined || functionName === "" ? {} : { modelAccess: { access: new ModelAccessInvoker({ functionName, lambda: new LambdaClient(awsClientConfiguration) }), proxyUrl: "" } }),
    developer: { signInTableName: requiredEnvironment("DEVELOPER_SIGNIN_TABLE_NAME") },
  };
}

const queueUrl = reflectQueueUrlOf(process.env);
const visibility = queueUrl === undefined ? undefined : sqsReflectVisibility(new SQSClient(process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION }), queueUrl);

export const lessonsWorkerHandler = createLessonsWorkerHandler(() => lessonsWorkerDependencies(), visibility === undefined ? {} : { visibility });
