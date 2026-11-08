// Team record wiring (wire-team-record): puts the Team record's storage into the real control plane, behind ONE switch that is OFF by default.
//
// The switch is the CDK context `agentxTeamRecord=enabled`. Absent (or `off`), NOTHING is created or changed: no table, no vector bucket, no lake, no Athena workgroup, no schedule, no IAM
// statement, no environment variable on any function. The synthesised templates are byte-for-byte what they were before this file existed, which a test pins. With the switch on, the
// broker receives the setting `TEAM_RECORD_ENABLED=1` (a packed broker setting, see BROKER_SETTINGS); without it the broker's Team-record code does not even build its clients.
//
// The switch is a deploy-time switch (it creates resources). It is separate from the per-project learning mode (Off, Collect, Suggest, On), which decides per project whether anything is
// captured. Both must allow a write.
//
// What each part costs when the switch is ON and nothing has been recorded yet (us-east-1 / us-west-2 list prices read 2026-10-30, see the design's section 6):
//   - DynamoDB table (on demand, point-in-time recovery): no standing charge while empty. PITR is billed per GB of table size (about $0.20 per GB-month).
//   - S3 Vectors bucket and per-workspace indexes: storage $0.06 per GB-month; an empty bucket costs nothing.
//   - S3 Tables bucket and four tables (lake): storage $0.0265 per GB-month plus per-object monitoring and compaction; empty is about zero.
//   - Athena workgroup: $5 per TB scanned, only when a query runs; the workgroup itself is free.
//   - EventBridge Scheduler schedules (three): free at this volume; each invoke is one Lambda run of the broker (a few milliseconds when nothing is due).
// Model calls (embeddings, the distiller) are NOT created here: they are billed on the org's spend when a feature uses them.
import { CfnParameter, Duration, Token, aws_cloudwatch as cloudwatch, aws_lambda_event_sources as eventSources, aws_scheduler as scheduler, aws_sqs as sqs, type Stack, aws_iam as iam } from "aws-cdk-lib";
import type { aws_dynamodb as dynamodb, aws_s3 as s3 } from "aws-cdk-lib";
import type { aws_lambda as lambda } from "aws-cdk-lib";
import { aws_lambda as lambdaValues } from "aws-cdk-lib";
import {
  LESSONS_REFLECT_MAX_RECEIVES, LESSONS_REFLECT_VISIBILITY_SECONDS, LESSONS_WORKER_RESERVED_CONCURRENCY, LESSONS_WORKER_TIMEOUT_SECONDS, TEAM_RECORD_OPS_MAX_RECEIVES,
  lessonsReflectDeadLetterName, lessonsReflectQueueName, teamRecordNamePrefix, teamRecordOpsDeadLetterName, teamRecordOpsQueueName, teamRecordTableName,
} from "@agentx/contracts";
import { packagedFunction } from "./control-plane.js";
import { BrokerNames, BrokerSettings } from "./broker-names.js";
import { DEFAULT_EMBEDDING_MODEL_ID, type TeamRecordContext } from "./team-record-edition.js";
import { TeamRecordStorage } from "./team-record-storage.js";
import { TeamRecordTable } from "./team-record-table.js";

export const TEAM_RECORD_CONTEXT_KEY = "agentxTeamRecord";

/** The event the schedules send; the broker's handler recognises `source` exactly (`isTeamRecordJobEvent`). */
export const TEAM_RECORD_JOB_SOURCE = "agentx.team-record";

/**
 * Reads the switch. `undefined` means OFF. A value other than `enabled` or `off` is refused (a typo must not read as on or as off without a word). When the switch is on, the install must be a
 * named environment (the table and buckets are named from the environment) and must have an edition: Public cloud, or Enterprise by `rovaraEdition`.
 */
