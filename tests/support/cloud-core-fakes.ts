// Convergence S0: Cloud adapter modules over fakes, for the composition root's tests and the parity suite's core engine. Each module fills one point the way
// the real Cloud adapter will (the adapter lanes' A1-A9); the real modules replace these one by one when train/0515-adapters is merged
// (packages/broker/src/cloud/app/cloud-modules.ts). Nothing here touches AWS.
import { createLocalOwnerApprovers, createLocalOwnerIdentity, createMemoryModelKeyStore, FakeWorkerMachines, MemoryDocumentStore, MemoryQueueService, type FakeWorkerMachinesOptions } from "@rovara-code/broker/ports";
import { TASK_FLOW_INDEXES } from "@rovara-code/broker/core/task-flow";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, type Admission, type AuditEvent, type AuditSink, type DocumentStore, type ObjectStorage, type QueueService, type SecretStore, type TransactItem } from "@rovara-code/contracts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderObjectStorage } from "@rovara-code/local-adapters";
import { FakeHostModel } from "../../vendor/rovara-code/packages/broker/src/plugins/fake/model.js";
import { FakeCodeHost } from "../../vendor/rovara-code/packages/broker/src/plugins/fake/code-host.js";
import { FakeCheckRunner } from "../../vendor/rovara-code/packages/broker/src/plugins/fake/check-runner.js";
import { createCloudAdmission, createCloudMetering } from "../../packages/broker/src/cloud-adapters/money/index.js";
import { CORE_ADMISSION_ACTIONS } from "../../packages/broker/src/cloud/app/cloud-modules.js";
import { cloudAdapter, type CloudAdapterContext, type CloudAdapterModule } from "../../packages/broker/src/cloud/app/registry.js";

export const FAKE_COMPANY = "org_s0parity00000000000a" as const;

export interface FakeWorld {
  clock: { now: number; advance(seconds: number): void };
  store: DocumentStore;
  queues: QueueService;
  machines: FakeWorkerMachines;
  host: FakeCodeHost;
  hostModel: FakeHostModel;
  audit: AuditEvent[];
  /** Admission outcomes, in order (`admitted:task.start`, `refused:task.start:<code>`). */
  spend: string[];
  /** How many times a module's `create` ran (an off app must leave this at 0). */
  created: string[];
  modules: CloudAdapterModule[];
  context(): CloudAdapterContext;
}

/** Records each decision of an admission (the parity suite's spend facet); the decisions themselves are the adapter's. */
function recordingAdmission(inner: Admission, spend: string[]): Admission {
  const note = (action: string, decision: { allowed: boolean; code?: string }) => { spend.push(decision.allowed ? `admitted:${action}` : `refused:${action}:${String(decision.code)}`); };
  return {
    enforcesCost: inner.enforcesCost,
    async admit(request) { const decision = await inner.admit(request); note(request.action, decision); return decision; },
    async stage(request) { const staged = await inner.stage(request); note(request.action, staged.decision); return staged; },
    settle: (id, actual) => inner.settle(id, actual),
    release: (id) => inner.release(id),
  } as Admission;
}

/** An audit sink that stages a Cloud-shaped audit outbox row in the caller's transaction (A7's shape, simplified) and records the event. */
function recordingAudit(events: AuditEvent[]): AuditSink {
  return {
    stage(event): TransactItem[] {
      events.push(event);
      return [{ kind: "put", item: { pk: `ORG#${event.companyId}#AUDIT_OUTBOX`, sk: `EVENT#${event.eventId}`, entityType: "AUDIT_OUTBOX", action: event.action, at: event.at }, condition: { op: "notExists", path: ["pk"] } }];
    },
    async record(event) { events.push(event); },
  };
}

/** S3's stand-in: Code's folder object storage in a temp folder (A3's S3 adapter is the real one; the conformance suite holds them to one contract). */
function folderObjects(): ObjectStorage {
  return new FolderObjectStorage({ root: join(mkdtempSync(join(tmpdir(), "cloud-core-objects-")), "store"), maxObjectBytes: 10_000_000 });
}

