// Convergence S0: the production list of Cloud adapter modules, from the adapter lanes merged in train/0515-adapters (A2, A3, A5, A6, A8, A9) and the
// generic AWS adapters vendored from public Code (decision 72 O2: DynamoDB, S3, Secrets Manager). Each module builds its adapter from `CloudModuleDeps`, the
// clients and option bags the Lambda entry makes once per container. Nothing here runs while the switch is off (app.ts builds nothing then).
//
// S3 item 7 (S0-OWED-POINTS): the four points that were owed are now modules. `audit-sink` (lane A7, `onInvalid: "skip"`: a malformed event is dropped with a log line, never
// thrown into a task's transaction) is always registered. `queue` (A2: Code's SQS adapter, at the vendor pin), `worker-machines` (A4: the EC2 session machines) and `check-runner`
// (A9: GitHub Actions, CodeBuild) are registered when the deployment gives their clients in `CloudModuleDeps`. A point whose deps are absent stays EMPTY and
// `buildCloudRegistry` refuses the switch by name (`owedPoints(deps)` lists them): the registry's refusal is the guard, and it is kept.
// The A8 Slack channel adapter is registered only once `slackSwitchReadiness` says ready (slack-switch.ts); the A8 realtime publisher whenever the events service is given.
import { createDynamoStoreFromSettings } from "@rovara-code/aws-adapters/dynamodb";
import { createSqsQueueServiceFromSettings } from "@rovara-code/aws-adapters/sqs";
import { S3ObjectStorage, type S3ObjectStorageOptions } from "@rovara-code/aws-adapters/s3";
import { createSecretsManagerSecretStore, type SecretsManagerSecretStoreOptions } from "@rovara-code/aws-adapters/secrets-manager";
import { TASK_FLOW_INDEXES } from "@rovara-code/broker/core/task-flow";
import { WORKFLOW_DISPATCH_DUE_INDEX, type IndexDefinition, type JsonObject, type JsonValue, type PriceTable } from "@rovara-code/contracts";
import { createCloudAdmission, createCloudMetering, type CloudActionRule } from "../../cloud-adapters/money/index.js";
import { createCloudModelKeyStore, type CloudModelKeyStoreOptions } from "../../cloud-adapters/model-keys/secrets-manager.js";
import { createCloudAuditSink } from "../adapters/audit-sink/index.js";
import { SessionWorkerMachines, type SessionWorkerMachinesDependencies } from "../../aws/worker-machines/session-worker-machines.js";
import type { CodeBuildGateway } from "../../codebuild.js";
import { CODEBUILD_RUNNER_KIND, codeBuildCheckRunner } from "../../plugins/check-runner/codebuild/index.js";
import { GITHUB_ACTIONS_RUNNER_KIND, githubActionsCheckRunner, type GitHubActionsProvider } from "../../plugins/check-runner/github-actions/index.js";
import { createCloudApprovers, createCloudIdentityProvider, type CloudApproversDependencies, type CloudPeopleDependencies } from "../adapters/people/index.js";
import { githubCodeHost } from "../../plugins/code-host/github/index.js";
import { cloudAdmissionLevels, type LevelSources } from "./money.js";
import { cloudRefusalWords } from "./refusal-words.js";
import { cloudPageNotices } from "./realtime.js";
import { slackSwitchReadiness, type SlackSwitchFacts } from "./slack-switch.js";
import { AppSyncEventsPublisher, type AppSyncEventsPublisherOptions } from "../../cloud-adapters/realtime-appsync/publisher.js";
import { CloudSlackChannel, type CloudSlackOptions } from "../../plugins/channel/slack-cloud/index.js";
import { cloudAdapter, type CloudAdapterModule } from "./registry.js";

/** A held room check before a spending action, in dollars (the A5 conformance value; Cloud's own `admitWork` minimum is the open question A5-S0-Q4). */
export const CLOUD_ROOM_MINIMUM_USD = 0.5;

/**
 * Every action Rovara Code's core asks Admission about, and how Cloud admits it. An action not listed is refused (CloudAdmission fails closed): a new
 * spending action in the core is a wiring decision here. `automation.run` is left out on purpose (decision 45.10: automation is hidden in Cloud).
 */
export const CORE_ADMISSION_ACTIONS: Readonly<Record<string, CloudActionRule>> = {
  "task.start": { kind: "room", minimumUsd: CLOUD_ROOM_MINIMUM_USD },
  "machine.start": { kind: "room", minimumUsd: CLOUD_ROOM_MINIMUM_USD },
  "autofix.base-merged": { kind: "room", minimumUsd: CLOUD_ROOM_MINIMUM_USD },
  "nightly.run": { kind: "room", minimumUsd: CLOUD_ROOM_MINIMUM_USD },
  // A model call the core makes itself (Ask, the second review, the design review, a diagnosis): held at its estimate, its worst case when unknown.
  "model.call": { kind: "hold", unknownCostUsd: 2 },
  // The lessons model's own calls (reflect on a finished task; local/app/lessons-model.ts asks `learning.call`): held like any model call. Found by the
  // parity suite: without a rule it failed closed and no lesson was reflected after a merge.
  "learning.call": { kind: "hold", unknownCostUsd: 2 },
};

