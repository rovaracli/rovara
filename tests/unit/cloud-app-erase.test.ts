// Convergence S0 follow-up: a removed person's evidence for core-stamped tasks (packages/broker/src/cloud/app/erase.ts), over the parity fakes.
// The walk reads the person's task index, erases each core-stamped task's evidence, keeps everything else, writes nothing, and reports counts only. It runs from two ports
// (the store and the object storage), never the registry or a switch: a task keeps its engine after the switch is turned off. Core task records carry `companyId` only
// (vendor core task-flow/start.ts), so they are seeded that way; Cloud's own walk (`orgId` only) is shown to skip them.
import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Readable } from "node:stream";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createOwnerTaskAccess } from "@rovara-code/broker/core/task-flow";
import { createDynamoStoreFromSettings } from "@rovara-code/aws-adapters/dynamodb";
import type { AdapterRegistry, DocumentStore, ObjectStorage, OrgId } from "@rovara-code/contracts";
import { FakeDynamoDb } from "../../vendor/rovara-code/tests/support/ports/dynamodb-fake.js";
import { FakeS3 } from "../../vendor/rovara-code/tests/support/ports/aws-fakes.js";
import { evidencePrefixesOf as codePrefixesOf, eraseTaskEvidence } from "../../vendor/rovara-code/packages/broker/src/core/proof/evidence-erase.js";
import { createEvidenceErase, evidencePrefixesOf as cloudPrefixesOf } from "../../packages/broker/src/rovara-code/evidence-erase.js";
import { coreEvidencePorts, personErasureStep } from "../../packages/broker/src/aws/broker/evidence-wiring.js";
import {
  CORE_ERASE_MARGIN_MS, CORE_ERASE_PENDING_PK, CORE_ERASE_RETRY_MAX, CORE_ERASE_RESUME_SHARE_MS, CorePersonEraseUnfinished, beginCoreEvidenceErase, noteRequestEnd, coreErasePortsOf, corePersonEraseOf, createCloudApp, erasePersonOnCore, readCoreEngineFlags, resumeCoreEvidenceErase, stampForNewTask, stampItem, type CloudApp, type CoreErasePorts, type PersonEraseOnCoreReport,
} from "../../packages/broker/src/cloud/app/index.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";

const OTHER_COMPANY = "org_s0parity00000000000b";
const PERSON = "a".repeat(64);
const OTHER_PERSON = "b".repeat(64);
const PACK_NAME = `${"c".repeat(64)}.json`;
const TAIL_NAME = "d".repeat(64);
const NONE: PersonEraseOnCoreReport = { tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, missingRecord: 0, refused: 0, incomplete: 0, complete: true };

interface Seeded { taskId: string; ownerKey: string; workspaceId: string }

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv): CloudApp {
  return createCloudApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
      services: () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } }),
    }),
  });
}

interface SeedInput {
  /** Whose index row it is (the person erased, or someone else). */
  person: string;
  /** Who created the task (the record's `developerId`): a person with a row for a task they did not create took it over. Default: `person`. */
  creator?: string;
  company?: string;
  stamp: "core" | "cloud" | "none";
  /** The company the person's index row names (both engines write `orgId` on it). Default: the task's company. */
  indexCompany?: string;
  /** Replaces the owner key (a malformed one is refused). */
  ownerKey?: string;
  /** The record's shape: the core's start writes `companyId` only, Cloud's records `orgId`. Default: the core's when the stamp is `core`. */
  shape?: "core" | "cloud";
  /** No task record at all (it expired, or was never written). */
  noRecord?: boolean;
}

/**
 * A task of a person: the index row, the task record, optionally an engine stamp, and the two evidence objects (a pack and an output tail). A core-stamped record is shaped
 * as the core's start writes it (`companyId` only, no `orgId`); Cloud's own record names its company as `orgId`.
 */
