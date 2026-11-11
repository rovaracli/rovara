// Plan 4 Task 19: the public endpoint vendors post events to. Security is the point: a forged request is refused with one answer, writes nothing and costs no AWS call beyond
// what the plan allows; a replayed body is a duplicate or too old; the sender can't choose the project or the hook; nothing secret reaches a log.
import { describe, expect, it } from "vitest";
import { HOOK_BODY_MAX_BYTES, HOOK_FAILED_VERIFY_PER_MINUTE, HOOK_MAX_DELIVERIES_PER_MINUTE, HOOK_MAX_EVENTS_PER_DELIVERY, HOOK_PRE_VERIFY_PER_IP_PER_MINUTE } from "@rovara-code/contracts";
import { hookEventKey, hookRateKey } from "@rovara-code/contracts";
import { WindowCounter } from "../../packages/broker/src/triggers/ingress.js";
import { HOOK_2, HOOK_OTHER_ORG, LINEAR_TENANT, ORG_A, ORG_B, OTHER_TENANT, SECRET_1, SECRET_2, iso, setupHookWorld, type HookWorld, type TestBody } from "../support/hook-fixtures.js";

const FORBIDDEN = { error: { code: "FORBIDDEN", message: "signature check failed" } };
const BAD_BODY = { error: { code: "BAD_REQUEST", message: "the delivery body can't be read" } };
const HOUR = 3_600_000;
const SECOND = 1000;
const T0 = Date.parse("2026-10-22T09:00:00.000Z");
/** A body for the linear hook, dated at the world's clock so that its age is nothing. */
const bodyOf = (w: HookWorld, id: string, over: Partial<TestBody> = {}): TestBody => ({ id, tenant: LINEAR_TENANT, occurredAt: iso(w.clock.now), ...over });

async function linear(over: Parameters<HookWorld["hook"]>[0] = {}) {
  const w = setupHookWorld();
  const hook = await w.hook(over);
  return { w, hook };
}

describe("a forged request writes nothing and is refused with one answer", () => {
  it("answers 403 with the uniform body and makes no write for no signature, another hook's secret and a body changed by one byte", async () => {
    const { w, hook } = await linear();
    await w.hook({ hookId: HOOK_2, secret: SECRET_2 });
    const body = bodyOf(w, "e1");
    const tampered = w.delivery(hook, body);
    tampered.raw = Buffer.concat([tampered.raw.subarray(0, tampered.raw.length - 1), Buffer.from(" ")]);
    const cases = { "no signature": w.delivery(hook, body, { secret: null }), "another hook's secret": w.delivery(hook, body, { secret: SECRET_2 }), "a body changed by one byte": tampered };
    for (const [name, delivery] of Object.entries(cases)) {
      const mark = w.db.commandNames().length;
      const reply = await w.receive(delivery);
      expect(reply, name).toEqual({ status: 403, body: FORBIDDEN });
      expect(w.writesSince(mark), name).toEqual([]);
    }
    expect(w.dispatched).toEqual([]);
    expect(w.db.find((item) => String(item["pk"]).includes("HOOK_RATE#") || String(item["pk"]).includes("HOOK_EVENT#"))).toEqual([]);
  });

  it("answers an unknown hook, a disabled hook and a hook of another source with the same 403", async () => {
    const { w, hook } = await linear();
    const sentry = await w.hook({ hookId: HOOK_2, source: "sentry", secret: SECRET_1 });
    const off = await w.hook({ hookId: `hk_${"3".repeat(26)}` });
    await w.store.disable(ORG_A, off.hookId);
    const body = bodyOf(w, "e1");
    const answers = [
      await w.receive(w.delivery({ source: "linear", hookId: `hk_${"4".repeat(26)}` }, body)),
      await w.receive(w.delivery(off, body)),
      // Signed with the sentry hook's own secret and naming its own tenant: only the path's source gives it away.
      await w.receive(w.delivery({ source: "linear", hookId: sentry.hookId }, { ...body, tenant: sentry.tenant })),
      await w.receive(w.delivery({ source: "linear", hookId: "not-a-hook" }, body)),
      await w.receive(w.delivery({ source: "github", hookId: hook.hookId }, body)),
      await w.receive(w.delivery({ source: "pagerduty", hookId: hook.hookId }, body)),
    ];
    for (const answer of answers) expect(answer).toEqual({ status: 403, body: FORBIDDEN });
    expect(w.dispatched).toEqual([]);
  });

  it("answers 403 for a lookup with no record behind it, a hook with no provider and a hook whose provider checks another way", async () => {
    const w = setupHookWorld();
    const hook = await w.hook();
    // A lookup that names an org whose record is not this hook's.
    w.db.set({ pk: `HOOK#${HOOK_OTHER_ORG}`, sk: "ORG", orgId: ORG_B });
    expect(await w.receive(w.delivery({ source: "linear", hookId: HOOK_OTHER_ORG }, bodyOf(w, "e1")))).toEqual({ status: 403, body: FORBIDDEN });
    const noProvider = await w.hook({ hookId: HOOK_2, source: "pagerduty", tenant: { subdomain: "acme" } as never });
    expect(await w.receive(w.delivery(noProvider, bodyOf(w, "e1")))).toEqual({ status: 403, body: FORBIDDEN });
    const wrongWay = await w.hook({ hookId: `hk_${"5".repeat(26)}`, auth: "token" });
    expect(await w.receive(w.delivery(wrongWay, bodyOf(w, "e1")))).toEqual({ status: 403, body: FORBIDDEN });
    const sns = await w.hook({ hookId: `hk_${"6".repeat(26)}`, source: "sentry", auth: "sns", hasSecret: false });
    expect(await w.receive(w.delivery(sns, bodyOf(w, "e1")))).toEqual({ status: 403, body: FORBIDDEN });
    expect((await w.receive(w.delivery(hook, bodyOf(w, "e1")))).status).toBe(202);
  });
});

