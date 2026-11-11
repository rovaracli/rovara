// Plan 4 Task 19: what a maintainer does with a project's event hooks: create (the secret is shown once and kept nowhere else), list, rotate (with an overlap so the vendor's setting
// can be changed without dropped events) and delete; who may; what closing an org does to them. The deliveries use the same stores, so what the routes make is what ingress checks.
import { describe, expect, it } from "vitest";
import { HookStore, clearOrgHooks, HOOKS_PER_PROJECT_MAX } from "../../packages/broker/src/triggers/hooks.js";
import { hookDirectoryKey, hookKey, hookLookupKey } from "@rovara-code/contracts";
import { DANA, MAX, ORG_A, ORG_B, PRIYA, STRANGER, VIV, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";
import { FakeHookSecrets, LINEAR_TENANT, OTHER_TENANT, SECRET_1, SECRET_2, TEST_PROVIDERS, iso, setupHookWorld, type HookWorld } from "../support/hook-fixtures.js";

const HOUR = 3_600_000;
const BASE = "/v1/app/projects/web/event-hooks";
const DATADOG = { datadogOrgId: "1234" };
const rid = () => crypto.randomUUID();

/** The trigger world (two orgs, project roles, the real routes) with the hook routes switched on over the same table and clock as a hook world's ingress. */
function world(): { v: TriggerWorld; hw: HookWorld } {
  const v = setupTriggerWorld();
  const hw = setupHookWorld(TEST_PROVIDERS(), { db: v.db, clock: v.clock });
  v.routeDeps.eventHooks = { store: hw.store, secrets: hw.secrets, providers: hw.providers, origin: "https://api.example.com", secretRotated: (hookId) => hw.memory.remember(hookId, undefined) };
  return { v, hw };
}

const hookOf = (called: { body: Record<string, unknown> }) => called.body["hook"] as { hookId: string; url: string; [key: string]: unknown };
const body = (hw: HookWorld, id: string) => ({ id, tenant: LINEAR_TENANT, occurredAt: iso(hw.clock.now) });
const DATADOG_BODY = (hw: HookWorld, id: string) => ({ id, tenant: DATADOG, occurredAt: iso(hw.clock.now) });
const allItems = (hw: HookWorld) => JSON.stringify([...hw.db.items.values()]);

describe("creating a hook", () => {
  it("makes a vendor-origin hook from the secret the person pastes: the answer has the address and no secret, the secret is stored through the secret store only, and deliveries signed with it are accepted", async () => {
    const { v, hw } = world();
    const made = await v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const hook = hookOf(made);
    expect(hook).toMatchObject({ hookId: expect.stringMatching(/^hk_[0-9a-z]{26}$/) as string, source: "linear", project: "web", auth: "hmac", status: "active", hasSecret: true, tenant: LINEAR_TENANT, createdBy: { developerId: DANA, name: "Dana" } });
    expect(hook.url).toBe(`https://api.example.com/v1/hooks/linear/${hook.hookId}`);
    expect(made.body["url"]).toBe(hook.url);
    expect(made.body).not.toHaveProperty("secret");
    expect(JSON.stringify(made.body)).not.toContain(SECRET_1);
    expect(hw.secrets.stored(ORG_A, hook.hookId)).toEqual({ current: SECRET_1 });
    // Nowhere else: not in a record, a lookup, an index item or a request item.
    expect(allItems(hw)).not.toContain(SECRET_1);
    expect(hw.db.get(hookKey(ORG_A, hook.hookId))).toMatchObject({ orgId: ORG_A, source: "linear" });
    expect(hw.db.get(hookLookupKey(hook.hookId))).toMatchObject({ orgId: ORG_A });
    expect(hw.db.get(hookDirectoryKey(ORG_A, hook.hookId))).toBeDefined();
    const delivered = await hw.receive(hw.delivery({ source: "linear", hookId: hook.hookId }, body(hw, "e1")));
    expect(delivered.status).toBe(202);
    expect(hw.dispatched[0]!.event).toMatchObject({ project: "web", hookId: hook.hookId, source: "linear" });
  });

  it("makes a Rovara-origin hook with a secret of its own, shown once: 32 random bytes in base64url, never listed again", async () => {
    const { v, hw } = world();
    const made = await v.agentCall(MAX, "POST", BASE, { source: "datadog", tenant: DATADOG });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const secret = String(made.body["secret"]);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hook = hookOf(made);
    expect(hw.secrets.stored(ORG_A, hook.hookId)).toEqual({ current: secret });
    const other = await v.agentCall(MAX, "POST", BASE, { source: "datadog", tenant: DATADOG });
    expect(String(other.body["secret"])).not.toBe(secret);
    const listed = await v.agentCall(MAX, "GET", BASE);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    expect((listed.body["hooks"] as unknown[]).length).toBe(2);
    expect(allItems(hw)).not.toContain(secret);
    expect((await hw.receive(hw.delivery({ source: "datadog", hookId: hook.hookId }, DATADOG_BODY(hw, "m1"), { secret }))).status).toBe(202);
  });

  it("refuses what it can't make: a secret where Rovara makes it, none where the vendor does, a short one, a tenant that isn't the source's, an unknown field, GitHub and a source with no provider yet", async () => {
    const { v, hw } = world();
    const refusals: Array<[string, Record<string, unknown>, number]> = [
      ["a secret for a Rovara-origin source", { source: "datadog", tenant: DATADOG, secret: SECRET_1 }, 400],
      ["no secret for a vendor-origin source", { source: "linear", tenant: LINEAR_TENANT }, 400],
      ["a short secret", { source: "linear", tenant: LINEAR_TENANT, secret: "short" }, 400],
      ["a secret with a control character", { source: "linear", tenant: LINEAR_TENANT, secret: `${SECRET_1}\n` }, 400],
      ["a tenant missing a field", { source: "linear", tenant: { organizationId: LINEAR_TENANT.organizationId }, secret: SECRET_1 }, 400],
      ["a tenant with an extra field", { source: "linear", tenant: { ...LINEAR_TENANT, extra: 1 }, secret: SECRET_1 }, 400],
      ["another source's tenant", { source: "linear", tenant: DATADOG, secret: SECRET_1 }, 400],
      ["an unknown field", { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1, auth: "none" }, 400],
      ["GitHub", { source: "github", tenant: {}, secret: SECRET_1 }, 400],
      ["a source with no provider yet", { source: "pagerduty", tenant: { subdomain: "acme" }, secret: SECRET_1 }, 503],
      ["CloudWatch, which Task 25 makes", { source: "cloudwatch", tenant: { awsAccountId: "123456789012", topicArn: "arn:aws:sns:us-east-1:123456789012:alarms" } }, 503],
    ];
    for (const [name, input, status] of refusals) expect((await v.agentCall(DANA, "POST", BASE, input)).status, name).toBe(status);
    expect(await hw.store.list(ORG_A)).toEqual([]);
    expect(hw.secrets.values.size).toBe(0);
  });

  it("is for people who may edit the project's settings, and another org's project or one the caller has no role on is not found", async () => {
    const { v, hw } = world();
    const input = { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 };
    expect((await v.agentCall(PRIYA, "POST", BASE, input)).status).toBe(403);
    expect((await v.agentCall(PRIYA, "GET", BASE)).status).toBe(403);
    expect((await v.agentCall(STRANGER, "POST", BASE, input, ORG_B)).status).toBe(404);
    expect((await v.agentCall(DANA, "POST", "/v1/app/projects/nowhere/event-hooks", input)).status).toBe(404);
    expect((await v.agentCall(MAX, "POST", BASE, input)).status).toBe(201);
    expect(hw.secrets.puts).toBe(1);
  });

  it("answers a repeat of a request with the hook it made, writes nothing, and says the secret was shown once; the same id for another hook is refused", async () => {
    const { v, hw } = world();
    const requestId = rid();
    const first = await v.agentCall(DANA, "POST", BASE, { requestId, source: "datadog", tenant: DATADOG });
    expect(first.status).toBe(201);
    const puts = hw.secrets.puts;
    const again = await v.agentCall(DANA, "POST", BASE, { requestId, source: "datadog", tenant: DATADOG });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true });
    expect(again.body).not.toHaveProperty("secret");
    expect(hookOf(again).hookId).toBe(hookOf(first).hookId);
    expect(hw.secrets.puts).toBe(puts);
    expect(hw.secrets.stored(ORG_A, hookOf(first).hookId)).toEqual({ current: String(first.body["secret"]) });
    expect((await v.agentCall(DANA, "POST", BASE, { requestId, source: "datadog", tenant: { datadogOrgId: "9999" } })).status).toBe(400);
    // Another person's request with the same id is their own request.
    expect(hookOf(await v.agentCall(MAX, "POST", BASE, { requestId, source: "datadog", tenant: DATADOG })).hookId).not.toBe(hookOf(first).hookId);
  });

  it("stops at the most hooks a project may have, counting only those that are on", async () => {
    const { v } = world();
    for (let index = 0; index < HOOKS_PER_PROJECT_MAX; index += 1) expect((await v.agentCall(DANA, "POST", BASE, { source: "datadog", tenant: { datadogOrgId: String(index) } })).status).toBe(201);
    expect((await v.agentCall(DANA, "POST", BASE, { source: "datadog", tenant: DATADOG })).status).toBe(400);
    const first = ((await v.agentCall(DANA, "GET", BASE)).body["hooks"] as Array<{ hookId: string }>)[0]!;
    expect((await v.agentCall(DANA, "DELETE", `${BASE}/${first.hookId}`, {})).status).toBe(200);
    expect((await v.agentCall(DANA, "POST", BASE, { source: "datadog", tenant: DATADOG })).status).toBe(201);
  });

  it("leaves nothing behind when the secret can't be saved, and schedules a secret it saved for deletion when the hook can't be stored", async () => {
    const { v, hw } = world();
    hw.secrets.failPuts = new Error("secrets are down");
    await expect(v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 })).rejects.toThrow("secrets are down");
    expect(await hw.store.list(ORG_A)).toEqual([]);
    hw.secrets.failPuts = undefined;
    hw.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 })).rejects.toThrow();
    expect(await hw.store.list(ORG_A)).toEqual([]);
    expect(hw.secrets.deleted).toHaveLength(1);
  });

  it("answers 404 where hooks are not set up", async () => {
    const v = setupTriggerWorld();
    expect((await v.agentCall(DANA, "GET", BASE)).status).toBe(404);
  });
});

