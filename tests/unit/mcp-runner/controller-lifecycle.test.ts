// Stdio MCP host redesign, task T7: the controller's lifecycle against a fake task runner and fake per-server resources: idle and lifetime stops, reconcile from the cloud's records
// (leftovers, over-age jobs, tasks that are not the approved one), crashes and backoff, a replaced secret, the per-server task definition and security group, and the release route.
import { describe, expect, it, vi } from "vitest";
import type { ControllerEvent as Told, ServerResources, RunnerSpec } from "../../../packages/gateway/src/mcp-controller.js";
import type { RunnerTaskInfo } from "../../../packages/gateway/src/mcp-runner/task-runner.js";
import { CONTROLLER_LIMITS, memoryProbeSlots } from "../../../packages/gateway/src/mcp-controller.js";
import { HOST_PROBE_TIMEOUT_MS } from "../../../packages/broker/src/context-sources/server-port.js";
import { PROBE_SLOT_LEASE_MS } from "../../../packages/broker/src/mcp-host/probe-slots.js";
import { toolsHashOfNames } from "../../support/mcp-controller-fixtures.js";
import { BROKER, BUNDLE, BYTES, ECHO, OTHER, approvedOf, mcp, post, specOf, useControllerWorld, world } from "../../support/mcp-controller-world.js";

useControllerWorld();

const MIN = 60_000;
const HOUR = 60 * MIN;
const ID = "mcpsim000001";

class FakeResources implements ServerResources {
  ensured: Array<{ kind: string; id: string; spec: RunnerSpec; secretRef: string | undefined }> = [];
  released: Array<{ kind: string; id: string }> = [];
  held: Array<{ kind: "serve" | "probe"; id: string }> = [];
  failEnsure = false;
  failRelease = false;
  async ensure(input: { kind: "serve" | "probe"; id: string; spec: RunnerSpec; secretRef?: string | undefined }) {
    if (this.failEnsure) throw new Error("denied");
    this.ensured.push({ kind: input.kind, id: input.id, spec: input.spec, secretRef: input.secretRef });
    const family = input.kind === "serve" ? `rovara-mcp-serve-${input.id}` : `rovara-mcp-probe-${input.id}`;
    return { family, taskDefinition: `${family}:checked`, securityGroupId: "sg-0aaaaaaaaaaaaaaaa" };
  }
  async release(kind: "serve" | "probe", id: string) { if (this.failRelease) throw new Error("in use"); this.released.push({ kind, id }); }
  async list() { return this.held; }
}

const clock = { offset: 0 };
const now = (): number => Date.now() + clock.offset;
const ghost = (over: Partial<RunnerTaskInfo> = {}): RunnerTaskInfo => ({ taskId: "ghost-1", purpose: "serve", serverId: "mcpghost0001", approval: "a".repeat(12), family: "rovara-mcp-serve-mcpghost0001", owner: "fakeinst1", startedAt: now(), state: "running", ...over });

async function lifecycle(over: Parameters<typeof world>[0] = {}) {
  clock.offset = 0;
  const resources = new FakeResources();
  const w = await world({ ...over, controller: { now, resources, ...over.controller } });
  return { ...w, resources };
}

describe("T7 lifecycle: idle and maximum lifetime", () => {
  it("stops a server that has not been used for 10 minutes, and starts a fresh task for the next call; one used 9 minutes ago stays", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    clock.offset = 9 * MIN;
    await w.controller.reconcile();
    expect(w.controller.running()).toBe(1);
    clock.offset = 9 * MIN + 2 * MIN;
    await w.controller.reconcile();
    expect(w.controller.running()).toBe(0);
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("idle");
    expect((await mcp(w.brokerUrl, ID)).status).toBe(200);
    expect(w.runner.started("serve")).toHaveLength(2);
  });
  it("stops a server that is in use all the time after 12 hours, so anything it left behind does not last", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    clock.offset = 12 * HOUR + MIN;
    await mcp(w.brokerUrl, ID);
    await w.controller.reconcile();
    expect(w.controller.running()).toBe(0);
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("lifetime");
    clock.offset = 12 * HOUR + 2 * MIN;
    expect((await mcp(w.brokerUrl, ID)).status).toBe(200);
    expect(w.runner.started("serve")).toHaveLength(2);
  });
  it("stops it after 12 hours even when the cloud's list cannot be read, from its own record of the start", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    clock.offset = 12 * HOUR + MIN;
    await mcp(w.brokerUrl, ID);
    w.runner.listFails = true;
    await w.controller.reconcile();
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("lifetime");
  });
  it("keeps a server that is used often and is younger than 12 hours", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    clock.offset = 11 * HOUR;
    await mcp(w.brokerUrl, ID);
    await w.controller.reconcile();
    expect(w.controller.running()).toBe(1);
  });
});