describe("forged traffic is bounded and never uses a real delivery's allowance", () => {
  it("reads the secret once for 50 forged requests in a minute, and after the gate trips answers 403 with no read at all", async () => {
    const { w, hook } = await linear();
    for (let index = 0; index < 50; index += 1) expect((await w.receive(w.delivery(hook, bodyOf(w, `f${String(index)}`), { secret: SECRET_2 }))).status).toBe(403);
    expect(w.secrets.reads).toBe(1);
    // The cached copy is now older than the re-read age and the gate is tripped (50 failures): no read, whatever the age.
    w.clock.now += 40 * SECOND;
    const before = w.secrets.reads;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "late"), { secret: SECRET_2 }))).status).toBe(403);
    expect(w.secrets.reads).toBe(before);
  });

  it("answers a validly signed delivery 202 after 100 forged ones in the same minute, checked against the cached secret with no read", async () => {
    const { w, hook } = await linear();
    for (let index = 0; index < 100; index += 1) await w.receive(w.delivery(hook, bodyOf(w, `f${String(index)}`), { secret: SECRET_2 }));
    const reads = w.secrets.reads;
    const real = await w.receive(w.delivery(hook, bodyOf(w, "real")));
    expect(real.status).toBe(202);
    expect(w.secrets.reads).toBe(reads);
    expect(w.dispatched).toHaveLength(1);
  });

  it("makes no read for a hook with no cached secret while the gate is tripped and forged traffic goes on, and finds the secret when the minute is over", async () => {
    const w = setupHookWorld();
    const hook = await w.hook({ secret: null });
    // No secret exists: every forged request reads (nothing is cached) until the gate trips at the 30th failure.
    for (let index = 0; index < HOOK_FAILED_VERIFY_PER_MINUTE; index += 1) expect((await w.receive(w.delivery(hook, bodyOf(w, `f${String(index)}`)))).status).toBe(403);
    expect(w.secrets.reads).toBe(HOOK_FAILED_VERIFY_PER_MINUTE);
    // The secret appears. Tripped, with the last read just now, a request reads nothing and (with nothing cached) is refused.
    w.secrets.values.set(`${ORG_A}|${hook.hookId}`, JSON.stringify({ current: SECRET_1 }));
    expect((await w.receive(w.delivery(hook, bodyOf(w, "a")))).status).toBe(403);
    for (let second = 5; second < 60; second += 5) {
      w.clock.now = T0 + second * SECOND;
      expect((await w.receive(w.delivery(hook, bodyOf(w, `s${String(second)}`), { secret: SECRET_2 }))).status).toBe(403);
      expect(w.secrets.reads, `at ${String(second)} seconds`).toBe(HOOK_FAILED_VERIFY_PER_MINUTE);
    }
    // A minute after the trip the secret is read, and a real delivery is checked against it.
    w.clock.now = T0 + 61 * SECOND;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "real")))).status).toBe(202);
    expect(w.secrets.reads).toBe(HOOK_FAILED_VERIFY_PER_MINUTE + 1);
  });

  it("picks up a rotated secret with one re-read once the cached copy is 30 seconds old, and not before", async () => {
    const { w, hook } = await linear();
    expect((await w.receive(w.delivery(hook, bodyOf(w, "first")))).status).toBe(202);
    w.secrets.values.set(`${ORG_A}|${hook.hookId}`, JSON.stringify({ current: SECRET_2 }));
    expect((await w.receive(w.delivery(hook, bodyOf(w, "early"), { secret: SECRET_2 }))).status).toBe(403);
    expect(w.secrets.reads).toBe(1);
    w.clock.now += 31 * SECOND;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "later"), { secret: SECRET_2 }))).status).toBe(202);
    expect(w.secrets.reads).toBe(2);
    // The old secret is gone with the rotation that had no overlap.
    expect((await w.receive(w.delivery(hook, bodyOf(w, "old"), { secret: SECRET_1 }))).status).toBe(403);
  });

  it("does not let 200 forged requests use up the allowance a real delivery needs", async () => {
    const { w, hook } = await linear();
    for (let index = 0; index < 200; index += 1) await w.receive(w.delivery(hook, bodyOf(w, `f${String(index)}`), { secret: SECRET_2 }));
    expect(w.db.find((item) => String(item["pk"]).includes("HOOK_RATE#"))).toEqual([]);
    expect((await w.receive(w.delivery(hook, bodyOf(w, "real")))).status).toBe(202);
  });

  it("answers 429 to a source address over its minute's requests with no DynamoDB or secret call, and forgets it a minute later", async () => {
    const { w, hook } = await linear();
    for (let index = 0; index < HOOK_PRE_VERIFY_PER_IP_PER_MINUTE; index += 1) await w.receive(w.delivery({ source: "linear", hookId: `hk_${"7".repeat(26)}` }, bodyOf(w, "x"), { ip: "198.51.100.1" }));
    const mark = w.db.commandNames().length;
    const reads = w.secrets.reads;
    const over = await w.receive(w.delivery(hook, bodyOf(w, "e1"), { ip: "198.51.100.1" }));
    expect(over.status).toBe(429);
    expect(w.commandsSince(mark)).toEqual([]);
    expect(w.secrets.reads).toBe(reads);
    // Another address is not held up, and the first one is let in again when its minute is over.
    expect((await w.receive(w.delivery(hook, bodyOf(w, "e2"), { ip: "198.51.100.2" }))).status).toBe(202);
    w.clock.now += 61 * SECOND;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "e3"), { ip: "198.51.100.1" }))).status).toBe(202);
  });

  it("keeps the in-memory counters to a window of a minute and to a bounded number of keys", () => {
    const counter = new WindowCounter(3);
    expect(counter.hit("a", 0)).toBe(1);
    expect(counter.hit("a", 30_000)).toBe(2);
    expect(counter.count("a", 59_000)).toBe(2);
    expect(counter.count("a", 61_000)).toBe(1);
    expect(counter.count("a", 91_000)).toBe(0);
  });

  it("forgets a hit when its second leaves the window exactly a minute later, and holds at most its number of keys, the oldest going first", () => {
    const counter = new WindowCounter(3);
    counter.hit("a", 0);
    expect(counter.count("a", 59_999)).toBe(1);
    expect(counter.count("a", 60_000)).toBe(0);
    counter.hit("a", 0); counter.hit("b", 0); counter.hit("c", 0);
    counter.hit("d", 0);
    expect([counter.count("a", 0), counter.count("b", 0), counter.count("c", 0), counter.count("d", 0)]).toEqual([0, 1, 1, 1]);
  });

  it("answers 413 for a body over the limit before any read or count", async () => {
    const { w, hook } = await linear();
    const mark = w.db.commandNames().length;
    const reply = await w.receive(w.delivery(hook, "x", { raw: Buffer.alloc(HOOK_BODY_MAX_BYTES + 1, 0x61) }));
    expect(reply.status).toBe(413);
    expect(w.commandsSince(mark)).toEqual([]);
    expect(w.secrets.reads).toBe(0);
    // Exactly at the limit is read as any body: it fails its signature, not its size.
    expect((await w.receive(w.delivery(hook, "x", { raw: Buffer.alloc(HOOK_BODY_MAX_BYTES, 0x61), secret: SECRET_2 }))).status).toBe(403);
  });
});

