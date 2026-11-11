// Plan 5 Task 17: devices and the company's rules for local agents. A member registers their own Macs (at most ten live ones), lists only their own, and removes
// one; an org owner or admin removes anyone's. The company's rule (`LOCAL_AGENTS` in the org settings) says whether local agents are allowed, which tools, and on
// which projects; it defaults to allowed, only an owner or admin changes it, a change names the revision it read, and a rule that can't be read refuses.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEVICES_LIMIT_MESSAGE, deviceCommandKey, deviceKey, memberDevicesKey, orgSettingsKey, type LocalAgentPolicy, type OrgRole } from "@agentx/cloud-contracts";
import { INDEX_EXPIRY_ATTRIBUTE, LOCAL_TOOLS, agentRequestKey, type OrgId } from "@rovara-code/contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { checkLocalAgentAllowed, readLocalAgentPolicy, readLocalAgentPolicyWithRevision } from "../../packages/broker/src/devices/policy.js";
import { isDeviceRoute, routeDeviceRequest, type DeviceRouteDependencies } from "../../packages/broker/src/devices/routes.js";
import { clearOrgSessions } from "../../packages/broker/src/agent-sessions/lifecycle.js";
import { readDevice } from "../../packages/broker/src/devices/store.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ARJUN, BO, MIA, OLA, ORG_A, ORG_B, PRIYA, sessionWorld, T0 } from "../support/agent-session-world.js";

const CELL = "https://cell.example.com";
type Item = Record<string, unknown>;
type World = ReturnType<typeof world>;

const TOOL_TEXT = (tool: string) => `${tool} isn't allowed in your company. Ask an admin to allow it.`;
const NEED_PROJECT_TEXT = "Local agents need a project your company allows. Ask an admin to allow them.";
const PROJECT_TEXT = (project: string) => `Local agents aren't allowed on ${project}. Ask an admin to allow them.`;
const FULL: LocalAgentPolicy = { allowed: true, tools: [...LOCAL_TOOLS], projects: "all" };
const CONFLICT_TEXT = "Someone else changed your company's rules for local agents. Reload them and make your change again.";

