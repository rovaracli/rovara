// The positive control: Code's own fakes and defaults, run through the same suites a Cloud adapter will be. If one of these fails here, the harness (the vendored suite, the
// way the vendor shims resolve it, the toolchain) is wrong, not an adapter. Each entry is the harness Code's own unit test uses for the same fake (vendor/rovara-code is the
// pinned sha; the unit tests themselves are not vendored).
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeWorkerMachines,
  MemoryDocumentStore,
  MemoryQueueService,
  createAllowAllAdmission,
  createFakeImageRegistry,
  createFakeScheduler,
  createLocalOwnerApprovers,
  createLocalOwnerIdentity,
  createLocalSecretStore,
  createMemoryModelKeyStore,
  createNoopAuditSink,
  createPriceTableMetering,
  createTransactionalOutbox,
  createEnvironmentModelKeyStore,
  environmentVariableFor,
  localOwnerPrincipal,
  LOCAL_SESSION_METHOD,
  LOCAL_SESSION_SCHEME,
} from "@rovara-code/broker/ports";
import { AGENTX_PROTOCOL_VERSION, OUTBOX_PENDING_INDEX, SecretRefSchema, SecretValue, WorkerInvocationSchema } from "@rovara-code/contracts";
import type { MeterEntry, ModelUsage, PriceTable, QueueService, SecretStore, WorkerInvocation } from "@rovara-code/contracts";
import { FolderObjectStorage } from "@rovara-code/local-adapters";
import { CONFORMANCE_INDEXES } from "../../vendor/rovara-code/tests/support/ports/document-store-conformance.js";
import { fakeCheckRunnerWorld, fakeCodeHostWorld, fakeTrackerWorld } from "../../vendor/rovara-code/tests/support/ports/plugin-fake-worlds.js";
import type { PortHarnesses, PortName } from "./ports.js";

export interface CodeFake<P extends PortName> {
  readonly name: string;
  readonly harness: PortHarnesses[P];
}

const owner = localOwnerPrincipal();
const DAY = 86_400_000;
const SESSION_TOKEN = ["session", "value", "for", "tests"].join("-");

function invocation(operationId: string): WorkerInvocation {
  return WorkerInvocationSchema.parse({
    protocolVersion: AGENTX_PROTOCOL_VERSION,
    operationId,
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(48),
    kind: "task",
    payload: { conversationId: randomUUID(), prompt: "make the change" },
  });
}

/** A map behind `read`: the shape Cloud's Secrets Manager adapter has. */
function memorySecrets(held: Map<string, string>): SecretStore {
  return {
    async read(_company, ref) {
      if (!SecretRefSchema.safeParse(ref).success) throw new Error("the secret reference is not valid");
      const name = (ref as Record<string, string>).named;
      if (name === undefined) return undefined;
      const found = held.get(name);
      return found === undefined ? undefined : new SecretValue(found);
    },
  };
}

const table: PriceTable = { currency: "USD", models: { "anthropic/model-a": { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000, cacheReadMicrosPerMillionTokens: 300_000 } } };
const known: ModelUsage = { provider: "anthropic", modelId: "model-a", tokens: { input: 1_000, output: 500, cacheRead: 2_000, cacheWrite: 0 } };
const approvalRequest = { companyId: owner.companyId, requestId: "req-1", kind: "plan", subject: { type: "task", id: "t1" }, projectName: "web", revision: 2, artifactDigest: "a".repeat(64) };

