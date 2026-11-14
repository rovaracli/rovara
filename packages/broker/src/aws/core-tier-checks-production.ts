// S3-10 (S3-9-TIER-CHECKS-HOST-INPUTS): the CoreTierChecks function's Cloud root from its own clients. See core-tier-checks-entry.ts.
//
// What this function has: the State table, the artifacts bucket (read), the model access function (the reviewer's calls), the GitHub App (the tier pass reads the change from the code host). The core
// dispatch queue's URLs fill its root's queue point, but it holds no grant on the queue: its State writes are held to the tier review's own rows, so it stages no outbox row and sends nothing. What it has not, by design, and is not given: the developer API (nobody is decided for here:
// the people points refuse), the callback signing key (a random key of this container: nothing it could sign is accepted by the broker), the worker machines (a tier pass starts, stops and signs nothing:
// every machine call refuses in words).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { MachineError } from "@rovara-code/contracts";
import { containerOnlyKey, issueOnlyRepositoryGrants } from "../cloud/app/core-host.js";
import { cloudCoreEntryInputsFromHost, coreEngineWanted, type CloudCoreHostResources, type CloudCoreMachineOps } from "../cloud/app/entry-inputs.js";
import { installModelKeyArns } from "../cloud-adapters/model-keys/secrets-manager.js";
import { ModelAccessInvoker, singleAttemptLambda } from "../model-proxy/invoker.js";
import { installationBindingCheck } from "../org/github-connection.js";
import { installOrgIdFromEnvironment } from "../org/resolve.js";
import { createGitHubAppCredentials } from "./github-credentials.js";
import { coreTierChecksHostFrom, type CoreTierChecksHost } from "./broker/core-tier-checks.js";
import type { AwsBrokerDependencies } from "./broker/definitions.js";
import { requiredEnvironment } from "./lambda.js";

/** What a tier pass's function says to any worker machine call. */
export const NO_MACHINES_HERE = "worker machines are not started, stopped or reached from the tier pass's function";

/** Machine operations that refuse every call (a tier pass needs none). */
export function refusingMachineOps(): CloudCoreMachineOps {
  const refuse = async (): Promise<never> => { throw new MachineError("unavailable", NO_MACHINES_HERE); };
  return {
    sessions: { get: refuse, ensureSession: refuse, deleteSession: refuse, claimStop: refuse, markStopped: refuse },
    stopInstance: refuse, sign: refuse, post: refuse, ping: async () => undefined,
  };
}

/** The tier pass's root, or undefined while the switch is off (nothing is built). */
export function coreTierChecksProductionHost(env: NodeJS.ProcessEnv): CoreTierChecksHost | undefined {
  if (!coreEngineWanted(env)) return undefined;
  const configuration = env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION };
  const tableName = requiredEnvironment("STATE_TABLE_NAME");
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(configuration), { marshallOptions: { removeUndefinedValues: true } });
  const secretsManager = new SecretsManagerClient(configuration);
  const github = createGitHubAppCredentials(secretsManager, { requireInstallationBound: installationBindingCheck({ documentClient, tableName }) });
  const lambda = new LambdaClient(configuration);
  const queueUrl = env.CORE_DISPATCH_QUEUE_URL;
  const deadLetterUrl = env.CORE_DISPATCH_DEAD_LETTER_URL;
  const resources: CloudCoreHostResources = {
    dynamo: new DynamoDBClient(configuration), s3: new S3Client(configuration), artifactBucketName: requiredEnvironment("ARTIFACT_BUCKET_NAME"),
    secretsManager, secretNamePrefix: `agentx/${requiredEnvironment("AGENTX_ENV")}/`, installModelKeys: installModelKeyArns(env),
    sqs: new SQSClient(configuration), region: env.AWS_REGION ?? "us-east-1",
    ...(queueUrl === undefined || queueUrl === "" || deadLetterUrl === undefined || deadLetterUrl === "" ? {} : { coreDispatchQueue: { url: queueUrl, deadLetterUrl } }),
    github: { provider: github.provider, credentialRef: requiredEnvironment("GITHUB_APP_CREDENTIAL_REF") },
    machines: refusingMachineOps(),
  };
  const key = containerOnlyKey();
  const installCompanyId = installOrgIdFromEnvironment(env);
  const view = {
    documentClient, tableName, callbackSigningKey: key, repositoryGrants: issueOnlyRepositoryGrants(key), cloud: true, environmentName: env.AGENTX_ENV,
    modelAccess: { access: new ModelAccessInvoker({ functionName: requiredEnvironment("MODEL_ACCESS_FUNCTION_NAME"), lambda, learningLambda: singleAttemptLambda(configuration) }), proxyUrl: "" },
    // The spend ledger (`ledgerOf`) is built where agent runs exist; the reviewer's meter needs it, and this function's only work is that meter's.
    agents: {},
    cloudCore: cloudCoreEntryInputsFromHost({ documentClient, tableName, routes: () => undefined, peopleHere: false, installCompanyId, resources, now: Date.now }),
  };
  return coreTierChecksHostFrom(view as unknown as AwsBrokerDependencies, { env });
}