function world() {
  const w = sessionWorld();
  const deps: DeviceRouteDependencies = { documentClient: w.db, tableName: "state", now: () => w.clock.now, log: () => undefined };
  const as = (developerId: string, orgRole: OrgRole = "member", orgId: OrgId = ORG_A): DeveloperCaller => ({ ...w.caller(developerId, orgId), orgRole });
  const call = (caller: DeveloperCaller, method: string, path: string, body?: unknown, using: DeviceRouteDependencies = deps) => routeDeviceRequest(
    using, caller, { method, path, headers: {}, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, new URL(`${CELL}${path}`),
  ) as Promise<{ statusCode?: number; body?: Record<string, unknown> } & Record<string, unknown>>;
  const body = (reply: { statusCode?: number; body?: Record<string, unknown> } & Record<string, unknown>): Record<string, unknown> => (reply.statusCode === undefined ? reply : reply.body!);
  const deviceOf = (reply: { statusCode?: number; body?: Record<string, unknown> } & Record<string, unknown>) => body(reply).device as { deviceId: string; label: string };
  const register = async (caller: DeveloperCaller, label = "Priya's MacBook", extra: Record<string, unknown> = {}) =>
    deviceOf(await call(caller, "POST", "/v1/app/devices", { requestId: randomUUID(), label, platform: "mac", ...extra }));
  const devicesOf = async (caller: DeveloperCaller) => (body(await call(caller, "GET", "/v1/app/devices")).devices as Array<{ deviceId: string; label: string }>);
  const policyOf = async (caller: DeveloperCaller) => body(await call(caller, "GET", "/v1/app/org/local-agents")) as { policy: LocalAgentPolicy; revision: number };
  const putPolicy = (caller: DeveloperCaller, change: Partial<LocalAgentPolicy>, revision: number, requestId = randomUUID()) =>
    call(caller, "PUT", "/v1/app/org/local-agents", { requestId, revision, policy: { ...FULL, ...change } });
  const meta = (orgId: OrgId, deviceId: string) => w.db.get(deviceKey(orgId, deviceId)) as Item | undefined;
  const row = (orgId: OrgId, developerId: string, deviceId: string) => w.db.get(memberDevicesKey(orgId, developerId, deviceId)) as Item | undefined;
  const writes = () => w.db.transactions().length;
  return { ...w, deps, as, call, body, deviceOf, register, devicesOf, policyOf, putPolicy, meta, row, writes };
}

/** What a synchronous check throws: its code and text without the code's prefix. */
const refusal = (check: () => void) => {
  try { check(); } catch (error) { const { code, message } = error as { code?: string; message: string }; return { code, message: message.replace(`${String(code)}: `, "") }; }
  return undefined;
};

const outcome = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

describe("registering and listing devices", () => {
  it("a member registers a Mac and lists only their own", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const arjun = w.as(ARJUN);
    const mine = await w.register(priya, "Priya's MacBook");
    const his = await w.register(arjun, "Arjun's Mac mini");
    expect(mine.deviceId).toMatch(/^dvc_[0-9a-z]{20}$/);
    expect((await w.devicesOf(priya)).map((d) => d.deviceId)).toEqual([mine.deviceId]);
    expect((await w.devicesOf(arjun)).map((d) => d.deviceId)).toEqual([his.deviceId]);
    const shown = (await w.devicesOf(priya))[0]!;
    expect(shown).toEqual({ deviceId: mine.deviceId, label: "Priya's MacBook", platform: "mac", createdAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString() });
  });

  it("writes the record, the member's list row and the request item in one transaction, in the shape the member lifecycle reads", async () => {
    const w = world();
    const device = await w.register(w.as(PRIYA), "Priya's MacBook");
    const tx = w.db.transactions().at(-1)!;
    expect(tx).toHaveLength(3);
    expect(w.meta(ORG_A, device.deviceId)).toMatchObject({
      entityType: "DEVICE", orgId: ORG_A, deviceId: device.deviceId, developerId: PRIYA, label: "Priya's MacBook", platform: "mac",
      createdAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString(),
    });
    expect(w.meta(ORG_A, device.deviceId)).not.toHaveProperty("revokedAt");
    expect(w.row(ORG_A, PRIYA, device.deviceId)).toMatchObject({ orgId: ORG_A, developerId: PRIYA, deviceId: device.deviceId });
    expect(w.db.find((item) => String(item.pk).includes("AGENT_REQUEST#"))).toHaveLength(1);
  });

  it("refuses the eleventh live device, and a removed one frees its place", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const made: string[] = [];
    for (let i = 0; i < 10; i += 1) made.push((await w.register(priya, `Mac ${String(i)}`)).deviceId);
    const before = w.writes();
    expect(await outcome(w.call(priya, "POST", "/v1/app/devices", { requestId: randomUUID(), label: "One too many", platform: "mac" })))
      .toEqual({ code: "CONFIG_INVALID", message: "You can register up to 10 devices. Remove one first." });
    expect(w.writes()).toBe(before);
    // Another member's devices do not count against Priya, and hers do not count against theirs.
    await w.register(w.as(ARJUN), "Arjun's Mac");
    await w.call(priya, "DELETE", `/v1/app/devices/${made[0]!}`);
    await expect(w.register(priya, "Replacement")).resolves.toMatchObject({ label: "Replacement" });
    expect(await w.devicesOf(priya)).toHaveLength(10);
  });

  it("does not count a device the member lifecycle revoked (the list row stays), and does not list it", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const kept: string[] = [];
    for (let i = 0; i < 10; i += 1) kept.push((await w.register(priya, `Mac ${String(i)}`)).deviceId);
    // Task 21's member removal marks the record `revokedAt` and leaves the list row.
    w.db.set({ ...w.meta(ORG_A, kept[3]!)!, revokedAt: new Date(T0).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: 1 });
    expect((await w.devicesOf(priya)).map((d) => d.deviceId)).not.toContain(kept[3]);
    await expect(w.register(priya, "Replacement")).resolves.toBeDefined();
  });

  it("ignores list rows that point at another member's, another org's or a missing record, and counts none of them", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const arjun = await w.register(w.as(ARJUN), "Arjun's Mac");
    const bo = await w.register(w.as(BO, "member", ORG_B), "Bo's Mac");
    // Forged rows in Priya's list: Arjun's device, a device of org B, and a device that does not exist.
    w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, arjun.deviceId), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: PRIYA, deviceId: arjun.deviceId });
    w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, bo.deviceId), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: PRIYA, deviceId: bo.deviceId });
    w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, "dvc_zzzzzzzzzzzzzzzzzzzz"), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: PRIYA, deviceId: "dvc_zzzzzzzzzzzzzzzzzzzz" });
    w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, "dvc_0123456789abcdefghij"), entityType: "MEMBER_DEVICE", orgId: ORG_B, developerId: PRIYA, deviceId: "dvc_0123456789abcdefghij" });
    expect(await w.devicesOf(priya)).toEqual([]);
    // Arjun's device is still Arjun's alone.
    expect((await w.devicesOf(w.as(ARJUN))).map((d) => d.deviceId)).toEqual([arjun.deviceId]);
  });

  it("two registrations racing at nine devices leave at most ten live ones", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    for (let i = 0; i < 9; i += 1) await w.register(priya, `Mac ${String(i)}`);
    const results = await Promise.allSettled([
      w.call(priya, "POST", "/v1/app/devices", { requestId: randomUUID(), label: "Racer A", platform: "mac" }),
      w.call(priya, "POST", "/v1/app/devices", { requestId: randomUUID(), label: "Racer B", platform: "mac" }),
    ]);
    expect((await w.devicesOf(priya)).length).toBeLessThanOrEqual(10);
    // A refused racer leaves nothing of its own behind.
    const live = (await w.devicesOf(priya)).map((d) => d.label);
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") expect(live).not.toContain(index === 0 ? "Racer A" : "Racer B");
    }
  });

  it("reads past 50 list rows: removed devices' rows stay, marked, and a live device after them is found and counted", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const marked = (i: number) => `dvc_${String(i).padStart(20, "0")}`;
    for (let i = 0; i < 120; i += 1) {
      w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, marked(i)), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: PRIYA, deviceId: marked(i), revokedAt: new Date(T0).toISOString() });
    }
    const last = "dvc_zzzzzzzzzzzzzzzzzzzy";
    w.db.set({ ...deviceKey(ORG_A, last), entityType: "DEVICE", orgId: ORG_A, deviceId: last, developerId: PRIYA, label: "Far down the list", platform: "mac", createdAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString() });
    w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, last), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: PRIYA, deviceId: last });
    expect((await w.devicesOf(priya)).map((d) => d.deviceId)).toEqual([last]);
    await expect(w.register(priya, "Next")).resolves.toBeDefined();
    expect(await w.devicesOf(priya)).toHaveLength(2);
  });

  it("refuses to register when it can't see the whole list (more rows than its pages hold), and when the list can't be read", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    for (let i = 0; i < 1001; i += 1) {
      const id = `dvc_${String(i).padStart(20, "0")}`;
      w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, id), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: PRIYA, deviceId: id, revokedAt: new Date(T0).toISOString() });
    }
    const before = w.writes();
    expect(await outcome(w.call(priya, "POST", "/v1/app/devices", { requestId: randomUUID(), label: "Blind", platform: "mac" }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.writes()).toBe(before);

    const fresh = world();
    fresh.db.injectFault({ command: "QueryCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 1 });
    expect(await outcome(fresh.call(fresh.as(PRIYA), "POST", "/v1/app/devices", { requestId: randomUUID(), label: "Blind", platform: "mac" }))).toMatchObject({ code: undefined });
    expect(fresh.writes()).toBe(0);
  });

  it.each([[2, "CONFIG_INVALID"], [3, "RUNTIME_UNAVAILABLE"]])("when %i take-back attempts fail the registration is refused (%s), never reports an eleventh device, and the repeat finishes the take-back", async (failures, firstCode) => {
    const w = world();
    const priya = w.as(PRIYA);
    for (let i = 0; i < 9; i += 1) await w.register(priya, `Mac ${String(i)}`);
    let racerLanded = false;
    let deletesToFail = failures;
    const racing: DeviceRouteDependencies = {
      ...w.deps,
      documentClient: {
        send: async (command: unknown) => {
          const name = (command as { constructor: { name: string } }).constructor.name;
          const items = (command as { input?: { TransactItems?: Array<Record<string, unknown>> } }).input?.TransactItems;
          if (name === "TransactWriteCommand" && items?.every((entry) => "Delete" in entry) === true && deletesToFail > 0) {
            deletesToFail -= 1;
            throw new Error("table unavailable");
          }
          const result = await w.db.send(command as never);
          if (name === "TransactWriteCommand" && !racerLanded && items?.some((entry) => "Put" in entry) === true) {
            racerLanded = true;
            const racer = "dvc_racerracerracerracer";
            w.db.set({ ...deviceKey(ORG_A, racer), entityType: "DEVICE", orgId: ORG_A, deviceId: racer, developerId: PRIYA, label: "Racer", platform: "mac", createdAt: new Date(T0).toISOString(), lastSeenAt: new Date(T0).toISOString() });
            w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, racer), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: PRIYA, deviceId: racer });
          }
          return result;
        },
      },
    };
    const payload = { requestId: randomUUID(), label: "Late one", platform: "mac" };
    expect(await outcome(w.call(priya, "POST", "/v1/app/devices", payload, racing))).toMatchObject({ code: firstCode });
    // The repeat finds the member over the limit (or, when the first request took the device back, a full list), and never answers the device.
    expect(await outcome(w.call(priya, "POST", "/v1/app/devices", payload))).toEqual({ code: "CONFIG_INVALID", message: DEVICES_LIMIT_MESSAGE });
    const live = await w.devicesOf(priya);
    expect(live).toHaveLength(10);
    expect(live.map((d) => d.label)).not.toContain("Late one");
    expect(w.db.get(agentRequestKey(ORG_A, PRIYA, payload.requestId))).toBeUndefined();
  });

  it("repeats: the same request id answers the first device and writes nothing; another body with that id is refused; a repeat after removal is refused and doesn't bring it back", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const requestId = randomUUID();
    const first = w.deviceOf(await w.call(priya, "POST", "/v1/app/devices", { requestId, label: "Priya's MacBook", platform: "mac" }));
    const before = w.writes();
    const again = w.deviceOf(await w.call(priya, "POST", "/v1/app/devices", { requestId, label: "Priya's MacBook", platform: "mac" }));
    expect(again).toEqual(first);
    expect(w.writes()).toBe(before);
    expect(await w.devicesOf(priya)).toHaveLength(1);
    expect(await outcome(w.call(priya, "POST", "/v1/app/devices", { requestId, label: "A different label", platform: "mac" }))).toMatchObject({ code: "CONFIG_INVALID" });
    await w.call(priya, "DELETE", `/v1/app/devices/${first.deviceId}`);
    const afterRemoval = w.writes();
    expect(await outcome(w.call(priya, "POST", "/v1/app/devices", { requestId, label: "Priya's MacBook", platform: "mac" }))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.writes()).toBe(afterRemoval);
    expect(await w.devicesOf(priya)).toEqual([]);
    expect(w.meta(ORG_A, first.deviceId)).toHaveProperty("revokedAt");
  });

  it("a repeat whose stored answer is not a device is not answered", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const requestId = randomUUID();
    await w.call(priya, "POST", "/v1/app/devices", { requestId, label: "Priya's MacBook", platform: "mac" });
    w.db.set({ ...w.db.get(agentRequestKey(ORG_A, PRIYA, requestId))!, result: { deviceId: "nope" } });
    expect(await outcome(w.call(priya, "POST", "/v1/app/devices", { requestId, label: "Priya's MacBook", platform: "mac" }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("the repeat of a request that raced and lost its request item answers the winner's outcome", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const requestId = randomUUID();
    const results = await Promise.allSettled([
      w.call(priya, "POST", "/v1/app/devices", { requestId, label: "Priya's MacBook", platform: "mac" }),
      w.call(priya, "POST", "/v1/app/devices", { requestId, label: "Priya's MacBook", platform: "mac" }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await w.devicesOf(priya)).toHaveLength(1);
    expect(w.db.find((item) => item.pk === agentRequestKey(ORG_A, PRIYA, requestId).pk)).toHaveLength(1);
  });

  it.each([
    ["no label", { label: undefined }],
    ["an empty label", { label: "" }],
    ["a blank label", { label: "   " }],
    ["a label of 61 characters", { label: "x".repeat(61) }],
    ["a label with a newline", { label: "Mac\nbook" }],
    ["a label with a zero-width character", { label: "Mac​book" }],
    ["a label that reverses text", { label: "Mac‮book" }],
    ["another platform", { platform: "windows" }],
    ["no platform", { platform: undefined }],
    ["a field the route does not take", { developerId: ARJUN }],
    ["no request id", { requestId: undefined }],
    ["a request id that is not a uuid", { requestId: "again" }],
  ])("refuses %s and writes nothing", async (_name, change) => {
    const w = world();
    const payload = { requestId: randomUUID(), label: "Priya's MacBook", platform: "mac", ...change };
    expect(await outcome(w.call(w.as(PRIYA), "POST", "/v1/app/devices", payload))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.writes()).toBe(0);
  });

  it("accepts a label of exactly 60 characters counted as characters, trimmed", async () => {
    const w = world();
    const label = "\u{1F4BB}".repeat(60);
    expect((await w.register(w.as(PRIYA), `  ${label}  `)).label).toBe(label);
  });

  it("answers 201 with the device", async () => {
    const w = world();
    const reply = await w.call(w.as(PRIYA), "POST", "/v1/app/devices", { requestId: randomUUID(), label: "Priya's MacBook", platform: "mac" });
    expect(reply.statusCode).toBe(201);
  });
});

describe("removing a device", () => {
  it("the owner removes their own: the record is marked revoked and expires, the list row goes, and it no longer lists", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const device = await w.register(priya);
    const reply = w.body(await w.call(priya, "DELETE", `/v1/app/devices/${device.deviceId}`));
    expect(reply).toEqual({ deviceId: device.deviceId, revoked: true });
    expect(w.meta(ORG_A, device.deviceId)).toMatchObject({ revokedAt: new Date(T0).toISOString(), developerId: PRIYA });
    expect(w.meta(ORG_A, device.deviceId)![INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(T0 / 1000) + 365 * 86_400);
    // The list row stays, marked and expiring with the record, so the member lifecycle (org close) still finds the device.
    expect(w.row(ORG_A, PRIYA, device.deviceId)).toMatchObject({
      orgId: ORG_A, developerId: PRIYA, deviceId: device.deviceId, revokedAt: new Date(T0).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(T0 / 1000) + 365 * 86_400,
    });
    expect(await w.devicesOf(priya)).toEqual([]);
  });

  it("remove a device, then close the org: the device partition is gone (Task 21's close finds the revoked device through the marked list row)", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const removed = await w.register(priya, "Priya's old MacBook");
    const live = await w.register(priya, "Priya's new MacBook");
    w.db.set({ ...deviceCommandKey(ORG_A, removed.deviceId, 1), entityType: "DEVICE_COMMAND", orgId: ORG_A, deviceId: removed.deviceId, command: "stop" });
    expect(w.body(await w.call(priya, "DELETE", `/v1/app/devices/${removed.deviceId}`))).toEqual({ deviceId: removed.deviceId, revoked: true });
    expect(w.meta(ORG_A, removed.deviceId)).toHaveProperty("revokedAt");

    await clearOrgSessions({ documentClient: w.db, tableName: "state", now: () => w.clock.now }, ORG_A);

    const partition = (deviceId: string) => w.db.find((item) => item.pk === deviceKey(ORG_A, deviceId).pk);
    expect(partition(removed.deviceId)).toEqual([]);
    expect(partition(live.deviceId)).toEqual([]);
    expect(w.row(ORG_A, PRIYA, removed.deviceId)).toBeUndefined();
    expect(w.row(ORG_A, PRIYA, live.deviceId)).toBeUndefined();
  });

  it("another member's DELETE gets 404 and changes nothing; an org admin's succeeds", async () => {
    const w = world();
    const device = await w.register(w.as(PRIYA));
    const before = w.writes();
    expect(await outcome(w.call(w.as(ARJUN), "DELETE", `/v1/app/devices/${device.deviceId}`))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.writes()).toBe(before);
    expect(w.meta(ORG_A, device.deviceId)).not.toHaveProperty("revokedAt");
    expect(await w.devicesOf(w.as(PRIYA))).toHaveLength(1);
    await w.call(w.as(OLA, "admin"), "DELETE", `/v1/app/devices/${device.deviceId}`);
    expect(w.meta(ORG_A, device.deviceId)).toHaveProperty("revokedAt");
    expect(w.row(ORG_A, PRIYA, device.deviceId)).toMatchObject({ developerId: PRIYA, revokedAt: new Date(T0).toISOString() });
  });

  it("an owner may too; a maintainer-by-grant or project viewer who is only a member may not", async () => {
    const w = world();
    const device = await w.register(w.as(PRIYA));
    expect(await outcome(w.call(w.as(MIA), "DELETE", `/v1/app/devices/${device.deviceId}`))).toMatchObject({ code: "NOT_FOUND" });
    await w.call(w.as(OLA, "owner"), "DELETE", `/v1/app/devices/${device.deviceId}`);
    expect(w.meta(ORG_A, device.deviceId)).toHaveProperty("revokedAt");
  });

  it("removing twice is the same answer and keeps the first time", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const device = await w.register(priya);
    await w.call(priya, "DELETE", `/v1/app/devices/${device.deviceId}`);
    const first = w.meta(ORG_A, device.deviceId)!.revokedAt;
    w.clock.now += 60_000;
    expect(w.body(await w.call(priya, "DELETE", `/v1/app/devices/${device.deviceId}`))).toEqual({ deviceId: device.deviceId, revoked: true });
    expect(w.meta(ORG_A, device.deviceId)!.revokedAt).toBe(first);
  });

  it("a missing device, a malformed id and another org's device are all 404; an admin of org B can't reach org A's device", async () => {
    const w = world();
    const device = await w.register(w.as(PRIYA));
    for (const id of ["dvc_zzzzzzzzzzzzzzzzzzzz", "dvc_short", "not-a-device", device.deviceId.toUpperCase()]) {
      expect(await outcome(w.call(w.as(PRIYA), "DELETE", `/v1/app/devices/${id}`))).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await outcome(w.call(w.as(BO, "owner", ORG_B), "DELETE", `/v1/app/devices/${device.deviceId}`))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.meta(ORG_A, device.deviceId)).not.toHaveProperty("revokedAt");
    // And Priya can't remove a device that sits in her own list but isn't hers.
    const arjun = await w.register(w.as(ARJUN));
    w.db.set({ ...memberDevicesKey(ORG_A, PRIYA, arjun.deviceId), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: PRIYA, deviceId: arjun.deviceId });
    expect(await outcome(w.call(w.as(PRIYA), "DELETE", `/v1/app/devices/${arjun.deviceId}`))).toMatchObject({ code: "NOT_FOUND" });
    expect(w.meta(ORG_A, arjun.deviceId)).not.toHaveProperty("revokedAt");
  });

  it("org B can't see org A's devices, and a record that names another org in A's partition is not found", async () => {
    const w = world();
    await w.register(w.as(PRIYA));
    expect(await w.devicesOf(w.as(BO, "member", ORG_B))).toEqual([]);
    // A record whose orgId says B, written under A's key, is not a device of A's.
    w.db.set({ ...deviceKey(ORG_A, "dvc_0123456789abcdefghij"), entityType: "DEVICE", orgId: ORG_B, deviceId: "dvc_0123456789abcdefghij", developerId: PRIYA, label: "x", platform: "mac", createdAt: "2026-10-22T09:00:00.000Z", lastSeenAt: "2026-10-22T09:00:00.000Z" });
    expect(await readDevice(w.deps, ORG_A, "dvc_0123456789abcdefghij")).toBeUndefined();
  });

  it("a removal that loses to a member merge reads the record again and marks its new owner's list row", async () => {
    const w = world();
    const device = await w.register(w.as(PRIYA));
    // Task 21 moves the device to the survivor between the read and the write.
    let moved = false;
    const racing: DeviceRouteDependencies = {
      ...w.deps,
      documentClient: {
        send: async (command: unknown) => {
          const name = (command as { constructor: { name: string } }).constructor.name;
          if (name === "TransactWriteCommand" && !moved) {
            moved = true;
            w.db.set({ ...w.meta(ORG_A, device.deviceId)!, developerId: ARJUN });
            w.db.delete(memberDevicesKey(ORG_A, PRIYA, device.deviceId));
            w.db.set({ ...memberDevicesKey(ORG_A, ARJUN, device.deviceId), entityType: "MEMBER_DEVICE", orgId: ORG_A, developerId: ARJUN, deviceId: device.deviceId });
          }
          return w.db.send(command as never);
        },
      },
    };
    await w.call(w.as(OLA, "admin"), "DELETE", `/v1/app/devices/${device.deviceId}`, undefined, racing);
    expect(w.meta(ORG_A, device.deviceId)).toMatchObject({ developerId: ARJUN });
    expect(w.meta(ORG_A, device.deviceId)).toHaveProperty("revokedAt");
    expect(w.row(ORG_A, ARJUN, device.deviceId)).toMatchObject({ developerId: ARJUN, revokedAt: expect.any(String) as string });
  });

  it("a method other than DELETE on a device does nothing to it", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    const device = await w.register(priya);
    for (const method of ["GET", "POST", "PUT", "PATCH"]) {
      expect(await outcome(w.call(priya, method, `/v1/app/devices/${device.deviceId}`, {}))).toMatchObject({ code: "NOT_FOUND" });
    }
    expect(w.meta(ORG_A, device.deviceId)).not.toHaveProperty("revokedAt");
    expect(await w.devicesOf(priya)).toHaveLength(1);
  });

  it("a record whose own id differs from its key is not that device", async () => {
    const w = world();
    const device = await w.register(w.as(PRIYA));
    w.db.set({ ...w.meta(ORG_A, device.deviceId)!, deviceId: "dvc_zzzzzzzzzzzzzzzzzzzz" });
    expect(await readDevice(w.deps, ORG_A, device.deviceId)).toBeUndefined();
    expect(await w.devicesOf(w.as(PRIYA))).toEqual([]);
  });

  it("readDevice returns a live or revoked record of that org and refuses a malformed one", async () => {
    const w = world();
    const device = await w.register(w.as(PRIYA));
    expect(await readDevice(w.deps, ORG_A, device.deviceId)).toMatchObject({ orgId: ORG_A, deviceId: device.deviceId, developerId: PRIYA, platform: "mac" });
    expect(await readDevice(w.deps, ORG_B, device.deviceId)).toBeUndefined();
    await w.call(w.as(PRIYA), "DELETE", `/v1/app/devices/${device.deviceId}`);
    expect(await readDevice(w.deps, ORG_A, device.deviceId)).toHaveProperty("revokedAt");
    w.db.set({ ...w.meta(ORG_A, device.deviceId)!, platform: "beos" });
    expect(await readDevice(w.deps, ORG_A, device.deviceId)).toBeUndefined();
  });
});