const isFunction = (value: unknown): boolean => typeof value === "function";
const refuseHollow = (what: string, missing: readonly string[]): never => { throw new Error(`the ${what} input is hollow: ${missing.join(", ")} missing`); };

/** A module's input that names the right things, or the module refuses at create (a hollow input must not look wired). */
function requireFunctions(what: string, value: object | undefined, names: readonly string[]): void {
  const missing = names.filter((name) => !isFunction((value as Record<string, unknown> | undefined)?.[name]));
  if (missing.length > 0) refuseHollow(what, missing);
}

/** The core's dispatch queue (`TaskFlowDeps.dispatchQueue`'s default): a queue map without it would let the registry look complete while no task could be dispatched. */
export const CORE_DISPATCH_QUEUE = "task-dispatch";

/** The State table's indexes the core reads (the dispatch due index, the workspace index and the outbox's planned index). */
export function stateTableIndexes(): IndexDefinition[] {
  return TASK_FLOW_INDEXES.map((index) => (index.name === WORKFLOW_DISPATCH_DUE_INDEX.name ? { name: index.name, partitionAttribute: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, sortAttribute: WORKFLOW_DISPATCH_DUE_INDEX.sortKey } : index));
}

export interface CloudModuleDeps {
  tableName: string;
  dynamo: NonNullable<Parameters<typeof createDynamoStoreFromSettings>[1]>;
  objects: Omit<S3ObjectStorageOptions, "now">;
  secrets: SecretsManagerSecretStoreOptions;
  modelKeys: CloudModelKeyStoreOptions;
  prices: PriceTable;
  levels: LevelSources;
  people: CloudPeopleDependencies;
  approvers: CloudApproversDependencies;
  codeHost: { provider: Parameters<typeof githubCodeHost>[0]; options: Parameters<typeof githubCodeHost>[1] };
  /**
   * The `queue` point (lane A2): Code's SQS adapter over the declared queues (`{ region, queues: { "task-dispatch": { url, deadLetterUrl } } }`; the queues are the stack's, this makes none).
   * `client` replaces the SDK's (tests). Absent: the point stays empty and the registry refuses the switch.
   */
  queue?: { settings: JsonObject; client?: Parameters<typeof createSqsQueueServiceFromSettings>[1] };
  /** The `worker-machines` point (lane A4): the EC2 session machines. Absent: the point stays empty and the registry refuses the switch. */
  workerMachines?: SessionWorkerMachinesDependencies;
  /**
   * The `check-runner` point (lane A9), one adapter per kind given. Absent (neither kind): the point stays empty and the registry refuses the switch.
   * A CI fix is told which check failed, with the log only where the runner can read it.
   */
  checkRunners?: { githubActions?: GitHubActionsProvider; codeBuild?: CodeBuildGateway };
  /** The cloud events service (lane A8's publisher). Absent: no `realtime` adapter, and the core's pages are told by Cloud's own sink only. */
  realtime?: AppSyncEventsPublisherOptions;
  /**
   * Cloud's Slack on the core's channel point (lane A8). Registered only once `slackSwitchReadiness` says ready (the CHANNEL_TENANTS backfill has run to zero, Cloud's bind
   * writes the row, the inbound queue is wired into the sink): until then a Slack message and a Slack card keep going through Cloud's own path, whatever else is on.
   */
  slack?: { options: CloudSlackOptions; facts: SlackSwitchFacts };
}