describe("T7 lifecycle: reconcile from the cloud's records", () => {
  it("stops a task the controller does not know, whatever its purpose, and leaves the ones it knows", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    const own = w.runner.started("serve")[0]!.taskId;
    w.runner.extra.push(ghost(), ghost({ taskId: "ghost-2", purpose: "probe", serverId: "probe0123456789", family: "rovara-mcp-probe-probe0123456789" }), ghost({ taskId: "ghost-3", purpose: "install", serverId: "install", approval: "", family: "rovara-mcp-install" }));
    await w.controller.reconcile();
    expect(w.runner.stops.filter((stop) => stop.reason === "leftover").map((stop) => stop.taskId).sort()).toEqual(["ghost-1", "ghost-2", "ghost-3"]);
    expect(w.runner.stoppedFor(own)).toBeUndefined();
    expect(w.controller.running()).toBe(1);
  });
  it("does not judge a task the runner has made but not yet answered for: a start in flight is left for the next pass", async () => {
    const w = await lifecycle({ runner: { startDelayMs: 200 } });
    const request = mcp(w.brokerUrl, ID);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(w.runner.tasks.size).toBe(1);
    await w.controller.reconcile();
    expect(w.runner.stops).toEqual([]);
    expect((await request).status).toBe(200);
    await w.controller.reconcile();
    expect(w.runner.stops).toEqual([]);
  });
  it("stops an install that has run longer than five minutes, and a probe too", async () => {
    const w = await lifecycle({ runner: { install: () => new Promise<void>(() => undefined) }, controller: { limits: { installMs: 30_000, startMs: 1_500 } } });
    const install = post(w.brokerUrl, "/install", BROKER, { spec: { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } } });
    for (let tries = 0; tries < 100 && w.runner.started("install").length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await w.controller.reconcile();
    expect(w.runner.stops).toEqual([]);
    clock.offset = 4 * MIN;
    await w.controller.reconcile();
    expect(w.runner.stops).toEqual([]);
    clock.offset = 6 * MIN;
    await w.controller.reconcile();
    expect(w.runner.stops.map((stop) => stop.reason)).toEqual(["leftover"]);
    expect(await (await install).json()).toMatchObject({ ok: false, code: "install_failed" });
  });
  it("stops a task whose approval tag is not the approved bundle any more, with no call from the broker", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    w.approved.set(ID, approvedOf({ spec: specOf(OTHER) }));
    await w.controller.reconcile();
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("approval_changed");
    expect(w.controller.running()).toBe(0);
  });
  it("stops a task of a server that is no longer approved, and removes the task definition and security group it left", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    w.resources.held = [{ kind: "serve", id: ID }, { kind: "serve", id: "mcpother00001" }, { kind: "probe", id: "probe0123456789" }];
    w.approved.clear();
    w.approved.set("mcpother00001", approvedOf());
    await w.controller.reconcile();
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("disabled");
    // the disabled server's resources go; an approved server's stay; a probe nobody is running goes
    expect(w.resources.released.map((item) => `${item.kind}:${item.id}`).sort()).toEqual([`probe:probe0123456789`, `serve:${ID}`]);
  });
  it("leaves the resources of a server that is approved or serving, and of a probe that is running", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    w.resources.held = [{ kind: "serve", id: ID }];
    await w.controller.reconcile();
    expect(w.resources.released).toEqual([]);
  });
  it("judges nothing from a list it could not read, and stops the leftover once it can", async () => {
    const w = await lifecycle();
    w.runner.extra.push(ghost());
    w.runner.listFails = true;
    await w.controller.reconcile();
    expect(w.runner.stops).toEqual([]);
    w.runner.listFails = false;
    await w.controller.reconcile();
    expect(w.runner.stops.map((stop) => stop.taskId)).toEqual(["ghost-1"]);
  });
  it("does not stop a running task of a server whose approval it cannot read at the moment (nothing is served meanwhile), and stops it once it can read that it is gone", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    w.approved.clear();
    w.state.registryDown = true;
    await w.controller.reconcile();
    expect(w.runner.stops).toEqual([]);
    expect((await mcp(w.brokerUrl, ID)).status).toBe(503);
    w.state.registryDown = false;
    await w.controller.reconcile();
    expect(w.runner.stops.map((stop) => stop.reason)).toEqual(["disabled"]);
  });
  it("leaves the resources of a probe that is running, and removes them when it ends", async () => {
    const w = await lifecycle({ runner: { neverRunning: true }, controller: { limits: { startMs: 600, installMs: 2_000 } } });
    await w.bundles.put(BUNDLE, (async function* () { yield Buffer.from("a bundle"); })(), 1_000);
    const proposal = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 }, integrity: `sha512-${"A".repeat(86)}==` };
    const probe = post(w.brokerUrl, "/probe", BROKER, { spec: proposal, pinned: { lockfileHash: "2".repeat(64), bundleHash: BUNDLE } });
    for (let tries = 0; tries < 100 && w.resources.ensured.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const id = w.resources.ensured[0]!.id;
    w.resources.held = [{ kind: "probe", id }];
    await w.controller.reconcile();
    expect(w.resources.released).toEqual([]);
    expect(await (await probe).json()).toEqual({ error: "host_refused" });
    expect(w.resources.released).toEqual([{ kind: "probe", id }]);
  });
  it("does nothing once it is closed, and does not run two passes at once", async () => {
    const w = await lifecycle();
    w.runner.listDelayMs = 100;
    await Promise.all([w.controller.reconcile(), w.controller.reconcile(), w.controller.reconcile()]);
    expect(w.runner.listCalls).toBe(1);
    await w.controller.close();
    w.runner.extra.push(ghost());
    await w.controller.reconcile();
    expect(w.runner.listCalls).toBe(1);
    expect(w.runner.stops).toEqual([]);
  });
  it("clears its timer when it is closed", async () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      const w = await world({ controller: { sweepMs: 5_000 } });
      const handle = set.mock.results.find((result) => result.type === "return" && (result.value as { hasRef?: unknown }).hasRef !== undefined)?.value as ReturnType<typeof setInterval>;
      expect(handle).toBeDefined();
      expect(clear).not.toHaveBeenCalledWith(handle);
      await w.controller.close();
      expect(clear).toHaveBeenCalledWith(handle);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });
  it("runs on its own at start and then on a timer, and stops running when the controller is closed", async () => {
    clock.offset = 0;
    const w = await world({ controller: { sweepMs: 25 } });
    w.runner.extra.push(ghost());
    for (let tries = 0; tries < 100 && w.runner.stops.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.runner.stops.map((stop) => stop.taskId)).toEqual(["ghost-1"]);
    await w.controller.close();
    const calls = w.runner.listCalls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(w.runner.listCalls).toBe(calls);
  });
});

