// S3-10 (0519-INFRA-CORE-DISPATCH-CONSUMER): the dispatcher's half of the core engine. Loaded by aws/dispatcher.ts only while the combined switch is on, and only on the first batch from the CORE dispatch queue
// (a dynamic import), so a dispatcher with the switch off loads none of it.
//
// It builds the Cloud root on the dispatcher (cloud/app/core-host.ts) from the dispatcher's own clients: the State table, the core dispatch queue (to extend a message's visibility), the provisioner and the deleter
// (Step Functions), EC2 (to end a session's instance, own-tagged only), the invoke signing key (KMS Sign, which only this role may use) and the worker's port. The callback signing key is read from its secret
// (named environments), so the grants and capabilities a dispatch issues are the ones the broker verifies. Nothing here decides for a person and nothing reads a repository.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EC2Client, TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { OrgId } from "@rovara-code/contracts";
import { createCoreHostEntry, createProductionCoreDispatchHost, issueOnlyRepositoryGrants, refusingCodeHost } from "../cloud/app/core-host.js";
import type { CloudCoreHostResources, CloudCoreMachineOps } from "../cloud/app/entry-inputs.js";
import { anyCoreAreaOn, readCoreEngineFlags } from "../cloud/app/flags.js";
import type { CloudCoreEntry } from "../cloud/app/entry.js";
import type { CoreDispatchHost } from "./worker-machines/core-dispatch-host.js";
import { callbackKeySource } from "./signing-key-secrets.js";
import type { SessionManager } from "./sessions.js";

export interface DispatcherCoreInputs {
  env: NodeJS.ProcessEnv;
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
  installCompanyId: OrgId;
  /** The dispatcher's EC2 session manager (the provisioner and the deleter). */
  sessions: Pick<SessionManager, "get" | "ensureSession" | "deleteSession" | "claimStop" | "markStopped">;
  sign: CloudCoreMachineOps["sign"];
  post: CloudCoreMachineOps["post"];
  ping: CloudCoreMachineOps["ping"];
  log: (entry: Record<string, unknown>) => void;
  /** Test seams: the AWS clients (default: the SDK's). */
  clients?: { dynamo?: CloudCoreHostResources["dynamo"]; s3?: CloudCoreHostResources["s3"]; secretsManager?: SecretsManagerClient; sqs?: CloudCoreHostResources["sqs"] & { send(command: unknown): Promise<unknown> }; ec2?: { send(command: unknown): Promise<unknown> } } | undefined;
}

/** The words the dispatcher logs when it cannot serve the core (no named environment, no core queue). */
export const DISPATCHER_CORE_NOT_CONFIGURED = "the dispatcher cannot serve the core engine here: it needs a named environment and the core dispatch queue's URLs";

/** The dispatcher's core dispatch host: the root on this function and lane A4's host over it. */
export async function createDispatcherCoreDispatch(inputs: DispatcherCoreInputs): Promise<CoreDispatchHost> {
  const { env } = inputs;
  const queueUrl = env.CORE_DISPATCH_QUEUE_URL;
  const deadLetterUrl = env.CORE_DISPATCH_DEAD_LETTER_URL;
  const environmentName = env.AGENTX_ENV?.trim();
  if (queueUrl === undefined || queueUrl === "" || deadLetterUrl === undefined || deadLetterUrl === "" || environmentName === undefined || environmentName === "") throw new Error(DISPATCHER_CORE_NOT_CONFIGURED);
  const configuration = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const secretsManager = inputs.clients?.secretsManager ?? new SecretsManagerClient(configuration);
  const sqs: { send(command: unknown): Promise<unknown> } = inputs.clients?.sqs ?? new SQSClient(configuration);
  const ec2 = inputs.clients?.ec2 ?? new EC2Client(configuration);
  // The broker's own callback signing key (the named environment's secret): the capability a worker posts with and the repository grant it exchanges are verified by the broker with it.
  const callbackKey = (await callbackKeySource(env, () => secretsManager)()).current;
  const resources: CloudCoreHostResources = {
    dynamo: inputs.clients?.dynamo ?? new DynamoDBClient(configuration), s3: inputs.clients?.s3 ?? new S3Client(configuration), artifactBucketName: env.ARTIFACT_BUCKET_NAME ?? "",
    secretsManager, secretNamePrefix: `agentx/${environmentName}/`, installModelKeys: {},
    sqs: sqs as CloudCoreHostResources["sqs"], region: env.AWS_REGION ?? "us-east-1", coreDispatchQueue: { url: queueUrl, deadLetterUrl },
    // A dispatch reads no repository: the dispatcher holds no GitHub App, and its code host refuses in words.
    github: { provider: refusingCodeHost(), credentialRef: "" },
    machines: {
      sessions: inputs.sessions,
      // The reaper's own action on a session's instance (ec2:TerminateInstances, own-tagged instances only): gone once EC2 says it is terminated, else the reaper's next tick finishes the stop.
      stopInstance: async (instanceId) => {
        const answer = await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] })) as { TerminatingInstances?: Array<{ CurrentState?: { Name?: string } }> };
        return { gone: answer.TerminatingInstances?.[0]?.CurrentState?.Name === "terminated" };
      },
      sign: inputs.sign, post: inputs.post, ping: inputs.ping,
    },
  };
  let entry: CloudCoreEntry | undefined;
  const entryOf = async (): Promise<CloudCoreEntry> => {
    entry ??= createCoreHostEntry({
      host: "dispatcher", env, installCompanyId: inputs.installCompanyId, resources, now: () => new Date(), log: inputs.log,
      view: { documentClient: inputs.documentClient as never, tableName: inputs.tableName, callbackSigningKey: callbackKey, repositoryGrants: issueOnlyRepositoryGrants(callbackKey) as never, cloud: true, environmentName },
    });
    return entry;
  };
  return createProductionCoreDispatchHost({
    entry: entryOf, documentClient: inputs.documentClient as never, tableName: inputs.tableName, installCompanyId: inputs.installCompanyId,
    // Read per batch: a dispatcher whose switch went off takes nothing (its messages come back and wait, never Cloud's path).
    enabled: () => anyCoreAreaOn(readCoreEngineFlags(env)),
    changeVisibility: async (receiptHandle, seconds) => { await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds })); },
    log: inputs.log,
  });
}
