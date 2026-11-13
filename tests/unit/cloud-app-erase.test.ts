// Convergence S0 follow-up: a removed person's evidence for core-stamped tasks (packages/broker/src/cloud/app/erase.ts), over the parity fakes.
// The walk reads the person's task index, erases each core-stamped task's evidence, keeps everything else, writes nothing, and reports counts only.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOwnerTaskAccess } from "@rovara-code/broker/core/task-flow";
import type { AdapterRegistry, OrgId } from "@rovara-code/contracts";
import { evidencePrefixesOf as codePrefixesOf, eraseTaskEvidence } from "../../vendor/rovara-code/packages/broker/src/core/proof/evidence-erase.js";
import { evidencePrefixesOf as cloudPrefixesOf } from "../../packages/broker/src/rovara-code/evidence-erase.js";
import { personErasureStep } from "../../packages/broker/src/aws/broker/evidence-wiring.js";
import {
  CorePersonEraseUnfinished, corePersonEraseOf, createCloudApp, erasePersonOnCore, readCoreEngineFlags, stampForNewTask, stampItem, type CloudApp, type PersonEraseOnCoreReport,
} from "../../packages/broker/src/cloud/app/index.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";

const OTHER_COMPANY = "org_s0parity00000000000b";
const PERSON = "a".repeat(64);
const OTHER_PERSON = "b".repeat(64);
const PACK_NAME = `${"c".repeat(64)}.json`;
const TAIL_NAME = "d".repeat(64);

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