let seededRows = 0;
async function seedRecords(world: FakeWorld, input: SeedInput, store: DocumentStore = world.store): Promise<Seeded> {
  const company = input.company ?? FAKE_COMPANY;
  const seeded = { taskId: randomUUID(), ownerKey: input.ownerKey ?? randomUUID().replaceAll("-", "").repeat(2), workspaceId: randomUUID() };
  const shape = input.shape ?? (input.stamp === "core" ? "core" : "cloud");
  const owner = shape === "core" ? { companyId: company } : { orgId: company };
  await store.put({ item: { pk: `DEVELOPER#${input.person}`, sk: `TASK#${new Date(Date.UTC(2026, 10, 12, 10, 0, 0) + (seededRows += 1) * 1_000).toISOString()}#${seeded.taskId}`, entityType: "DEVELOPER_TASK_INDEX", taskId: seeded.taskId, orgId: input.indexCompany ?? company } });
  if (input.noRecord !== true) await store.put({ item: { pk: `DEVTASK#${seeded.taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: seeded.taskId, developerId: input.creator ?? input.person, ...owner, ownerKey: seeded.ownerKey, workspaceId: seeded.workspaceId } });
  if (input.stamp !== "none") {
    const flags = readCoreEngineFlags(input.stamp === "core" ? { CLOUD_CORE_ENGINE: "on" } : {});
    await store.put({ item: stampItem(company, seeded.taskId, stampForNewTask(flags, company, new Date(world.clock.now))).item });
  }
  return seeded;
}

async function seedTask(world: FakeWorld, objects: ObjectStorage, input: SeedInput): Promise<Seeded> {
  const seeded = await seedRecords(world, input);
  for (const key of keysOf(seeded)) await objects.put(key, new TextEncoder().encode("{}"), { contentType: "application/json", metadata: {}, retention: "evidence-std" });
  return seeded;
}

const keysOf = (task: Seeded): string[] => [
  `private/${task.ownerKey}/${task.workspaceId}/evidence-pack/${task.taskId}/${PACK_NAME}`,
  `private/${task.ownerKey}/${task.workspaceId}/evidence/${task.taskId}/${TAIL_NAME}`,
];

/** Per task, how many of its two objects are left (an answer that names no key). */
async function leftOf(registry: Pick<AdapterRegistry, "require">, task: Seeded): Promise<number> {
  const objects = registry.require("object-storage");
  return (await Promise.all(keysOf(task).map(async (key) => (await objects.stat(key)) !== undefined))).filter(Boolean).length;
}

/** A world with the registry built once (only to give the folder object storage and the store); the walk itself is given the two ports, like the broker. */
async function setup() {
  const world = createFakeWorld();
  const registry = await appOver(world, { CLOUD_CORE_ENGINE: "on" }).registry();
  const objects = registry.require("object-storage");
  const logs: Array<Record<string, unknown>> = [];
  const ports: CoreErasePorts = { store: world.store, objects, log: (entry) => logs.push(entry) };
  const seed = (input: SeedInput) => seedTask(world, objects, input);
  return { world, registry, ports, logs, seed };
}

describe("erasePersonOnCore", () => {
  it("erases a core task's evidence, keeps another person's task, another company's task and a Cloud-stamped task, and reports counts", async () => {
    const { registry, ports, seed } = await setup();
    const mine = await seed({ person: PERSON, stamp: "core" });
    const second = await seed({ person: PERSON, stamp: "core" });
    const theirs = await seed({ person: OTHER_PERSON, stamp: "core" });
    const cloud = await seed({ person: PERSON, stamp: "cloud" });
    const unstamped = await seed({ person: PERSON, stamp: "none" });
    const elsewhere = await seed({ person: PERSON, company: OTHER_COMPANY, stamp: "core" });
    // Positive control: everything is there before the walk.
    for (const task of [mine, second, theirs, cloud, unstamped, elsewhere]) expect(await leftOf(registry, task)).toBe(2);

    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });

    expect(report).toEqual({ tasks: 5, erased: 2, cloudStamped: 2, skipped: 1, missingRecord: 0, refused: 0, incomplete: 0, complete: true });
    expect(await leftOf(registry, mine)).toBe(0);
    expect(await leftOf(registry, second)).toBe(0);
    expect(await leftOf(registry, theirs)).toBe(2);
    expect(await leftOf(registry, cloud)).toBe(2);
    expect(await leftOf(registry, unstamped)).toBe(2);
    expect(await leftOf(registry, elsewhere)).toBe(2);
    // Counts only: nothing in the report names a person, a task or a key.
    expect(JSON.stringify(report)).not.toMatch(/[a-f0-9]{16}/u);
  });

  it("erases the evidence of a task the person took over (they hold its index row) and keeps the creator's other tasks: the same created-or-owns rule as Cloud's walk", async () => {
    const { registry, ports, seed } = await setup();
    const takenOver = await seed({ person: PERSON, creator: OTHER_PERSON, stamp: "core" });
    const creatorsOwn = await seed({ person: OTHER_PERSON, stamp: "core" });
    expect(await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON })).toMatchObject({ erased: 1 });
    expect(await leftOf(registry, takenOver)).toBe(0);
    expect(await leftOf(registry, creatorsOwn)).toBe(2);
  });

  it("leaves a task alone whose index row names another company, even if its record names this one", async () => {
    const { registry, ports, seed } = await setup();
    const task = await seed({ person: PERSON, stamp: "core", indexCompany: OTHER_COMPANY });
    expect(await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON })).toMatchObject({ erased: 0, skipped: 1 });
    expect(await leftOf(registry, task)).toBe(2);
  });

  it("leaves a task alone whose record names another company, even if the person's index row names this one", async () => {
    const { world, registry, ports, seed } = await setup();
    const task = await seed({ person: PERSON, stamp: "core" });
    const meta = (await world.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }))!;
    await world.store.put({ item: { ...meta, companyId: OTHER_COMPANY } });
    expect(await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON })).toMatchObject({ erased: 0, skipped: 1 });
    expect(await leftOf(registry, task)).toBe(2);
  });

  it("is idempotent: a second run erases nothing new, writes nothing and keeps what was kept", async () => {
    const { world, registry, ports, seed } = await setup();
    const mine = await seed({ person: PERSON, stamp: "core" });
    const theirs = await seed({ person: OTHER_PERSON, stamp: "core" });
    const first = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(first.erased).toBe(1);
    const writes = [vi.spyOn(world.store, "put"), vi.spyOn(world.store, "transact"), vi.spyOn(world.store, "update"), vi.spyOn(world.store, "delete")];
    const again = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(again).toEqual(first);
    // The only writes are the walk's own pending item (put first, deleted at the end): no task, index row or stamp is written.
    for (const spy of writes) for (const [request] of spy.mock.calls) expect(JSON.stringify(request)).toContain(CORE_ERASE_PENDING_PK);
    expect(writes[1]!).not.toHaveBeenCalled();
    expect(writes[2]!).not.toHaveBeenCalled();
    expect(await leftOf(registry, mine)).toBe(0);
    expect(await leftOf(registry, theirs)).toBe(2);
  });

  it("counts a task whose erase did not finish or threw, goes on to the next, and keeps the fault's text out of the report", async () => {
    const { registry, ports, seed } = await setup();
    const stuck = await seed({ person: PERSON, stamp: "core" });
    const fine = await seed({ person: PERSON, stamp: "core" });
    const objects = registry.require("object-storage");
    const real = objects.deletePrefix.bind(objects);
    const mode = { value: "unfinished" as "unfinished" | "throws" };
    vi.spyOn(objects, "deletePrefix").mockImplementation(async (prefix) => {
      if (prefix.includes(stuck.taskId)) { if (mode.value === "throws") throw new Error(`secret ${prefix}`); await real(prefix); return false; }
      return real(prefix);
    });
    const first = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(first).toMatchObject({ erased: 1, incomplete: 1, refused: 0, complete: false });
    expect(await leftOf(registry, fine)).toBe(0);
    // The next run tries only the failing task again (the walk has gone past the rest), here with a fault that names a key.
    mode.value = "throws";
    const again = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(again).toMatchObject({ erased: 0, incomplete: 1, refused: 0, complete: false });
    for (const report of [first, again]) expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("counts a task with a malformed id apart (refused), logs counts only, and does not hold the request open", async () => {
    const { registry, ports, logs, seed } = await setup();
    const bad = await seed({ person: PERSON, stamp: "core", ownerKey: "owner.not-a-plain-id" });
    const fine = await seed({ person: PERSON, stamp: "core" });
    const report = await corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON);
    expect(report).toEqual({ tasks: 2, erased: 1, cloudStamped: 0, skipped: 0, missingRecord: 0, refused: 1, incomplete: 0, complete: true });
    expect(await leftOf(registry, fine)).toBe(0);
    expect(await leftOf(registry, bad)).toBe(2);
    expect(logs).toEqual([{ component: "broker", event: "core_person_erase.refused", tasks: 2, refused: 1 }]);
  });

  it("refuses an empty company or person (nothing is walked)", async () => {
    const { ports } = await setup();
    await expect(erasePersonOnCore({ ports, companyId: "", developerId: PERSON })).rejects.toThrow();
    await expect(erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: "" })).rejects.toThrow();
  });
});

describe("with every switch off", () => {
  it("a person's erase still erases the evidence of a core-stamped task, with no registry and no switch (a task keeps its engine)", async () => {
    const { registry, ports, seed } = await setup();
    const task = await seed({ person: PERSON, stamp: "core" });
    // Nothing here reads a switch: the flags are off and an app over them builds nothing.
    const offWorld = createFakeWorld();
    const off = appOver(offWorld, {});
    expect(off.active).toBe(false);
    const order: string[] = [];
    await personErasureStep(undefined, { person: async () => { order.push("evidence"); } }, undefined, corePersonEraseOf(ports))(FAKE_COMPANY, PERSON);
    expect(order).toEqual(["evidence"]);
    expect(await leftOf(registry, task)).toBe(0);
    expect(offWorld.created).toEqual([]);
  });

  it("with no core-stamped task it reads and deletes nothing", async () => {
    const { ports, world, seed } = await setup();
    await seed({ person: PERSON, stamp: "cloud" });
    await seed({ person: PERSON, stamp: "none" });
    const deleted = vi.spyOn(ports.objects, "deletePrefix");
    const writes = [vi.spyOn(world.store, "put"), vi.spyOn(world.store, "transact")];
    expect(await corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON)).toEqual({ ...NONE, tasks: 2, cloudStamped: 2 });
    expect(deleted).not.toHaveBeenCalled();
    // Only the pending item is written (owed, then cleared); nothing of a task.
    for (const [request] of writes[0]!.mock.calls) expect(JSON.stringify(request)).toContain(CORE_ERASE_PENDING_PK);
    expect(writes[1]!).not.toHaveBeenCalled();
  });
});

/** Cloud's person erase over a table where the person has one core-shaped task: the index row names `orgId`, the task record names `companyId` only. Its bucket holds that task's evidence. */
function cloudWalkOver(core: Seeded) {
  const objects = new Set(keysOf(core));
  const items = new Map<string, Record<string, unknown>>([[`EVIDENCE_STORED#${FAKE_COMPANY}|META`, { pk: `EVIDENCE_STORED#${FAKE_COMPANY}`, sk: "META" }]]);
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof PutCommand) { items.set(`${String(command.input.Item!.pk)}|${String(command.input.Item!.sk)}`, command.input.Item!); return {}; }
    if (command instanceof DeleteCommand) { items.delete(`${String(command.input.Key!.pk)}|${String(command.input.Key!.sk)}`); return {}; }
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues as Record<string, string>;
      return values[":pk"] === `DEVELOPER#${PERSON}` ? { Items: [{ taskId: core.taskId, orgId: FAKE_COMPANY }] } : { Items: [] };
    }
    if (command instanceof GetCommand) {
      const key = command.input.Key as { pk: string; sk: string };
      if (key.pk.startsWith("EVIDENCE_")) return { Item: items.get(`${key.pk}|${key.sk}`) };
      return { Item: key.pk === `DEVTASK#${core.taskId}` ? { ownerKey: core.ownerKey, workspaceId: core.workspaceId, companyId: FAKE_COMPANY } : undefined };
    }
    throw new Error("unexpected command");
  });
  const s3 = { async send(command: unknown) {
    if (command instanceof ListObjectsV2Command) return { Contents: [...objects].filter((key) => key.startsWith(command.input.Prefix!)).map((Key) => ({ Key })) };
    if (command instanceof DeleteObjectsCommand) { for (const { Key } of command.input.Delete!.Objects!) objects.delete(Key!); return {}; }
    throw new Error("unexpected command");
  } };
  return { objects, ports: { s3: s3 as never, artifactBucketName: "bucket", documentClient: { send }, tableName: "State" } };
}