export function parseTeamRecordSwitch(input: { get: (key: string) => unknown; env: string | undefined; edition: "enterprise" | "public" | undefined; cloud: boolean }): TeamRecordContext | undefined {
  const raw = input.get(TEAM_RECORD_CONTEXT_KEY);
  if (raw === undefined || raw === "" || raw === "off" || raw === false || raw === "false") return undefined;
  if (raw !== "enabled") throw new Error(`team record: ${TEAM_RECORD_CONTEXT_KEY} must be "enabled" or "off", not ${JSON.stringify(raw)}`);
  if (input.env === undefined) throw new Error("team record: the Team record needs a named environment (agentxEnv): its table and buckets are named from it");
  const edition = input.edition ?? (input.cloud ? "public" : undefined);
  if (edition === undefined) throw new Error("team record: the Team record needs an edition (rovaraEdition=enterprise|public, or the hosted cloud)");
  if (edition === "public" && !input.cloud) throw new Error("team record: a Public edition install is the hosted cloud (agentxCloud=true)");
  const optional = (name: string): unknown => {
    const value = input.get(`${TEAM_RECORD_CONTEXT_KEY}${name}`);
    return value === "" ? undefined : value;
  };
  return {
    edition,
    embeddingModelId: optional("EmbeddingModelId"),
    kmsKeyArn: optional("KmsKeyArn"),
    lakeEnabled: optional("Lake"),
    athenaUsers: optional("AthenaUsers"),
    enterpriseWorkspaceId: optional("EnterpriseWorkspaceId"),
  };
}

export interface TeamRecordWiringProps {
  readonly env: string;
  readonly context: TeamRecordContext;
  readonly broker: lambda.Function;
  readonly slackIngress: lambda.Function;
  /**
   * The dispatcher (WL-6): a stage is queued with lesson ids and versions only, and the dispatcher builds the lessons' text from the record's table at delivery. It gets read access to the lesson
   * rows and the table's name (`TEAM_RECORD_TABLE_NAME`); without that name it delivers no lessons. Optional so a caller without a dispatcher still synthesises.
   */
  readonly dispatcher?: lambda.Function;
  /** The role the other recovery schedules use to invoke the broker. */
  readonly scheduleRole: iam.IRole;
}

/** The jobs the schedules wake. Each is bounded by its own budget in the broker. `poll` (the MCP pollers) is not scheduled: the MCP host is not part of the install yet. */
export const TEAM_RECORD_JOBS = [
  { id: "Hourly", job: "hourly", expression: "rate(1 hour)" },
  // 03:17 UTC: the archiver, the raw-text expiry and the nightly work. Off the hour on purpose.
  { id: "Nightly", job: "nightly", expression: "cron(17 3 * * ? *)" },
] as const;

export interface TeamRecordResources {
  readonly table: TeamRecordTable;
  readonly storage: TeamRecordStorage;
  /** The pause parameter's value (`TEAM_RECORD_ACTIVE`): the LessonsWorker is given it so a paused record learns nothing there either. */
  readonly activeSetting: string;
}

