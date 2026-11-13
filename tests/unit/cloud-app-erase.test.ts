// Convergence S0 follow-up: a removed person's evidence for core-stamped tasks (packages/broker/src/cloud/app/erase.ts), over the parity fakes.
// The walk reads the person's task index, erases each core-stamped task's evidence, keeps everything else, writes nothing, and reports counts only. It runs from two ports
// (the store and the object storage), never the registry or a switch: a task keeps its engine after the switch is turned off. Core task records carry `companyId` only
// (vendor core task-flow/start.ts), so they are seeded that way; Cloud's own walk (`orgId` only) is shown to skip them.
import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createOwnerTaskAccess } from "@rovara-code/broker/core/task-flow";
import type { AdapterRegistry, ObjectStorage, OrgId } from "@rovara-code/contracts";
import { evidencePrefixesOf as codePrefixesOf, eraseTaskEvidence } from "../../vendor/rovara-code/packages/broker/src/core/proof/evidence-erase.js";
import { createEvidenceErase, evidencePrefixesOf as cloudPrefixesOf } from "../../packages/broker/src/rovara-code/evidence-erase.js";
import { personErasureStep } from "../../packages/broker/src/aws/broker/evidence-wiring.js";
import {
  CorePersonEraseUnfinished, corePersonEraseOf, createCloudApp, erasePersonOnCore, readCoreEngineFlags, stampForNewTask, stampItem, type CloudApp, type CoreErasePorts, type PersonEraseOnCoreReport,
} from "../../packages/broker/src/cloud/app/index.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";

const OTHER_COMPANY = "org_s0parity00000000000b";
const PERSON = "a".repeat(64);
const OTHER_PERSON = "b".repeat(64);
const PACK_NAME = `${"c".repeat(64)}.json`;
const TAIL_NAME = "d".repeat(64);
const NONE: PersonEraseOnCoreReport = { tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, refused: 0, incomplete: 0 };

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
}

/**
 * A task of a person: the index row, the task record, optionally an engine stamp, and the two evidence objects (a pack and an output tail). A core-stamped record is shaped
 * as the core's start writes it (`companyId` only, no `orgId`); Cloud's own record names its company as `orgId`.
 */
async function seedTask(world: FakeWorld, objects: ObjectStorage, input: SeedInput): Promise<Seeded> {
  const company = input.company ?? FAKE_COMPANY;
  const seeded = { taskId: randomUUID(), ownerKey: input.ownerKey ?? randomUUID().replaceAll("-", "").repeat(2), workspaceId: randomUUID() };
  const owner = input.stamp === "core" ? { companyId: company } : { orgId: company };
  await world.store.put({ item: { pk: `DEVELOPER#${input.person}`, sk: `TASK#2026-11-12T10:00:00.000Z#${seeded.taskId}`, entityType: "DEVELOPER_TASK_INDEX", taskId: seeded.taskId, orgId: input.indexCompany ?? company } });
  await world.store.put({ item: { pk: `DEVTASK#${seeded.taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: seeded.taskId, developerId: input.creator ?? input.person, ...owner, ownerKey: seeded.ownerKey, workspaceId: seeded.workspaceId } });
  if (input.stamp !== "none") {
    const flags = readCoreEngineFlags(input.stamp === "core" ? { CLOUD_CORE_ENGINE: "on" } : {});
    await world.store.put({ item: stampItem(company, seeded.taskId, stampForNewTask(flags, company, new Date(world.clock.now))).item });
  }
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

    expect(report).toEqual({ tasks: 5, erased: 2, cloudStamped: 2, skipped: 1, refused: 0, incomplete: 0 });
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
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
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
    for (const value of ["unfinished", "throws"] as const) {
      mode.value = value;
      const report = await erasePersonOnCore({ ports, companyId: FAKE_COMPANY, developerId: PERSON });
      expect(report).toMatchObject({ erased: 1, incomplete: 1, refused: 0 });
      expect(JSON.stringify(report)).not.toContain("secret");
    }
    expect(await leftOf(registry, fine)).toBe(0);
  });

  it("counts a task with a malformed id apart (refused), logs counts only, and does not hold the request open", async () => {
    const { registry, ports, logs, seed } = await setup();
    const bad = await seed({ person: PERSON, stamp: "core", ownerKey: "owner.not-a-plain-id" });
    const fine = await seed({ person: PERSON, stamp: "core" });
    const report = await corePersonEraseOf(ports).person(FAKE_COMPANY, PERSON);
    expect(report).toEqual({ tasks: 2, erased: 1, cloudStamped: 0, skipped: 0, refused: 1, incomplete: 0 });
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
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
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
    const core = { person: async (): Promise<PersonEraseOnCoreReport> => { order.push("core"); return NONE; } };
    await personErasureStep(record, evidence, undefined, core)(ORG, PERSON);
    expect(order).toEqual(["record", "evidence", "core"]);
    order.length = 0;
    await personErasureStep(record, evidence)(ORG, PERSON);
    expect(order).toEqual(["record", "evidence"]);
  });

  it("the step fails when the core's erase fails (the request is repeated), and does not reach it when Cloud's evidence erase fails", async () => {
    await expect(personErasureStep(undefined, { person: async () => undefined }, undefined, { person: async () => { throw new Error("unfinished"); } })(ORG, PERSON)).rejects.toThrow("unfinished");
    const core = { person: vi.fn(async () => NONE) };
    await expect(personErasureStep(undefined, { person: async () => { throw new Error("cloud unfinished"); } }, undefined, core)(ORG, PERSON)).rejects.toThrow("cloud unfinished");
    expect(core.person).not.toHaveBeenCalled();
  });
});
