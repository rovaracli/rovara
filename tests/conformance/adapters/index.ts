// The Cloud adapters under conformance test. Empty until wave 1 (convergence plan section 4): each adapter lane adds its registration here.
//
//   // adapters/document-store-dynamodb.ts (lane A1)
//   export const dynamoDocumentStore = defineCloudAdapter({ port: "document-store", name: "DynamoDB", harness: { async create() { ... } } });
//   // this file
//   import { dynamoDocumentStore } from "./document-store-dynamodb.js";
//   export const CLOUD_ADAPTERS: readonly CloudAdapterRegistration[] = [dynamoDocumentStore];
//
// A harness builds its adapter over a fake or local emulator of the AWS service (no live AWS in the test shards), and `dispose`s it. Never import a live client constructor with real
// credentials here. The port's pending row in the test report (a todo) disappears once an adapter is registered for it.
import type { CloudAdapterRegistration } from "../registry.js";
import { cloudAdmission } from "./admission-cloud.js";
import { cloudApprovers } from "./approvers-cloud.js";
import { cloudAuditSink } from "./audit-sink-cloud.js";
import { codeBuildCheckRunnerAdapter } from "./check-runner-codebuild.js";
import { githubActionsCheckRunnerAdapter } from "./check-runner-github-actions.js";
import { githubAppCodeHost } from "./code-host-github-app.js";
import { cloudIdentity } from "./identity-cloud.js";
import { cloudMetering } from "./metering-cloud.js";
import { cachedSecretsManagerModelKeyStore, secretsManagerModelKeyStore } from "./model-key-store-secrets-manager.js";
import { jiraTrackerAdapter } from "./tracker-jira.js";
import { linearTrackerAdapter } from "./tracker-linear.js";
import { ec2SessionWorkerMachines } from "./worker-machines-ec2-sessions.js";

export const CLOUD_ADAPTERS: readonly CloudAdapterRegistration[] = [
  secretsManagerModelKeyStore,
  cachedSecretsManagerModelKeyStore,
  cloudAdmission,
  cloudMetering,
  cloudApprovers,
  // Lane A7 cloud/audit-sink
  cloudAuditSink,
  cloudIdentity,
  // Lane A9 cloud/hosts-trackers
  githubAppCodeHost, githubActionsCheckRunnerAdapter, codeBuildCheckRunnerAdapter, linearTrackerAdapter, jiraTrackerAdapter,
  // Lane A4 cloud/ec2-machines
  ec2SessionWorkerMachines,
];