describe("who erases what", () => {
  it("Cloud's own person erase skips a core-shaped task record (companyId only), so the core's walk is the only one that erases it", async () => {
    const { registry, ports, seed } = await setup();
    const task = await seed({ person: PERSON, stamp: "core" });
    const cloud = cloudWalkOver(task);
    await createEvidenceErase(cloud.ports).person(FAKE_COMPANY, PERSON);
    expect(cloud.objects.size).toBe(2);
    // The core's walk over its own store does erase it.
    expect(await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON })).toMatchObject({ erased: 1 });
    expect(await leftOf(registry, task)).toBe(0);
  });
});

describe("the same prefixes as Code's per-task erase", () => {
  it("Cloud's copy of evidencePrefixesOf and Code's agree, including on ids that are refused", () => {
    const ok = { ownerKey: "o".repeat(64), workspaceId: randomUUID(), taskId: randomUUID() };
    for (const scope of [ok, { ...ok, taskId: undefined }, { ...ok, ownerKey: "../x" }, { ...ok, workspaceId: "a/b" }, { ...ok, taskId: "" }, { ...ok, taskId: "t/../u" }, { ...ok, ownerKey: "" }]) {
      expect(cloudPrefixesOf(scope)).toEqual(codePrefixesOf(scope));
    }
  });

  it("deletes exactly what Code's eraseTaskEvidence deletes", async () => {
    const { registry, ports, seed } = await setup();
    const a = await seed({ person: PERSON, stamp: "core" });
    const b = await seed({ person: PERSON, stamp: "core" });
    await eraseTaskEvidence(registry.require("object-storage"), a);
    await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
    expect([await leftOf(registry, a), await leftOf(registry, b)]).toEqual([0, 0]);
  });
});

describe("corePersonEraseOf and the person-erasure step", () => {
  it("erases, and throws counts-only when a task did not finish so the request is repeated", async () => {
    const { registry, ports, seed } = await setup();
    const task = await seed({ person: PERSON, stamp: "core" });
    const core = corePersonEraseOf(ports);
    expect(await core.person(FAKE_COMPANY, PERSON)).toMatchObject({ erased: 1, incomplete: 0 });
    expect(await leftOf(registry, task)).toBe(0);
    const stuck = await seed({ person: PERSON, stamp: "core" });
    vi.spyOn(registry.require("object-storage"), "deletePrefix").mockResolvedValue(false);
    const error = await core.person(FAKE_COMPANY, PERSON).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CorePersonEraseUnfinished);
    // Every core task of the person is walked again (the first one too: the walk is idempotent, and the stubbed store reports "not finished" for all).
    expect((error as CorePersonEraseUnfinished).report).toMatchObject({ tasks: 2, incomplete: 2 });
    expect((error as Error).message).not.toContain(stuck.taskId);
  });

  const ORG = FAKE_COMPANY as OrgId;
  it("the step calls the core's erase last, and not at all when none is given", async () => {
    const order: string[] = [];
    const record = { erase: { person: async () => { order.push("record"); } } };
    const evidence = { person: async () => { order.push("evidence"); } };
    const core = { begin: async () => { order.push("owed"); }, person: async (): Promise<PersonEraseOnCoreReport> => { order.push("core"); return NONE; } };
    await personErasureStep(record, evidence, undefined, core)(ORG, PERSON);
    // The walk is recorded as owed FIRST, before the Team record's erase and Cloud's walk (either may fail or run out the Lambda); it runs last.
    expect(order).toEqual(["owed", "record", "evidence", "core"]);
    order.length = 0;
    await personErasureStep(record, evidence)(ORG, PERSON);
    expect(order).toEqual(["record", "evidence"]);
  });

  it("the step fails when the core's erase fails (the request is repeated), and does not reach the walk when Cloud's evidence erase fails, but the walk is already recorded as owed", async () => {
    const begin = async () => undefined;
    await expect(personErasureStep(undefined, { person: async () => undefined }, undefined, { begin, person: async () => { throw new Error("unfinished"); } })(ORG, PERSON)).rejects.toThrow("unfinished");
    const core = { begin: vi.fn(async () => undefined), person: vi.fn(async () => NONE) };
    await expect(personErasureStep(undefined, { person: async () => { throw new Error("cloud unfinished"); } }, undefined, core)(ORG, PERSON)).rejects.toThrow("cloud unfinished");
    expect(core.begin).toHaveBeenCalledTimes(1);
    expect(core.person).not.toHaveBeenCalled();
  });

  it("a core pending item exists after Cloud's step throws, and the every-minute resume then erases the evidence (nothing depends on the request being repeated)", async () => {
    const { world, registry, ports, seed } = await setup();
    const task = await seed({ person: PERSON, stamp: "core" });
    const step = personErasureStep(undefined, { person: async () => { throw new Error("cloud unfinished"); } }, undefined, corePersonEraseOf(ports));
    await expect(step(ORG, PERSON)).rejects.toThrow("cloud unfinished");
    expect(await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` })).toMatchObject({ companyId: FAKE_COMPANY, developerId: PERSON });
    expect(await leftOf(registry, task)).toBe(2);
    expect(await resumeCoreEvidenceErase(ports, { millis: 10_000 })).toEqual({ pending: 1, finished: 1 });
    expect(await leftOf(registry, task)).toBe(0);
    expect(await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` })).toBeUndefined();
  });

  it("recording the walk as owed never overwrites a saved cursor", async () => {
    const { world, ports } = await setup();
    const key = { pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` };
    await world.store.put({ item: { ...key, entityType: "CORE_EVIDENCE_ERASE_PENDING", companyId: FAKE_COMPANY, developerId: PERSON, cursor: "TASK#2026-11-12T10:00:00.000Z#saved" } });
    await beginCoreEvidenceErase(ports, FAKE_COMPANY, PERSON);
    expect(await world.store.get(key)).toMatchObject({ cursor: "TASK#2026-11-12T10:00:00.000Z#saved" });
    // And on a fresh person it writes one, without a cursor.
    await beginCoreEvidenceErase(ports, FAKE_COMPANY, OTHER_PERSON);
    const fresh = await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${OTHER_PERSON}` });
    expect(fresh).toBeDefined();
    expect(fresh).not.toHaveProperty("cursor");
  });

  it("a store fault in the walk leaves the pending item, is reported as an unfinished erase (not a bare store error), and the resume finishes it once the store answers", async () => {
    const { world, registry, ports, seed } = await setup();
    const task = await seed({ person: PERSON, stamp: "core" });
    const query = vi.spyOn(world.store, "query").mockRejectedValueOnce(new Error("table unavailable private/secret"));
    const error = await corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CorePersonEraseUnfinished);
    expect((error as Error).message).not.toContain("secret");
    query.mockRestore();
    expect(await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` })).toBeDefined();
    expect(await resumeCoreEvidenceErase(ports, { millis: 10_000 })).toEqual({ pending: 1, finished: 1 });
    expect(await leftOf(registry, task)).toBe(0);
  });

  it("the walk itself reports a store fault (it does not throw it): not complete, the pending item stands, nothing of the fault in the report", async () => {
    const { world, ports, seed } = await setup();
    await seed({ person: PERSON, stamp: "core" });
    vi.spyOn(world.store, "getMany").mockRejectedValue(new Error("table unavailable private/secret"));
    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(report).toMatchObject({ complete: false, erased: 0 });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` })).toBeDefined();
  });

  it("any other error from the core's erase (a store that cannot even record it as owed) is reported as an unfinished erase, so the person is told the right thing", async () => {
    const { world, ports } = await setup();
    vi.spyOn(world.store, "put").mockRejectedValue(new Error("no write"));
    await expect(corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON)).rejects.toBeInstanceOf(CorePersonEraseUnfinished);
    await expect(beginCoreEvidenceErase(ports, FAKE_COMPANY, PERSON)).rejects.toThrow();
  });
});