export interface FakeWorldOptions {
  machines?: FakeWorkerMachinesOptions;
  admission?: Admission;
  /** The company's monthly money limit (undefined: none). */
  companyLimitUsd?: number;
  /** Leave these points out (to test the registry's refusal). */
  without?: readonly string[];
  /** Register Code's default for these points (`isDefault`), to test the never-default rule. */
  asDefault?: readonly string[];
}

export function createFakeWorld(options: FakeWorldOptions = {}): FakeWorld {
  const clock = { now: Date.parse("2026-11-12T10:00:00.000Z"), advance(seconds: number) { clock.now += seconds * 1_000; } };
  const now = () => new Date(clock.now);
  const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, ttlAttribute: "indexExpiresAt", nowSeconds: () => Math.floor(clock.now / 1_000) });
  const queues = new MemoryQueueService({ now: () => clock.now });
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES], now, ...options.machines });
  const hostModel = new FakeHostModel({ url: "https://github.com/example/demo.git", id: "1", fullName: "example/demo" });
  // A repository record names no host, which is the code host registered as `github` (Cloud's one GitHub App connection, D8).
  const host = Object.defineProperties(new FakeCodeHost(hostModel), { kind: { value: "github" } });
  // The fake host's clock is its own; a credential a worker is sent must expire in the real future (as Code's own tests do).
  const issue = host.issueGitCredential.bind(host);
  host.issueGitCredential = async (repository, access, scope) => ({ ...(await issue(repository, access, scope)), expiresAt: new Date(Date.now() + 50 * 60_000).toISOString() });
  const audit: AuditEvent[] = [];
  const spend: string[] = [];
  const created: string[] = [];
  const secrets: SecretStore = { async read() { return undefined; } };
  const all: CloudAdapterModule[] = [
    cloudAdapter({ point: "storage", name: "dynamodb", lane: "A1", create: () => store }),
    cloudAdapter({ point: "queue", name: "sqs", lane: "A2", create: () => queues }),
    cloudAdapter({ point: "worker-machines", name: "ec2", lane: "A4", create: () => machines }),
    // Lane A5's real adapters, over the same store, with the actions the composition root admits (cloud-modules.ts) and a company limit the scenario sets.
    cloudAdapter({ point: "admission", name: "cloud", lane: "A5", create: () => options.admission ?? recordingAdmission(createCloudAdmission({ store, levels: async () => [{ scope: "ORG", kind: "org", limitUsd: options.companyLimitUsd }], actions: CORE_ADMISSION_ACTIONS, now: () => clock.now }), spend) }),
    cloudAdapter({ point: "metering", name: "cloud", lane: "A5", create: () => createCloudMetering({ store, prices: { currency: "USD", models: {} } }) }),
    cloudAdapter({ point: "audit-sink", name: "cloud", lane: "A7", create: () => recordingAudit(audit) }),
    cloudAdapter({ point: "approvers", name: "cloud", lane: "A6", create: () => createLocalOwnerApprovers({ now }) }),
    cloudAdapter({ point: "identity", name: "cloud", lane: "A6", create: () => createLocalOwnerIdentity({ companyId: IMPLICIT_COMPANY_ID }) }),
    cloudAdapter({ point: "object-storage", name: "s3", lane: "A3", create: () => folderObjects() }),
    cloudAdapter({ point: "code-host", name: host.kind, lane: "A9", create: () => host }),
    cloudAdapter({ point: "check-runner", name: "fake-checks", lane: "A9", create: () => ({ kind: "fake-checks", create: () => new FakeCheckRunner(hostModel) }) }),
    cloudAdapter({ point: "model-keys", name: "secrets-manager", lane: "A3", create: () => createMemoryModelKeyStore({}) }),
    cloudAdapter({ point: "secrets", name: "secrets-manager", lane: "A3", create: () => secrets }),
  ];
  const modules = all
    .filter((module) => !(options.without ?? []).includes(module.point))
    .map((module) => {
      const wrapped: CloudAdapterModule = { ...module, ...((options.asDefault ?? []).includes(module.point) ? { isDefault: true } : {}), create: (context, registry) => { created.push(module.point); return module.create(context, registry); } };
      return wrapped;
    });
  return {
    clock, store, queues, machines, host, hostModel, audit, spend, created, modules,
    context: () => ({ installCompanyId: FAKE_COMPANY, now, env: {}, clients: {}, log: () => undefined }),
  };
}