export function attachTeamRecord(stack: Stack, props: TeamRecordWiringProps): TeamRecordResources {
  const { broker } = props;
  const table = new TeamRecordTable(stack, "TeamRecordTable", {
    tableName: teamRecordTableName(props.env),
    ...(typeof props.context.kmsKeyArn === "string" ? { kmsKeyArn: props.context.kmsKeyArn } : {}),
  });
  const storage = new TeamRecordStorage(stack, "TeamRecord", {
    namePrefix: teamRecordNamePrefix(props.env),
    env: props.env,
    context: props.context,
    brokerPrincipal: broker.role!,
  });
  // The broker's rights: the table and its indexes (no scan, no table-level delete), the vector data role (assume only; the data rights sit on the role and each session is narrowed to one
  // workspace), Bedrock InvokeModel for the embedding model only, and the lake (Athena, S3 Tables, Glue) where the lake exists.
  for (const statement of [...table.brokerStatements(), ...storage.brokerStatements()]) broker.addToRolePolicy(statement);

  // WL-6: the dispatcher reads the lesson rows at delivery (no write), and the customer's key where there is one.
  if (props.dispatcher !== undefined) {
    for (const statement of table.dispatcherStatements()) props.dispatcher.addToRolePolicy(statement);
    if (typeof props.context.kmsKeyArn === "string") props.dispatcher.addToRolePolicy(new iam.PolicyStatement({ sid: "TeamRecordLessonReadsKms", actions: ["kms:Decrypt", "kms:DescribeKey"], resources: [props.context.kmsKeyArn],
      // Only through DynamoDB: the dispatcher cannot decrypt anything else that is sealed under the customer's key.
      conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } } }));
    props.dispatcher.addEnvironment("TEAM_RECORD_TABLE_NAME", teamRecordTableName(props.env));
  }

  // The switch and the two install parameters the broker cannot derive from the environment's name. The names of the resources are derived (derived-names.ts).
  const settings = BrokerSettings.of(broker);
  // UX-4b: once built, the record stays switched on for the broker (erasure, removals, Slack deletes, expiry and the archiver must keep running over the retained data); the stack parameter
  // (`agentx config set teamRecord.enabled 0|1`) is a PAUSE on top of it: 0 stops capture, reads, search and learning (TEAM_RECORD_ACTIVE, team-record/runtime.ts) and keeps every stored item.
  const enabled = new CfnParameter(stack, "TeamRecordEnabled", { type: "String", default: "1", allowedValues: ["0", "1"], description: "1: the Team record is on; 0: paused, nothing new is captured, read or learned, while erasure, removals and expiry keep running on the stored record (agentx config set teamRecord.enabled 1)" });
  settings.add("teamRecord", "1");
  settings.add("teamRecordActive", enabled.valueAsString);
  // The default model is not passed: the broker reads an unset model as the default (team-record/runtime.ts), which keeps 36 bytes of the broker's 4 KB environment.
  if (storage.parameters.embeddingModelId !== DEFAULT_EMBEDDING_MODEL_ID) settings.add("teamRecordEmbeddingModel", storage.parameters.embeddingModelId);
  settings.add("teamRecordLake", storage.lake === undefined ? "0" : "1");
  if (storage.vectors.dataRole !== undefined) BrokerNames.of(broker).add("teamRecordVectorsRole", storage.vectors.dataRole.roleName);
  // The customer's key (Enterprise) must be in this account and region: the broker builds its ARN from the key id, the region and the account.
  const key = storage.parameters.kmsKeyArn === undefined ? undefined : /^arn:aws[a-z-]*:kms:([a-z0-9-]+):(\d{12}):key\/([0-9a-f-]{36})$/.exec(storage.parameters.kmsKeyArn);
  if (key !== null && key !== undefined) {
    if ((!Token.isUnresolved(stack.region) && key[1] !== stack.region) || (!Token.isUnresolved(stack.account) && key[2] !== stack.account)) throw new Error("team record: kmsKeyArn must be a key in this install's own account and region");
    BrokerNames.of(broker).add("teamRecordKmsKey", key[3]!);
  }

  // The durable queue (fix round 1, B1): a removal or an edit that cannot be applied at once waits here and the broker drains it, retrying; after five tries it lands in the dead-letter queue, which
  // the health route lists (`team-record`). It holds ids for removals and, for an edit, only text that may be kept (never a Slack message in Public). Encrypted with SQS-managed keys like the other
  // queues of this stack. The visibility timeout is far above the broker's 30 s timeout, as Lambda requires.
  const deadLetters = new sqs.Queue(stack, "TeamRecordOpsDeadLetters", { queueName: teamRecordOpsDeadLetterName(props.env), encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14) });
  const ops = new sqs.Queue(stack, "TeamRecordOps", {
    queueName: teamRecordOpsQueueName(props.env), encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(4), visibilityTimeout: Duration.seconds(180),
    deadLetterQueue: { queue: deadLetters, maxReceiveCount: TEAM_RECORD_OPS_MAX_RECEIVES },
  });
  broker.addEventSource(new eventSources.SqsEventSource(ops, { batchSize: 10, reportBatchItemFailures: true }));
  ops.grantSendMessages(broker);
  // Not passed to the broker: its name is fixed (`teamRecordOpsDeadLetterName`) and the broker derives its URL for the health route (broker-environment.ts).
  // The hourly job deletes PUT messages out of the dead-letter queue (they hold a draft's text, TRW-5 S1): receive and delete on that one queue.
  deadLetters.grantConsumeMessages(broker);
  // A delete that neither the table nor the queue took is sent to the broker itself as an asynchronous Event (TRW-5 S2). A policy of its own, so the function does not wait on its own role (no cycle).
  // A removal Lambda could not run lands in the stack's failure queue, which alarms (the broker's `configureAsyncInvoke`, control-plane.ts).
  new iam.Policy(stack, "TeamRecordBrokerSelfInvoke", { roles: [broker.role!], statements: [new iam.PolicyStatement({ actions: ["lambda:InvokeFunction"], resources: [broker.functionArn] })] });

  // The Slack ingress hands a verified event to the broker (direct invoke, which it is already allowed to do) and sends removals (ids only) to the durable queue: this tells it to, and where.
  props.slackIngress.addEnvironment("TEAM_RECORD_ENABLED", "1");
  props.slackIngress.addEnvironment("TEAM_RECORD_OPS_QUEUE_URL", ops.queueUrl);
  ops.grantSendMessages(props.slackIngress);

  for (const { id, job, expression } of TEAM_RECORD_JOBS) {
    new scheduler.CfnSchedule(stack, `TeamRecord${id}Schedule`, {
      flexibleTimeWindow: { mode: "OFF" },
      scheduleExpression: expression,
      state: "ENABLED",
      target: {
        arn: broker.functionArn,
        roleArn: props.scheduleRole.roleArn,
        input: JSON.stringify({ source: TEAM_RECORD_JOB_SOURCE, job }),
        // No retries: the next run is the retry, and the jobs resume from their own cursors.
        retryPolicy: { maximumRetryAttempts: 0, maximumEventAgeInSeconds: 600 },
      },
    });
  }
  return { table, storage, activeSetting: enabled.valueAsString };
}