describe("fix round 1, I2: a second controller never stops the first one's tasks", () => {
  const other = (over: Partial<RunnerTaskInfo> = {}) => ghost({ taskId: "theirs-1", owner: "otherinst2", ...over });
  const leases = (alive: Record<string, boolean>, over: { renewFails?: boolean; aliveFails?: boolean } = {}) => {
    const calls: string[] = [];
    return { calls, api: {
      renew: async () => { calls.push("renew"); if (over.renewFails === true) throw new Error("down"); },
      alive: async (id: string) => { calls.push(`alive:${id}`); if (over.aliveFails === true) throw new Error("down"); return alive[id] === true; },
    } };
  };
  it("leaves the tasks of an instance whose lease is alive, however old they look, and stops those of an instance that is gone", async () => {
    const l = leases({ otherinst2: true, deadinst3: false });
    const w = await lifecycle({ controller: { leases: l.api } });
    w.runner.extra.push(other(), other({ taskId: "theirs-2", owner: "deadinst3" }), other({ taskId: "theirs-3", owner: "" }), ghost());
    await w.controller.reconcile();
    expect(w.runner.stops.map((stop) => stop.taskId).sort()).toEqual(["ghost-1", "theirs-2", "theirs-3"]);
    expect(w.runner.stops.every((stop) => stop.reason === "leftover")).toBe(true);
  });
  it("renews its own lease before it judges anything", async () => {
    const l = leases({ otherinst2: true });
    const w = await lifecycle({ controller: { leases: l.api } });
    w.runner.extra.push(other());
    await w.controller.reconcile();
    expect(l.calls).toEqual(["renew", "alive:otherinst2"]);
  });
  it("judges no other instance's task when it has no leases, when its own lease could not be renewed, or when it cannot tell whether the other is alive", async () => {
    for (const setup of [{ controller: {} }, { controller: { leases: leases({}, { renewFails: true }).api } }, { controller: { leases: leases({}, { aliveFails: true }).api } }]) {
      const w = await lifecycle(setup);
      w.runner.extra.push(other());
      await w.controller.reconcile();
      expect(w.runner.stops, JSON.stringify(Object.keys(setup.controller))).toEqual([]);
    }
  });
  it("still judges its own tasks when the lease cannot be renewed", async () => {
    const w = await lifecycle({ controller: { leases: leases({}, { renewFails: true }).api } });
    w.runner.extra.push(ghost());
    await w.controller.reconcile();
    expect(w.runner.stops.map((stop) => stop.taskId)).toEqual(["ghost-1"]);
  });
  it("leaves a serve task of another instance alone even when this instance has no record of its server", async () => {
    const w = await lifecycle({ controller: { leases: leases({ otherinst2: true }).api } });
    w.runner.extra.push(other({ serverId: ID, approval: BUNDLE.slice(0, 12) }));
    await w.controller.reconcile();
    expect(w.runner.stops).toEqual([]);
  });
});