describe("which tasks are the core's", () => {
  it("a record with companyId and no orgId and no stamp is the core's (the net under a start that wrote no stamp); a `cloud` stamp wins over the record's shape", async () => {
    const { registry, ports, seed } = await setup();
    const unstampedCore = await seed({ person: PERSON, stamp: "none", shape: "core" });
    const cloudStampedCoreShaped = await seed({ person: PERSON, stamp: "cloud", shape: "core" });
    const unstampedCloud = await seed({ person: PERSON, stamp: "none", shape: "cloud" });
    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(report).toMatchObject({ tasks: 3, erased: 1, cloudStamped: 2, incomplete: 0, complete: true });
    expect(await leftOf(registry, unstampedCore)).toBe(0);
    expect(await leftOf(registry, cloudStampedCoreShaped)).toBe(2);
    expect(await leftOf(registry, unstampedCloud)).toBe(2);
  });

  it("a core task whose record is missing or expired is counted and logged as counts only, and does not hold the request open", async () => {
    const { registry, ports, logs, seed } = await setup();
    const gone = await seed({ person: PERSON, stamp: "core", noRecord: true });
    const fine = await seed({ person: PERSON, stamp: "core" });
    const report = await corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON);
    expect(report).toMatchObject({ tasks: 2, erased: 1, missingRecord: 1, incomplete: 0, complete: true });
    expect(await leftOf(registry, fine)).toBe(0);
    expect(await leftOf(registry, gone)).toBe(2);
    expect(logs).toEqual([{ component: "broker", event: "core_person_erase.skipped", tasks: 2, missingRecord: 1 }]);
  });
});

/** An object store that is a set of keys, whose every delete takes `cost` ms of a clock the test owns: for many tasks and a small budget. */
function slowObjects(keys: Set<string>, clock: { at: number }, cost: number) {
  const calls = { deletes: 0 };
  const objects: CoreErasePorts["objects"] = {
    async deletePrefix(prefix) { calls.deletes += 1; clock.at += cost; for (const key of [...keys]) if (key.startsWith(prefix)) keys.delete(key); return true; },
  };
  return { objects, calls };
}