describe("rotating a hook's secret", () => {
  async function datadogHook(v: TriggerWorld) {
    const made = await v.agentCall(DANA, "POST", BASE, { source: "datadog", tenant: DATADOG });
    return { hook: hookOf(made), secret: String(made.body["secret"]) };
  }

  it("gives a Rovara-origin hook a new secret at once and keeps the old one for 24 hours, then drops it", async () => {
    const { v, hw } = world();
    const { hook, secret: first } = await datadogHook(v);
    const target = { source: "datadog" as const, hookId: hook.hookId };
    expect((await hw.receive(hw.delivery(target, DATADOG_BODY(hw, "m1"), { secret: first }))).status).toBe(202);
    const rotatedAt = hw.clock.now;
    const rotated = await v.agentCall(DANA, "POST", `${BASE}/${hook.hookId}/rotate`, {});
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    const second = String(rotated.body["secret"]);
    expect(second).not.toBe(first);
    expect(hw.secrets.stored(ORG_A, hook.hookId)).toEqual({ current: second, previous: first, previousValidUntil: iso(rotatedAt + 24 * HOUR) });
    expect(allItems(hw)).not.toContain(second);
    // The new secret works at once, in this container, though the old one was cached.
    expect((await hw.receive(hw.delivery(target, DATADOG_BODY(hw, "m2"), { secret: second }))).status).toBe(202);
    hw.clock.now = rotatedAt + 24 * HOUR - 1000;
    expect((await hw.receive(hw.delivery(target, DATADOG_BODY(hw, "m3"), { secret: first }))).status).toBe(202);
    hw.clock.now = rotatedAt + 24 * HOUR + 1000;
    expect((await hw.receive(hw.delivery(target, DATADOG_BODY(hw, "m4"), { secret: first }))).status).toBe(403);
    expect((await hw.receive(hw.delivery(target, DATADOG_BODY(hw, "m5"), { secret: second }))).status).toBe(202);
    // The listing shows when, never what.
    const listed = (await v.agentCall(DANA, "GET", BASE)).body["hooks"] as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ rotatedAt: iso(rotatedAt) });
    expect(JSON.stringify(listed)).not.toContain(second);
  });

  it("takes the new secret of a vendor-origin hook from the person, and requires it; the vendor's own setting can be changed within the overlap", async () => {
    const { v, hw } = world();
    const made = await v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 });
    const hook = hookOf(made);
    expect((await v.agentCall(DANA, "POST", `${BASE}/${hook.hookId}/rotate`, {})).status).toBe(400);
    const rotated = await v.agentCall(DANA, "POST", `${BASE}/${hook.hookId}/rotate`, { secret: SECRET_2 });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body).not.toHaveProperty("secret");
    expect(JSON.stringify(rotated.body)).not.toContain(SECRET_2);
    expect(hw.secrets.stored(ORG_A, hook.hookId)).toMatchObject({ current: SECRET_2, previous: SECRET_1 });
    const target = { source: "linear" as const, hookId: hook.hookId };
    expect((await hw.receive(hw.delivery(target, body(hw, "a"), { secret: SECRET_1 }))).status).toBe(202);
    expect((await hw.receive(hw.delivery(target, body(hw, "b"), { secret: SECRET_2 }))).status).toBe(202);
  });

  it("keeps one overlap only: a second rotation drops what the first one kept", async () => {
    const { v, hw } = world();
    const { hook, secret: first } = await datadogHook(v);
    const second = String((await v.agentCall(DANA, "POST", `${BASE}/${hook.hookId}/rotate`, {})).body["secret"]);
    const third = String((await v.agentCall(DANA, "POST", `${BASE}/${hook.hookId}/rotate`, {})).body["secret"]);
    expect(hw.secrets.stored(ORG_A, hook.hookId)).toMatchObject({ current: third, previous: second });
    const target = { source: "datadog" as const, hookId: hook.hookId };
    expect((await hw.receive(hw.delivery(target, DATADOG_BODY(hw, "m1"), { secret: first }))).status).toBe(403);
  });

  it("answers a repeat of a rotation without rotating again, and refuses a hook that is off, another project's and another org's", async () => {
    const { v, hw } = world();
    const { hook } = await datadogHook(v);
    const requestId = rid();
    const first = await v.agentCall(DANA, "POST", `${BASE}/${hook.hookId}/rotate`, { requestId });
    const stored = hw.secrets.stored(ORG_A, hook.hookId);
    const puts = hw.secrets.puts;
    const again = await v.agentCall(DANA, "POST", `${BASE}/${hook.hookId}/rotate`, { requestId });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true });
    expect(again.body).not.toHaveProperty("secret");
    expect(hw.secrets.puts).toBe(puts);
    expect(hw.secrets.stored(ORG_A, hook.hookId)).toEqual(stored);
    expect(first.body["secret"]).toBe(stored!.current);
    expect((await v.agentCall(PRIYA, "POST", `${BASE}/${hook.hookId}/rotate`, {})).status).toBe(403);
    expect((await v.agentCall(STRANGER, "POST", `${BASE}/${hook.hookId}/rotate`, {}, ORG_B)).status).toBe(404);
    expect((await v.agentCall(DANA, "POST", `${BASE}/hk_${"z".repeat(26)}/rotate`, {})).status).toBe(404);
    expect((await v.agentCall(DANA, "POST", `${BASE}/not-a-hook/rotate`, {})).status).toBe(404);
    await v.agentCall(DANA, "DELETE", `${BASE}/${hook.hookId}`, {});
    expect((await v.agentCall(DANA, "POST", `${BASE}/${hook.hookId}/rotate`, {})).status).toBe(400);
  });
});