describe("replay and the window of time", () => {
  it("starts a signed body once: 202, then 200 DUPLICATE with one dispatch", async () => {
    const { w, hook } = await linear();
    const delivery = w.delivery(hook, bodyOf(w, "e1"));
    expect(await w.receive(delivery)).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 1 } });
    expect(await w.receive(delivery)).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]!.event).toMatchObject({ eventKey: "test:e1", hookId: hook.hookId });
  });

  it("skips an event whose own time is more than 24 hours old, and a signed body replayed after a day is too old even though its de-duplication item is still there", async () => {
    const { w, hook } = await linear();
    const old = await w.receive(w.delivery(hook, bodyOf(w, "old", { occurredAt: iso(w.clock.now - 25 * HOUR) })));
    expect(old.status).toBe(202);
    expect(w.dispatched).toEqual([]);
    expect(w.logs.map((entry) => entry.event)).toContain("hook.stale");
    expect(w.db.find((item) => String(item["pk"]).includes("HOOK_EVENT#"))).toEqual([]);
    const fresh = w.delivery(hook, bodyOf(w, "e1"));
    expect((await w.receive(fresh)).status).toBe(202);
    w.clock.now += 23 * HOUR;
    expect(await w.receive(fresh)).toEqual({ status: 200, body: { delivery: "DUPLICATE" } });
    w.clock.now += 2 * HOUR;
    expect((await w.receive(fresh)).status).toBe(202);
    expect(w.dispatched).toHaveLength(1);
  });

  it("skips an event dated ahead of the clock by more than its slack, which would outlive its de-duplication item and be replayable", async () => {
    const { w, hook } = await linear();
    expect((await w.receive(w.delivery(hook, bodyOf(w, "ahead", { occurredAt: iso(w.clock.now + 6 * 60_000) })))).status).toBe(202);
    expect(w.dispatched).toEqual([]);
    expect(w.logs.map((entry) => entry.event)).toContain("hook.future");
    expect((await w.receive(w.delivery(hook, bodyOf(w, "near", { occurredAt: iso(w.clock.now + 4 * 60_000) })))).status).toBe(202);
    expect(w.dispatched).toHaveLength(1);
  });

  it("keeps the de-duplication item for 72 hours and writes it under the hook's own org and id", async () => {
    const { w, hook } = await linear();
    await w.receive(w.delivery(hook, bodyOf(w, "e1")));
    const item = w.db.get(hookEventKey(ORG_A, hook.hookId, "test:e1"))!;
    expect(item).toBeDefined();
    expect(item["indexExpiresAt"]).toBe(Math.floor(w.clock.now / 1000) + 72 * 3600);
    expect(w.db.get(hookEventKey(ORG_A, HOOK_2, "test:e1"))).toBeUndefined();
    expect(w.db.get(hookEventKey(ORG_B, hook.hookId, "test:e1"))).toBeUndefined();
  });

  it("starts the events of one delivery once each, and counts a repeat inside the delivery as a duplicate", async () => {
    const { w, hook } = await linear();
    const reply = await w.receive(w.delivery(hook, bodyOf(w, "g", { events: [{ id: "a" }, { id: "b" }, { id: "a" }] })));
    expect(reply).toEqual({ status: 202, body: { delivery: "ACCEPTED", events: 2 } });
    expect(w.dispatched.map((entry) => entry.event.eventKey)).toEqual(["test:a", "test:b"]);
  });

  it("starts at most HOOK_MAX_EVENTS_PER_DELIVERY events of one delivery and says so in the log", async () => {
    const { w, hook } = await linear();
    const events = Array.from({ length: HOOK_MAX_EVENTS_PER_DELIVERY + 10 }, (_, index) => ({ id: `n${String(index)}` }));
    expect((await w.receive(w.delivery(hook, bodyOf(w, "g", { events })))).status).toBe(202);
    expect(w.dispatched).toHaveLength(HOOK_MAX_EVENTS_PER_DELIVERY);
    expect(w.logs.find((entry) => entry.event === "hook.too_many_events")).toMatchObject({ fields: { hookId: hook.hookId, events: HOOK_MAX_EVENTS_PER_DELIVERY + 10 } });
  });

  it("forgets what it recorded for an event it could not start, answers 503, and starts it when the vendor sends it again", async () => {
    const { w, hook } = await linear();
    const delivery = w.delivery(hook, bodyOf(w, "g", { events: [{ id: "a" }, { id: "b" }] }));
    w.dispatchFails.error = new Error("the broker could not start it");
    expect(await w.receive(delivery)).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "try again" } } });
    expect(w.db.find((item) => String(item["pk"]).includes("HOOK_EVENT#"))).toEqual([]);
    w.dispatchFails.error = undefined;
    expect((await w.receive(delivery)).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.eventKey)).toEqual(["test:a", "test:b"]);
  });

  it("keeps what was started when a later event fails, so the retry does not start it twice", async () => {
    const { w, hook } = await linear();
    const delivery = w.delivery(hook, bodyOf(w, "g", { events: [{ id: "a" }, { id: "b" }] }));
    let calls = 0;
    const original = w.deps.dispatch.bind(w.deps);
    w.deps.dispatch = async (orgId, event) => {
      calls += 1;
      if (calls === 2) throw new Error("second fails");
      return original(orgId, event);
    };
    expect((await w.receive(delivery)).status).toBe(503);
    w.deps.dispatch = original;
    expect((await w.receive(delivery)).status).toBe(202);
    expect(w.dispatched.map((entry) => entry.event.eventKey)).toEqual(["test:a", "test:b"]);
  });
});