describe("a budget, a cursor and the every-minute resume", () => {
  const MANY = 230;
  async function many() {
    const world = createFakeWorld();
    const clock = { at: 1_000_000 };
    const keys = new Set<string>();
    for (let index = 0; index < MANY; index += 1) {
      const task = await seedRecords(world, { person: PERSON, stamp: "core" });
      for (const key of keysOf(task)) keys.add(key);
    }
    const slow = slowObjects(keys, clock, 5);
    const ports: CoreErasePorts = { store: world.store, objects: slow.objects, now: () => clock.at };
    return { world, clock, keys, ports, slow };
  }
  const pendingOf = async (world: FakeWorld) => await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` });

  it("never reports done early, moves forward on each repeat, and ends with the pending item gone", async () => {
    const { world, keys, ports } = await many();
    const queries = vi.spyOn(world.store, "query");
    let runs = 0;
    let last = keys.size;
    for (;;) {
      runs += 1;
      expect(runs).toBeLessThan(40);
      const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 250 });
      // Done exactly when nothing is left: never earlier.
      expect(report.complete).toBe(keys.size === 0);
      if (report.complete) break;
      expect(keys.size).toBeLessThan(last);
      last = keys.size;
      expect((await pendingOf(world))?.cursor).toEqual(expect.stringContaining("TASK#"));
    }
    expect(runs).toBeGreaterThan(3);
    expect(await pendingOf(world)).toBeUndefined();
    // The repeats read from the saved cursor, not from the start of the index.
    expect(queries.mock.calls.some(([request]) => request.sk?.op === "between")).toBe(true);
  });

  it("with no time at all it deletes nothing, saves a pending item, and the person-erase call fails so the request is repeated", async () => {
    const { world, ports, keys, slow } = await many();
    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 0 });
    expect(report).toMatchObject({ erased: 0, complete: false });
    expect(slow.calls.deletes).toBe(0);
    expect(keys.size).toBe(MANY * 2);
    expect(await pendingOf(world)).toMatchObject({ companyId: FAKE_COMPANY, developerId: PERSON });
    await expect(corePersonEraseOf(ports, 0).person(FAKE_COMPANY, PERSON)).rejects.toBeInstanceOf(CorePersonEraseUnfinished);
  });

  it("with no time left it does not read the index at all, even when none of its rows needs a delete (a Cloud person's erase pays nothing past the deadline)", async () => {
    const world = createFakeWorld();
    for (let index = 0; index < 150; index += 1) await seedRecords(world, { person: PERSON, stamp: "cloud" });
    const queries = vi.spyOn(world.store, "query");
    const report = await erasePersonOnCore({ ports: { store: world.store, objects: { deletePrefix: async () => true } }, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 0 });
    expect(report).toMatchObject({ tasks: 0, complete: false });
    expect(queries.mock.calls.filter(([request]) => request.pk === `DEVELOPER#${PERSON}`)).toEqual([]);
  });

  it("a person with only Cloud tasks, over more than one page, is complete after one run, with batched reads and no deletes", async () => {
    const world = createFakeWorld();
    for (let index = 0; index < 150; index += 1) await seedRecords(world, { person: PERSON, stamp: "cloud" });
    const getMany = vi.spyOn(world.store, "getMany");
    const deleted = vi.fn(async () => true);
    const report = await erasePersonOnCore({ ports: { store: world.store, objects: { deletePrefix: deleted } }, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(report).toMatchObject({ tasks: 150, cloudStamped: 150, complete: true });
    expect(deleted).not.toHaveBeenCalled();
    // One batched read per page of stamps (no record read for a Cloud stamp): two pages, two reads, never one per row.
    expect(getMany.mock.calls.map(([keys]) => keys.length)).toEqual([100, 50]);
  });

  it("the every-minute resume finishes what a request left, from the cursor, and clears the pending item", async () => {
    const { world, ports, keys, clock } = await many();
    const first = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 250 });
    expect(first.complete).toBe(false);
    const left = keys.size;
    expect(left).toBeGreaterThan(0);
    // Each every-minute run gives the walk its fixed share; within a few runs it is finished.
    let out = { pending: 0, finished: 0 };
    for (let run = 0; run < 10 && out.finished === 0; run += 1) out = await resumeCoreEvidenceErase(ports, { millis: 60_000 });
    expect(out).toEqual({ pending: 1, finished: 1 });
    expect(keys.size).toBe(0);
    expect(await pendingOf(world)).toBeUndefined();
    expect(clock.at).toBeGreaterThan(1_000_000);
    // Nothing pending: the resume does nothing.
    expect(await resumeCoreEvidenceErase(ports, { millis: 60_000 })).toEqual({ pending: 0, finished: 0 });
  });

  it("a resume with too little time left leaves the item for the next minute", async () => {
    const { world, ports, keys } = await many();
    await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 250 });
    expect(await resumeCoreEvidenceErase(ports, { millis: 100 })).toEqual({ pending: 1, finished: 0 });
    expect(keys.size).toBeGreaterThan(0);
    expect(await pendingOf(world)).toBeDefined();
  });

  it("a task that did not finish keeps the cursor before it: the next run does it again, and the walk is not complete", async () => {
    const { world, ports, keys } = await many();
    const real = ports.objects.deletePrefix.bind(ports.objects);
    let failing = true;
    vi.spyOn(ports.objects, "deletePrefix").mockImplementation(async (prefix) => (failing ? false : real(prefix)));
    const stuck = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 10_000 });
    expect(stuck).toMatchObject({ complete: false, erased: 0 });
    expect(stuck.incomplete).toBeGreaterThan(0);
    expect(keys.size).toBe(MANY * 2);
    failing = false;
    expect((await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 10_000 })).complete).toBe(true);
    expect(keys.size).toBe(0);
    expect(await pendingOf(world)).toBeUndefined();
  });
});

/** `count` core tasks of PERSON in the world's store, their evidence a set of keys, every delete costing `cost` ms of a clock the test owns. */
async function manyTasks(count: number, cost = 5) {
  const world = createFakeWorld();
  const clock = { at: 5_000_000 };
  const keys = new Set<string>();
  const tasks: Seeded[] = [];
  for (let index = 0; index < count; index += 1) {
    const task = await seedRecords(world, { person: PERSON, stamp: "core" });
    tasks.push(task);
    for (const key of keysOf(task)) keys.add(key);
  }
  const calls = { deletes: 0 };
  const failing = new Set<string>();
  const objects: CoreErasePorts["objects"] = {
    async deletePrefix(prefix) {
      calls.deletes += 1;
      clock.at += cost;
      if ([...failing].some((taskId) => prefix.includes(taskId))) return false;
      for (const key of [...keys]) if (key.startsWith(prefix)) keys.delete(key);
      return true;
    },
  };
  const ports: CoreErasePorts = { store: world.store, objects, now: () => clock.at };
  return { world, clock, keys, tasks, calls, failing, ports };
}
const leftKeys = (keys: Set<string>, task: Seeded): number => keysOf(task).filter((key) => keys.has(key)).length;