export interface LessonsWorkerProps {
  readonly env: string;
  readonly context: TeamRecordContext;
  readonly broker: lambda.Function;
  readonly resources: TeamRecordResources;
  /** The State table and the artifacts bucket (plan text), the developer sign-in table (people's names and merges), the in-VPC model function and the GitHub App's key secret and identity. */
  readonly state: dynamodb.Table;
  readonly artifacts: s3.Bucket;
  readonly signInTable: dynamodb.Table;
  readonly modelAccessFunction: lambda.IFunction;
  readonly githubAppPrivateKeySecretArn: string;
  readonly githubAppCredentialRef: string;
  readonly githubAppId: string;
  /** Whether the worker reserves Lambda concurrency (default true; the same `agentxReservedConcurrency` context as the audit ledger's functions). */
  readonly reservedConcurrency?: boolean;
  /** M5: the install's alarm names and the operator notification the other alarms use. */
  readonly alarms: { readonly name: (suffix: string) => string; readonly action: cloudwatch.IAlarmAction };
}

/** The key prefixes (the table's partition key) the LessonsWorker may WRITE in the State table, and why: its lease, the spend ledger's records for the keys it mints, and pending audit items. M7. */
export const LESSONS_WORKER_STATE_WRITE_KEY_PATTERNS = [
  "LEARN#*",
  // The spend ledger: a key's reservation (counters, the key's record, the global open-key index), taken back or blocked after the call.
  "ORG#*#SPEND#*", "ORG#*#MODEL_KEY#*", "OPEN_MODEL_KEYS",
  // Audit events are written as pending items; the broker's drain sends them.
  "AUDIT_PENDING#*",
] as const;

