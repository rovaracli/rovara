// The three small hunks that offer verified deliveries to the Team record taps (R5 GitHub, R6 Slack, R7 hooks). Each tap is optional and
// can never change how the delivery is answered.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubWebhookRefusal, RECORD_TAP_BUDGET_MS as GITHUB_BUDGET, handleGithubWebhook } from "../../packages/broker/src/aws/github-webhooks.js";
import { createSlackIngressHandler, RECORD_REMOVAL_BUDGET_MS, RECORD_TAP_BUDGET_MS } from "../../packages/broker/src/aws/slack-ingress.js";
import { HOOK_RECORD_TAP_BUDGET_MS } from "../../packages/broker/src/triggers/ingress.js";
import { createHookRecordTap } from "../../packages/broker/src/team-record/sources/ticket-webhooks.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { LINEAR_TENANT, setupHookWorld } from "../support/hook-fixtures.js";
import { TEST_ORG } from "../support/orgs.js";

const GH_SECRET = "whsec-record";
const ghSign = (raw: string) => `sha256=${createHmac("sha256", GH_SECRET).update(raw).digest("hex")}`;

afterEach(() => { vi.useRealTimers(); });

describe("GitHub webhook: record tap", () => {
  const deliver = (eventName: string, payload: object, recordTap?: Parameters<typeof handleGithubWebhook>[0]["recordTap"]) => {
    const raw = JSON.stringify(payload);
    return handleGithubWebhook({
      documentClient: new FakeDynamoDb(), tableName: "T", rawBody: raw, secret: GH_SECRET, now: () => "2026-10-30T10:00:00.000Z",
      headers: { "x-hub-signature-256": ghSign(raw), "x-github-delivery": "6a0b3c52-0000-4000-8000-000000000001", "x-github-event": eventName },
      authorizeRepository: async () => false, process: async () => undefined,
      ...(recordTap === undefined ? {} : { recordTap }),
    });
  };

  it("offers a verified delivery that the task path does not follow, and still refuses it as before", async () => {
    const seen: unknown[] = [];
    await expect(deliver("push", { ref: "refs/heads/main" }, async (verified) => { seen.push(verified); })).rejects.toBeInstanceOf(GithubWebhookRefusal);
    expect(seen).toEqual([{ eventName: "push", deliveryId: "6a0b3c52-0000-4000-8000-000000000001", payload: { ref: "refs/heads/main" } }]);
  });

  it("offers nothing for a bad signature, and a tap that fails changes nothing", async () => {
    const seen: unknown[] = [];
    const raw = JSON.stringify({ ref: "x" });
    await expect(handleGithubWebhook({
      documentClient: new FakeDynamoDb(), tableName: "T", rawBody: raw, secret: GH_SECRET, now: () => "2026-10-30T10:00:00.000Z",
      headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}`, "x-github-delivery": "6a0b3c52-0000-4000-8000-000000000001", "x-github-event": "push" },
      authorizeRepository: async () => false, process: async () => undefined, recordTap: async (verified) => { seen.push(verified); },
    })).rejects.toThrow(/signature/);
    expect(seen).toEqual([]);
    const failing = deliver("push", { ref: "refs/heads/main" }, async () => { throw new Error("record down"); });
    await expect(failing).rejects.toBeInstanceOf(GithubWebhookRefusal);
    await expect(failing).rejects.not.toThrow(/record down/);
  });
});

describe("GitHub webhook: record tap budget", () => {
  it("a tap that never answers holds the delivery for the budget at most, then the delivery goes on as before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const raw = JSON.stringify({ ref: "refs/heads/main" });
    let settled = false;
    const outcome = handleGithubWebhook({
      documentClient: new FakeDynamoDb(), tableName: "T", rawBody: raw, secret: GH_SECRET, now: () => "2026-10-30T10:00:00.000Z",
      headers: { "x-hub-signature-256": ghSign(raw), "x-github-delivery": "6a0b3c52-0000-4000-8000-000000000001", "x-github-event": "push" },
      authorizeRepository: async () => false, process: async () => undefined, recordTap: () => new Promise(() => undefined),
    }).then(() => "answered", () => "refused").finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(GITHUB_BUDGET - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toBe("refused");
  });
});

describe("Slack ingress: record tap", () => {
  const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
  const nowSeconds = 1_758_657_600;
  function handler(recordTap?: (payload: unknown) => Promise<unknown>) {
    const logs: string[] = [];
    const handle = createSlackIngressHandler({
      secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
      resolveOrg: async () => TEST_ORG,
      getBinding: async () => undefined,
      claimEvent: async () => true, releaseEvent: async () => undefined, changePending: async () => 1, enqueue: async () => undefined, postMessage: async () => undefined,
      now: () => nowSeconds * 1000, log: (event) => logs.push(event),
      ...(recordTap === undefined ? {} : { recordTap }),
    });
    const send = (payload: unknown) => {
      const body = JSON.stringify(payload);
      const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${String(nowSeconds)}:${body}`).digest("hex")}`;
      return handle({ body, headers: { "x-slack-request-timestamp": String(nowSeconds), "x-slack-signature": signature }, isBase64Encoded: false });
    };
    return { send, logs };
  }
  const plain = { type: "event_callback", team_id: "T0TEAM00001", event_id: "Ev1", event: { type: "message", channel: "C0123456789", user: "U0ALICE0001", text: "hello", ts: "1758657600.000200" } };

  it("offers every signed event callback, even one the ingress then ignores, and the answer is unchanged", async () => {
    const seen: unknown[] = [];
    const without = await handler().send(plain);
    const { send } = handler(async (payload) => { seen.push(payload); });
    const withTap = await send(plain);
    expect(seen).toEqual([plain]);
    expect(withTap).toEqual(without);
    expect(withTap.statusCode).toBe(200);
  });

  it("runs alongside the mention path, never before it: a tap that waits for the mention path to start still finishes inside its budget", async () => {
    let mentionPathStarted!: () => void;
    const started = new Promise<void>((resolve) => { mentionPathStarted = resolve; });
    const logs: string[] = [];
    const handle = createSlackIngressHandler({
      secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
      // The mention path reaches resolveOrg only after the tap was started; a tap that was awaited first could never see it.
      resolveOrg: async () => { mentionPathStarted(); return TEST_ORG; },
      getBinding: async () => undefined, claimEvent: async () => true, releaseEvent: async () => undefined, changePending: async () => 1, enqueue: async () => undefined, postMessage: async () => undefined,
      now: () => nowSeconds * 1000, log: (event) => logs.push(event),
      recordTap: async () => { await started; },
    });
    const body = JSON.stringify({ type: "event_callback", team_id: "T0TEAM00001", event_id: "Ev9", event: { type: "app_mention", channel: "C0123456789", user: "U0ALICE0001", text: "<@U0BOT000001> hi", ts: "1758657600.000200" } });
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${String(nowSeconds)}:${body}`).digest("hex")}`;
    const response = await handle({ body, headers: { "x-slack-request-timestamp": String(nowSeconds), "x-slack-signature": signature }, isBase64Encoded: false });
    expect(response.statusCode).toBe(200);
    expect(logs).not.toContain("record.tap_slow");
  });

  it("is not offered a request with a bad signature or a url verification", async () => {
    const seen: unknown[] = [];
    const { send } = handler(async (payload) => { seen.push(payload); });
    await send({ type: "url_verification", challenge: "abc" });
    expect(seen).toEqual([]);
  });

  it("a tap that throws, or never answers, does not change the answer or hold the ingress past its budget", async () => {
    const failing = handler(async () => { throw new Error("record down"); });
    expect((await failing.send(plain)).statusCode).toBe(200);
    expect(failing.logs).toContain("record.tap_failed");
    const slow = handler(() => new Promise(() => undefined));
    const started = Date.now();
    expect((await slow.send(plain)).statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(RECORD_TAP_BUDGET_MS + 1_500);
    expect(slow.logs).toContain("record.tap_slow");
  });
});

describe("Slack ingress: a removal is never lost to the tap's budget or failure", () => {
  const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
  const nowSeconds = 1_758_657_600;
  const deleted = { type: "event_callback", team_id: "T0TEAM00001", event_id: "Ev2", event: { type: "message", subtype: "message_deleted", channel: "C0123456789", deleted_ts: "1758657600.000200", ts: "1758657700.000200" } };
  const plain = { type: "event_callback", team_id: "T0TEAM00001", event_id: "Ev1", event: { type: "message", channel: "C0123456789", user: "U0ALICE0001", text: "hello", ts: "1758657600.000200" } };
  function send(recordTap: (payload: unknown) => Promise<unknown>, payload: unknown) {
    const logs: string[] = [];
    const handle = createSlackIngressHandler({
      secrets: async () => ({ signingSecret, botToken: "xoxb-test" }), resolveOrg: async () => TEST_ORG, getBinding: async () => undefined,
      claimEvent: async () => true, releaseEvent: async () => undefined, changePending: async () => 1, enqueue: async () => undefined, postMessage: async () => undefined,
      now: () => nowSeconds * 1000, log: (event) => logs.push(event), recordTap,
    });
    const body = JSON.stringify(payload);
    const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${String(nowSeconds)}:${body}`).digest("hex")}`;
    return handle({ body, headers: { "x-slack-request-timestamp": String(nowSeconds), "x-slack-signature": signature }, isBase64Encoded: false }).then((response) => ({ response, logs }));
  }

  it("a removal whose tap fails is answered 500 so Slack sends it again; the same failure on any other event stays a 200", async () => {
    const lost = await send(async () => { throw new Error("queue and invoke down"); }, deleted);
    expect(lost.response.statusCode).toBe(500);
    expect(lost.logs).toContain("record.removal_failed");
    expect((await send(async () => { throw new Error("record down"); }, plain)).response.statusCode).toBe(200);
  });

  it("a removal gets the longer budget (a fallback may need it); one that is still not done by then is answered 500, and the event is not logged as slow", async () => {
    expect(RECORD_REMOVAL_BUDGET_MS).toBeGreaterThan(RECORD_TAP_BUDGET_MS);
    const patient = await send(() => new Promise<void>((resolve) => setTimeout(resolve, RECORD_TAP_BUDGET_MS + 200)), deleted);
    expect(patient.response.statusCode).toBe(200);
    expect(patient.logs).not.toContain("record.tap_slow");
    const stuck = await send(() => new Promise(() => undefined), deleted);
    expect(stuck.response.statusCode).toBe(500);
    expect(stuck.logs).toContain("record.removal_failed");
  }, 10_000);
});

describe("hook ingress: record tap", () => {
  const body = (tenant: unknown) => ({ id: "evt-1", tenant });

  it("offers a verified body after the tenant check, with the hook and its org; a mismatched tenant is not offered", async () => {
    const world = setupHookWorld();
    const seen: Array<{ orgId: string; hook: { hookId: string; source: string; project: string }; body: unknown }> = [];
    world.deps.recordTap = async (input) => { seen.push(input); };
    const hook = await world.hook({ source: "linear" });
    const good = await world.receive(world.delivery(hook, body(LINEAR_TENANT)));
    expect(good.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ orgId: hook.orgId, hook: { hookId: hook.hookId, source: "linear", project: "web" }, body: { id: "evt-1" } });
    const wrong = await world.receive(world.delivery(hook, body({ organizationId: "other", teamId: "x" })));
    expect(wrong.status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  it("a tap that never answers holds the answer for the budget at most, and the dispatch still happens", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const world = setupHookWorld();
    world.deps.recordTap = () => new Promise(() => undefined);
    const hook = await world.hook({ source: "linear" });
    const answered = world.receive(world.delivery(hook, body(LINEAR_TENANT)));
    await vi.advanceTimersByTimeAsync(HOOK_RECORD_TAP_BUDGET_MS + 100);
    expect((await answered).status).toBe(202);
    expect(world.dispatched).toHaveLength(1);
  });

  it("TRW-4 S2: a tap that fails AFTER the budget (a removal no path could take) is caught and logged: the answer stands, and nothing is left unhandled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const world = setupHookWorld();
      world.deps.recordTap = () => new Promise((_resolve, reject) => { setTimeout(() => reject(Object.assign(new Error("not accepted"), { name: "RecordRemovalNotAccepted" })), HOOK_RECORD_TAP_BUDGET_MS + 500); });
      const hook = await world.hook({ source: "linear" });
      const answered = world.receive(world.delivery(hook, body(LINEAR_TENANT)));
      await vi.advanceTimersByTimeAsync(HOOK_RECORD_TAP_BUDGET_MS + 100);
      expect((await answered).status).toBe(202);
      await vi.advanceTimersByTimeAsync(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(world.logs.map((entry) => entry.event)).toContain("hook.record_tap_late_failure");
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a failing tap leaves the answer and the dispatch as they were", async () => {
    const world = setupHookWorld();
    world.deps.recordTap = async () => { throw new Error("record down"); };
    const hook = await world.hook({ source: "linear" });
    const answer = await world.receive(world.delivery(hook, body(LINEAR_TENANT)));
    expect(answer.status).toBe(202);
    expect(world.dispatched).toHaveLength(1);
    expect(world.logs.map((entry) => entry.event)).toContain("hook.record_tap_failed");
  });

  it("TRW-5 S2: a delete the record could not take at all is answered 503 with nothing sent on, so Linear or Jira sends it again; any other tap failure still leaves the answer alone", async () => {
    const world = setupHookWorld();
    world.deps.recordTap = async () => { throw Object.assign(new Error("not accepted"), { name: "RecordRemovalNotAccepted" }); };
    const hook = await world.hook({ source: "linear" });
    const answer = await world.receive(world.delivery(hook, body(LINEAR_TENANT)));
    expect(answer.status).toBe(503);
    expect(world.dispatched).toHaveLength(0);
  });

  it("TRW-5 S2: the adapter throws RecordRemovalNotAccepted when the recorder cannot take a delete, and swallows a failed record", async () => {
    const removalDown = createHookRecordTap({ recorder: { record: async () => "stored", remove: async () => { throw new Error("table, queue and invoke down"); } } });
    const linearRemove = { type: "Issue", action: "remove", organizationId: LINEAR_TENANT.organizationId, data: { id: "i1", teamId: LINEAR_TENANT.teamId } };
    await expect(removalDown({ orgId: "org-1", hook: { source: "linear", project: "web", tenant: LINEAR_TENANT }, body: linearRemove })).rejects.toMatchObject({ name: "RecordRemovalNotAccepted" });
    const recordDown = createHookRecordTap({ recorder: { record: async () => { throw new Error("down"); }, remove: async () => undefined } });
    const linearCreate = { type: "Issue", action: "create", organizationId: LINEAR_TENANT.organizationId, data: { id: "i1", teamId: LINEAR_TENANT.teamId, title: "t" } };
    await expect(recordDown({ orgId: "org-1", hook: { source: "linear", project: "web", tenant: LINEAR_TENANT }, body: linearCreate })).resolves.toBeUndefined();
  });

  it("the adapter passes only Linear and Jira hooks on, with their own tenant", async () => {
    const calls: unknown[] = [];
    const adapter = createHookRecordTap({ recorder: { record: async (context, item) => { calls.push({ context, id: item.id }); return "stored"; }, remove: async () => undefined } });
    const linearBody = { type: "Issue", action: "create", organizationId: LINEAR_TENANT.organizationId, webhookTimestamp: 1_761_800_000_000, data: { id: "i1", teamId: LINEAR_TENANT.teamId, title: "t" } };
    await adapter({ orgId: "org-1", hook: { source: "linear", project: "web", tenant: LINEAR_TENANT }, body: linearBody });
    await adapter({ orgId: "org-1", hook: { source: "sentry", project: "web", tenant: {} }, body: linearBody });
    expect(calls).toEqual([{ context: { workspaceId: "org-1", project: "web" }, id: "issue:i1" }]);
  });
});