describe("the verified delivery's own allowance", () => {
  it("answers the 121st verified delivery to one hook in a minute with 429, dispatches nothing for it, and lets the next minute in", async () => {
    const { w, hook } = await linear();
    for (let index = 0; index < HOOK_MAX_DELIVERIES_PER_MINUTE; index += 1) expect((await w.receive(w.delivery(hook, bodyOf(w, `d${String(index)}`)))).status).toBe(202);
    expect((await w.receive(w.delivery(hook, bodyOf(w, "over")))).status).toBe(429);
    expect(w.dispatched).toHaveLength(HOOK_MAX_DELIVERIES_PER_MINUTE);
    expect(w.db.get(hookRateKey(ORG_A, hook.hookId, iso(w.clock.now).slice(0, 16)))!["count"]).toBe(HOOK_MAX_DELIVERIES_PER_MINUTE);
    expect(w.logs.map((entry) => entry.event)).toContain("hook.rate_limited");
    w.clock.now += 60 * SECOND;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "next")))).status).toBe(202);
  });

  it("gives each hook its own allowance", async () => {
    const { w, hook } = await linear();
    const second = await w.hook({ hookId: HOOK_2, secret: SECRET_2 });
    for (let index = 0; index < HOOK_MAX_DELIVERIES_PER_MINUTE; index += 1) await w.receive(w.delivery(hook, bodyOf(w, `d${String(index)}`)));
    expect((await w.receive(w.delivery(second, bodyOf(w, "other"), { secret: SECRET_2 }))).status).toBe(202);
  });
});