/**
 * Lessons in production, lane 2 (WB-4): the LessonsReflect queue, its dead-letter queue and the LessonsWorker Lambda. Behind the Team record switch like everything in this file (the caller runs it only with
 * `agentxTeamRecord=enabled`); with the switch off none of this exists and the templates are what they were.
 *
 *  - The queue: SQS-managed encryption, 4 days of retention, a dead-letter queue after 5 receives (14 days; the messages are ids only; H1: a reflection that failed before anything was spent is tried again up to 3
 *    times with a visibility backoff, so the queue reaches the dead-letter queue only after those attempts). The broker (and only the broker) may send; its URL is derived from the environment's name (nothing is
 *    passed). The visibility timeout is six times the worker's timeout (`LESSONS_REFLECT_VISIBILITY_SECONDS`), so SQS never hands a message to a second worker while the first may still be running.
 *  - The worker: the broker's bundle but its OWN entry (`aws/lessons-worker-entry.ts`, M6), outside the VPC like the broker, and with an EXPLICIT environment: the environment's name and account, the few names and settings
 *    learning reads (packed the broker's way), and the GitHub App's key ARN. It is not given the callback signing key, the OIDC settings or anything else the broker holds. Timeout 300 s: it outlives the 130 s the broker
 *    waits for the in-VPC model function, the key-block step after it, and the work around it (the worker itself stops starting model calls 240 s in). Batch size 1, concurrency 2 (reserved, and on the event source, so a
 *    burst waits in the queue and is not thrown back at SQS), partial-batch answers.
 *  - Its role is its own and holds only what the reflection touches: the Team record table, the State table (reads table-wide; WRITES only under the key prefixes of `LESSONS_WORKER_STATE_WRITE_KEY_PATTERNS`, M7), the sign-in
 *    table (read), the artifacts bucket (read, the plan documents), `lambda:InvokeFunction` on the model-access function and nothing else on Lambda, the queue (consume, including changing a message's visibility for the
 *    backoff), the GitHub App's key secret (read; citations are checked against the code host) and, in Enterprise, the customer's table key through DynamoDB only. It has no EC2, no Bedrock, no scheduler and no other
 *    queue (not even the audit intake queue: audit events are written as pending items and sent by the broker's drain). It does not invoke itself.
 *  - M5: an alarm on the dead-letter queue (any message), on the worker's errors (15 minutes) and on its throttles; the dead-letter queue is listed on the Health page (`lessons-reflect`, derived from the environment's name).
 *  - L8 (noted): similarity (vectors, an embedder) is stubbed today (`lessonSimilarityFor`). When it lands the worker's role needs the vectors role and the embedding grant (and the customer's key in Enterprise); the IAM
 *    test names this so the gap is caught.
 */