describe("deleting a hook", () => {
  it("turns it off, takes its lookup away and schedules its secret's deletion; a delivery to it is then refused, and deleting again is the same answer", async () => {
    const { v, hw } = world();
    const hook = hookOf(await v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 }));
    const target = { source: "linear" as const, hookId: hook.hookId };
    expect((await hw.receive(hw.delivery(target, body(hw, "a")))).status).toBe(202);
    const deleted = await v.agentCall(DANA, "DELETE", `${BASE}/${hook.hookId}`, {});
    expect(deleted).toMatchObject({ status: 200, body: { deleted: true } });
    expect(await hw.store.record(ORG_A, hook.hookId)).toMatchObject({ status: "disabled" });
    expect(hw.db.get(hookLookupKey(hook.hookId))).toBeUndefined();
    expect(hw.secrets.deleted).toEqual([`${ORG_A}|${hook.hookId}`]);
    expect((await hw.receive(hw.delivery(target, body(hw, "b")))).status).toBe(403);
    expect((await v.agentCall(DANA, "DELETE", `${BASE}/${hook.hookId}`, {})).status).toBe(200);
    expect(hw.secrets.deleted).toHaveLength(2);
    expect(await v.hookReader.get(ORG_A, hook.hookId)).toBeUndefined();
  });

  it("is for people who may edit the project's settings, and a hook of another project or org is not found", async () => {
    const { v, hw } = world();
    const hook = hookOf(await v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 }));
    expect((await v.agentCall(PRIYA, "DELETE", `${BASE}/${hook.hookId}`, {})).status).toBe(403);
    expect((await v.agentCall(STRANGER, "DELETE", `${BASE}/${hook.hookId}`, {}, ORG_B)).status).toBe(404);
    expect((await v.agentCall(DANA, "DELETE", "/v1/app/projects/nowhere/event-hooks/" + hook.hookId, {})).status).toBe(404);
    expect((await v.agentCall(DANA, "DELETE", `${BASE}/${hook.hookId}`, { extra: 1 })).status).toBe(400);
    expect(await hw.store.record(ORG_A, hook.hookId)).toMatchObject({ status: "active" });
    expect(hw.secrets.deleted).toEqual([]);
    expect((await v.agentCall(DANA, "DELETE", `${BASE}/${hook.hookId}`, {})).status).toBe(200);
    expect(VIV).toBeDefined();
  });
});