describe("a secret that is being rotated", () => {
  it("accepts the previous secret until its time is over, whatever the cached copy says", async () => {
    const w = setupHookWorld();
    const hook = await w.hook({ secretJson: JSON.stringify({ current: SECRET_2, previous: SECRET_1, previousValidUntil: iso(T0 + 24 * HOUR) }) });
    expect((await w.receive(w.delivery(hook, bodyOf(w, "new"), { secret: SECRET_2 }))).status).toBe(202);
    expect((await w.receive(w.delivery(hook, bodyOf(w, "old"), { secret: SECRET_1 }))).status).toBe(202);
    w.clock.now = T0 + 24 * HOUR - 1000;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "old2"), { secret: SECRET_1 }))).status).toBe(202);
    w.clock.now = T0 + 24 * HOUR;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "old3"), { secret: SECRET_1 }))).status).toBe(403);
    expect((await w.receive(w.delivery(hook, bodyOf(w, "new2"), { secret: SECRET_2 }))).status).toBe(202);
  });

  it("does not accept a previous secret that carries no end time", async () => {
    const w = setupHookWorld();
    const hook = await w.hook({ secretJson: JSON.stringify({ current: SECRET_2, previous: SECRET_1 }) });
    expect((await w.receive(w.delivery(hook, bodyOf(w, "old"), { secret: SECRET_1 }))).status).toBe(403);
  });
});

describe("what the sender may not choose", () => {
  it("refuses a body that names another tenant, another organization or none, and logs only the hook id", async () => {
    const { w, hook } = await linear();
    for (const tenant of [{ ...LINEAR_TENANT, teamId: "44444444-4444-4444-8444-444444444444" }, OTHER_TENANT, undefined]) {
      expect(await w.receive(w.delivery(hook, bodyOf(w, "e1", { tenant })))).toEqual({ status: 403, body: FORBIDDEN });
    }
    expect(w.dispatched).toEqual([]);
    const logged = w.logs.filter((entry) => entry.event === "hook.tenant_mismatch");
    expect(logged).toHaveLength(3);
    for (const entry of logged) expect(entry.fields).toEqual({ hookId: hook.hookId });
  });

  it("gives two hooks of one source and project each its own hook id on its events, and ignores the project and hook a body names", async () => {
    const { w, hook } = await linear();
    const second = await w.hook({ hookId: HOOK_2, secret: SECRET_2 });
    await w.receive(w.delivery(hook, bodyOf(w, "one", { project: "other-project", hookId: HOOK_2 })));
    await w.receive(w.delivery(second, bodyOf(w, "two", { project: "api", hookId: hook.hookId }), { secret: SECRET_2 }));
    expect(w.dispatched.map((entry) => ({ eventKey: entry.event.eventKey, hookId: entry.event.hookId, project: entry.event.project, orgId: entry.orgId }))).toEqual([
      { eventKey: "test:one", hookId: hook.hookId, project: "web", orgId: ORG_A },
      { eventKey: "test:two", hookId: HOOK_2, project: "web", orgId: ORG_A },
    ]);
  });

  it("sets the event's source from the hook, and drops an event that is not a well-formed event", async () => {
    const { w, hook } = await linear();
    const provider = w.providers.linear!;
    w.providers.linear = { ...provider, normalize: (body, headers, record) => {
      const result = provider.normalize(body, headers, record);
      return "events" in result ? { events: [...result.events.map((event) => ({ ...event, source: "github" as const })), { ...result.events[0]!, type: "no.such.type" }] } : result;
    } };
    expect((await w.receive(w.delivery(hook, bodyOf(w, "e1")))).status).toBe(202);
    expect(w.dispatched).toHaveLength(1);
    expect(w.dispatched[0]!.event.source).toBe("linear");
    expect(w.logs.map((entry) => entry.event)).toContain("hook.event_invalid");
  });

  it("answers 202 IGNORED for an event the provider ignores, and records nothing for it", async () => {
    const { w, hook } = await linear();
    expect(await w.receive(w.delivery(hook, bodyOf(w, "e1", { kind: "ignore" })))).toEqual({ status: 202, body: { delivery: "IGNORED" } });
    expect(w.dispatched).toEqual([]);
    expect(w.db.find((item) => String(item["pk"]).includes("HOOK_EVENT#"))).toEqual([]);
  });
});