describe("T7 lifecycle: crashes and backoff", () => {
  it("notices a task that died, counts it, and starts a fresh one on the next call", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    await w.runner.crash(w.runner.started("serve")[0]!.taskId);
    await w.controller.reconcile();
    expect(w.controller.running()).toBe(0);
    expect(w.controller.recentStarts(ID).failures).toBe(1);
    expect((await mcp(w.brokerUrl, ID)).status).toBe(200);
    expect(w.runner.started("serve")).toHaveLength(2);
  });
  it("backs off a server that keeps stopping: three in ten minutes, then nothing is started for ten minutes, and it says so", async () => {
    const w = await lifecycle();
    for (let round = 0; round < 3; round += 1) {
      expect((await mcp(w.brokerUrl, ID)).status).toBe(200);
      await w.runner.crash(w.runner.started("serve")[round]!.taskId);
      await w.controller.reconcile();
    }
    const refused = await mcp(w.brokerUrl, ID);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "keeps_stopping" });
    expect(w.runner.started("serve")).toHaveLength(3);
    const recent = w.controller.recentStarts(ID);
    expect(recent.failures).toBe(3);
    expect(recent.backoffUntil).toBeGreaterThan(now());
    clock.offset = 9 * MIN;
    expect((await mcp(w.brokerUrl, ID)).status).toBe(503);
    clock.offset = 11 * MIN;
    expect((await mcp(w.brokerUrl, ID)).status).toBe(200);
    expect(w.runner.started("serve")).toHaveLength(4);
    expect(w.controller.recentStarts(ID)).toEqual({ failures: 0 });
  });
  it("backs off a server that starts cleanly but dies under every call (found by the call, not by a pass)", async () => {
    const w = await lifecycle();
    for (let round = 0; round < 3; round += 1) {
      expect((await mcp(w.brokerUrl, ID)).status).toBe(200);
      await w.runner.crash(w.runner.started("serve")[round]!.taskId);
      expect((await mcp(w.brokerUrl, ID)).status).toBe(503);
    }
    expect(w.controller.recentStarts(ID).backoffUntil).toBeGreaterThan(now());
    const refused = await mcp(w.brokerUrl, ID);
    expect(await refused.json()).toEqual({ error: "keeps_stopping" });
    expect(w.runner.started("serve")).toHaveLength(3);
  });
  it("judges every task but those of a server whose start is in flight: steady start traffic for one server does not put off a leftover of another", async () => {
    const w = await lifecycle({ runner: { startDelayMs: 300 } });
    w.runner.extra.push(ghost());
    const request = mcp(w.brokerUrl, ID);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await w.controller.reconcile();
    expect(w.runner.stops.map((stop) => stop.taskId)).toEqual(["ghost-1"]);
    expect((await request).status).toBe(200);
  });
  it("counts only failures within ten minutes", async () => {
    const w = await lifecycle();
    for (let round = 0; round < 2; round += 1) { await mcp(w.brokerUrl, ID); await w.runner.crash(w.runner.started("serve")[round]!.taskId); await w.controller.reconcile(); }
    clock.offset = 11 * MIN;
    await mcp(w.brokerUrl, ID);
    await w.runner.crash(w.runner.started("serve")[2]!.taskId);
    await w.controller.reconcile();
    expect(w.controller.recentStarts(ID).failures).toBe(1);
    expect((await mcp(w.brokerUrl, ID)).status).toBe(200);
  });
  it("backs off failed starts too", async () => {
    const w = await lifecycle({ runner: { failStart: true } });
    for (let round = 0; round < 3; round += 1) expect((await mcp(w.brokerUrl, ID)).status).toBe(503);
    expect(await (await mcp(w.brokerUrl, ID)).json()).toEqual({ error: "keeps_stopping" });
  });
});