describe("what a trigger's checks read of a hook", () => {
  it("answers the hook's project, source and whether it is off, and nothing for another org's hook or one that was never made", async () => {
    const { v, hw } = world();
    const hook = hookOf(await v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 }));
    expect(await hw.store.get(ORG_A, hook.hookId)).toEqual({ orgId: ORG_A, hookId: hook.hookId, project: "web", source: "linear", disabled: false });
    expect(await hw.store.get(ORG_B, hook.hookId)).toBeUndefined();
    expect(await hw.store.get(ORG_A, `hk_${"q".repeat(26)}`)).toBeUndefined();
    for (const status of ["unsubscribed", "disabled"] as const) {
      hw.db.set({ ...hw.db.get(hookKey(ORG_A, hook.hookId))!, status });
      expect((await hw.store.get(ORG_A, hook.hookId))!.disabled).toBe(true);
    }
    hw.db.set({ ...hw.db.get(hookKey(ORG_A, hook.hookId))!, status: "pending_confirmation" });
    expect((await hw.store.get(ORG_A, hook.hookId))!.disabled).toBe(false);
  });

  it("reads a record that is not what this code wrote as no hook", async () => {
    const { v, hw } = world();
    const hook = hookOf(await v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 }));
    const stored = hw.db.get(hookKey(ORG_A, hook.hookId))!;
    for (const broken of [{ source: "github" }, { tenant: OTHER_TENANT.organizationId }, { status: "on" }, { auth: "none" }, { hasSecret: "yes" }, { orgId: ORG_B }, { hookId: `hk_${"r".repeat(26)}` }]) {
      hw.db.set({ ...stored, ...broken });
      expect(await hw.store.record(ORG_A, hook.hookId), JSON.stringify(broken)).toBeUndefined();
    }
  });
});

