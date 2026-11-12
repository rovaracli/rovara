// Customer test AWS account, lane TA2: the real adapter of the AWS port (aws-port.ts), over the AWS SDK. This is the ONE file in the lane that sends anything to AWS. It is not wired anywhere by TA2 and its tests use fake clients: nothing
// here has run against AWS (TA11 proves it live, in Rovara's staging account, through staging-aws.sh).
//
// Rules: a result is a fixed word, never AWS's text (AWS's messages can name resources and accounts; a message is read here only to tell a service control policy from the role's own refusal, and is dropped); the queue calls refuse any name or
// URL that is not a run-named queue of the connected account before they send (the adapter fences itself as well as IAM); every credential is passed to the SDK in memory and nowhere else.
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { GetRoleCommand, IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { CreateQueueCommand, DeleteQueueCommand, ListQueuesCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { ListTopicsCommand, SNSClient } from "@aws-sdk/client-sns";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ListSecretsCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DescribeParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { ListStateMachinesCommand, SFNClient } from "@aws-sdk/client-sfn";
import { RUN_TAG_KEY } from "@agentx/cloud-contracts";
import { AssumeFailureError, type AccountCalls, type AssumedCredentials, type DeleteOutcome, type ServiceProbe, type TestAccessAws } from "./aws-port.js";

export interface SdkClient { send(command: unknown): Promise<unknown> }
export interface SdkClients { sts: SdkClient; iam: SdkClient; sqs: SdkClient; dynamodb: SdkClient; s3: SdkClient; sns: SdkClient; lambda: SdkClient; logs: SdkClient; secretsmanager: SdkClient; ssm: SdkClient; states: SdkClient }

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "");
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "");
const DENIED = new Set(["AccessDenied", "AccessDeniedException", "AuthorizationError", "UnauthorizedOperation", "UnrecognizedClientException", "AuthFailure"]);
const isDenied = (error: unknown): boolean => DENIED.has(nameOf(error));
/** AWS's access-denied text names a service control policy when one blocked the call. Only the fact is kept. */
const blockedByScp = (error: unknown): boolean => /service control polic/iu.test(messageOf(error));
const RUN_QUEUE_NAME = /^rv-[0-9a-z]{8}-[A-Za-z0-9_-]{1,60}$/u;
const QUEUE_NAME = /^[A-Za-z0-9_-]{1,80}$/u;

type Probe = [client: keyof SdkClients, command: () => unknown];
const PROBES: Readonly<Record<string, Probe>> = {
  dynamodb: ["dynamodb", () => new ListTablesCommand({ Limit: 1 })],
  s3: ["s3", () => new ListBucketsCommand({ MaxBuckets: 1 })],
  sns: ["sns", () => new ListTopicsCommand({})],
  sqs: ["sqs", () => new ListQueuesCommand({ MaxResults: 1 })],
  lambda: ["lambda", () => new ListFunctionsCommand({ MaxItems: 1 })],
  logs: ["logs", () => new DescribeLogGroupsCommand({ limit: 1 })],
  secretsmanager: ["secretsmanager", () => new ListSecretsCommand({ MaxResults: 1 })],
  ssm: ["ssm", () => new DescribeParametersCommand({ MaxResults: 1 })],
  states: ["states", () => new ListStateMachinesCommand({ maxResults: 1 })],
};