describe("T7 lifecycle: a replaced secret", () => {
  it("stops the running task on the next call after the secret changed, and starts one that reads the new value", async () => {
    const w = await lifecycle({ approved: { [ID]: approvedOf({ secretVersion: "v1", secretRef: "agentx/test/org-connectors/org/mcpsim000001" }) } });
    await mcp(w.brokerUrl, ID);
    w.approved.set(ID, approvedOf({ secretVersion: "v2", secretRef: "agentx/test/org-connectors/org/mcpsim000001" }));
    expect((await mcp(w.brokerUrl, ID)).status).toBe(200);
    const tasks = w.runner.started("serve");
    expect(tasks).toHaveLength(2);
    expect(w.runner.stoppedFor(tasks[0]!.taskId)).toBe("secret_replaced");
    expect(w.runner.stoppedFor(tasks[1]!.taskId)).toBeUndefined();
  });
  it("stops it without a call too, at reconcile", async () => {
    const w = await lifecycle({ approved: { [ID]: approvedOf({ secretVersion: "v1" }) } });
    await mcp(w.brokerUrl, ID);
    w.approved.set(ID, approvedOf({ secretVersion: "v2" }));
    await w.controller.reconcile();
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("secret_replaced");
    expect(w.controller.running()).toBe(0);
  });
  it("does not restart a server whose secret is unchanged", async () => {
    const w = await lifecycle({ approved: { [ID]: approvedOf({ secretVersion: "v1" }) } });
    await mcp(w.brokerUrl, ID);
    await mcp(w.brokerUrl, ID);
    await w.controller.reconcile();
    expect(w.runner.started("serve")).toHaveLength(1);
  });
});

describe("T7 lifecycle: the server's task definition and security group", () => {
  it("makes them before the task starts, from the approved spec, and starts the task in them", async () => {
    const w = await lifecycle({ approved: { [ID]: approvedOf({ secretRef: "agentx/test/org-connectors/org/mcpsim000001" }) } });
    await mcp(w.brokerUrl, ID);
    expect(w.resources.ensured).toEqual([{ kind: "serve", id: ID, spec: { name: "@acme/sim-mcp", args: ["--read-only"], secretEnv: ["JIRA_TOKEN"], destinations: [], size: { cpu: 256, memoryMiB: 512 }, bundleHash: BUNDLE }, secretRef: "agentx/test/org-connectors/org/mcpsim000001" }]);
    expect(w.runner.started("serve")[0]!.spec).toMatchObject({ family: `rovara-mcp-serve-${ID}`, taskDefinition: `rovara-mcp-serve-${ID}:checked`, securityGroupId: "sg-0aaaaaaaaaaaaaaaa" });
  });
  it("starts nothing when they cannot be made", async () => {
    const w = await lifecycle();
    w.resources.failEnsure = true;
    expect((await mcp(w.brokerUrl, ID)).status).toBe(503);
    expect(w.runner.started()).toEqual([]);
    expect(w.controller.running()).toBe(0);
  });
  it("makes them for a probe, and removes them again when the probe ends, however it ends", async () => {
    let url = "";
    const proposal = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], destinations: [{ host: "jira.corp.example", port: 443 }], secretEnv: [], size: { cpu: 256, memoryMiB: 512 } };
    const report = { ok: true, integrity: `sha512-${"A".repeat(86)}==`, lockfileHash: "2".repeat(64), bundleHash: BUNDLE, packageCount: 1, unpackedBytes: 1, tarBytes: 8, bin: "bin/a.js" };
    const w = await lifecycle({ runner: { install: async ({ token }) => {
      await fetch(`${url}/bundles/${BUNDLE}`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: Buffer.from("a bundle") });
      await fetch(`${url}/result`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(report) });
    } } });
    url = w.runnerUrl;
    expect((await post(w.brokerUrl, "/probe", BROKER, { spec: proposal })).status).toBe(200);
    expect(w.resources.ensured).toHaveLength(1);
    expect(w.resources.ensured[0]).toMatchObject({ kind: "probe", spec: { destinations: [{ host: "jira.corp.example", port: 443 }], bundleHash: BUNDLE } });
    expect(w.resources.ensured[0]!.id).toMatch(/^probe[0-9a-f]{10}$/u);
    expect(w.resources.released).toEqual([{ kind: "probe", id: w.resources.ensured[0]!.id }]);
    // and when the probe cannot be made
    w.resources.failEnsure = true;
    expect(await (await post(w.brokerUrl, "/probe", BROKER, { spec: proposal })).json()).toEqual({ error: "host_refused" });
    expect(w.resources.released).toHaveLength(2);
  });
});