describe("closing an org", () => {
  it("turns its hooks off, takes their lookups away and schedules their secrets' deletion, and leaves another org's hooks alone; run again it finishes the same", async () => {
    const { v, hw } = world();
    const mine = [hookOf(await v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 })), hookOf(await v.agentCall(DANA, "POST", BASE, { source: "datadog", tenant: DATADOG }))];
    const theirs = await hw.hook({ orgId: ORG_B, hookId: `hk_${"b".repeat(26)}`, project: "web" });
    await clearOrgHooks({ store: hw.store, secrets: hw.secrets }, ORG_A);
    for (const hook of mine) {
      expect(await hw.store.record(ORG_A, hook.hookId)).toMatchObject({ status: "disabled" });
      expect(hw.db.get(hookLookupKey(hook.hookId))).toBeUndefined();
      expect(hw.secrets.deleted).toContain(`${ORG_A}|${hook.hookId}`);
      expect((await hw.receive(hw.delivery({ source: hook.source as "linear", hookId: hook.hookId }, body(hw, "x")))).status).toBe(403);
    }
    expect(await hw.store.record(ORG_B, theirs.hookId)).toMatchObject({ status: "active" });
    expect(hw.db.get(hookLookupKey(theirs.hookId))).toMatchObject({ orgId: ORG_B });
    expect(hw.secrets.deleted).not.toContain(`${ORG_B}|${theirs.hookId}`);
    await clearOrgHooks({ store: hw.store, secrets: hw.secrets }, ORG_A);
    expect(hw.secrets.deleted.filter((entry) => entry.startsWith(ORG_A))).toHaveLength(4);
    expect(new HookStore({ documentClient: hw.db, tableName: "T", now: () => 0 })).toBeDefined();
    expect(FakeHookSecrets).toBeDefined();
  });

  it("does not take another org's lookup when an id is shared by mistake", async () => {
    const { hw } = world();
    const theirs = await hw.hook({ orgId: ORG_B, hookId: `hk_${"b".repeat(26)}`, project: "web" });
    await hw.store.disable(ORG_A, theirs.hookId);
    expect(hw.db.get(hookLookupKey(theirs.hookId))).toMatchObject({ orgId: ORG_B });
    expect(await hw.store.record(ORG_B, theirs.hookId)).toMatchObject({ status: "active" });
  });
});