describe("the Lambda's remaining time, the deadline inside a batch and a task that never finishes", () => {
  it("a person's erase spends at most the request's remaining time minus the margin, when that is less than its own budget", async () => {
    const { clock, ports, calls, keys } = await manyTasks(60, 50);
    const started = clock.at;
    // 5 s left in the request, a 3 s margin: 2 s for the walk (its own budget is 4 s).
    noteRequestEnd(5_000, () => clock.at);
    try {
      await expect(corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON)).rejects.toBeInstanceOf(CorePersonEraseUnfinished);
    } finally { noteRequestEnd(undefined); }
    // Deletes of one batch start together (10 tasks, 2 prefixes, 50 ms each), so the walk stops within one batch of its 2 s: far short of its own 4 s.
    expect(clock.at - started).toBeLessThanOrEqual(2_000 + 10 * 2 * 50);
    expect(calls.deletes).toBeGreaterThan(0);
    expect(keys.size).toBeGreaterThan(0);
  });

  it("with less than the margin left it does not start deleting at all, but the walk is already owed (pending) and the request fails so it is repeated", async () => {
    const { world, clock, ports, calls, keys } = await manyTasks(20);
    noteRequestEnd(CORE_ERASE_MARGIN_MS - 1, () => clock.at);
    try {
      await expect(corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON)).rejects.toBeInstanceOf(CorePersonEraseUnfinished);
    } finally { noteRequestEnd(undefined); }
    expect(calls.deletes).toBe(0);
    expect(keys.size).toBe(40);
    expect(await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` })).toBeDefined();
  });

  it("with plenty of time left its own budget applies", async () => {
    const { clock, ports, keys } = await manyTasks(60);
    noteRequestEnd(25_000, () => clock.at);
    try { await corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON); } finally { noteRequestEnd(undefined); }
    expect(keys.size).toBe(0);
  });

  it("checks the deadline inside a batch: tasks of the batch that have not started (or are between their two prefixes) do not start after it", async () => {
    // 10 tasks in one batch; each delete takes 20 ms of the shared clock and the budget is 30 ms: the first prefixes of the batch all start together (clock 0), then the clock stands past the budget.
    const { ports, calls, keys } = await manyTasks(10, 20);
    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 30 });
    // Not every prefix of the batch was started (20 would be all), nothing is reported erased, and running out of time is not a failure.
    expect(calls.deletes).toBeLessThan(20);
    expect(report).toMatchObject({ erased: 0, incomplete: 0, complete: false });
    expect(keys.size).toBeGreaterThan(0);
  });

  it("keeps erasing the later tasks past a task that does not finish, moves the cursor past it and keeps it to be tried again, and the walk is not complete", async () => {
    const { world, ports, keys, tasks, failing } = await manyTasks(25, 1);
    failing.add(tasks[3]!.taskId);
    const first = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 60_000 });
    expect(first).toMatchObject({ erased: 24, incomplete: 1, complete: false });
    expect(leftKeys(keys, tasks[3]!)).toBe(2);
    for (const task of tasks.filter((_, index) => index !== 3)) expect(leftKeys(keys, task)).toBe(0);
    // The cursor went to the end of the index; the failing task is kept apart, by its index row, to be tried again.
    const pending = await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` });
    expect(pending?.cursor as string).toContain(`#${tasks[24]!.taskId}`);
    expect(pending).toMatchObject({ scanned: true, retry: [expect.stringContaining(`#${tasks[3]!.taskId}`)] });
    // The failure goes away: the next run finishes, and the pending item goes.
    failing.clear();
    expect(await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 60_000 })).toMatchObject({ incomplete: 0, complete: true });
    expect(keys.size).toBe(0);
    expect(await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` })).toBeUndefined();
  });

  it("running out of time keeps the cursor at the end of the last batch that finished (a failure in it is kept to be tried again)", async () => {
    const { world, ports, keys, tasks, failing } = await manyTasks(25, 1);
    failing.add(tasks[3]!.taskId);
    // One batch of ten tasks takes about 20 ms of the clock (two prefixes, ten at once); 15 ms stops the walk inside the first batch.
    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 15 });
    expect(report.complete).toBe(false);
    const pending = await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` });
    // The cursor is past the failing task and before the first task the deadline came first for: every task up to it (but the failing one) is erased, the next one is not.
    const at = tasks.findIndex((task) => (pending?.cursor as string).endsWith(`#${task.taskId}`));
    expect(at).toBeGreaterThan(3);
    expect(at).toBeLessThan(9);
    for (const task of tasks.slice(0, at + 1)) expect(leftKeys(keys, task)).toBe(task === tasks[3] ? 2 : 0);
    expect(leftKeys(keys, tasks[at + 1]!)).toBeGreaterThan(0);
    expect(pending?.retry).toEqual([expect.stringContaining(`#${tasks[3]!.taskId}`)]);
    expect(pending?.scanned).toBeUndefined();
  });

  it("the resumed query is bounded on both sides: after the cursor and inside the TASK# range", async () => {
    const { world, ports } = await manyTasks(25, 1);
    await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 15 });
    const cursor = (await world.store.get({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${PERSON}` }))?.cursor as string;
    const query = vi.spyOn(world.store, "query");
    await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 60_000 });
    expect(query.mock.calls[0]![0].sk).toEqual({ op: "between", low: `${cursor}\u0000`, high: "TASK#\uffff" });
  });
});

/** The real vendored adapters (DynamoDB store, S3 object storage) over the vendored fakes of the two clients. */
async function realWorld() {
  const table = new FakeDynamoDb({ tableName: "State" });
  const s3 = new FakeS3({ bucket: "artifact-bucket" });
  const store = createDynamoStoreFromSettings({ tableName: "State" }, table);
  const world = createFakeWorld();
  const logs: Array<Record<string, unknown>> = [];
  const send = (command: unknown) => s3.send(command);
  const ports = coreErasePortsOf({ dynamo: table, tableName: "State", s3: { send }, bucket: "artifact-bucket", log: (entry) => logs.push(entry) });
  const put = async (task: Seeded) => { for (const key of keysOf(task)) await s3.send(new PutObjectCommand({ Bucket: "artifact-bucket", Key: key, Body: new TextEncoder().encode("{}") })); };
  const seed = async (input: SeedInput) => { const task = await seedRecords(world, input, store); await put(task); return task; };
  return { table, s3, store, ports, logs, seed, send, left: (task: Seeded) => keysOf(task).filter((key) => s3.objects.has(key)).length };
}

describe("over the real DynamoDB and S3 adapters", () => {
  it("erases a core task's evidence in the artifact bucket at the exact keys (no key prefix), reading the State table, and keeps the rest", async () => {
    const { s3, ports, seed, left } = await realWorld();
    const mine = await seed({ person: PERSON, stamp: "core" });
    const cloud = await seed({ person: PERSON, stamp: "none" });
    const theirs = await seed({ person: OTHER_PERSON, stamp: "core" });
    expect(await corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON)).toMatchObject({ erased: 1, cloudStamped: 1, complete: true });
    expect([left(mine), left(cloud), left(theirs)]).toEqual([0, 2, 2]);
    // Every call went to the artifact bucket, and every key asked for starts at `private/` (the layout Cloud writes): nothing was prefixed.
    const prefixes = s3.calls.flatMap((call) => (typeof call.input.Prefix === "string" ? [call.input.Prefix] : []));
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) expect(prefix.startsWith("private/")).toBe(true);
    expect(new Set(s3.calls.map((call) => call.input.Bucket))).toEqual(new Set(["artifact-bucket"]));
  });

  it("a batch delete that reports errors is a failure (counted incomplete), not a round to repeat", async () => {
    const { table, s3, send, seed, left, logs } = await realWorld();
    const task = await seed({ person: PERSON, stamp: "core" });
    const failing = coreErasePortsOf({ dynamo: table, tableName: "State", bucket: "artifact-bucket", log: (entry) => logs.push(entry),
      s3: { async send(command: unknown) { const answer = await send(command); return command instanceof DeleteObjectsCommand ? { ...(answer as object), Errors: [{ Key: "x", Code: "AccessDenied" }] } : answer; } } });
    const before = s3.calls.length;
    const report = await erasePersonOnCore({ ports: failing, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 10_000 });
    expect(report).toMatchObject({ erased: 0, incomplete: 1, complete: false });
    // It stopped at the first answer with errors: one list and one delete per prefix, not a hundred rounds.
    expect(s3.calls.length - before).toBeLessThanOrEqual(6);
    expect(JSON.stringify(report)).not.toContain("AccessDenied");
    // The objects the fake deleted before the error was reported are gone, the task is still not reported done, and a clean run finishes it.
    expect(left(task)).toBeLessThanOrEqual(2);
    expect((await erasePersonOnCore({ ports: coreErasePortsOf({ dynamo: table, tableName: "State", s3: { send }, bucket: "artifact-bucket" }), companyId: FAKE_COMPANY, developerId: PERSON })).complete).toBe(true);
  });

  it("an item the store cannot read is logged without the person or the task", async () => {
    const { table, ports, logs, seed } = await realWorld();
    await seed({ person: PERSON, stamp: "core" });
    // A set attribute cannot be represented by the port (decision 60): the store leaves the item out and tells `onUnreadable`.
    await table.send(new PutItemCommand({ TableName: "State", Item: { pk: { S: `DEVELOPER#${PERSON}` }, sk: { S: `TASK#2026-11-12T11:00:00.000Z#${randomUUID()}` }, tags: { SS: ["a"] } } }));
    await corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON);
    const unreadable = logs.filter((entry) => entry.event === "core_person_erase.unreadable_item");
    expect(unreadable).toEqual([{ component: "broker", event: "core_person_erase.unreadable_item" }]);
    expect(JSON.stringify(logs)).not.toContain(PERSON);
  });

  it("a core task whose record the store cannot read is incomplete (evidence may be left), not a missing record; a missing one is still counted apart", async () => {
    const { table, ports, seed } = await realWorld();
    const unreadable = await seed({ person: PERSON, stamp: "core", noRecord: true });
    // The record exists but holds a set, which the port cannot represent: the store leaves it out and reports it.
    await table.send(new PutItemCommand({ TableName: "State", Item: { pk: { S: `DEVTASK#${unreadable.taskId}` }, sk: { S: "META" }, tags: { SS: ["a"] } } }));
    const gone = await seed({ person: PERSON, stamp: "core", noRecord: true });
    expect(gone.taskId).not.toBe(unreadable.taskId);
    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(report).toMatchObject({ incomplete: 1, missingRecord: 1, complete: false });
    await expect(corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON)).rejects.toBeInstanceOf(CorePersonEraseUnfinished);
  });

  /** Cloud's walk speaks lib-dynamodb commands; this answers the few it sends from the same store the core's walk reads. */
  function documentClientOver(store: DocumentStore) {
    return { async send(command: unknown): Promise<unknown> {
      if (command instanceof GetCommand) return { Item: await store.get(command.input.Key as { pk: string; sk: string }) };
      if (command instanceof PutCommand) { await store.put({ item: command.input.Item as { pk: string; sk: string } }); return {}; }
      if (command instanceof DeleteCommand) { await store.delete({ key: command.input.Key as { pk: string; sk: string } }); return {}; }
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues as Record<string, string>;
        const start = (command.input.ExclusiveStartKey as { c?: string } | undefined)?.c;
        if (typeof values[":prefix"] !== "string") return { Items: [] };
        const page = await store.query({ pk: values[":pk"]!, sk: { op: "beginsWith", prefix: values[":prefix"] }, ...(command.input.Limit === undefined ? {} : { limit: command.input.Limit }), ...(start === undefined ? {} : { cursor: start }) });
        return { Items: page.items, ...(page.cursor === undefined ? {} : { LastEvaluatedKey: { c: page.cursor } }) };
      }
      throw new Error("unexpected command");
    } };
  }

  it("Cloud and core tasks of one person, through the person-erasure step with both real walks: each walk erases its own, nothing else", async () => {
    const { store, ports, seed, left, send } = await realWorld();
    // Cloud's walk starts only for an org that kept evidence.
    await store.put({ item: { pk: `EVIDENCE_STORED#${FAKE_COMPANY}`, sk: "META", entityType: "EVIDENCE_STORED", orgId: FAKE_COMPANY } });
    const cloudTask = await seed({ person: PERSON, stamp: "none", shape: "cloud" });
    const coreTask = await seed({ person: PERSON, stamp: "core" });
    const coreUnstamped = await seed({ person: PERSON, stamp: "none", shape: "core" });
    const theirs = await seed({ person: OTHER_PERSON, stamp: "core" });
    const theirsCloud = await seed({ person: OTHER_PERSON, stamp: "none", shape: "cloud" });
    const cloudWalk = createEvidenceErase({ s3: { send } as never, artifactBucketName: "artifact-bucket", documentClient: documentClientOver(store), tableName: "State" });
    await personErasureStep(undefined, cloudWalk, undefined, corePersonEraseOf(ports))(FAKE_COMPANY, PERSON);
    expect([left(cloudTask), left(coreTask), left(coreUnstamped)]).toEqual([0, 0, 0]);
    expect([left(theirs), left(theirsCloud)]).toEqual([2, 2]);
  });
});