describe("T7 lifecycle: disable and remove", () => {
  it("stops the task at once and removes its definition and security group when the broker releases a server that is no longer approved", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    w.approved.clear();
    const answer = await post(w.brokerUrl, `/servers/${ID}/release`, BROKER);
    expect(await answer.json()).toEqual({ status: "released", resources: "removed" });
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("disabled");
    expect(w.resources.released).toEqual([{ kind: "serve", id: ID }]);
    expect(w.controller.running()).toBe(0);
  });
  it("says the resources are pending when they cannot be removed yet (a network interface is still in use), and reconcile removes them later", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    w.approved.clear();
    w.resources.failRelease = true;
    expect(await (await post(w.brokerUrl, `/servers/${ID}/release`, BROKER)).json()).toEqual({ status: "released", resources: "pending" });
    expect(w.runner.stoppedFor(w.runner.started("serve")[0]!.taskId)).toBe("disabled");
    w.resources.failRelease = false;
    w.resources.held = [{ kind: "serve", id: ID }];
    await w.controller.reconcile();
    expect(w.resources.released).toEqual([{ kind: "serve", id: ID }]);
  });
  it("refuses to release a server that is still approved, and stops nothing", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    const answer = await post(w.brokerUrl, `/servers/${ID}/release`, BROKER);
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ error: "still_approved" });
    expect(w.runner.stops).toEqual([]);
    expect(w.resources.released).toEqual([]);
  });
  it("needs the broker's token, a POST and an id that is one", async () => {
    const w = await lifecycle();
    w.approved.clear();
    expect((await post(w.brokerUrl, `/servers/${ID}/release`, undefined)).status).toBe(401);
    expect((await post(w.brokerUrl, `/servers/${ID}/release`, "x".repeat(48))).status).toBe(401);
    expect((await fetch(`${w.brokerUrl}/servers/${ID}/release`, { headers: { authorization: `Bearer ${BROKER}` } })).status).toBe(405);
    expect((await post(w.brokerUrl, "/servers/..%2Fx/release", BROKER)).status).toBe(404);
    expect((await post(w.brokerUrl, `/servers/${ID}/release`, "t".repeat(43))).status).toBe(401);
  });
  it("stops serving a server the moment it is released, even when the broker's request for the call arrives later", async () => {
    const w = await lifecycle();
    await mcp(w.brokerUrl, ID);
    w.approved.clear();
    await post(w.brokerUrl, `/servers/${ID}/release`, BROKER);
    expect((await mcp(w.brokerUrl, ID)).status).toBe(404);
    expect(w.runner.started("serve")).toHaveLength(1);
  });
});

describe("T7 lifecycle: tools check still holds on a restart", () => {
  it("a restarted task with other tools is stopped, and the registry is told", async () => {
    const w = await lifecycle({ runner: { tools: () => [{ name: "echo", inputSchema: {} }, { name: "other", inputSchema: {} }] } });
    expect(w.approved.get(ID)!.toolsHash).toBe(toolsHashOfNames(ECHO));
    expect((await mcp(w.brokerUrl, ID)).status).toBe(409);
    expect(w.changes).toHaveLength(1);
  });
});