describe("a hook belongs to its project", () => {
  it("lists only the project's hooks, and finds a hook of another project neither to rotate nor to delete", async () => {
    const { v, hw } = world();
    v.projectMembers.addProject(ORG_A, "api");
    const mine = hookOf(await v.agentCall(DANA, "POST", BASE, { source: "linear", tenant: LINEAR_TENANT, secret: SECRET_1 }));
    const other = await hw.hook({ hookId: `hk_${"o".repeat(26)}`, project: "api" });
    const listed = (await v.agentCall(DANA, "GET", BASE)).body["hooks"] as Array<{ hookId: string }>;
    expect(listed.map((hook) => hook.hookId)).toEqual([mine.hookId]);
    expect((await v.agentCall(DANA, "GET", "/v1/app/projects/api/event-hooks")).body["hooks"] as unknown[]).toHaveLength(1);
    expect((await v.agentCall(DANA, "DELETE", `${BASE}/${other.hookId}`, {})).status).toBe(404);
    expect((await v.agentCall(DANA, "POST", `${BASE}/${other.hookId}/rotate`, { secret: SECRET_2 })).status).toBe(404);
    expect(await hw.store.record(ORG_A, other.hookId)).toMatchObject({ status: "active" });
  });

  it("deletes a hook only after turning it off, and a rotation records only for a hook that is on", async () => {
    const { v, hw } = world();
    const hook = hookOf(await v.agentCall(DANA, "POST", BASE, { source: "datadog", tenant: DATADOG }));
    await hw.store.disable(ORG_A, hook.hookId);
    await hw.store.noteRotation(ORG_A, hook.hookId, rid(), "2026-10-22T09:00:00.000Z");
    expect((await hw.store.record(ORG_A, hook.hookId))!.rotationRequestId).toBeUndefined();
    await hw.store.touch(ORG_A, hook.hookId, "2026-10-22T09:00:00.000Z");
    expect((await hw.store.record(ORG_A, hook.hookId))!.lastDeliveryAt).toBeUndefined();
  });
});