export function attachLessonsWorker(stack: Stack, props: LessonsWorkerProps): { queue: sqs.Queue; deadLetters: sqs.Queue; worker: lambda.Function } {
  const deadLetters = new sqs.Queue(stack, "LessonsReflectDeadLetters", { queueName: lessonsReflectDeadLetterName(props.env), encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14) });
  const queue = new sqs.Queue(stack, "LessonsReflect", {
    queueName: lessonsReflectQueueName(props.env), encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(4), visibilityTimeout: Duration.seconds(LESSONS_REFLECT_VISIBILITY_SECONDS),
    deadLetterQueue: { queue: deadLetters, maxReceiveCount: LESSONS_REFLECT_MAX_RECEIVES },
  });
  queue.grantSendMessages(props.broker);
  // The Health page reads the dead-letter queue's depth with the broker's role (read-only; the messages are ids and are never read or deleted by the broker).
  deadLetters.grant(props.broker, "sqs:GetQueueAttributes");

  // M6: an explicit environment. Nothing is copied from the broker.
  const worker = packagedFunction(stack, "LessonsWorker", "packages/broker/src/aws/lessons-worker-entry.ts", {
    AGENTX_ENV: props.env, AGENTX_ACCOUNT_ID: stack.account, GITHUB_APP_PRIVATE_KEY_SECRET_ARN: props.githubAppPrivateKeySecretArn,
  }, Duration.seconds(LESSONS_WORKER_TIMEOUT_SECONDS), [], 512, [], lambdaValues.Tracing.ACTIVE, "lessonsWorkerHandler");
  const names = BrokerNames.of(worker);
  names.add("stateTable", props.state.tableName);
  names.add("artifactBucket", props.artifacts.bucketName);
  names.add("signInTable", props.signInTable.tableName);
  names.add("modelAccessFunction", props.modelAccessFunction.functionName);
  const key = typeof props.context.kmsKeyArn === "string" ? /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/([0-9a-f-]{36})$/.exec(props.context.kmsKeyArn) : null;
  if (key !== null) names.add("teamRecordKmsKey", key[1]!);
  const settings = BrokerSettings.of(worker);
  settings.add("teamRecord", "1");
  settings.add("teamRecordActive", props.resources.activeSetting);
  settings.add("githubAppCredentialRef", props.githubAppCredentialRef);
  settings.add("githubAppId", props.githubAppId);
  if (props.reservedConcurrency !== false) (worker.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions = LESSONS_WORKER_RESERVED_CONCURRENCY;
  // grantConsumeMessages (the event source) includes ChangeMessageVisibility, which the retry backoff uses.
  worker.addEventSource(new eventSources.SqsEventSource(queue, { batchSize: 1, maxConcurrency: LESSONS_WORKER_RESERVED_CONCURRENCY, reportBatchItemFailures: true }));

  // The State table: reads anywhere (the task and project records, settings, sources, the spend ledger), no Scan; WRITES only under the key prefixes the worker uses (M7).
  worker.addToRolePolicy(new iam.PolicyStatement({
    sid: "LessonsStateTableReads", actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"],
    resources: [props.state.tableArn, `${props.state.tableArn}/index/*`],
  }));
  worker.addToRolePolicy(new iam.PolicyStatement({
    sid: "LessonsStateTableWrites", actions: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"],
    resources: [props.state.tableArn],
    // ForAllValues passes when the key is absent, so a Null test requires that the condition key is present (re-check R6: no action added later can slip past). The patterns cover EVERY org's spend counters and model-key
    // records (`ORG#*#SPEND#*`, `ORG#*#MODEL_KEY#*`): the worker serves all orgs, so that breadth is inherent to the design and accepted. `LEARN#*` does not match `LEARNING_WALK#...`.
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...LESSONS_WORKER_STATE_WRITE_KEY_PATTERNS] }, Null: { "dynamodb:LeadingKeys": "false" } },
  }));
  for (const statement of props.resources.table.brokerStatements()) worker.addToRolePolicy(statement);
  worker.addToRolePolicy(new iam.PolicyStatement({
    sid: "LessonsSignInTableReads", actions: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"], resources: [props.signInTable.tableArn, `${props.signInTable.tableArn}/index/*`],
  }));
  props.artifacts.grantRead(worker, "private/*");
  props.modelAccessFunction.grantInvoke(worker);
  worker.addToRolePolicy(new iam.PolicyStatement({ sid: "ReadGithubAppKey", actions: ["secretsmanager:GetSecretValue"], resources: [props.githubAppPrivateKeySecretArn] }));
  if (typeof props.context.kmsKeyArn === "string") {
    worker.addToRolePolicy(new iam.PolicyStatement({
      sid: "TeamRecordTableKms", actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"], resources: [props.context.kmsKeyArn],
      // Only through DynamoDB: the worker cannot use the customer's key for anything else.
      conditions: { StringEquals: { "kms:ViaService": `dynamodb.${stack.region}.amazonaws.com` } },
    }));
  }

  // M5: silent loss was the failure: a worker that fails every message sends them all to the dead-letter queue, and learning stops. Both alarms notify the operator; the dead-letter queue is also on the Health page.
  const alarm = (id: string, suffix: string, description: string, metric: cloudwatch.IMetric): void => {
    new cloudwatch.Alarm(stack, id, {
      alarmName: props.alarms.name(suffix), alarmDescription: description, metric, threshold: 1, evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(props.alarms.action);
  };
  alarm("LessonsReflectDeadLettersAlarm", "LessonsReflectDeadLetters", "A finished task's reflection exhausted its receives and is in the lessons-reflect dead-letter queue (ids only). Learning from that task is lost unless it is redriven; check the LessonsWorker logs for lessons_worker.result.",
    deadLetters.metricApproximateNumberOfMessagesVisible({ statistic: "Maximum", period: Duration.minutes(5) }));
  alarm("LessonsWorkerErrorsAlarm", "LessonsWorkerErrors", "The LessonsWorker failed an invocation (a start-up fault, a timeout or an out-of-memory kill). Check its logs.",
    worker.metricErrors({ statistic: "Sum", period: Duration.minutes(15) }));
  alarm("LessonsWorkerThrottlesAlarm", "LessonsWorkerThrottles", "The LessonsWorker was throttled. Messages wait in the queue; check the reserved concurrency and the account's limit.",
    worker.metricThrottles({ statistic: "Sum", period: Duration.minutes(15) }));
  return { queue, deadLetters, worker };
}
