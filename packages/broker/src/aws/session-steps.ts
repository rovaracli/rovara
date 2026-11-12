import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { MODEL_PROXY_URL_PARAMETER, WORKER_FEATURES_MAX, WORKER_FEATURE_MAX_CHARS, WORKER_PING_FEATURES_FIELD, agentXError, getParametersInBatches } from "@rovara-code/contracts";
import { requiredEnvironment } from "./lambda.js";
import { testServicesEnabled } from "../test-env/test-services-switch.js";
import { readWorkerSettings, type WorkerSettings } from "./worker-settings-read.js";
import { launchPrivateAddresses, workerUserDataWithPrivateAddresses } from "./private-address-launch.js";
import { privateAddressInstallOf } from "../org/private-address-install.js";

export { readWorkerSettings, type WorkerSettings };
import { SessionManager, computeMeteringFromEnvironment } from "./sessions.js";

/** The worker's health endpoint (#80 leaves it unauthenticated for exactly this probe). */
const WORKER_PORT = 8080;
const PING_TIMEOUT_MS = 2_000;
/**
 * #211: what a failed boot answers on the worker's port instead of the worker (boot.sh's
 * report_boot_failure), with the reason in plain words.
 */
const BOOT_FAILED_STATUS = "BootFailed";
/** The error the probe step throws for a reported boot failure; ProbePing's Catch fails the session. */
const BOOT_FAILED_ERROR = "WorkerBootFailed";
const BOOT_FAILURE_REASON_MAX = 300;

const uuid = z.string().uuid();
const generation = z.number().int().positive();
const volumeId = z.string().regex(/^vol-[0-9a-f]{8,17}$/);

/** One step of the provisioner or deleter state machine. */
export const SessionStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("launchConfiguration"), workspaceId: uuid, generation, volumeId, expectNewVolume: z.boolean() }).strict(),
  z.object({ action: z.literal("recordVolume"), workspaceId: uuid, generation, volumeId }).strict(),
  z.object({ action: z.literal("recordInstance"), workspaceId: uuid, generation, instanceId: z.string().regex(/^i-[0-9a-f]{8,17}$/), privateIp: z.ipv4(), instanceType: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z0-9]+$/).optional() }).strict(),
  z.object({ action: z.literal("probePing"), privateIp: z.ipv4() }).strict(),
  // `workerFeatures`: what the probe heard on /ping (LR-1). Optional so a step machine from before this still parses; the machine always sends it, and an absent list is recorded as unknown.
  z.object({ action: z.literal("markReady"), workspaceId: uuid, generation, workerFeatures: z.array(z.string().min(1).max(WORKER_FEATURE_MAX_CHARS)).max(WORKER_FEATURES_MAX).optional() }).strict(),
  z.object({ action: z.literal("markFailed"), workspaceId: uuid, generation, error: z.string().max(16_384) }).strict(),
  z.object({ action: z.literal("markDeleted"), workspaceId: uuid }).strict(),
]);

export type SessionStep = z.infer<typeof SessionStepSchema>;

export interface SessionStepsDependencies {
  sessions: Pick<SessionManager, "markVolume" | "markInstance" | "markReady" | "markFailed" | "markDeleted">;
  workerSettings: () => Promise<WorkerSettings>;
  /**
   * True in a named environment, where workers have no provider keys and no Bedrock access: a launch without a model
   * proxy URL fails here with a clear error rather than boot a worker that could not call a model.
   */
  modelProxyRequired?: boolean;
  /** Test services (`tx`) are on for this install (the stack's TestServicesEnabled, handed to this function as TEST_SERVICES_ENABLED). Named environments only. */
  testServices?: boolean;
  /** The invoke signing key's public key as base64 DER, as KMS GetPublicKey returns it. */
  invokePublicKey: () => Promise<string>;
  /**
   * The boot script to render: "named" is boot.sh, stage 1 of a two-stage boot whose stage 2 ships in the worker image; "legacy" is the
   * production deployment's single-file boot, boot-legacy.sh (ruling R58).
   */
  bootScript: (variant: "named" | "legacy") => string;
  controlPlaneUrl: string;
  logGroupName: string;
  /** GET on the worker's /ping; resolves to what it reported, rejects when unreachable. */
  ping: (url: string) => Promise<WorkerPing | undefined>;
  /**
   * Owner decision 123: the internal addresses the workspace's company approved, for a named environment's launch (private-address-launch.ts). Absent: none. A read that fails fails the launch (it is retried), so a
   * worker never boots with a list it was not meant to have, nor silently without the one it was.
   */
  privateAddresses?: (workspaceId: string) => Promise<string[]>;
}

/** The body of the worker's /ping, or of a failed boot's report in its place. */
export interface WorkerPing {
  status?: string;
  reason?: string;
  /** The invocation features the worker lists (spec 053); none for a worker built before them. */
  features?: string[];
}

