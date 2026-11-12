// Convergence S0: the production list of Cloud adapter modules, from the adapter lanes merged in train/0515-adapters (A2, A3, A5, A6, A8, A9) and the
// generic AWS adapters vendored from public Code (decision 72 O2: DynamoDB, S3, Secrets Manager). Each module builds its adapter from `CloudModuleDeps`, the
// clients and option bags the Lambda entry makes once per container. Nothing here runs while the switch is off (app.ts builds nothing then).
//
// Points still OWED (no adapter merged yet), so `buildCloudRegistry` refuses a switch that needs them, by name:
//   - `queue`: Code's SQS adapter (`@rovara/aws-adapters/sqs`, lane A2's public half) is not in the vendor pin yet; bump the pin.
//   - `worker-machines`: lane A4 (EC2 machines, dispatcher hosting `runDispatchOnce`) is not merged.
//   - `audit-sink`: lane A7's adapter (adapters/a7-audit-sink 166d4cfea) is not in train/0515-adapters. When it is: `createCloudAuditSink({ ..., onInvalid: "skip" })`
//     (A7 note: a malformed event is dropped with a log line, never thrown into a task's transaction).
// The A8 Slack channel adapter is registered only once `slackSwitchReadiness` says ready (slack-switch.ts); the A8 realtime publisher whenever the events service is given.
import { createDynamoStoreFromSettings } from "@rovara-code/aws-adapters/dynamodb";
import { S3ObjectStorage, type S3ObjectStorageOptions } from "@rovara-code/aws-adapters/s3";
import { createSecretsManagerSecretStore, type SecretsManagerSecretStoreOptions } from "@rovara-code/aws-adapters/secrets-manager";
import { TASK_FLOW_INDEXES } from "@rovara-code/broker/core/task-flow";
import { WORKFLOW_DISPATCH_DUE_INDEX, type IndexDefinition, type JsonValue, type PriceTable } from "@rovara-code/contracts";
import { createCloudAdmission, createCloudMetering, type CloudActionRule } from "../../cloud-adapters/money/index.js";
import { createCloudModelKeyStore, type CloudModelKeyStoreOptions } from "../../cloud-adapters/model-keys/secrets-manager.js";
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

/** The points no merged adapter fills yet, with the lane that owes each (shown by the registry's refusal and in the lane report). */
export const OWED_POINTS = {
  queue: "A2 public half (@rovara/aws-adapters/sqs) needs a vendor pin bump",
  "worker-machines": "A4 (EC2 machines) not merged",
  "audit-sink": "A7 (adapters/a7-audit-sink) not in train/0515-adapters",
  "check-runner": "A9's CodeBuild and Actions runners need their per-install clients wired here",
} as const;