export function sdkAccountCalls(clients: SdkClients, region: string, accountId: string): AccountCalls {
  const queueUrlOf = (name: string): string => `https://sqs.${region}.amazonaws.com/${accountId}/${name}`;
  const deleteQueue = async (queueUrl: string): Promise<DeleteOutcome> => {
    try {
      await clients.sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      return "deleted";
    } catch (error) {
      if (isDenied(error)) return "denied";
      if (nameOf(error) === "QueueDoesNotExist" || nameOf(error) === "AWS.SimpleQueueService.NonExistentQueue") return "not_found";
      return "error";
    }
  };
  return {
    async listAccountAliases() {
      try {
        return ((await clients.iam.send(new ListAccountAliasesCommand({}))) as { AccountAliases?: string[] }).AccountAliases ?? [];
      } catch {
        return [];
      }
    },
    async roleBoundary(roleName) {
      try {
        return ((await clients.iam.send(new GetRoleCommand({ RoleName: roleName }))) as { Role?: { PermissionsBoundary?: { PermissionsBoundaryArn?: string } } }).Role?.PermissionsBoundary?.PermissionsBoundaryArn;
      } catch {
        return undefined;
      }
    },
    async probeService(service): Promise<ServiceProbe> {
      const probe = PROBES[service];
      if (probe === undefined) return "no_client";
      try {
        await clients[probe[0]].send(probe[1]());
        return "ok";
      } catch (error) {
        if (isDenied(error)) return blockedByScp(error) ? "scp_blocked" : "no_access";
        return "unreachable";
      }
    },
    async listNames(service, limit) {
      try {
        switch (service) {
          case "dynamodb": return (((await clients.dynamodb.send(new ListTablesCommand({ Limit: Math.min(limit, 100) }))) as { TableNames?: string[] }).TableNames ?? []).slice(0, limit);
          case "s3": return (((await clients.s3.send(new ListBucketsCommand({ MaxBuckets: Math.min(limit, 1000) }))) as { Buckets?: Array<{ Name?: string }> }).Buckets ?? []).flatMap((bucket) => (bucket.Name === undefined ? [] : [bucket.Name])).slice(0, limit);
          case "sqs": return (((await clients.sqs.send(new ListQueuesCommand({ MaxResults: Math.min(limit, 1000) }))) as { QueueUrls?: string[] }).QueueUrls ?? []).map((url) => url.split("/").pop() as string).slice(0, limit);
          case "sns": return (((await clients.sns.send(new ListTopicsCommand({}))) as { Topics?: Array<{ TopicArn?: string }> }).Topics ?? []).flatMap((topic) => (topic.TopicArn === undefined ? [] : [topic.TopicArn.split(":").pop() as string])).slice(0, limit);
          default: return undefined;
        }
      } catch {
        return undefined;
      }
    },
    async createQueue(name, runId) {
      // The adapter refuses anything but a run-named queue before it sends.
      if (!RUN_QUEUE_NAME.test(name) || name.split("-")[1] !== runId) return { ok: false, code: "error" };
      try {
        const out = (await clients.sqs.send(new CreateQueueCommand({ QueueName: name, tags: { [RUN_TAG_KEY]: runId } }))) as { QueueUrl?: string };
        return out.QueueUrl === undefined ? { ok: false, code: "error" } : { ok: true, queueUrl: out.QueueUrl };
      } catch (error) {
        return { ok: false, code: isDenied(error) ? "denied" : "error" };
      }
    },
    async deleteQueueByName(name) {
      // The test's "not ours" probe: any plain queue name, in the connected account and Region, and never a URL a caller built.
      if (!QUEUE_NAME.test(name)) return "error";
      return deleteQueue(queueUrlOf(name));
    },
    async deleteQueueByUrl(queueUrl) {
      // Only a run-named queue of this account and Region: a URL that is anything else is not deleted.
      const expected = new RegExp(`^https://sqs\\.${region}\\.amazonaws\\.com/${accountId}/(rv-[0-9a-z]{8}-[A-Za-z0-9_-]{1,60})$`, "u").exec(queueUrl);
      if (expected === null) return "error";
      return deleteQueue(queueUrl);
    },
  };
}

export function sdkTestAccessAws(config: { sts: SdkClient; clientsFor: (credentials: AssumedCredentials, region: string) => SdkClients }): TestAccessAws {
  return {
    async assumeRole(request) {
      let out: { Credentials?: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: Date }; AssumedRoleUser?: { Arn?: string } };
      try {
        out = (await config.sts.send(new AssumeRoleCommand({ RoleArn: request.RoleArn, RoleSessionName: request.RoleSessionName, DurationSeconds: request.DurationSeconds, ...(request.ExternalId === undefined ? {} : { ExternalId: request.ExternalId }), ...(request.Policy === undefined ? {} : { Policy: request.Policy }), ...(request.Tags === undefined ? {} : { Tags: request.Tags }) }))) as typeof out;
      } catch (error) {
        throw new AssumeFailureError(isDenied(error) || nameOf(error) === "MalformedPolicyDocument" ? "refused" : "unreachable");
      }
      const credentials = out.Credentials;
      if (credentials?.AccessKeyId === undefined || credentials.SecretAccessKey === undefined || credentials.SessionToken === undefined || credentials.Expiration === undefined) throw new AssumeFailureError("unreachable");
      return { credentials: { accessKeyId: credentials.AccessKeyId, secretAccessKey: credentials.SecretAccessKey, sessionToken: credentials.SessionToken, expiration: credentials.Expiration }, assumedRoleArn: out.AssumedRoleUser?.Arn };
    },
    calls: (credentials, region, accountId) => sdkAccountCalls(config.clientsFor(credentials, region), region, accountId),
  };
}

/** Real SDK clients for one assumed session: the credentials stay in memory, Regional clients are in the connection's Region, IAM is global (us-east-1). Two attempts at most, so a refusal is not retried into a throttle. */
export function realSdkClients(credentials: AssumedCredentials, region: string): SdkClients {
  const config = { region, maxAttempts: 2, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken, expiration: credentials.expiration } };
  return {
    sts: new STSClient(config), iam: new IAMClient({ ...config, region: "us-east-1" }), sqs: new SQSClient(config), dynamodb: new DynamoDBClient(config), s3: new S3Client(config), sns: new SNSClient(config),
    lambda: new LambdaClient(config), logs: new CloudWatchLogsClient(config), secretsmanager: new SecretsManagerClient(config), ssm: new SSMClient(config), states: new SFNClient(config),
  };
}
