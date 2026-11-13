// Convergence S0: the composition root. Off by default with no behaviour change; the switch parses fail closed; a task keeps the engine it started on;
// the registry refuses a half-wired core; jobs run per company in isolation; the money, retention and Slack rules S0 owns.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOwnerTaskAccess } from "@rovara-code/broker/core/task-flow";
import { createAllowAllAdmission, localOwnerPrincipal } from "@rovara-code/broker/ports";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type ProjectDefinition } from "@rovara-code/contracts";
import { SLACK_NOT_A_MEMBER_NOTICE } from "@agentx/cloud-contracts";
import {
  CORE_ENGINE_OFF, CORE_JOBS, CloudRegistryError, closeHold, coreAreaOn, createCloudApp, engineOfStoredTask, engineStampKey, holdsChannelLinkCode, parseCoreSwitch, readCoreEngineFlags,
  runPerCompany, scheduleEventOf, slackRefusalReply, slackSwitchReadiness, spendWriterFor, stampForNewTask, stampOf, type CloudApp,
} from "../../packages/broker/src/cloud/app/index.js";
import { REMOVED_FROM_ORG_MESSAGE } from "../../packages/broker/src/org/sign-in.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/cloud-core-fakes.js";

const OTHER = "org_s0parity00000000000b";
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://examplehost/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv): CloudApp {
  return createCloudApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({
      callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined,
      services: () => ({
        "merge-tracking": { pass: async () => ({ swept: 0 }) }, "session-sweep": { pass: async () => ({ swept: 0 }) },
        "notify-deliver": { pass: async () => ({ sent: 0 }) }, "admission-hold-sweep": { pass: async () => ({ charged: 0 }) },
      }),
    }),
  });
}

async function registerProject(world: FakeWorld, companyId: string): Promise<void> {
  await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
}