describe("fix round 1, m6: a probe job is over before its slot can be taken, and before the broker gives up", () => {
  const proposal = { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 }, integrity: `sha512-${"A".repeat(86)}==` };
  it("keeps the job's deadline shorter than the broker's wait, and the broker's wait shorter than the slot's lease", () => {
    expect(CONTROLLER_LIMITS.probeJobMs).toBeLessThan(HOST_PROBE_TIMEOUT_MS);
    expect(HOST_PROBE_TIMEOUT_MS).toBeLessThan(PROBE_SLOT_LEASE_MS);
  });
  it("answers at the deadline however long its parts would take, stops the tasks as the job ends, and gives the slot back only then", async () => {
    const slots = memoryProbeSlots(1);
    const w = await lifecycle({ runner: { neverRunning: true }, controller: { probeSlots: slots, limits: { startMs: 20_000, probeJobMs: 200 } } });
    await w.bundles.put(BUNDLE, (async function* () { yield Buffer.from("a bundle"); })(), 1_000);
    const started = Date.now();
    const answer = await post(w.brokerUrl, "/probe", BROKER, { spec: proposal, pinned: { lockfileHash: "2".repeat(64), bundleHash: BUNDLE } });
    expect(await answer.json()).toEqual({ error: "host_refused" });
    expect(Date.now() - started).toBeLessThan(3_000);
    // the job notices it was told to stop, its task is stopped, and then the slot is free
    let free = false;
    for (let tries = 0; tries < 200 && !free; tries += 1) { const release = await slots.acquire(); if (release !== undefined) { free = true; await release(); } else await new Promise((resolve) => setTimeout(resolve, 10)); }
    expect(free).toBe(true);
    expect(w.runner.stoppedFor(w.runner.started("probe")[0]!.taskId)).toBe("failed");
    expect(w.resources.released).toHaveLength(1);
  });
  it("cuts an install that never reports at the deadline too, and stops its task", async () => {
    const w = await lifecycle({ runner: { install: () => new Promise<void>(() => undefined) }, controller: { limits: { installMs: 30_000, probeJobMs: 200 } } });
    const answer = await post(w.brokerUrl, "/probe", BROKER, { spec: { ...proposal, integrity: undefined } });
    expect(await answer.json()).toEqual({ error: "host_refused" });
    for (let tries = 0; tries < 200 && w.runner.stops.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.runner.stops.map((stop) => stop.reason)).toEqual(["done"]);
  });
  it("answers a job that finishes in time as it always did", async () => {
    const w = await lifecycle({ controller: { limits: { probeJobMs: 5_000 } } });
    await w.bundles.put(BUNDLE, (async function* () { yield Buffer.from("a bundle"); })(), 1_000);
    const answer = await post(w.brokerUrl, "/probe", BROKER, { spec: proposal, pinned: { lockfileHash: "2".repeat(64), bundleHash: BUNDLE } });
    expect(await answer.json()).toMatchObject({ bundleHash: BUNDLE });
  });
});