describe("unreadable input fails closed", () => {
  it("answers 400 (a bad request, not an auth failure) to a validly signed body that is not UTF-8, is empty or is not JSON, and logs only the hook id and the error name", async () => {
    const { w, hook } = await linear();
    for (const raw of [Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), Buffer.alloc(0), Buffer.from("not json PAYLOAD-MARK")]) {
      expect(await w.receive(w.delivery(hook, "", { raw })), raw.toString("hex")).toEqual({ status: 400, body: BAD_BODY });
    }
    expect(w.logs).toEqual([
      { event: "hook.body_unreadable", fields: { hookId: hook.hookId, error: "TypeError" } },
      { event: "hook.body_unreadable", fields: { hookId: hook.hookId, error: "SyntaxError" } },
      { event: "hook.body_unreadable", fields: { hookId: hook.hookId, error: "SyntaxError" } },
    ]);
    expect(w.dispatched).toEqual([]);
  });

  it("still answers 403 to a validly signed body that parses but is not an object the provider can read, and 403 to an unsigned body that is not JSON", async () => {
    const { w, hook } = await linear();
    for (const raw of [Buffer.from("null"), Buffer.from("42")]) {
      expect(await w.receive(w.delivery(hook, "", { raw })), raw.toString("hex")).toEqual({ status: 403, body: FORBIDDEN });
    }
    expect(await w.receive(w.delivery(hook, "", { raw: Buffer.from("not json"), secret: SECRET_2 }))).toEqual({ status: 403, body: FORBIDDEN });
    expect(w.dispatched).toEqual([]);
  });

  it("refuses a hook whose stored secret is not the shape this code writes, and logs only the hook id", async () => {
    const w = setupHookWorld();
    for (const [index, secretJson] of ["not json", "{}", JSON.stringify({ current: "" }), JSON.stringify({ current: SECRET_1, extra: 1 }), JSON.stringify({ current: SECRET_1, previous: SECRET_2, previousValidUntil: "tomorrow" })].entries()) {
      const hook = await w.hook({ hookId: `hk_${String(index + 1).repeat(26)}`.slice(0, 29), secretJson });
      expect((await w.receive(w.delivery(hook, bodyOf(w, "e1")))).status, secretJson).toBe(403);
    }
    expect(w.logs.filter((entry) => entry.event === "hook.secret_unreadable").every((entry) => Object.keys(entry.fields).join() === "hookId")).toBe(true);
  });

  it("answers 503 and nothing else for a fault of ours, and 403 for a hook with no secret at all", async () => {
    const { w, hook } = await linear();
    w.secrets.failReads = new Error(`boom ${SECRET_1}`);
    const reply = await w.receive(w.delivery(hook, bodyOf(w, "e1")));
    expect(reply).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "try again" } } });
    expect(JSON.stringify(w.logs)).not.toContain(SECRET_1);
    const none = setupHookWorld();
    const bare = await none.hook({ secret: null });
    expect(await none.receive(none.delivery(bare, bodyOf(none, "e1")))).toEqual({ status: 403, body: FORBIDDEN });
  });
});

describe("what is kept and what is logged", () => {
  it("notes the last delivery on the hook for a verified delivery only, at most once a minute", async () => {
    const { w, hook } = await linear();
    await w.receive(w.delivery(hook, bodyOf(w, "forged"), { secret: SECRET_2 }));
    expect((await w.store.record(ORG_A, hook.hookId))!.lastDeliveryAt).toBeUndefined();
    await w.receive(w.delivery(hook, bodyOf(w, "e1")));
    const first = (await w.store.record(ORG_A, hook.hookId))!.lastDeliveryAt;
    expect(first).toBe(iso(w.clock.now));
    w.clock.now += 20 * SECOND;
    const mark = w.db.commandNames().length;
    await w.receive(w.delivery(hook, bodyOf(w, "e2")));
    expect((await w.store.record(ORG_A, hook.hookId))!.lastDeliveryAt).toBe(first);
    // The delivery's own rate count and the mark that its event was started; the hook is not touched again.
    expect(w.writesSince(mark).filter((name) => name === "UpdateCommand")).toHaveLength(2);
  });

  it("puts no secret, no body and no header value in any log line or answer, for every kind of refusal", async () => {
    const { w, hook } = await linear();
    const marker = "PAYLOAD-MARKER-31415";
    const secretLooking = "SECRET-LOOKING-HEADER-27182";
    const attempts = [
      w.delivery(hook, bodyOf(w, "a", { padding: marker }), { secret: SECRET_2, headers: { authorization: secretLooking } }),
      w.delivery(hook, bodyOf(w, "b", { padding: marker, tenant: OTHER_TENANT }), { headers: { authorization: secretLooking } }),
      w.delivery(hook, bodyOf(w, "c", { padding: marker, occurredAt: iso(w.clock.now - 30 * HOUR) })),
      w.delivery(hook, bodyOf(w, "d", { padding: marker, occurredAt: iso(w.clock.now + 2 * HOUR) })),
      w.delivery(hook, `${marker} not json`, {}),
    ];
    w.dispatchFails.error = new Error(`dispatch said ${marker} ${SECRET_1}`);
    attempts.push(w.delivery(hook, bodyOf(w, "e", { padding: marker })));
    const replies = [];
    for (const attempt of attempts) replies.push(await w.receive(attempt));
    const everything = JSON.stringify({ logs: w.logs, replies });
    for (const forbidden of [marker, secretLooking, SECRET_1, SECRET_2]) expect(everything, forbidden).not.toContain(forbidden);
    // The refusals did log, so the absence above means something.
    expect(w.logs.length).toBeGreaterThanOrEqual(4);
  });
});