describe("the broker's wiring of the ports", () => {
  it("sends the vendored store's plain commands through the broker's own document client, which leaves them unmarshalled (no second client is made)", async () => {
    const seen: Array<{ target: string | undefined; body: string }> = [];
    const requestHandler = {
      async handle(request: { headers: Record<string, string>; body?: unknown }) {
        seen.push({ target: request.headers["x-amz-target"], body: String(request.body) });
        const answer = JSON.stringify({ Item: { pk: { S: "pk-1" }, sk: { S: "sk-1" }, kept: { S: "yes" } } });
        return { response: { statusCode: 200, headers: { "content-type": "application/x-amz-json-1.0" }, body: Readable.from([Buffer.from(answer)]) } };
      },
      updateHttpClientConfig() { /* none */ },
      httpHandlerConfigs() { return {}; },
    };
    const credentials = { accessKeyId: ["fake", "access"].join("-"), secretAccessKey: ["fake", "secret"].join("-") };
    const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-west-2", credentials, requestHandler: requestHandler as never }));
    const ports = coreEvidencePorts({ documentClient, tableName: "State", artifactBucketName: "artifact-bucket", s3: { send: async () => ({}) } as never });
    expect(await ports.store.get({ pk: "pk-1", sk: "sk-1" })).toMatchObject({ pk: "pk-1", sk: "sk-1", kept: "yes" });
    expect(seen.map((call) => call.target)).toEqual(["DynamoDB_20120810.GetItem"]);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ TableName: "State", Key: { pk: { S: "pk-1" }, sk: { S: "sk-1" } } });
  });
});