/** A task of a person: the index row, the task record, optionally an engine stamp, and the two evidence objects (a pack and an output tail). */
async function seedTask(world: FakeWorld, registry: Pick<AdapterRegistry, "require">, input: { person: string; company?: string; stamp: "core" | "cloud" | "none"; indexCompany?: string }): Promise<Seeded> {
  const company = input.company ?? FAKE_COMPANY;
  const seeded = { taskId: randomUUID(), ownerKey: randomUUID().replaceAll("-", "").repeat(2), workspaceId: randomUUID() };
  await world.store.put({ item: { pk: `DEVELOPER#${input.person}`, sk: `TASK#2026-11-12T10:00:00.000Z#${seeded.taskId}`, entityType: "DEVELOPER_TASK", taskId: seeded.taskId, orgId: input.indexCompany ?? company } });
  await world.store.put({ item: { pk: `DEVTASK#${seeded.taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: seeded.taskId, companyId: company, orgId: company, ownerKey: seeded.ownerKey, workspaceId: seeded.workspaceId } });
  if (input.stamp !== "none") {
    const flags = readCoreEngineFlags(input.stamp === "core" ? { CLOUD_CORE_ENGINE: "on" } : {});
    await world.store.put({ item: stampItem(company, seeded.taskId, stampForNewTask(flags, company, new Date(world.clock.now))).item });
  }
  const objects = registry.require("object-storage");
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

async function setup() {
  const world = createFakeWorld();
  const app = appOver(world, { CLOUD_CORE_ENGINE: "on" });
  const registry = await app.registry();
  return { world, app, registry };
}

describe("erasePersonOnCore", () => {
  it("erases a core task's evidence, keeps another person's task, another company's task and a Cloud-stamped task, and reports counts", async () => {
    const { world, registry } = await setup();
    const mine = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    const second = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    const theirs = await seedTask(world, registry, { person: OTHER_PERSON, stamp: "core" });
    const cloud = await seedTask(world, registry, { person: PERSON, stamp: "cloud" });
    const unstamped = await seedTask(world, registry, { person: PERSON, stamp: "none" });
    const elsewhere = await seedTask(world, registry, { person: PERSON, company: OTHER_COMPANY, stamp: "core" });
    // Positive control: everything is there before the walk.
    for (const task of [mine, second, theirs, cloud, unstamped, elsewhere]) expect(await leftOf(registry, task)).toBe(2);

    const report = await erasePersonOnCore({ registry, companyId: FAKE_COMPANY, developerId: PERSON });

    expect(report).toEqual({ tasks: 5, erased: 2, cloudStamped: 2, skipped: 1, incomplete: 0 });
    expect(await leftOf(registry, mine)).toBe(0);
    expect(await leftOf(registry, second)).toBe(0);
    expect(await leftOf(registry, theirs)).toBe(2);
    expect(await leftOf(registry, cloud)).toBe(2);
    expect(await leftOf(registry, unstamped)).toBe(2);
    expect(await leftOf(registry, elsewhere)).toBe(2);
    // Counts only: nothing in the report names a person, a task or a key.
    expect(JSON.stringify(report)).not.toMatch(/[a-f0-9]{16}/u);
  });

  it("leaves a task alone whose index row names another company, even if its record names this one", async () => {
    const { world, registry } = await setup();
    const task = await seedTask(world, registry, { person: PERSON, stamp: "core", indexCompany: OTHER_COMPANY });
    expect(await erasePersonOnCore({ registry, companyId: FAKE_COMPANY, developerId: PERSON })).toMatchObject({ erased: 0, skipped: 1 });
    expect(await leftOf(registry, task)).toBe(2);
  });

  it("is idempotent: a second run erases nothing new, writes nothing and keeps what was kept", async () => {
    const { world, registry } = await setup();
    const mine = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    const theirs = await seedTask(world, registry, { person: OTHER_PERSON, stamp: "core" });
    const first = await erasePersonOnCore({ registry, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(first.erased).toBe(1);
    const writes = [vi.spyOn(world.store, "put"), vi.spyOn(world.store, "transact"), vi.spyOn(world.store, "update"), vi.spyOn(world.store, "delete")];
    const again = await erasePersonOnCore({ registry, companyId: FAKE_COMPANY, developerId: PERSON });
    expect(again).toEqual(first);
    for (const spy of writes) expect(spy).not.toHaveBeenCalled();
    expect(await leftOf(registry, mine)).toBe(0);
    expect(await leftOf(registry, theirs)).toBe(2);
  });

  it("counts a task whose erase did not finish or threw, goes on to the next, and keeps the fault's text out of the report", async () => {
    const { world, registry } = await setup();
    const stuck = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    const fine = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    const objects = registry.require("object-storage");
    const real = objects.deletePrefix.bind(objects);
    const mode = { value: "unfinished" as "unfinished" | "throws" };
    vi.spyOn(objects, "deletePrefix").mockImplementation(async (prefix) => {
      if (prefix.includes(stuck.taskId)) { if (mode.value === "throws") throw new Error(`secret ${prefix}`); await real(prefix); return false; }
      return real(prefix);
    });
    for (const value of ["unfinished", "throws"] as const) {
      mode.value = value;
      const report = await erasePersonOnCore({ registry, companyId: FAKE_COMPANY, developerId: PERSON });
      expect(report).toMatchObject({ erased: 1, incomplete: 1 });
      expect(JSON.stringify(report)).not.toContain("secret");
    }
    expect(await leftOf(registry, fine)).toBe(0);
  });

  it("refuses an empty company or person (nothing is walked)", async () => {
    const { registry } = await setup();
    await expect(erasePersonOnCore({ registry, companyId: "", developerId: PERSON })).rejects.toThrow();
    await expect(erasePersonOnCore({ registry, companyId: FAKE_COMPANY, developerId: "" })).rejects.toThrow();
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
    const { world, registry } = await setup();
    const a = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    const b = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    await eraseTaskEvidence(registry.require("object-storage"), a);
    await erasePersonOnCore({ registry, companyId: FAKE_COMPANY, developerId: PERSON });
    expect([await leftOf(registry, a), await leftOf(registry, b)]).toEqual([0, 0]);
  });
});

describe("corePersonEraseOf and the person-erasure step", () => {
  it("with every switch off it does nothing: no registry is built, no object is touched", async () => {
    const world = createFakeWorld();
    const on = appOver(world, { CLOUD_CORE_ENGINE: "on" });
    const task = await seedTask(world, await on.registry(), { person: PERSON, stamp: "core" });
    const offWorld = createFakeWorld();
    const off = appOver(offWorld, {});
    const core = corePersonEraseOf(off);
    expect(core.active).toBe(false);
    expect(await core.person(FAKE_COMPANY, PERSON)).toEqual({ tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, incomplete: 0 });
    expect(offWorld.created).toEqual([]);
    expect(await leftOf(await on.registry(), task)).toBe(2);
  });

  it("with a switch on it erases, and throws counts-only when a task did not finish so the request is repeated", async () => {
    const { world, app, registry } = await setup();
    const task = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    const core = corePersonEraseOf(app);
    expect(core.active).toBe(true);
    expect(await core.person(FAKE_COMPANY, PERSON)).toMatchObject({ erased: 1, incomplete: 0 });
    expect(await leftOf(registry, task)).toBe(0);
    const stuck = await seedTask(world, registry, { person: PERSON, stamp: "core" });
    vi.spyOn(registry.require("object-storage"), "deletePrefix").mockResolvedValue(false);
    const error = await core.person(FAKE_COMPANY, PERSON).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CorePersonEraseUnfinished);
    // Every core task of the person is walked again (the first one too: the walk is idempotent, and the stubbed store reports "not finished" for all).
    expect((error as CorePersonEraseUnfinished).report).toMatchObject({ tasks: 2, incomplete: 2 });
    expect((error as Error).message).not.toContain(stuck.taskId);
  });

  const ORG = FAKE_COMPANY as OrgId;
  it("the step calls the core's erase last, and only while a switch is on", async () => {
    const order: string[] = [];
    const record = { erase: { person: async () => { order.push("record"); } } };
    const evidence = { person: async () => { order.push("evidence"); } };
    const person = async (): Promise<PersonEraseOnCoreReport> => { order.push("core"); return { tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, incomplete: 0 }; };
    await personErasureStep(record, evidence, undefined, { active: true, person })(ORG, PERSON);
    expect(order).toEqual(["record", "evidence", "core"]);
    order.length = 0;
    await personErasureStep(record, evidence, undefined, { active: false, person })(ORG, PERSON);
    await personErasureStep(record, evidence)(ORG, PERSON);
    expect(order).toEqual(["record", "evidence", "record", "evidence"]);
  });

  it("the step fails when the core's erase fails (the request is repeated), and does not reach it when Cloud's evidence erase fails", async () => {
    const calls: string[] = [];
    const evidence = { person: async () => { calls.push("evidence"); } };
    await expect(personErasureStep(undefined, evidence, undefined, { active: true, person: async () => { throw new Error("unfinished"); } })(ORG, PERSON)).rejects.toThrow("unfinished");
    const core = { active: true, person: vi.fn(async () => ({ tasks: 0, erased: 0, cloudStamped: 0, skipped: 0, incomplete: 0 })) };
    await expect(personErasureStep(undefined, { person: async () => { throw new Error("cloud unfinished"); } }, undefined, core)(ORG, PERSON)).rejects.toThrow("cloud unfinished");
    expect(core.person).not.toHaveBeenCalled();
  });
});