describe("what the endpoint reads and counts before it knows who is asking", () => {
  it("reads nothing for a source or a hook id that is not well formed, and one lookup for an id nobody made", async () => {
    const { w, hook } = await linear();
    for (const target of [{ source: "linear", hookId: "not-a-hook" }, { source: "github", hookId: hook.hookId }, { source: "nope", hookId: hook.hookId }]) {
      const mark = w.db.commandNames().length;
      expect((await w.receive(w.delivery(target, bodyOf(w, "e1")))).status).toBe(403);
      expect(w.commandsSince(mark), JSON.stringify(target)).toEqual([]);
    }
    const mark = w.db.commandNames().length;
    await w.receive(w.delivery({ source: "linear", hookId: `hk_${"4".repeat(26)}` }, bodyOf(w, "e1")));
    expect(w.commandsSince(mark)).toEqual(["GetCommand"]);
    // A lookup that names no organization is no lookup.
    w.db.set({ pk: `HOOK#${HOOK_OTHER_ORG}`, sk: "ORG", orgId: "bogus" });
    const again = w.db.commandNames().length;
    expect((await w.receive(w.delivery({ source: "linear", hookId: HOOK_OTHER_ORG }, bodyOf(w, "e1")))).status).toBe(403);
    expect(w.commandsSince(again)).toEqual(["GetCommand"]);
  });

  it("refuses a hook that is not on, whatever its other state: unsubscribed and pending confirmation too", async () => {
    const w = setupHookWorld();
    for (const [index, status] of (["unsubscribed", "pending_confirmation", "disabled"] as const).entries()) {
      const hook = await w.hook({ hookId: `hk_${String(index + 3).repeat(26)}`, status });
      expect((await w.receive(w.delivery(hook, bodyOf(w, "e1")))).status, status).toBe(403);
    }
  });

  it("counts requests with no source address together, and addresses cut at 64 characters as one", async () => {
    const { w, hook } = await linear();
    const nobody = { source: "linear", hookId: `hk_${"7".repeat(26)}` };
    for (let index = 0; index < HOOK_PRE_VERIFY_PER_IP_PER_MINUTE; index += 1) {
      w.clock.now += 1;
      await w.receive({ ...w.delivery(nobody, bodyOf(w, "x")), sourceIp: undefined });
    }
    w.clock.now += 1;
    expect((await w.receive({ ...w.delivery(hook, bodyOf(w, "e1")), sourceIp: undefined })).status).toBe(429);
    const long = "a".repeat(64);
    for (let index = 0; index < HOOK_PRE_VERIFY_PER_IP_PER_MINUTE; index += 1) await w.receive(w.delivery(nobody, bodyOf(w, "x"), { ip: `${long}${String(index % 10)}` }));
    expect((await w.receive(w.delivery(hook, bodyOf(w, "e2"), { ip: `${long}z` }))).status).toBe(429);
  });
});