// Fifth round (M-A, M-B, L2): a task that fails for good must not keep the person's later evidence, a stuck walk must not starve another person's, and one prefix's delete must
// stop at the deadline between its rounds.
describe("a task that fails for good, stuck walks in the every-minute run, and a prefix with many rounds", () => {
  const pendingKeyOf = (person: string) => ({ pk: CORE_ERASE_PENDING_PK, sk: `${FAKE_COMPANY}|${person}` });

  it("M-A: 300 core tasks, task 0 always fails, 1 s per run and 5 ms per delete: the other 299 are erased within a bounded number of runs, task 0 stays owed and is retried", async () => {
    const { world, ports, keys, tasks, failing, calls } = await manyTasks(300, 5);
    failing.add(tasks[0]!.taskId);
    let runs = 0;
    while (tasks.slice(1).some((task) => leftKeys(keys, task) > 0)) {
      runs += 1;
      expect(runs).toBeLessThanOrEqual(8);
      const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 1_000 });
      expect(report.complete).toBe(false);
    }
    expect(leftKeys(keys, tasks[0]!)).toBe(2);
    // The main cursor went past the failing task: it is kept apart, by its index row, to be tried again (and nothing else is).
    const pending = await world.store.get(pendingKeyOf(PERSON));
    expect(pending?.retry).toEqual([expect.stringContaining(`#${tasks[0]!.taskId}`)]);
    // Later runs retry it (and only it, cheaply), are never complete while it fails, and finish once it erases.
    const before = calls.deletes;
    const again = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 1_000 });
    expect(again).toMatchObject({ incomplete: 1, complete: false });
    expect(calls.deletes - before).toBeLessThanOrEqual(2);
    failing.clear();
    expect(await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 1_000 })).toMatchObject({ incomplete: 0, complete: true });
    expect(keys.size).toBe(0);
    expect(await world.store.get(pendingKeyOf(PERSON))).toBeUndefined();
  });

  /** Several people of one company with core tasks in one store, every delete costing `cost` ms of a clock the test owns; a task id in `failing` never erases. */
  async function crowd(counts: Record<string, number>, cost = 5) {
    const world = createFakeWorld();
    const clock = { at: 9_000_000 };
    const keys = new Set<string>();
    const tasks: Record<string, Seeded[]> = {};
    for (const [person, count] of Object.entries(counts)) {
      tasks[person] = [];
      for (let index = 0; index < count; index += 1) {
        const task = await seedRecords(world, { person, stamp: "core" });
        tasks[person].push(task);
        for (const key of keysOf(task)) keys.add(key);
      }
      await beginCoreEvidenceErase({ store: world.store }, FAKE_COMPANY, person);
    }
    const failing = new Set<string>();
    const objects: CoreErasePorts["objects"] = {
      async deletePrefix(prefix) {
        clock.at += cost;
        if ([...failing].some((taskId) => prefix.includes(taskId))) return false;
        for (const key of [...keys]) if (key.startsWith(prefix)) keys.delete(key);
        return true;
      },
    };
    const ports: CoreErasePorts = { store: world.store, objects, now: () => clock.at };
    return { world, clock, keys, tasks, failing, ports };
  }

  it("M-B: three stuck people ahead of a fourth with one task: the fourth is erased within a few every-minute runs", async () => {
    const [p1, p2, p3, p4] = ["1", "2", "3", "4"].map((digit) => digit.repeat(64)) as [string, string, string, string];
    const { world, clock, keys, tasks, failing, ports } = await crowd({ [p1]: 300, [p2]: 300, [p3]: 300, [p4]: 1 });
    for (const person of [p1, p2, p3]) failing.add(tasks[person]![0]!.taskId);
    let runs = 0;
    while (leftKeys(keys, tasks[p4]![0]!) > 0) {
      runs += 1;
      expect(runs).toBeLessThanOrEqual(3);
      await resumeCoreEvidenceErase(ports, { millis: 2_000 });
      clock.at += 60_000;
    }
    expect(await world.store.get(pendingKeyOf(p4))).toBeUndefined();
  });

  it("M-B: the start point moves on: with more stuck people ahead than one run has shares for, the person behind them is still reached within a few runs", async () => {
    const people = ["a1", "a2", "a3", "a4", "a5", "a6"].map((name) => name.repeat(32));
    const last = people.at(-1)!;
    const { keys, tasks, failing, clock, ports } = await crowd(Object.fromEntries(people.map((person) => [person, person === last ? 1 : 300])));
    for (const person of people.slice(0, -1)) failing.add(tasks[person]![0]!.taskId);
    let runs = 0;
    while (leftKeys(keys, tasks[last]![0]!) > 0) {
      runs += 1;
      expect(runs).toBeLessThanOrEqual(3);
      await resumeCoreEvidenceErase(ports, { millis: 2_000 });
      clock.at += 60_000;
    }
  });

  it("M-B: a walk gets at most its fixed share of the every-minute run, however much time the run has", async () => {
    const big = "7".repeat(64);
    const { clock, ports } = await crowd({ [big]: 300 });
    const started = clock.at;
    await resumeCoreEvidenceErase(ports, { millis: 60_000 });
    // Ten tasks of two prefixes start together, 5 ms each: the walk stops within one batch (100 ms) of its share.
    expect(clock.at - started).toBeLessThanOrEqual(CORE_ERASE_RESUME_SHARE_MS + 100);
  });

  it("M-B: the run starts with whoever was tried longest ago, and skips a walk that has only failing tasks left and was tried in the last few minutes", async () => {
    const [p1, p2] = ["5", "6"].map((digit) => digit.repeat(64)) as [string, string];
    const { world, clock, keys, tasks, failing, ports } = await crowd({ [p1]: 3, [p2]: 3 });
    failing.add(tasks[p1]![1]!.taskId);
    // p1's walk is done but for its failing task; p2 has not been tried.
    await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: p1, budgetMs: 1_000 });
    expect((await world.store.get(pendingKeyOf(p1)))?.retry).toHaveLength(1);
    const tried: string[] = [];
    const get = world.store.get.bind(world.store);
    vi.spyOn(world.store, "get").mockImplementation(async (key) => { if (key.pk === CORE_ERASE_PENDING_PK) tried.push(key.sk); return get(key); });
    clock.at += 1_000;
    await resumeCoreEvidenceErase(ports, { millis: 2_000 });
    // p1 was tried a second ago with only its failing task left: skipped. p2 is erased.
    expect(tried).toEqual([`${FAKE_COMPANY}|${p2}`]);
    for (const task of tasks[p2]!) expect(leftKeys(keys, task)).toBe(0);
    // Some minutes later p1 is tried again.
    clock.at += 10 * 60_000;
    tried.length = 0;
    await resumeCoreEvidenceErase(ports, { millis: 2_000 });
    expect(tried).toEqual([`${FAKE_COMPANY}|${p1}`]);
  });

  it("keeps at most CORE_ERASE_RETRY_MAX failing tasks: the main walk stops before the next failure (the item stays small) and is never complete", async () => {
    const { world, ports, keys, tasks, failing } = await manyTasks(CORE_ERASE_RETRY_MAX + 5, 0);
    for (const task of tasks.slice(0, CORE_ERASE_RETRY_MAX + 1)) failing.add(task.taskId);
    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 60_000 });
    expect(report.complete).toBe(false);
    const pending = await world.store.get(pendingKeyOf(PERSON));
    expect(pending?.retry).toHaveLength(CORE_ERASE_RETRY_MAX);
    // The cursor stays before the first failure that did not fit, so that task is still owed by the main walk.
    expect(pending?.cursor as string).toContain(`#${tasks[CORE_ERASE_RETRY_MAX - 1]!.taskId}`);
    expect(pending?.scanned).toBeUndefined();
    // Once the failures clear, the next runs finish everything.
    failing.clear();
    for (let run = 0; run < 3 && keys.size > 0; run += 1) await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 60_000 });
    expect(keys.size).toBe(0);
  });

  it("L2: one prefix with many rounds of objects stops at the deadline between rounds (out of time, not a failure)", async () => {
    const world = createFakeWorld();
    const clock = { at: 7_000_000 };
    await seedRecords(world, { person: PERSON, stamp: "core" });
    let sends = 0;
    // A prefix that always lists a full page of objects: the vendored delete would go round a hundred times.
    const s3 = { async send(command: unknown): Promise<unknown> {
      sends += 1;
      clock.at += 50;
      if (command instanceof ListObjectsV2Command) return { Contents: Array.from({ length: 1_000 }, (_, index) => ({ Key: `${String(command.input.Prefix)}${String(index)}` })) };
      return {};
    } };
    const real = coreErasePortsOf({ dynamo: new FakeDynamoDb({ tableName: "State" }), tableName: "State", s3, bucket: "artifact-bucket", now: () => clock.at });
    const ports: CoreErasePorts = { ...real, store: world.store, now: () => clock.at };
    const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON, budgetMs: 500 });
    expect(report).toMatchObject({ erased: 0, incomplete: 0, complete: false });
    // At most the rounds that fit in the budget, plus the one round each started prefix always gets.
    expect(sends).toBeLessThanOrEqual(2 * (500 / 100 + 1) + 2);
  });
});