describe("the company's rules for local agents", () => {
  it("default to allowed: every tool, every project, revision 0, and any member reads them", async () => {
    const w = world();
    for (const caller of [w.as(PRIYA), w.as(MIA), w.as(OLA, "admin")]) {
      expect(await w.policyOf(caller)).toEqual({ policy: FULL, revision: 0 });
    }
    expect(w.writes()).toBe(0);
    expect(w.db.get(orgSettingsKey(ORG_A, "LOCAL_AGENTS"))).toBeUndefined();
  });

  it("only an owner or admin changes them: a member gets FORBIDDEN and nothing is written", async () => {
    const w = world();
    const before = w.writes();
    expect(await outcome(w.putPolicy(w.as(PRIYA), { allowed: false }, 0))).toMatchObject({ code: "FORBIDDEN" });
    expect(await outcome(w.putPolicy(w.as(PRIYA, "member"), { tools: ["codex"] }, 0))).toMatchObject({ code: "FORBIDDEN" });
    expect(w.writes()).toBe(before);
    expect(w.db.get(orgSettingsKey(ORG_A, "LOCAL_AGENTS"))).toBeUndefined();
    await w.putPolicy(w.as(OLA, "admin"), { tools: ["rovara", "claude-code"] }, 0);
    expect((await w.policyOf(w.as(PRIYA))).policy.tools).toEqual(["rovara", "claude-code"]);
    await w.putPolicy(w.as(OLA, "owner"), { tools: [...LOCAL_TOOLS] }, 1);
    expect((await w.policyOf(w.as(PRIYA))).revision).toBe(2);
  });

  it("a change names the revision it read: a stale one gets the conflict text and changes nothing", async () => {
    const w = world();
    const admin = w.as(OLA, "admin");
    await w.putPolicy(admin, { allowed: false }, 0);
    for (const stale of [0, 2, 7]) {
      expect(await outcome(w.putPolicy(admin, { allowed: true }, stale))).toEqual({ code: "AGENT_REVISION_CONFLICT", message: CONFLICT_TEXT });
    }
    expect(await w.policyOf(admin)).toMatchObject({ revision: 1, policy: { allowed: false } });
    expect(w.body(await w.putPolicy(admin, { allowed: true }, 1))).toMatchObject({ revision: 2 });
  });

  it("two changes at the same revision: exactly one applies", async () => {
    const w = world();
    const admin = w.as(OLA, "admin");
    const results = await Promise.allSettled([w.putPolicy(admin, { allowed: false }, 0), w.putPolicy(admin, { tools: ["codex"] }, 0)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "AGENT_REVISION_CONFLICT", message: expect.stringContaining(CONFLICT_TEXT) as string });
    expect((await w.policyOf(admin)).revision).toBe(1);
  });

  it("writes the document with its revision, who changed it and when, beside the request item, in one transaction", async () => {
    const w = world();
    await w.putPolicy(w.as(OLA, "admin"), { projects: ["web"] }, 0);
    expect(w.db.transactions().at(-1)).toHaveLength(2);
    expect(w.db.get(orgSettingsKey(ORG_A, "LOCAL_AGENTS"))).toMatchObject({
      entityType: "ORG_LOCAL_AGENTS", orgId: ORG_A, allowed: true, tools: [...LOCAL_TOOLS], projects: ["web"], revision: 1, updatedBy: OLA, updatedAt: new Date(T0).toISOString(),
    });
  });

  it("repeats: the same request answers the first outcome and writes nothing; the same id with another body is refused; a late repeat changes nothing", async () => {
    const w = world();
    const admin = w.as(OLA, "admin");
    const requestId = randomUUID();
    const first = w.body(await w.putPolicy(admin, { allowed: false }, 0, requestId));
    const before = w.writes();
    expect(w.body(await w.putPolicy(admin, { allowed: false }, 0, requestId))).toEqual(first);
    expect(w.writes()).toBe(before);
    expect(await outcome(w.putPolicy(admin, { allowed: true }, 0, requestId))).toMatchObject({ code: "CONFIG_INVALID" });
    await w.putPolicy(admin, { allowed: true }, 1);
    // The first request arrives late, after the opposite change: it answers what it did and undoes nothing.
    expect(w.body(await w.putPolicy(admin, { allowed: false }, 0, requestId))).toEqual(first);
    expect(await w.policyOf(admin)).toMatchObject({ revision: 2, policy: { allowed: true } });
  });

  it("the same request arriving twice at once changes the rules once and answers both the same", async () => {
    const w = world();
    const admin = w.as(OLA, "admin");
    const requestId = randomUUID();
    const [a, b] = await Promise.all([w.putPolicy(admin, { allowed: false }, 0, requestId), w.putPolicy(admin, { allowed: false }, 0, requestId)]);
    expect(w.body(a)).toEqual({ policy: { ...FULL, allowed: false }, revision: 1 });
    expect(w.body(b)).toEqual(w.body(a));
    expect((await w.policyOf(admin)).revision).toBe(1);
  });

  it("a repeat from someone who lost the right to change them is refused, not answered", async () => {
    const w = world();
    const requestId = randomUUID();
    await w.putPolicy(w.as(OLA, "admin"), { allowed: false }, 0, requestId);
    expect(await outcome(w.putPolicy(w.as(OLA, "member"), { allowed: false }, 0, requestId))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("a change that changes nothing records its request item and keeps the revision", async () => {
    const w = world();
    const admin = w.as(OLA, "admin");
    const reply = w.body(await w.putPolicy(admin, { tools: [...LOCAL_TOOLS].reverse() }, 0));
    expect(reply).toEqual({ policy: FULL, revision: 0 });
    expect(w.db.get(orgSettingsKey(ORG_A, "LOCAL_AGENTS"))).toBeUndefined();
    expect(w.db.find((item) => String(item.pk).includes("AGENT_REQUEST#"))).toHaveLength(1);
    await w.putPolicy(admin, { allowed: false }, 0);
    expect(await w.policyOf(admin)).toMatchObject({ revision: 1 });
    expect(w.body(await w.putPolicy(admin, { allowed: false }, 1))).toMatchObject({ revision: 1 });
    expect(await outcome(w.putPolicy(admin, { allowed: false }, 0))).toMatchObject({ code: "AGENT_REVISION_CONFLICT" });
  });

  it("keeps tools in their usual order and projects sorted", async () => {
    const w = world();
    const admin = w.as(OLA, "admin");
    await w.putPolicy(admin, { tools: ["codex", "rovara"], projects: ["web", "ops"] }, 0);
    expect((await w.policyOf(admin)).policy).toEqual({ allowed: true, tools: ["rovara", "codex"], projects: ["ops", "web"] });
  });

  it.each([
    ["an unknown tool", { tools: ["emacs"] }],
    ["a tool twice", { tools: ["codex", "codex"] }],
    ["a project that is not a name", { projects: ["Web App"] }],
    ["a project twice", { projects: ["web", "web"] }],
    ["more than 100 projects", { projects: Array.from({ length: 101 }, (_, i) => `p${String(i)}`) }],
    ["projects that are neither all nor a list", { projects: "none" }],
    ["allowed that is not a flag", { allowed: "yes" }],
    ["a field the rule does not have", { owner: ARJUN }],
  ])("refuses %s", async (_name, change) => {
    const w = world();
    expect(await outcome(w.putPolicy(w.as(OLA, "admin"), change as never, 0))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.writes()).toBe(0);
  });

  it("accepts exactly 100 projects, and none at all (no project allowed)", async () => {
    const w = world();
    const admin = w.as(OLA, "admin");
    await w.putPolicy(admin, { projects: Array.from({ length: 100 }, (_, i) => `p${String(i).padStart(3, "0")}`) }, 0);
    await w.putPolicy(admin, { projects: [], tools: [] }, 1);
    expect((await w.policyOf(admin)).policy).toEqual({ allowed: true, tools: [], projects: [] });
  });

  it.each([
    ["a revision that is negative", -1],
    ["a revision that is not whole", 1.5],
    ["a revision that is text", "0"],
    ["no revision", undefined],
  ])("refuses %s", async (_name, revision) => {
    const w = world();
    expect(await outcome(w.call(w.as(OLA, "admin"), "PUT", "/v1/app/org/local-agents", { requestId: randomUUID(), revision, policy: FULL }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(w.writes()).toBe(0);
  });

  it("is kept per company: org B's change doesn't reach org A, and org B reads its own default", async () => {
    const w = world();
    await w.putPolicy(w.as(OLA, "admin"), { allowed: false }, 0);
    expect(await w.policyOf(w.as(BO, "member", ORG_B))).toEqual({ policy: FULL, revision: 0 });
    await w.putPolicy(w.as(BO, "owner", ORG_B), { tools: ["codex"] }, 0);
    expect((await w.policyOf(w.as(PRIYA))).policy.allowed).toBe(false);
    expect((await w.policyOf(w.as(PRIYA))).policy.tools).toEqual([...LOCAL_TOOLS]);
  });
});

describe("a rule that can't be read refuses", () => {
  const stored = (w: World, change: Item) => w.db.set({ ...orgSettingsKey(ORG_A, "LOCAL_AGENTS"), entityType: "ORG_LOCAL_AGENTS", orgId: ORG_A, allowed: true, tools: [...LOCAL_TOOLS], projects: "all", revision: 1, ...change });

  it.each([
    ["allowed is not a flag", { allowed: "yes" }],
    ["allowed is missing", { allowed: undefined }],
    ["a tool is unknown", { tools: ["emacs"] }],
    ["projects is a word", { projects: "some" }],
    ["projects holds a non-name", { projects: ["Web App"] }],
    ["the revision is missing", { revision: undefined }],
    ["the revision is zero", { revision: 0 }],
    ["the org is another's", { orgId: ORG_B }],
  ])("when %s: a retryable 503, never the default of allowed", async (_name, change) => {
    const w = world();
    stored(w, change);
    for (const read of [() => readLocalAgentPolicy(w.deps, ORG_A), () => readLocalAgentPolicyWithRevision(w.deps, ORG_A), () => w.call(w.as(PRIYA), "GET", "/v1/app/org/local-agents")]) {
      expect(await outcome(read())).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    }
    expect(await outcome(w.putPolicy(w.as(OLA, "admin"), { allowed: false }, 1))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("when the table fails: the error reaches the caller", async () => {
    const w = world();
    w.db.injectFault({ command: "GetCommand", error: { name: "InternalServerError" }, times: 1 });
    expect(await outcome(readLocalAgentPolicy(w.deps, ORG_A))).toBeDefined();
  });
});

describe("checkLocalAgentAllowed", () => {
  const policy = (change: Partial<LocalAgentPolicy> = {}) => ({ ...FULL, ...change });

  it("lets an allowed tool on any project through, with or without a project", () => {
    expect(() => checkLocalAgentAllowed(policy(), "claude-code")).not.toThrow();
    expect(() => checkLocalAgentAllowed(policy(), "codex", "api")).not.toThrow();
  });

  it("refuses a tool the company turned off, with the exact text", () => {
    const rule = policy({ tools: LOCAL_TOOLS.filter((tool) => tool !== "codex") });
    expect(refusal(() => checkLocalAgentAllowed(rule, "codex", "web"))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: TOOL_TEXT("codex") });
    expect(() => checkLocalAgentAllowed(rule, "claude-code", "web")).not.toThrow();
  });

  it("refuses everything while local agents are off, with the tool text", () => {
    expect(refusal(() => checkLocalAgentAllowed(policy({ allowed: false }), "rovara"))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: TOOL_TEXT("rovara") });
    expect(refusal(() => checkLocalAgentAllowed(policy({ allowed: false }), "claude-code", "web"))?.code).toBe("LOCAL_AGENT_NOT_ALLOWED");
  });

  it("refuses a project the company didn't list, with the exact text; a listed project passes", () => {
    const rule = policy({ projects: ["web"] });
    expect(refusal(() => checkLocalAgentAllowed(rule, "claude-code", "api"))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: PROJECT_TEXT("api") });
    expect(() => checkLocalAgentAllowed(rule, "claude-code", "web")).not.toThrow();
    expect(refusal(() => checkLocalAgentAllowed(policy({ projects: [] }), "claude-code", "web"))?.code).toBe("LOCAL_AGENT_NOT_ALLOWED");
  });

  it("a rule that lists projects, even none, refuses a session with no project; a rule for all projects lets it pass", () => {
    for (const projects of [["web"], []]) {
      expect(refusal(() => checkLocalAgentAllowed(policy({ projects }), "claude-code"))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: NEED_PROJECT_TEXT });
    }
    expect(() => checkLocalAgentAllowed(policy({ projects: "all" }), "claude-code")).not.toThrow();
    // The tool text still comes first.
    expect(refusal(() => checkLocalAgentAllowed(policy({ tools: ["rovara"], projects: ["web"] }), "codex"))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: TOOL_TEXT("codex") });
  });

  it("the tool is checked before the project", () => {
    const rule = policy({ tools: ["rovara"], projects: ["web"] });
    expect(refusal(() => checkLocalAgentAllowed(rule, "codex", "api"))).toEqual({ code: "LOCAL_AGENT_NOT_ALLOWED", message: TOOL_TEXT("codex") });
  });

  it("refuses a tool it doesn't know, or a project that isn't a name, without repeating them", () => {
    for (const call of [() => checkLocalAgentAllowed(policy(), "emacs"), () => checkLocalAgentAllowed(policy(), "claude-code", "Web <b>App</b>")]) {
      let error: { code?: string; message: string } | undefined;
      try { call(); } catch (caught) { error = caught as typeof error; }
      expect(error?.code).toBe("CONFIG_INVALID");
      expect(error?.message).not.toContain("emacs");
      expect(error?.message).not.toContain("<b>");
    }
  });

  it("a rule with a tool outside the known ones doesn't let that tool through", () => {
    expect(() => checkLocalAgentAllowed(policy({ tools: ["emacs"] as never }), "emacs")).toThrow();
  });
});

describe("the routes", () => {
  it("claims /v1/app/devices*, and /v1/app/org/local-agents", () => {
    for (const path of ["/v1/app/devices", "/v1/app/devices/dvc_0123456789abcdefghij", "/v1/app/devices/dvc_0123456789abcdefghij/commands", "/v1/app/org/local-agents"]) {
      expect(isDeviceRoute(path)).toBe(true);
    }
    for (const path of ["/v1/app/devicesx", "/v1/app/org/local-agents/x", "/v1/app/org", "/v1/app/sessions", "/v1/app/org/spend-policy"]) {
      expect(isDeviceRoute(path)).toBe(false);
    }
  });

  it("answers 404 for a method or path it doesn't have, and CONFIG_INVALID for a body that is not JSON", async () => {
    const w = world();
    const priya = w.as(PRIYA);
    for (const [method, path] of [["PUT", "/v1/app/devices"], ["POST", "/v1/app/devices/dvc_0123456789abcdefghij"], ["GET", "/v1/app/devices/dvc_0123456789abcdefghij"], ["DELETE", "/v1/app/devices"], ["POST", "/v1/app/org/local-agents"], ["DELETE", "/v1/app/org/local-agents"]]) {
      expect(await outcome(w.call(priya, method!, path!, {}))).toMatchObject({ code: "NOT_FOUND" });
    }
    const reply = routeDeviceRequest(w.deps, priya, { method: "POST", path: "/v1/app/devices", headers: {}, requestId: "r", body: "{not json" }, new URL(`${CELL}/v1/app/devices`));
    expect(await outcome(reply)).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("through the developer API", () => {
  it("a member registers and lists a device, reads the rules, and can't change them; an owner can", async () => {
    const harness = await createDeveloperTaskBroker();
    seedMembership(harness.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const requestId = randomUUID();
    const made = await harness.dev(MAYA, "POST", "/v1/app/devices", { requestId, label: "Maya's MacBook", platform: "mac" });
    expect(made.status).toBe(201);
    const listed = await harness.dev(MAYA, "GET", "/v1/app/devices");
    expect((listed.body.devices as unknown[]).length).toBe(1);
    expect((await harness.dev(OMAR, "GET", "/v1/app/devices")).body.devices).toEqual([]);
    const rules = await harness.dev(MAYA, "GET", "/v1/app/org/local-agents");
    expect(rules.body).toMatchObject({ revision: 0, policy: { allowed: true } });
    const denied = await harness.dev(MAYA, "PUT", "/v1/app/org/local-agents", { requestId: randomUUID(), revision: 0, policy: { ...FULL, allowed: false } });
    expect(denied.status).toBe(403);
    const changed = await harness.dev(OMAR, "PUT", "/v1/app/org/local-agents", { requestId: randomUUID(), revision: 0, policy: { ...FULL, allowed: false } });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ revision: 1, policy: { allowed: false } });
  });
});