export function cloudAdapterModules(deps: CloudModuleDeps): CloudAdapterModule[] {
  return [
    cloudAdapter({
      point: "storage", name: "dynamodb", lane: "A1 (public)",
      create: () => createDynamoStoreFromSettings({ tableName: deps.tableName, ttlAttribute: "indexExpiresAt", indexes: JSON.parse(JSON.stringify(stateTableIndexes())) as JsonValue }, deps.dynamo),
    }),
    // A7: Cloud's audit ledger sink over the registry's store (asked at `record`, so the retention-wrapped adapter is the one used). `onInvalid: "skip"`: a malformed core event is dropped
    // with a log line (`audit.record_invalid`), never thrown into a task's transaction (A7 note).
    cloudAdapter({ point: "audit-sink", name: "cloud", lane: "A7", create: (context, registry) => createCloudAuditSink({ store: () => registry.require("storage"), now: () => context.now().getTime(), onInvalid: "skip", log: context.log }) }),
    ...(deps.queue === undefined ? [] : [cloudAdapter({ point: "queue", name: "sqs", lane: "A2", create: (context) => {
      const queues = (deps.queue!.settings as { queues?: Record<string, unknown> }).queues;
      if (queues === undefined || typeof queues !== "object" || queues[CORE_DISPATCH_QUEUE] === undefined) refuseHollow("queue", [`queues.${CORE_DISPATCH_QUEUE}`]);
      return createSqsQueueServiceFromSettings(deps.queue!.settings, deps.queue!.client, () => context.now().getTime());
    } })]),
    ...(deps.workerMachines === undefined ? [] : [cloudAdapter({ point: "worker-machines", name: "ec2", lane: "A4", create: () => {
      const given = deps.workerMachines!;
      requireFunctions("workerMachines", given, ["companyOfWorkspace", "binding", "stopInstance", "sign", "post", "ping"]);
      requireFunctions("workerMachines.sessions", given.sessions, ["get", "ensureSession", "deleteSession", "claimStop", "markStopped"]);
      if (typeof given.companyId !== "string" || given.companyId === "") refuseHollow("workerMachines", ["companyId"]);
      return new SessionWorkerMachines(given);
    } })]),
    ...(deps.checkRunners?.githubActions === undefined ? [] : [cloudAdapter({ point: "check-runner", name: GITHUB_ACTIONS_RUNNER_KIND, lane: "A9", create: () => {
      requireFunctions("checkRunners.githubActions", deps.checkRunners!.githubActions, ["getPullRequestStatus", "getJobLogTail"]);
      return { kind: GITHUB_ACTIONS_RUNNER_KIND, create: () => githubActionsCheckRunner(deps.checkRunners!.githubActions!) };
    } })]),
    ...(deps.checkRunners?.codeBuild === undefined ? [] : [cloudAdapter({ point: "check-runner", name: CODEBUILD_RUNNER_KIND, lane: "A9", create: () => {
      requireFunctions("checkRunners.codeBuild", deps.checkRunners!.codeBuild, ["status"]);
      return { kind: CODEBUILD_RUNNER_KIND, create: ({ allowedRepositories }) => codeBuildCheckRunner({ gateway: deps.checkRunners!.codeBuild!, allowedRepositories }) };
    } })]),
    cloudAdapter({
      point: "admission", name: "cloud", lane: "A5",
      create: (_context, registry) => createCloudAdmission({ store: registry.require("storage"), levels: cloudAdmissionLevels(deps.levels), actions: CORE_ADMISSION_ACTIONS, words: cloudRefusalWords }),
    }),
    cloudAdapter({ point: "metering", name: "cloud", lane: "A5", create: (_context, registry) => createCloudMetering({ store: registry.require("storage"), prices: deps.prices }) }),
    cloudAdapter({ point: "identity", name: "cloud", lane: "A6", create: () => createCloudIdentityProvider(deps.people) }),
    cloudAdapter({ point: "approvers", name: "cloud", lane: "A6", create: () => createCloudApprovers(deps.approvers) }),
    cloudAdapter({ point: "model-keys", name: "secrets-manager", lane: "A3", create: () => createCloudModelKeyStore(deps.modelKeys) }),
    cloudAdapter({ point: "secrets", name: "secrets-manager", lane: "A3 (public)", create: () => createSecretsManagerSecretStore(deps.secrets) }),
    cloudAdapter({ point: "object-storage", name: "s3", lane: "A3 (public)", create: (context) => new S3ObjectStorage({ ...deps.objects, now: () => context.now().getTime() }) }),
    cloudAdapter({ point: "code-host", name: "github", lane: "A9", create: () => githubCodeHost(deps.codeHost.provider, deps.codeHost.options) }),
    // The page notices Cloud's pages understand (realtime.ts maps away the core's own `attention.changed`).
    ...(deps.realtime === undefined ? [] : [cloudAdapter({ point: "realtime", name: "appsync", lane: "A8", create: () => cloudPageNotices(new AppSyncEventsPublisher(deps.realtime!)) })]),
    ...(deps.slack === undefined || !slackSwitchReadiness(deps.slack.facts).ready ? [] : [cloudAdapter({ point: "channel", name: "slack", lane: "A8", create: () => new CloudSlackChannel(deps.slack!.options) })]),
  ];
}

/** Why a point is empty, by point: what the deployment must give in `CloudModuleDeps` for the module to be registered. */
export const OWED_POINTS = {
  queue: "A2 (Code's SQS adapter): give `queue` (the declared queues) in the module deps",
  "worker-machines": "A4 (the EC2 session machines): give `workerMachines` in the module deps",
  "check-runner": "A9 (GitHub Actions, CodeBuild): give `checkRunners` with at least one kind in the module deps",
} as const;

/** The points the module list leaves empty for these deps, with what each needs (shown by a refused switch and in the lane report). Empty: nothing is owed. */
export function owedPoints(deps: Pick<CloudModuleDeps, "queue" | "workerMachines" | "checkRunners">): Array<{ point: keyof typeof OWED_POINTS; needs: string }> {
  const owed: Array<keyof typeof OWED_POINTS> = [];
  if (deps.queue === undefined) owed.push("queue");
  if (deps.workerMachines === undefined) owed.push("worker-machines");
  if (deps.checkRunners?.githubActions === undefined && deps.checkRunners?.codeBuild === undefined) owed.push("check-runner");
  return owed.map((point) => ({ point, needs: OWED_POINTS[point] }));
}