/** One short line of plain text: the reason reaches the Slack thread through markFailed. */
function bootFailureReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason.replace(/[\p{Cc}\s]+/gu, " ").trim() : "";
  return (text === "" ? "the boot script failed without a reason" : text).slice(0, BOOT_FAILURE_REASON_MAX);
}

/**
 * What MarkFailed receives for a reported boot failure is ProbePing's Catch text: the Lambda error's
 * type, then its payload as JSON. This keeps only the reason, and never passes the payload on, even
 * when MarkFailed's 4000 character cut leaves it incomplete.
 */
function plainFailure(error: string): string {
  const prefix = `${BOOT_FAILED_ERROR}: `;
  if (!error.startsWith(prefix)) return error;
  const cause = error.slice(prefix.length);
  let message: unknown;
  try {
    message = (JSON.parse(cause) as { errorMessage?: unknown }).errorMessage;
  } catch {
    const quoted = /"errorMessage":("(?:[^"\\]|\\.)*")/.exec(cause)?.[1];
    try {
      message = quoted === undefined ? undefined : JSON.parse(quoted);
    } catch {
      message = undefined;
    }
  }
  return typeof message === "string" ? `worker boot failed: ${bootFailureReason(message)}` : "worker boot failed (no reason recorded)";
}

/** The feature names of a /ping answer that fit what a session records: strings only, none empty or longer than the bound, no more than the bound's count, each once. */
export function boundedFeatures(listed: readonly unknown[]): string[] {
  return [...new Set(listed.filter((feature): feature is string => typeof feature === "string" && feature !== "" && feature.length <= WORKER_FEATURE_MAX_CHARS))].slice(0, WORKER_FEATURES_MAX);
}

/** GET on a worker's /ping. Any HTTP status: a failed boot answers 503 with its reason. */
export async function pingWorker(url: string, timeoutMs = PING_TIMEOUT_MS): Promise<WorkerPing> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json() as { status?: unknown; reason?: unknown; [WORKER_PING_FEATURES_FIELD]?: unknown };
  const listed = body[WORKER_PING_FEATURES_FIELD];
  return {
    ...(typeof body.status === "string" ? { status: body.status } : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    ...(Array.isArray(listed) ? { features: boundedFeatures(listed) } : {}),
  };
}