describe("what the secret cache and the checks may not do", () => {
  it("reads the secret again after five minutes, so a secret that was replaced is the only one believed", async () => {
    const { w, hook } = await linear();
    expect((await w.receive(w.delivery(hook, bodyOf(w, "a")))).status).toBe(202);
    w.secrets.values.set(`${ORG_A}|${hook.hookId}`, JSON.stringify({ current: SECRET_2 }));
    w.clock.now += 6 * 60_000;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "b"), { secret: SECRET_1 }))).status).toBe(403);
    expect((await w.receive(w.delivery(hook, bodyOf(w, "c"), { secret: SECRET_2 }))).status).toBe(202);
  });

  it.each([["is gone", (w: HookWorld, key: string) => w.secrets.values.delete(key)], ["can't be read", (w: HookWorld, key: string) => w.secrets.values.set(key, "not json")]])("forgets a secret that %s: a signature of the old secret is not believed from a copy kept while the gate is tripped", async (_name, spoil) => {
    const { w, hook } = await linear();
    expect((await w.receive(w.delivery(hook, bodyOf(w, "a")))).status).toBe(202);
    spoil(w, `${ORG_A}|${hook.hookId}`);
    w.clock.now += 6 * 60_000;
    for (let index = 0; index < HOOK_FAILED_VERIFY_PER_MINUTE; index += 1) await w.receive(w.delivery(hook, bodyOf(w, `f${String(index)}`), { secret: SECRET_2 }));
    expect((await w.receive(w.delivery(hook, bodyOf(w, "late")))).status).toBe(403);
  });

  it("counts a failed read of the secret toward the gate, which then stops the reads", async () => {
    const { w, hook } = await linear();
    w.secrets.failReads = new Error("secrets are down");
    for (let index = 0; index < HOOK_FAILED_VERIFY_PER_MINUTE; index += 1) expect((await w.receive(w.delivery(hook, bodyOf(w, `f${String(index)}`)))).status).toBe(503);
    expect(w.secrets.reads).toBe(HOOK_FAILED_VERIFY_PER_MINUTE);
    expect((await w.receive(w.delivery(hook, bodyOf(w, "next")))).status).toBe(403);
    expect(w.secrets.reads).toBe(HOOK_FAILED_VERIFY_PER_MINUTE);
  });

  it("checks a delivery again after it re-reads the secret, and refuses a forged one that the re-read does not change", async () => {
    const { w, hook } = await linear();
    expect((await w.receive(w.delivery(hook, bodyOf(w, "a")))).status).toBe(202);
    w.clock.now += 31 * SECOND;
    expect((await w.receive(w.delivery(hook, bodyOf(w, "forged"), { secret: SECRET_2 }))).status).toBe(403);
    expect(w.secrets.reads).toBe(2);
    expect(w.dispatched).toHaveLength(1);
  });

  it("treats a provider that throws as a refusal, and tries both secrets every time", async () => {
    const w = setupHookWorld();
    const hook = await w.hook({ secretJson: JSON.stringify({ current: SECRET_2, previous: SECRET_1, previousValidUntil: iso(T0 + 24 * HOUR) }) });
    const provider = w.providers.linear!;
    let calls = 0;
    w.providers.linear = { ...provider, verify: (...args) => { calls += 1; return provider.verify(...args); } };
    expect((await w.receive(w.delivery(hook, bodyOf(w, "a"), { secret: SECRET_2 }))).status).toBe(202);
    expect(calls).toBe(2);
    w.providers.linear = { ...provider, verify: () => { throw new Error("broken"); } };
    expect(await w.receive(w.delivery(hook, bodyOf(w, "b"), { secret: SECRET_2 }))).toEqual({ status: 403, body: FORBIDDEN });
  });

  it("answers 400 to a validly signed body whose bytes are not UTF-8 even where the JSON would otherwise read", async () => {
    const { w, hook } = await linear();
    const raw = Buffer.concat([Buffer.from(`{"id":"e1","tenant":${JSON.stringify(LINEAR_TENANT)},"occurredAt":"${iso(w.clock.now)}","note":"`), Buffer.from([0xff]), Buffer.from('"}')]);
    expect(await w.receive(w.delivery(hook, "", { raw }))).toEqual({ status: 400, body: BAD_BODY });
    expect(w.dispatched).toEqual([]);
  });

  it("answers 503, not a refusal or a count, when the table fails for a verified delivery, and keeps the minute's count and the de-duplication item exact", async () => {
    const { w, hook } = await linear();
    w.db.injectFault({ command: "UpdateCommand", error: { name: "InternalServerError" } });
    expect((await w.receive(w.delivery(hook, bodyOf(w, "a")))).status).toBe(503);
    w.db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" } });
    expect((await w.receive(w.delivery(hook, bodyOf(w, "b")))).status).toBe(503);
    expect(w.dispatched).toEqual([]);
    const reply = await w.receive(w.delivery(hook, bodyOf(w, "c")));
    expect(reply.status).toBe(202);
    const rate = w.db.get(hookRateKey(ORG_A, hook.hookId, iso(w.clock.now).slice(0, 16)))!;
    expect(rate["indexExpiresAt"]).toBe(Math.floor(w.clock.now / 1000) + 600);
  });

  it("writes its de-duplication items under the org the hook belongs to", async () => {
    const { w, hook } = await linear();
    await w.receive(w.delivery(hook, bodyOf(w, "e1")));
    const items = w.db.find((item) => String(item["pk"]).includes("HOOK_EVENT#"));
    expect(items.map((item) => item["pk"])).toEqual([hookEventKey(ORG_A, hook.hookId, "test:e1").pk]);
    expect(items[0]!["orgId"]).toBe(ORG_A);
  });
});
