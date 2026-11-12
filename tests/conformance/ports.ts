// The port conformance suites Cloud's adapters must pass (convergence plan W0-5), pulled from Code's pinned copy.
//
// The suites are Code's own files: `vendor/rovara-code/tests/support/ports/*` (byte for byte the pinned sha; `tests/support/ports` is in the vendor INCLUDE list, so
// `node scripts/vendor/verify-rovara-code.ts` checks them like the packages). Cloud holds no second copy and edits none of them. This file is the one place that
// names them: it maps each port to its suite function and the harness type that suite takes, and says which vendored suite files are accounted for.
// Adding an adapter does not touch this file (docs/architecture/cloud-adapter-conformance.md); a pin bump that brings a new suite does.
import { runAdmissionConformance, runApproversConformance, runAuditSinkConformance, runIdentityConformance, runMeteringConformance, runModelKeyStoreConformance } from "../../vendor/rovara-code/tests/support/ports/policy-conformance.js";
import type { AdmissionHarness, ApproversHarness, AuditSinkHarness, IdentityHarness, MeteringHarness, ModelKeyStoreHarness } from "../../vendor/rovara-code/tests/support/ports/policy-conformance.js";
import { runContract } from "../../vendor/rovara-code/tests/support/ports/plugin-contract-kit.js";
import type { ContractCheck } from "../../vendor/rovara-code/tests/support/ports/plugin-contract-kit.js";
import { checkRunnerChecks, type CheckRunnerWorld } from "../../vendor/rovara-code/tests/support/ports/check-runner-conformance.js";
import { codeHostChecks, type CodeHostWorld } from "../../vendor/rovara-code/tests/support/ports/code-host-conformance.js";
import { runDocumentStoreConformance, type DocumentStoreHarness } from "../../vendor/rovara-code/tests/support/ports/document-store-conformance.js";
import { runImageRegistryConformance, type ImageRegistryHarness } from "../../vendor/rovara-code/tests/support/ports/image-registry-conformance.js";
import { runObjectStorageConformance, type ObjectStorageHarness } from "../../vendor/rovara-code/tests/support/ports/object-storage-conformance.js";
import { runOutboxConformance, type OutboxHarness } from "../../vendor/rovara-code/tests/support/ports/outbox-conformance.js";
import { runQueueConformance, type QueueHarness } from "../../vendor/rovara-code/tests/support/ports/queue-conformance.js";
import { runSchedulerConformance, type SchedulerHarness } from "../../vendor/rovara-code/tests/support/ports/scheduler-conformance.js";
import { runSecretStoreConformance, type SecretStoreHarness } from "../../vendor/rovara-code/tests/support/ports/secret-store-conformance.js";
import { trackerChecks, type TrackerWorld } from "../../vendor/rovara-code/tests/support/ports/tracker-conformance.js";
import { runWorkerMachinesConformance, type WorkerMachinesHarness } from "../../vendor/rovara-code/tests/support/ports/worker-machines-conformance.js";

/** What an adapter for a plug-in contract (code host, check runner, tracker) hands over: a fresh world for each check, and the checks it cannot run yet, by check name, with the reason (shown as skipped). */
export interface ContractHarness<W> {
  makeWorld: () => Promise<W> | W;
  skip?: Readonly<Record<string, string>>;
}

/** Each port the conformance suites cover, and the harness an adapter for it provides (the type its suite takes). */
export interface PortHarnesses {
  "document-store": DocumentStoreHarness;
  queue: QueueHarness;
  outbox: OutboxHarness;
  "object-storage": ObjectStorageHarness;
  "secret-store": SecretStoreHarness;
  "worker-machines": WorkerMachinesHarness;
  scheduler: SchedulerHarness;
  "image-registry": ImageRegistryHarness;
  admission: AdmissionHarness;
  "audit-sink": AuditSinkHarness;
  approvers: ApproversHarness;
  identity: IdentityHarness;
  metering: MeteringHarness;
  "model-key-store": ModelKeyStoreHarness;
  "code-host": ContractHarness<CodeHostWorld>;
  "check-runner": ContractHarness<CheckRunnerWorld>;
  tracker: ContractHarness<TrackerWorld>;
}
export type PortName = keyof PortHarnesses;

const contract = <W>(checks: readonly ContractCheck<W>[]) => (label: string, harness: ContractHarness<W>): void => runContract(label, checks, harness.makeWorld, harness.skip === undefined ? {} : { skip: harness.skip });

/** The suite for each port: registers its vitest cases for one adapter under the given label. */
export const RUN_SUITE: { [P in PortName]: (label: string, harness: PortHarnesses[P]) => void } = {
  "document-store": runDocumentStoreConformance,
  queue: runQueueConformance,
  outbox: runOutboxConformance,
  "object-storage": runObjectStorageConformance,
  "secret-store": runSecretStoreConformance,
  "worker-machines": runWorkerMachinesConformance,
  scheduler: runSchedulerConformance,
  "image-registry": runImageRegistryConformance,
  admission: runAdmissionConformance,
  "audit-sink": runAuditSinkConformance,
  approvers: runApproversConformance,
  identity: runIdentityConformance,
  metering: runMeteringConformance,
  "model-key-store": runModelKeyStoreConformance,
  "code-host": contract(codeHostChecks),
  "check-runner": contract(checkRunnerChecks),
  tracker: contract(trackerChecks),
};

/** The vendored file that holds each port's suite (a path under vendor/rovara-code/tests/support/ports/). A test checks every `*-conformance.ts` file there is named here or in EXEMPT_SUITES. */
export const SUITE_FILE: Readonly<Record<PortName, string>> = {
  "document-store": "document-store-conformance.ts",
  queue: "queue-conformance.ts",
  outbox: "outbox-conformance.ts",
  "object-storage": "object-storage-conformance.ts",
  "secret-store": "secret-store-conformance.ts",
  "worker-machines": "worker-machines-conformance.ts",
  scheduler: "scheduler-conformance.ts",
  "image-registry": "image-registry-conformance.ts",
  admission: "policy-conformance.ts",
  "audit-sink": "policy-conformance.ts",
  approvers: "policy-conformance.ts",
  identity: "policy-conformance.ts",
  metering: "policy-conformance.ts",
  "model-key-store": "policy-conformance.ts",
  "code-host": "code-host-conformance.ts",
  "check-runner": "check-runner-conformance.ts",
  tracker: "tracker-conformance.ts",
};

/** Vendored suite files that are not a port a Cloud adapter implements, with the reason. */
export const EXEMPT_SUITES: Readonly<Record<string, string>> = {
  "github-client-conformance.ts": "Checks Code's own GitHub REST client against a fixture server. Cloud's code host adapter (A9) is the `code-host` suite above; the client suite belongs to the GitHub plug-in Cloud will adopt, not to a Cloud adapter.",
};
