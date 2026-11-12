// Convergence S0: Cloud adapter modules over fakes, for the composition root's tests and the parity suite's core engine. Each module fills one point the way
// the real Cloud adapter will (the adapter lanes' A1-A9); the real modules replace these one by one when train/0515-adapters is merged
// (packages/broker/src/cloud/app/cloud-modules.ts). Nothing here touches AWS.
import { createAllowAllAdmission, createLocalOwnerApprovers, createLocalOwnerIdentity, createMemoryModelKeyStore, createPriceTableMetering, FakeWorkerMachines, MemoryDocumentStore, MemoryQueueService, type FakeWorkerMachinesOptions } from "@rovara-code/broker/ports";
import { TASK_FLOW_INDEXES } from "@rovara-code/broker/core/task-flow";
import { IMPLICIT_COMPANY_ID, WORKER_INVOCATION_FEATURES, type Admission, type AuditEvent, type AuditSink, type DocumentStore, type ObjectStorage, type QueueService, type SecretStore, type TransactItem } from "@rovara-code/contracts";
import { FakeHostModel } from "../../vendor/rovara-code/packages/broker/src/plugins/fake/model.js";
import { FakeCodeHost } from "../../vendor/rovara-code/packages/broker/src/plugins/fake/code-host.js";
import { FakeCheckRunner } from "../../vendor/rovara-code/packages/broker/src/plugins/fake/check-runner.js";
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
  /** How many times a module's `create` ran (an off app must leave this at 0). */
  created: string[];
  modules: CloudAdapterModule[];
  context(): CloudAdapterContext;
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

function memoryObjects(): ObjectStorage {
  const objects = new Map<string, Buffer>();
  const storage = {
    put: async (key: string, body: Uint8Array) => { objects.set(key, Buffer.from(body)); return { key }; },
    get: async (key: string) => { const body = objects.get(key); return body === undefined ? undefined : { body, meta: { key } }; },
    head: async (key: string) => (objects.has(key) ? { key } : undefined),
    delete: async (key: string) => { objects.delete(key); },
    list: async (prefix: string) => [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
  };
  return storage as unknown as ObjectStorage;
}

export interface FakeWorldOptions {
  machines?: FakeWorkerMachinesOptions;
  admission?: Admission;
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
  const hostModel = new FakeHostModel({ url: "https://examplehost/example/demo.git", id: "1", fullName: "example/demo" });
  // A repository record names no host, which is the code host registered as `github` (Cloud's one GitHub App connection, D8).
  const host = Object.defineProperties(new FakeCodeHost(hostModel), { kind: { value: "github" } });
  const audit: AuditEvent[] = [];
  const created: string[] = [];
  const secrets: SecretStore = { async read() { return undefined; } };
  const all: CloudAdapterModule[] = [
    cloudAdapter({ point: "storage", name: "dynamodb", lane: "A1", create: () => store }),
    cloudAdapter({ point: "queue", name: "sqs", lane: "A2", create: () => queues }),
    cloudAdapter({ point: "worker-machines", name: "ec2", lane: "A4", create: () => machines }),
    cloudAdapter({ point: "admission", name: "cloud", lane: "A5", create: () => options.admission ?? { ...createAllowAllAdmission(), enforcesCost: true } }),
    cloudAdapter({ point: "metering", name: "cloud", lane: "A5", create: () => createPriceTableMetering({ currency: "USD", models: {} }) }),
    cloudAdapter({ point: "audit-sink", name: "cloud", lane: "A7", create: () => recordingAudit(audit) }),
    cloudAdapter({ point: "approvers", name: "cloud", lane: "A6", create: () => createLocalOwnerApprovers({ now }) }),
    cloudAdapter({ point: "identity", name: "cloud", lane: "A6", create: () => createLocalOwnerIdentity({ companyId: IMPLICIT_COMPANY_ID }) }),
    cloudAdapter({ point: "object-storage", name: "s3", lane: "A3", create: () => memoryObjects() }),
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
    clock, store, queues, machines, host, hostModel, audit, created, modules,
    context: () => ({ installCompanyId: FAKE_COMPANY, now, env: {}, clients: {}, log: () => undefined }),
  };
}