describe("T10: what the controller tells the broker", () => {
  async function told(over: Parameters<typeof world>[0] = {}) {
    const events: Told[] = [];
    const w = await lifecycle({ ...over, controller: { events: async (event) => { events.push(event); }, ...over.controller } });
    const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 5)); };
    return { ...w, events, settle };
  }
  it("says a server started, by a call, and stopped when idle, with the fixed reason", async () => {
    const w = await told();
    await mcp(w.brokerUrl, ID);
    clock.offset = 11 * MIN;
    await w.controller.reconcile();
    await w.settle();
    expect(w.events).toEqual([{ type: "task_started", serverId: ID, trigger: "call" }, { type: "task_stopped", serverId: ID, reason: "idle" }]);
  });
  it("says a start was a warm-up when the broker asked for one without a call", async () => {
    const w = await told();
    expect((await post(w.brokerUrl, `/servers/${ID}/warm`, BROKER)).status).toBe(202);
    await vi.waitFor(() => expect(w.events.map((event) => event.type)).toContain("task_started"));
    expect(w.events[0]).toEqual({ type: "task_started", serverId: ID, trigger: "warm" });
  });
  it("says why a task stopped: a crash, the end of its 12 hours, a disabled server, a leftover, a changed approval", async () => {
    const crashed = await told();
    await mcp(crashed.brokerUrl, ID);
    await crashed.runner.crash(crashed.runner.started("serve")[0]!.taskId);
    await crashed.controller.reconcile();
    await crashed.settle();
    expect(crashed.events.at(-1)).toEqual({ type: "task_stopped", serverId: ID, reason: "crash" });

    const old = await told();
    await mcp(old.brokerUrl, ID);
    clock.offset = 12 * HOUR + MIN;
    await mcp(old.brokerUrl, ID);
    await old.controller.reconcile();
    await old.settle();
    expect(old.events.at(-1)).toEqual({ type: "task_stopped", serverId: ID, reason: "lifetime" });

    const off = await told();
    await mcp(off.brokerUrl, ID);
    off.approved.delete(ID);
    expect((await post(off.brokerUrl, `/servers/${ID}/release`, BROKER)).status).toBe(200);
    await off.settle();
    expect(off.events.at(-1)).toEqual({ type: "task_stopped", serverId: ID, reason: "disabled" });

    const ghosted = await told();
    ghosted.runner.extra.push(ghost());
    await ghosted.controller.reconcile();
    await ghosted.settle();
    expect(ghosted.events).toEqual([{ type: "task_stopped", serverId: "mcpghost0001", reason: "leftover" }]);

    const moved = await told();
    await mcp(moved.brokerUrl, ID);
    moved.approved.set(ID, approvedOf({ spec: specOf(OTHER) }));
    await moved.controller.reconcile();
    await moved.settle();
    expect(moved.events.at(-1)).toEqual({ type: "task_stopped", serverId: ID, reason: "approval_changed" });
  });
  it("says the tools changed, with both hashes, and that the task stopped for it", async () => {
    const w = await told({ runner: { tools: () => [{ name: "echo", inputSchema: {} }, { name: "other", inputSchema: {} }] } });
    expect((await mcp(w.brokerUrl, ID)).status).toBe(409);
    await w.settle();
    expect(w.events).toContainEqual({ type: "task_stopped", serverId: ID, reason: "tools_changed" });
    expect(w.events).toContainEqual({ type: "changed_needs_review", serverId: ID, approved: toolsHashOfNames(ECHO), observed: toolsHashOfNames([{ name: "echo", inputSchema: {} }, { name: "other", inputSchema: {} }]) });
  });
  it("says nothing about a probe or an install task, running or left over: only servers that serve", async () => {
    const w = await told();
    await w.bundles.put(BUNDLE, (async function* () { yield BYTES; })(), 1_000);
    const answer = await post(w.brokerUrl, "/probe", BROKER, { spec: { registry: "npm", name: "@acme/sim-mcp", version: "1.4.2", args: [], destinations: [], secretEnv: [], size: { cpu: 256, memoryMiB: 512 }, integrity: `sha512-${"A".repeat(86)}==` }, pinned: { lockfileHash: "2".repeat(64), bundleHash: BUNDLE } });
    expect(await answer.json()).toMatchObject({ bundleHash: BUNDLE });
    expect(w.runner.started("probe")).toHaveLength(1);
    w.runner.extra.push(ghost({ taskId: "ghost-2", purpose: "probe", serverId: "probe0123456789", family: "rovara-mcp-probe-probe0123456789" }), ghost({ taskId: "ghost-3", purpose: "install", serverId: "install", approval: "", family: "rovara-mcp-install" }));
    await w.controller.reconcile();
    await w.settle();
    expect(w.runner.stops.filter((stop) => stop.reason === "leftover")).toHaveLength(2);
    expect(w.events).toEqual([]);
  });
  it("says a leftover serve task of an instance that is gone stopped, and not one of an instance that is alive", async () => {
    const calls = { alive: { deadinst3: false, otherinst2: true } as Record<string, boolean> };
    const w = await told({ controller: { leases: { renew: async () => undefined, alive: async (id: string) => calls.alive[id] === true } } });
    w.runner.extra.push(ghost({ taskId: "theirs-1", owner: "otherinst2", serverId: "mcpalive00001" }), ghost({ taskId: "theirs-2", owner: "deadinst3", serverId: "mcpgone000001" }), ghost({ taskId: "theirs-3", owner: "deadinst3", purpose: "probe", serverId: "probe0123456789", family: "rovara-mcp-probe-probe0123456789" }));
    await w.controller.reconcile();
    await w.settle();
    expect(w.events).toEqual([{ type: "task_stopped", serverId: "mcpgone000001", reason: "leftover" }]);
  });
  it("works the same when the broker cannot be told: a sink that throws or never answers changes nothing for the call", async () => {
    const throwing = await lifecycle({ controller: { events: async () => { throw new Error("table down"); } } });
    expect((await mcp(throwing.brokerUrl, ID)).status).toBe(200);
    const hanging = await lifecycle({ controller: { events: () => new Promise<void>(() => undefined) } });
    expect((await mcp(hanging.brokerUrl, ID)).status).toBe(200);
  });
});