export function createSessionStepsHandler(dependencies: SessionStepsDependencies) {
  return async (event: unknown): Promise<unknown> => {
    const step = SessionStepSchema.parse(event);
    switch (step.action) {
      case "launchConfiguration": {
        const [settings, invokePublicKey, privateAddresses] = await Promise.all([
          dependencies.workerSettings(), dependencies.invokePublicKey(),
          // Only a named environment's stage 2 applies the list; the legacy boot never reads it, so its launch never reads or carries one.
          dependencies.modelProxyRequired && dependencies.privateAddresses !== undefined ? dependencies.privateAddresses(step.workspaceId) : Promise.resolve([]),
        ]);
        if (dependencies.modelProxyRequired && !settings.modelProxyUrl) {
          throw new Error(`The model proxy URL is missing: this environment's workers have no provider keys or Bedrock access, and the SSM parameter ${MODEL_PROXY_URL_PARAMETER} is not set. Deploy the control plane's model proxy first.`);
        }
        // A named environment's stage 2 comes out of its worker image and is checked against the hash set beside that image.
        if (dependencies.modelProxyRequired && !settings.bootStage2Sha256) {
          throw agentXError("RUNTIME_UNAVAILABLE", "this control plane has no boot hash for its worker image; run agentx upgrade");
        }
        const userData = workerUserDataWithPrivateAddresses({
          workspaceId: step.workspaceId,
          generation: step.generation,
          volumeId: step.volumeId,
          expectNewVolume: step.expectNewVolume,
          workerImage: settings.workerImage,
          ...(dependencies.modelProxyRequired && settings.bootStage2Sha256 ? { bootStage2Sha256: settings.bootStage2Sha256 } : {}),
          ...(settings.executorImage ? { executorImage: settings.executorImage } : {}),
          invokePublicKey,
          controlPlaneUrl: dependencies.controlPlaneUrl,
          modelProvider: settings.modelProvider,
          modelId: settings.modelId,
          promptCacheRetention: settings.promptCacheRetention,
          ...(settings.openRouterSecretArn ? { openRouterSecretArn: settings.openRouterSecretArn } : {}),
          ...(settings.openRouterProviders ? { openRouterProviders: settings.openRouterProviders } : {}),
          ...(settings.anthropicSecretArn ? { anthropicSecretArn: settings.anthropicSecretArn } : {}),
          ...(settings.openaiSecretArn ? { openaiSecretArn: settings.openaiSecretArn } : {}),
          ...(settings.modelProxyUrl ? { modelProxyUrl: settings.modelProxyUrl } : {}),
          ...(settings.modelFallback ? { modelFallback: settings.modelFallback } : {}),
          // A named environment is the one that requires a model proxy; the legacy deployment's launch says nothing.
          ...(dependencies.modelProxyRequired ? { environmentKind: "named" as const } : {}),
          // The boot pre-pulls the catalog images only when test services (`tx`) are on; nothing is told to a launch with them off.
          ...(dependencies.modelProxyRequired && dependencies.testServices === true ? { testServices: true as const } : {}),
          logGroupName: dependencies.logGroupName,
        }, dependencies.bootScript(dependencies.modelProxyRequired ? "named" : "legacy"), privateAddresses);
        // Already base64 gzip, the form RunInstances takes (#229).
        return { userData };
      }
      case "recordVolume":
        await dependencies.sessions.markVolume(step.workspaceId, step.generation, step.volumeId);
        return {};
      case "recordInstance":
        await dependencies.sessions.markInstance(step.workspaceId, step.generation, step.instanceId, step.privateIp, step.instanceType);
        return {};
      case "probePing": {
        let ping: WorkerPing | undefined;
        try {
          ping = await dependencies.ping(`http://${step.privateIp}:${WORKER_PORT}/ping`);
        } catch {
          ping = undefined;
        }
        const status = ping?.status;
        if (status === BOOT_FAILED_STATUS) {
          // Fails the provisioning now: the worker will never answer, so waiting out the probe
          // window would only make the user wait for the same failure.
          const failure = new Error(bootFailureReason(ping?.reason));
          failure.name = BOOT_FAILED_ERROR;
          // The stack says nothing useful here and would only fill the Catch text.
          failure.stack = `${BOOT_FAILED_ERROR}: ${failure.message}`;
          throw failure;
        }
        // `features` is always an array (empty when the worker listed none or did not answer), so the machine can pass it on as it is (LR-1).
        return { healthy: status === "Healthy" || status === "HealthyBusy", status: status ?? "Unreachable", features: ping?.features ?? [] };
      }
      case "markReady":
        return dependencies.sessions.markReady(step.workspaceId, step.generation, step.workerFeatures);
      case "markFailed":
        return dependencies.sessions.markFailed(step.workspaceId, step.generation, plainFailure(step.error));
      case "markDeleted":
        await dependencies.sessions.markDeleted(step.workspaceId);
        return {};
    }
  };
}

const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
const ssm = new SSMClient(awsClientConfiguration);
const kms = new KMSClient(awsClientConfiguration);
let publicKey: Promise<string> | undefined;

// Set on named environments' functions only (infra/lib/session-lifecycle.ts), which are also the only ones allowed to read
// the proxy URL parameter: an SSM GetParameters naming a parameter the caller may not read fails as a whole.
const modelProxyRequired = process.env.MODEL_PROXY_REQUIRED === "true";

const stateClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration));
const stateTableName = process.env.STATE_TABLE_NAME ?? "";

export const handler = createSessionStepsHandler({
  modelProxyRequired,
  testServices: testServicesEnabled(),
  // The provisioner's cleanup (a launch that failed) and the deleter's last step end compute here.
  sessions: new SessionManager({
    documentClient: stateClient,
    tableName: stateTableName,
    ...computeMeteringFromEnvironment(stateClient, stateTableName),
  }),
  async workerSettings() {
    return readWorkerSettings(
      (names) => getParametersInBatches(names, (batch) => ssm.send(new GetParametersCommand({ Names: batch }))),
      { prefix: requiredEnvironment("WORKER_SETTINGS_PREFIX"), modelProxyRequired },
    );
  },
  invokePublicKey() {
    // The key never changes, so one read per container.
    publicKey ??= kms.send(new GetPublicKeyCommand({ KeyId: requiredEnvironment("INVOKE_SIGNING_KEY_ARN") }))
      .then((response) => Buffer.from(response.PublicKey ?? new Uint8Array()).toString("base64"));
    return publicKey;
  },
  // Bundled beside the handler from packages/worker/ec2/: boot.sh (stage 1) for a named environment, boot-legacy.sh for the legacy deployment.
  bootScript: (variant) => readFileSync(join(process.env.LAMBDA_TASK_ROOT ?? ".", variant === "legacy" ? "boot-legacy.sh" : "boot.sh"), "utf8"),
  controlPlaneUrl: process.env.CONTROL_PLANE_URL ?? "",
  logGroupName: process.env.WORKER_LOG_GROUP_NAME ?? "",
  ping: (url) => pingWorker(url),
  privateAddresses: (workspaceId) => launchPrivateAddresses({ documentClient: stateClient, tableName: stateTableName }, workspaceId, privateAddressInstallOf()),
});