export const CODE_FAKES: { [P in PortName]: readonly CodeFake<P>[] } = {
  "document-store": [{
    name: "Code in-memory fake",
    harness: {
      async create() {
        const store = new MemoryDocumentStore({ indexes: [...CONFORMANCE_INDEXES, OUTBOX_PENDING_INDEX], ttlAttribute: "expiresAt" });
        return { store, settleFeed: () => store.settled(), sweepExpired: async () => void store.sweepExpired() };
      },
    },
  }],
  queue: [{
    name: "Code in-memory fake",
    harness: {
      async create() {
        let now = Date.parse("2026-11-09T10:00:00.000Z");
        return { service: new MemoryQueueService({ now: () => now }), advance: async (seconds) => void (now += seconds * 1_000) };
      },
    },
  }],
  outbox: [{
    name: "Code generic outbox over the in-memory fakes",
    harness: {
      async create() {
        const store = new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] });
        const queues: QueueService = new MemoryQueueService();
        return { store, queues, outbox: createTransactionalOutbox({ store, queues }) };
      },
    },
  }],
  "object-storage": [{
    name: "Code folder adapter",
    harness: {
      async create() {
        let now = Date.parse("2026-11-09T00:00:00.000Z");
        const root = await mkdtemp(join(tmpdir(), "cloud-conformance-objects-"));
        return {
          store: new FolderObjectStorage({ root: join(root, "store"), maxObjectBytes: 100_000, now: () => now, retentionDays: { "evidence-std": 30 } }),
          tooBigBytes: 100_001,
          fitsBytes: 100_000,
          expire: async () => { now += 31 * DAY; },
          dispose: () => rm(root, { recursive: true, force: true }),
        };
      },
    },
  }],
  "secret-store": [
    {
      name: "memory map behind read",
      harness: {
        async create() {
          const held = new Map<string, string>();
          return { store: memorySecrets(held), ref: { named: "db-password" }, unknownRef: { env: "ANYTHING" }, set: async (_ref, text) => { if (text === undefined) held.delete("db-password"); else held.set("db-password", text); } };
        },
      },
    },
    {
      name: "Code environment adapter",
      harness: {
        async create() {
          const environment: Record<string, string | undefined> = {};
          return { store: createLocalSecretStore({ environment }), ref: { env: "P4_SECRET" }, unknownRef: { vault: "x" }, set: async (ref, text) => { environment[ref.env!] = text; } };
        },
      },
    },
  ],
  "worker-machines": [{
    name: "Code fake",
    harness: {
      async create() {
        return { machines: new FakeWorkerMachines({ startingChecks: 2 }), invocation, spec: (machineKey) => ({ machineKey, companyId: "org_aaaaaaaaaaaaaaaaaaaa" }) };
      },
    },
  }],
  scheduler: [{
    name: "Code in-memory fake",
    harness: {
      async create() {
        const scheduler = createFakeScheduler();
        return { scheduler, async fire(spec, scheduledAt) { await scheduler.fireForTest(spec.companyId, spec.scheduleId, scheduledAt); } };
      },
    },
  }],
  "image-registry": [{
    name: "Code in-memory fake",
    harness: {
      async create() {
        const registry = createFakeImageRegistry();
        return { registry, async push(repository) { return registry.pushForTest(repository); }, async makeForeign(repository) { registry.makeForeignForTest(repository); } };
      },
    },
  }],
  admission: [{ name: "Code default (allow all)", harness: { create: async () => createAllowAllAdmission(), admissible: { companyId: owner.companyId, idempotencyKey: "k", action: "task.start", projectName: "web" }, enforcesCost: false } }],
  "audit-sink": [{ name: "Code default (writes nothing)", harness: { create: async () => createNoopAuditSink() } }],
  approvers: [{
    name: "Code default (local owner session)",
    harness: {
      create: async () => createLocalOwnerApprovers({ owner, verifySession: (token) => token === SESSION_TOKEN }),
      request: approvalRequest,
      acceptable: { proofId: "p", method: LOCAL_SESSION_METHOD, requestId: approvalRequest.requestId, revision: approvalRequest.revision, artifactDigest: approvalRequest.artifactDigest, token: SESSION_TOKEN },
      forgedToken: "guessed-session",
    },
  }],
  identity: [{
    name: "Code default (local owner)",
    harness: {
      create: async () => createLocalOwnerIdentity({ isValidSession: (value) => value === SESSION_TOKEN, linkedAccounts: [{ provider: "any-tracker", tenant: "ws", accountId: "owner-account" }] }),
      valid: { credential: { scheme: LOCAL_SESSION_SCHEME, value: SESSION_TOKEN }, principal: { companyId: owner.companyId, personId: owner.personId } },
      linkedAccount: { provider: "any-tracker", tenant: "ws", accountId: "owner-account" },
    },
  }],
  metering: [{
    name: "Code default (tokens times a price table)",
    harness: {
      create: async () => createPriceTableMetering(table),
      known,
      unknown: { provider: "other", modelId: "model-z", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      entry: (usage): MeterEntry => ({ companyId: owner.companyId, entryId: "e1", at: "2026-11-09T10:00:00.000Z", usage, taskId: "t1" }),
    },
  }],
  "model-key-store": [
    { name: "Code memory", harness: { create: async (keys) => createMemoryModelKeyStore(keys) } },
    {
      name: "Code environment",
      harness: { create: async (keys) => createEnvironmentModelKeyStore(Object.fromEntries(Object.entries(keys).map(([provider, key]) => [environmentVariableFor(provider), key])), Object.keys(keys)) },
    },
  ],
  "code-host": [{ name: "Code FakeCodeHost", harness: { makeWorld: fakeCodeHostWorld } }],
  "check-runner": [{ name: "Code FakeCheckRunner", harness: { makeWorld: fakeCheckRunnerWorld } }],
  tracker: [{ name: "Code FakeTracker", harness: { makeWorld: fakeTrackerWorld } }],
};