describe("the switch", () => {
  it("reads off, on and on:<companies>, and anything else as OFF with a problem that does not echo the text", () => {
    expect(parseCoreSwitch(undefined)).toEqual({ value: { mode: "off" } });
    expect(parseCoreSwitch("")).toEqual({ value: { mode: "off" } });
    expect(parseCoreSwitch("0")).toEqual({ value: { mode: "off" } });
    expect(parseCoreSwitch("on")).toEqual({ value: { mode: "on" } });
    expect(parseCoreSwitch(`on:${FAKE_COMPANY}:${OTHER}`)).toEqual({ value: { mode: "on-for", companies: [FAKE_COMPANY, OTHER] } });
    for (const bad of ["1", "ON", "on:", "on:org_short", `on:${FAKE_COMPANY},${OTHER}`, "true", "yes please"]) {
      const parsed = parseCoreSwitch(bad);
      expect(parsed.value, bad).toEqual({ mode: "off" });
      expect(parsed.problem, bad).toBeDefined();
      expect(parsed.problem, bad).not.toContain(bad);
    }
  });

  it("is off by default, and one combined switch moves merge, build and flow together for the named company only", () => {
    expect(readCoreEngineFlags({})).toEqual(CORE_ENGINE_OFF);
    const flags = readCoreEngineFlags({ CLOUD_CORE_ENGINE: `on:${FAKE_COMPANY}` });
    for (const area of ["merge", "build", "flow"] as const) {
      expect(coreAreaOn(flags, area, FAKE_COMPANY)).toBe(true);
      expect(coreAreaOn(flags, area, OTHER)).toBe(false);
    }
  });

  it("a per-area key only narrows: it can never turn an area on that the combined switch leaves off", () => {
    expect(coreAreaOn(readCoreEngineFlags({ CLOUD_CORE_ENGINE_MERGE: "on" }), "merge", FAKE_COMPANY)).toBe(false);
    const narrowed = readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on", CLOUD_CORE_ENGINE_BUILD: "off" });
    expect(coreAreaOn(narrowed, "build", FAKE_COMPANY)).toBe(false);
    expect(coreAreaOn(narrowed, "flow", FAKE_COMPANY)).toBe(true);
    expect(readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on", CLOUD_CORE_ENGINE_FLOW: "bogus" }).problems).toEqual([{ variable: "CLOUD_CORE_ENGINE_FLOW", problem: expect.any(String) as string }]);
  });
});

describe("the engine stamp", () => {
  it("pins all three areas together; narrowing the flow keeps the whole task on Cloud (the core's build and merge read the core's task record)", () => {
    const now = new Date("2026-11-12T10:00:00.000Z");
    expect(stampForNewTask(readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on" }), FAKE_COMPANY, now)).toMatchObject({ engine: "core", areas: { merge: "core", build: "core", flow: "core" }, flags: "cc=on" });
    expect(stampForNewTask(readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on", CLOUD_CORE_ENGINE_FLOW: "off" }), FAKE_COMPANY, now)).toMatchObject({ engine: "cloud", areas: { merge: "cloud", build: "cloud", flow: "cloud" } });
    expect(stampForNewTask(readCoreEngineFlags({ CLOUD_CORE_ENGINE: "on", CLOUD_CORE_ENGINE_MERGE: "off" }), FAKE_COMPANY, now).areas).toEqual({ merge: "cloud", build: "core", flow: "core" });
  });

  it("reads an unstamped or malformed task as Cloud", async () => {
    const world = createFakeWorld();
    expect(await engineOfStoredTask(world.store, "t-none", "flow")).toBe("cloud");
    await world.store.put({ item: { ...engineStampKey("t-bad"), coreEngine: { engine: "core", areas: { merge: "core" }, flags: "x", stampedAt: "x" } } });
    expect(stampOf(await world.store.get(engineStampKey("t-bad")))).toBeUndefined();
    expect(await engineOfStoredTask(world.store, "t-bad", "flow")).toBe("cloud");
  });
});

describe("with every switch off (the default)", () => {
  it("builds nothing, reads nothing and answers every entry point with off: no behaviour change", async () => {
    const world = createFakeWorld();
    const context = vi.fn(() => world.context());
    const app = createCloudApp({ env: {}, modules: world.modules, context, runtime: () => { throw new Error("never"); } });
    const get = vi.spyOn(world.store, "get");
    expect(app.active).toBe(false);
    expect(app.engineForNewTask(FAKE_COMPANY)).toBe("cloud");
    expect(await app.handleScheduledJob(scheduleEventOf(CORE_JOBS[1]!))).toEqual({ skipped: "off" });
    expect(await app.handleScheduledJob({ source: "aws.events" })).toBeUndefined();
    expect(await app.relayOutbox([FAKE_COMPANY])).toEqual([]);
    await expect(app.registry()).rejects.toMatchObject({ name: "CoreEngineOffError" });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toMatchObject({ name: "CoreEngineOffError" });
    expect(world.created).toEqual([]);
    expect(context).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("a malformed switch is off too", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { CLOUD_CORE_ENGINE: "on:not-a-company" });
    expect(app.active).toBe(false);
    expect(app.flags.problems).toHaveLength(1);
    expect(world.created).toEqual([]);
  });
});

describe("the registry", () => {
  it("refuses a core with a needed point missing, naming it and the areas that need it", async () => {
    const world = createFakeWorld({ without: ["approvers", "code-host"] });
    const app = appOver(world, { CLOUD_CORE_ENGINE: "on" });
    const error = await app.registry().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudRegistryError);
    expect((error as CloudRegistryError).missing.map((entry) => entry.point).sort()).toEqual(["approvers", "code-host"]);
  });

  it("refuses Code's default where Cloud's own adapter is required (money, authority, audit)", async () => {
    const world = createFakeWorld({ asDefault: ["admission", "audit-sink"] });
    const error = await appOver(world, { CLOUD_CORE_ENGINE: "on" }).registry().catch((caught: unknown) => caught);
    expect([...(error as CloudRegistryError).defaulted].sort()).toEqual(["admission", "audit-sink"]);
  });

  it("is built once per container, sealed, and stores through Cloud's retention rule", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { CLOUD_CORE_ENGINE: "on" });
    const [one, two] = await Promise.all([app.registry(), app.registry()]);
    expect(one).toBe(two);
    expect(world.created.filter((point) => point === "storage")).toHaveLength(1);
    expect(() => { one.register("admission", "other", createAllowAllAdmission()); }).toThrow(/sealed/);
    const store = one.require("storage");
    await store.put({ item: { pk: "ORG#x#APPROVAL_DECISION#1", sk: "DECISION", entityType: "APPROVAL_DECISION", indexExpiresAt: 1 } });
    await store.put({ item: { pk: "ORG#x#WORKFLOW_DISPATCH", sk: "t#1", entityType: "WORKFLOW_DISPATCH", indexExpiresAt: 2 } });
    expect(await world.store.get({ pk: "ORG#x#APPROVAL_DECISION#1", sk: "DECISION" })).not.toHaveProperty("indexExpiresAt");
    expect(await world.store.get({ pk: "ORG#x#WORKFLOW_DISPATCH", sk: "t#1" })).toHaveProperty("indexExpiresAt", 2);
  });
});

describe("a task keeps the engine it started on", () => {
  it("a core start writes the stamp with the task; turning the switch off later leaves the running task on the core and sends new tasks to Cloud", async () => {
    const world = createFakeWorld();
    await registerProject(world, FAKE_COMPANY);
    const on = appOver(world, { CLOUD_CORE_ENGINE: `on:${FAKE_COMPANY}` });
    expect(on.engineForNewTask(FAKE_COMPANY)).toBe("core");
    expect(on.engineForNewTask(OTHER)).toBe("cloud");
    const runtime = await on.runtimeFor(FAKE_COMPANY);
    const owner = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "test" };
    const { task } = await runtime.flow.start(owner, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    expect(await on.engineOfTask(world.store, task.taskId, "build")).toBe("core");
    expect(stampOf(await world.store.get(engineStampKey(task.taskId)))).toMatchObject({ engine: "core", flags: `cc=on:${FAKE_COMPANY}` });

    const off = appOver(world, { CLOUD_CORE_ENGINE: "off" });
    expect(off.engineForNewTask(FAKE_COMPANY)).toBe("cloud");
    for (const area of ["merge", "build", "flow"] as const) expect(await off.engineOfTask(world.store, task.taskId, area)).toBe("core");
  });

  it("refuses a runtime whose switched areas lack a service (never a half-wired core)", async () => {
    const world = createFakeWorld();
    const app = createCloudApp({
      env: { CLOUD_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(),
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "x" }), now: () => new Date(world.clock.now), log: () => undefined }),
    });
    await expect(app.runtimeFor(FAKE_COMPANY)).rejects.toThrow(/merge-tracking/);
  });
});

describe("scheduled jobs", () => {
  it("each company runs isolated: one failure is that company's, the rest run, and the order rotates so a budget never defers the same tail", async () => {
    const seen: string[][] = [];
    for (const rotation of [0, 1, 2]) {
      const order: string[] = [];
      const reports = await runPerCompany(["a", "b", "c"], async (company) => { order.push(company); if (company === "b") throw new TypeError("boom"); return {}; }, { rotation, budgetMs: 1_000, nowMs: () => 0 });
      expect(reports.find((report) => report.companyId === "b")).toMatchObject({ outcome: "failed", error: "TypeError" });
      expect(reports.filter((report) => report.outcome === "ran")).toHaveLength(2);
      seen.push(order);
    }
    expect(seen.map((order) => order[0])).toEqual(["a", "b", "c"]);
    let clock = 0;
    const budgeted = await runPerCompany(["a", "b", "c"], async () => { clock += 600; return {}; }, { rotation: 0, budgetMs: 1_000, nowMs: () => clock });
    expect(budgeted.map((report) => report.outcome)).toEqual(["ran", "ran", "deferred"]);
  });

  it("runs a job only for the companies the switch covers, through the core", async () => {
    const world = createFakeWorld();
    const app = appOver(world, { CLOUD_CORE_ENGINE: `on:${FAKE_COMPANY}` });
    const result = await app.handleScheduledJob(scheduleEventOf(CORE_JOBS.find((job) => job.name === "dispatch-sweep")!));
    expect(result).toMatchObject({ job: "dispatch-sweep", companies: [{ companyId: FAKE_COMPANY, outcome: "ran" }] });
    expect(await app.handleScheduledJob({ source: "agentx.core-job", job: "nope" })).toEqual({ skipped: "unknown_job" });
    expect(await app.relayOutbox([OTHER])).toEqual([]);
    expect(await app.relayOutbox([FAKE_COMPANY, FAKE_COMPANY])).toMatchObject([{ companyId: FAKE_COMPANY, outcome: "ran" }]);
  });
});

describe("money (A5 notes)", () => {
  it("one spend writer: work on a Cloud model key releases its hold (the key ledger records the spend); other work settles from Metering", async () => {
    const admission = { settle: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    expect(spendWriterFor({ viaModelKey: true })).toBe("key-ledger");
    expect(await closeHold(admission, "r1", { viaModelKey: true }, { micros: 5, currency: "USD" })).toBe("released");
    expect(admission.settle).not.toHaveBeenCalled();
    expect(await closeHold(admission, "r2", { viaModelKey: false }, { micros: 5, currency: "USD" })).toBe("settled");
    expect(admission.settle).toHaveBeenCalledWith("r2", { cost: { micros: 5, currency: "USD" } });
    expect(await closeHold(admission, "r3", { viaModelKey: false }, undefined)).toBe("settled");
    expect(admission.settle).toHaveBeenLastCalledWith("r3", {});
  });
});

describe("Slack switch-on (A8 notes)", () => {
  it("a refused person gets today's words, never a channel link code", () => {
    expect(slackRefusalReply("unlinked")).toEqual({ code: "SLACK_ACCOUNT_NOT_LINKED", text: SLACK_NOT_A_MEMBER_NOTICE });
    expect(slackRefusalReply("not_a_member").code).toBe("SLACK_ACCOUNT_NOT_LINKED");
    expect(slackRefusalReply("banned")).toEqual({ code: "REMOVED_FROM_ORG", text: REMOVED_FROM_ORG_MESSAGE });
    expect(slackRefusalReply("removed").code).toBe("REMOVED_FROM_ORG");
    for (const refusal of ["unlinked", "not_a_member", "banned", "removed"] as const) expect(holdsChannelLinkCode(slackRefusalReply(refusal).text)).toBe(false);
    expect(holdsChannelLinkCode("Run `rovara link 123456` to link your account")).toBe(true);
  });

  it("is not ready while the CHANNEL_TENANTS backfill would still move rows or the inbound queue is not wired", () => {
    expect(slackSwitchReadiness({ tenantsBackfillPending: 3, bindWritesTenants: false, inboundWired: false }).blockers).toHaveLength(3);
    expect(slackSwitchReadiness({ tenantsBackfillPending: 0, bindWritesTenants: true, inboundWired: true })).toEqual({ ready: true, blockers: [] });
  });
});
