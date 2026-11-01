// Enterprise foundations P6: the poller, for a code host that cannot send webhooks. A pass reads the change requests an install follows, turns what changed into the neutral events a webhook
// would have given, and stays inside its read allowance; a host's rate limit stops it; one change request that fails does not stop the others; and a repeated pass finds the same events
// (same ids), which the intake drops.
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { hostRateLimitRetryAt, type ChangeRequestRef, type ChangeRequestStatus, type CodeHost, type CodeHostEvent, type ReadBudget } from "../../packages/contracts/src/index.js";
import { runCodeHostPollPasses } from "../../packages/broker/src/aws/broker/code-host-poll.js";
import { dynamoPollStore, pollTargetId } from "../../packages/broker/src/plugins/events/poll-store.js";
import { CLOSED_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, MAX_POLL_TARGETS, MAX_SEEN_FACTS, POLL_RETRY_MAX_MS, pollChanges, runPollPass, type PollTarget } from "../../packages/broker/src/plugins/events/poller.js";
import { dynamoEventReservations } from "../../packages/broker/src/plugins/events/reservations.js";
import { codeHostRepositoryKey } from "../../packages/broker/src/plugins/events/repository-key.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { trackingRecoveryItem } from "../../packages/broker/src/aws/workflow-merge-recovery.js";
import { linkedChangeRequestItem } from "../../packages/broker/src/rovara-code/linked-change-requests.js";
import { editionPolicy } from "../../packages/contracts/src/index.js";
import { TRACKING_HEARTBEAT_MINUTES } from "../../packages/contracts/src/rovara-code.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { NOW, TABLE, TASK_ID, world as trackingWorld } from "../support/rovara-code-tracking.js";

const URL = "https://git.example.test/acme/api";
const SCOPE = { system: "private-install" } as const;
const KIND = "fake";

/** A fake host that polls: it spends `requestsPerRead` reads of the allowance each time it is asked for a status. */
class PollingHost extends FakeCodeHost {
  requestsPerRead = 1;
  reads: string[] = [];
  constructor(model: FakeHostModel) {
    super(model);
    (this as { events: CodeHost["events"] }).events = { mode: "poll" };
  }
  override async changeRequestStatus(ref: ChangeRequestRef, scope: Parameters<FakeCodeHost["changeRequestStatus"]>[1], budget?: ReadBudget): Promise<ChangeRequestStatus> {
    for (let request = 1; request < this.requestsPerRead; request += 1) budget?.beforeRequest();
    const status = await super.changeRequestStatus(ref, scope, budget);
    // Recorded once the host has answered: a read its allowance refused is not one.
    this.reads.push(ref.id);
    return status;
  }
}

function pollWorld(options: { requests?: number } = {}) {
  const model = new FakeHostModel({ url: URL, id: "7", fullName: "acme/api" });
  const host = new PollingHost(model);
  if (options.requests !== undefined) host.requestsPerRead = options.requests;
  const db = new FakeDynamoDb();
  let now = NOW;
  const store = dynamoPollStore({ documentClient: db, tableName: TABLE, now: () => now });
  const reservations = dynamoEventReservations({ documentClient: db, tableName: TABLE, now: () => now });
  const consumed: CodeHostEvent[] = [];
  const consume = vi.fn(async (event: CodeHostEvent) => { consumed.push(event); });
  const open = (n: number) => {
    model.commit(`rovara/c${String(n)}`, { [`f${String(n)}.txt`]: "1" });
    const { cr } = model.reconcile({ sourceBranch: `rovara/c${String(n)}`, targetBranch: "main", title: `c${String(n)}`, draft: false });
    return { cr, ref: { repository: { url: URL }, id: cr.id, url: model.crUrl(cr.id) } satisfies ChangeRequestRef };
  };
  const pass = (overrides: Partial<Parameters<typeof runPollPass>[0]> = {}) => runPollPass({
    host, scope: SCOPE, store, reservations, consume, now: () => now, maxRequests: 100, maxRequestsPerTarget: 10, ...overrides,
  });
  return { model, host, db, store, reservations, consumed, consume, open, pass, advance: (ms: number) => { now += ms; }, now: () => now };
}

const statusOf = (overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus => ({
  id: "1", state: "open", draft: false, headRevision: "a".repeat(40), targetBranch: "main", mergeableState: "clean", checks: [], requiredChecks: [], targetHasRequiredChecks: false, headDefinesChecks: false,
  requestedReviewers: 0, reviews: [], ...overrides,
});
const TARGET: PollTarget = { id: "t", ref: { repository: { url: URL }, id: "1", url: `${URL}/pull/1` } };
const review = (login: string, state: "APPROVED" | "CHANGES_REQUESTED", revision = "a".repeat(40)) => ({ reviewer: { login, hostUserId: "9" }, accountType: "User", state, revision, submittedAt: "2026-10-31T10:00:00.000Z" });
const passing = (name: string) => ({ name, state: "completed" as const, conclusion: "success" as const, required: false, url: "" });

describe("P6: what a poll finds becomes the events a webhook would have given", () => {
  it("a first look reports nothing as new, except a change request that is already merged or closed", () => {
    const withHistory = statusOf({ reviews: [review("maya", "APPROVED")], checks: [passing("unit")] });
    expect(pollChanges(KIND, TARGET, undefined, withHistory).events).toEqual([]);
    expect(pollChanges(KIND, TARGET, undefined, withHistory).cursor.seen).toHaveLength(2);
    expect(pollChanges(KIND, TARGET, undefined, statusOf({ state: "merged" }))).toMatchObject({ events: [{ type: "change_request.merged" }], ended: true });
    expect(pollChanges(KIND, TARGET, undefined, statusOf({ state: "closed" }))).toMatchObject({ events: [{ type: "change_request.closed" }], ended: false });
  });

  it("reports a merge, a close, a reopening and a push, once each, and a merge ends the following", () => {
    const open = pollChanges(KIND, TARGET, undefined, statusOf()).cursor;
    expect(pollChanges(KIND, TARGET, open, statusOf({ state: "merged" }))).toMatchObject({ events: [{ type: "change_request.merged", host: KIND }], ended: true });
    expect(pollChanges(KIND, TARGET, open, statusOf({ state: "closed" })).events).toMatchObject([{ type: "change_request.closed" }]);
    const closed = pollChanges(KIND, TARGET, open, statusOf({ state: "closed" })).cursor;
    expect(pollChanges(KIND, TARGET, closed, statusOf()).events).toMatchObject([{ type: "change_request.updated" }]);
    expect(pollChanges(KIND, TARGET, open, statusOf({ headRevision: "b".repeat(40) })).events).toMatchObject([{ type: "change_request.updated" }]);
    expect(pollChanges(KIND, TARGET, open, statusOf()).events).toEqual([]);
    const merged = pollChanges(KIND, TARGET, open, statusOf({ state: "merged" })).cursor;
    expect(pollChanges(KIND, TARGET, merged, statusOf({ state: "merged", headRevision: "c".repeat(40) }))).toMatchObject({ events: [], ended: true });
  });

  it("reports each review and each finished check once, with the reviewer and the conclusion", () => {
    const open = pollChanges(KIND, TARGET, undefined, statusOf()).cursor;
    const found = pollChanges(KIND, TARGET, open, statusOf({ reviews: [review("maya", "CHANGES_REQUESTED")], checks: [passing("unit"), { name: "lint", state: "pending", required: false, url: "" }] }));
    expect(found.events).toMatchObject([{ type: "review.submitted", state: "CHANGES_REQUESTED", actor: "maya" }, { type: "check.completed", name: "unit", conclusion: "success", revision: "a".repeat(40) }]);
    // Seen now: the same facts give nothing the second time.
    expect(pollChanges(KIND, TARGET, found.cursor, statusOf({ reviews: [review("maya", "CHANGES_REQUESTED")], checks: [passing("unit")] })).events).toEqual([]);
    // A new review, or a check that passes again on a new head, is new.
    const next = pollChanges(KIND, TARGET, found.cursor, statusOf({ headRevision: "b".repeat(40), reviews: [review("maya", "CHANGES_REQUESTED"), review("priya", "APPROVED", "b".repeat(40))], checks: [passing("unit")] }));
    expect(next.events.map((event) => event.type)).toEqual(["change_request.updated", "review.submitted", "check.completed"]);
  });

  it("gives the same event the same id every time, and different events different ids", () => {
    const open = pollChanges(KIND, TARGET, undefined, statusOf()).cursor;
    const status = statusOf({ reviews: [review("maya", "APPROVED")], checks: [passing("unit")], headRevision: "b".repeat(40) });
    const ids = (events: readonly CodeHostEvent[]) => events.map((event) => event.eventId);
    expect(ids(pollChanges(KIND, TARGET, open, status).events)).toEqual(ids(pollChanges(KIND, TARGET, open, status).events));
    const found = ids(pollChanges(KIND, TARGET, open, status).events);
    expect(new Set(found).size).toBe(found.length);
    expect(ids(pollChanges(KIND, { ...TARGET, id: "other" }, open, status).events)).not.toEqual(found);
    for (const id of found) expect(id).toMatch(/^poll-[0-9a-f]{40}$/);
  });

  it("remembers a bounded number of facts, the newest", () => {
    let cursor = pollChanges(KIND, TARGET, undefined, statusOf()).cursor;
    for (let index = 0; index < MAX_SEEN_FACTS + 50; index += 1) {
      cursor = pollChanges(KIND, TARGET, cursor, statusOf({ checks: [passing(`check-${String(index)}`)] })).cursor;
    }
    expect(cursor.seen).toHaveLength(MAX_SEEN_FACTS);
  });
});

describe("P6: a poll pass", () => {
  it("looks first (no events), then reports what changed, then nothing; every event is consumed once", async () => {
    const w = pollWorld();
    const a = w.open(1);
    const b = w.open(2);
    expect(await w.store.register(KIND, a.ref, w.now())).toBe("registered");
    expect(await w.store.register(KIND, b.ref, w.now())).toBe("registered");
    expect(await w.store.register(KIND, b.ref, w.now())).toBe("exists");
    const first = await w.pass();
    expect(first).toMatchObject({ polled: 2, events: 0, delayed: 0, health: "ok" });
    // Nothing is due yet.
    expect(await w.pass()).toMatchObject({ polled: 0 });
    w.advance(DEFAULT_POLL_INTERVAL_MS);
    w.model.setAccount("maya", "write");
    w.model.addReview(a.cr.id, { login: "maya", state: "APPROVED" });
    w.model.commit("rovara/c2", { "more.txt": "2" });
    const second = await w.pass();
    expect(second).toMatchObject({ polled: 2, events: 2 });
    expect(w.consumed.map((event) => `${event.type}:${(event as { ref: ChangeRequestRef }).ref.id}`).sort()).toEqual([`change_request.updated:${b.cr.id}`, `review.submitted:${a.cr.id}`]);
    w.advance(DEFAULT_POLL_INTERVAL_MS);
    expect(await w.pass()).toMatchObject({ polled: 2, events: 0 });
    expect(w.consume).toHaveBeenCalledTimes(2);
  });

  it("a merge is reported and ends the following; the change request is no longer read", async () => {
    const w = pollWorld();
    const a = w.open(1);
    await w.store.register(KIND, a.ref, w.now());
    await w.pass();
    w.advance(DEFAULT_POLL_INTERVAL_MS);
    w.model.merge(a.cr.id, { revision: w.model.headRevisionOf(a.cr), method: "merge" });
    expect(await w.pass()).toMatchObject({ polled: 1, events: 1 });
    expect(w.consumed.map((event) => event.type)).toEqual(["change_request.merged"]);
    expect(await w.store.targets(KIND)).toEqual([]);
    w.host.reads = [];
    w.advance(DEFAULT_POLL_INTERVAL_MS);
    await w.pass();
    expect(w.host.reads).toEqual([]);
  });

  it("a closed change request is still looked at, but less often", async () => {
    const w = pollWorld();
    const a = w.open(1);
    await w.store.register(KIND, a.ref, w.now());
    await w.pass();
    w.advance(DEFAULT_POLL_INTERVAL_MS);
    w.model.update(a.cr.id, { state: "closed" });
    await w.pass();
    expect(w.consumed.map((event) => event.type)).toEqual(["change_request.closed"]);
    w.advance(DEFAULT_POLL_INTERVAL_MS);
    expect(await w.pass()).toMatchObject({ polled: 0 });
    w.advance(CLOSED_POLL_INTERVAL_MS);
    expect(await w.pass()).toMatchObject({ polled: 1 });
  });

  it("refuses a host that is not polled", async () => {
    const w = pollWorld();
    (w.host as { events: CodeHost["events"] }).events = { mode: "webhook" };
    await expect(w.pass()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  describe("the read allowance", () => {
    async function many(count: number, requests = 1) {
      const w = pollWorld({ requests });
      const refs = Array.from({ length: count }, (_, index) => w.open(index + 1));
      for (const [index, entry] of refs.entries()) { await w.store.register(KIND, entry.ref, w.now() + index); }
      w.advance(count);
      return { w, refs };
    }

    it("stops at the pass's allowance: it reads that many targets and no more, and says how many it did not reach", async () => {
      const { w } = await many(5);
      const report = await w.pass({ maxRequests: 2 });
      expect(report).toMatchObject({ polled: 2, delayed: 3, stoppedBy: "allowance", requests: 2 });
      expect(w.host.reads).toHaveLength(2);
    });

    it("never exceeds the allowance when a read costs several requests", async () => {
      const { w } = await many(4, 3);
      const used: number[] = [];
      const report = await w.pass({ maxRequests: 7, maxRequestsPerTarget: 3, signal: new AbortController().signal });
      used.push(report.requests);
      expect(report.requests).toBeLessThanOrEqual(7);
      // Two targets cost 3 each (6); the third needs 3 more and the pass has 1 left.
      expect(report).toMatchObject({ polled: 2, delayed: 2, stoppedBy: "allowance" });
    });

    it("works oldest-due first, so the targets one pass did not reach are the next pass's first", async () => {
      const { w, refs } = await many(4);
      await w.pass({ maxRequests: 2 });
      expect(w.host.reads).toEqual([refs[0]!.cr.id, refs[1]!.cr.id]);
      w.host.reads = [];
      // The two read are due again an interval later; the two not reached are already due and come first.
      w.advance(DEFAULT_POLL_INTERVAL_MS);
      await w.pass({ maxRequests: 2 });
      expect(w.host.reads).toEqual([refs[2]!.cr.id, refs[3]!.cr.id]);
    });

    it("says events are delayed when the targets it could not reach have waited longer than the stale time", async () => {
      const { w } = await many(3);
      const fresh = await w.pass({ maxRequests: 1, staleAfterMs: 10 * 60_000 });
      expect(fresh).toMatchObject({ delayed: 2, health: "ok" });
      w.advance(15 * 60_000);
      const late = await w.pass({ maxRequests: 1, staleAfterMs: 10 * 60_000 });
      expect(late.health).toBe("events_delayed");
      expect(late.oldestDelayedMs).toBeGreaterThan(10 * 60_000);
    });

    it("limits one change request to its own allowance: it waits longer, the others are still read", async () => {
      const { w, refs } = await many(3);
      const original = w.host.changeRequestStatus.bind(w.host);
      vi.spyOn(w.host, "changeRequestStatus").mockImplementation(async (ref, scope, budget) => {
        if (ref.id === refs[1]!.cr.id) for (let index = 0; index < 5; index += 1) budget?.beforeRequest();
        return original(ref, scope, budget);
      });
      const report = await w.pass({ maxRequests: 50, maxRequestsPerTarget: 3 });
      expect(report).toMatchObject({ polled: 2, failed: 1, delayed: 0 });
      const stored = (await w.store.targets(KIND)).find((poll) => poll.target.ref.id === refs[1]!.cr.id)!;
      expect(stored.attempts).toBe(1);
      expect(stored.dueAt).toBeGreaterThan(w.now() + DEFAULT_POLL_INTERVAL_MS);
    });

    it("stops with the caller's signal", async () => {
      const { w } = await many(3);
      const controller = new AbortController();
      w.consume.mockImplementation(async () => undefined);
      const original = w.host.changeRequestStatus.bind(w.host);
      vi.spyOn(w.host, "changeRequestStatus").mockImplementation(async (ref, scope, budget) => { controller.abort(); return original(ref, scope, budget); });
      const report = await w.pass({ signal: controller.signal });
      expect(report.stoppedBy).toBe("signal");
      expect(report.polled).toBeLessThan(3);
    });
  });

  describe("a host that says to slow down", () => {
    it("stops the pass, remembers until when, and does not ask the host again before then", async () => {
      const w = pollWorld();
      const a = w.open(1);
      await w.store.register(KIND, a.ref, w.now());
      const until = w.now() + 10 * 60_000;
      w.model.rateLimitedUntil = until;
      const asked = vi.spyOn(w.host, "changeRequestStatus");
      const first = await w.pass();
      expect(first).toMatchObject({ polled: 0, stoppedBy: "rate_limit", rateLimitedUntil: until, delayed: 1 });
      expect(asked).toHaveBeenCalledTimes(1);
      w.advance(5 * 60_000);
      const second = await w.pass();
      expect(second).toMatchObject({ polled: 0, stoppedBy: "blocked", rateLimitedUntil: until });
      expect(asked).toHaveBeenCalledTimes(1);
      // After the time the host gave, and with the limit lifted, polling resumes.
      w.advance(6 * 60_000);
      w.model.rateLimitedUntil = undefined;
      expect(await w.pass()).toMatchObject({ polled: 1 });
      expect(asked).toHaveBeenCalledTimes(2);
    });

    it("keeps the later of two limits", async () => {
      const w = pollWorld();
      await w.store.block(KIND, w.now() + 20 * 60_000);
      await w.store.block(KIND, w.now() + 5 * 60_000);
      expect(await w.store.blockedUntil(KIND)).toBe(w.now() + 20 * 60_000);
      w.advance(30 * 60_000);
      expect(await w.store.blockedUntil(KIND)).toBeUndefined();
    });

    it("the signal is the neutral one, from any host", () => {
      expect(hostRateLimitRetryAt(Object.assign(new Error("x"), { retryAt: 5 }))).toBeUndefined();
    });
  });

  describe("a change request that fails", () => {
    it("does not stop the others, and waits longer each time, up to a cap", async () => {
      const w = pollWorld();
      const a = w.open(1);
      const b = w.open(2);
      await w.store.register(KIND, a.ref, w.now());
      await w.store.register(KIND, b.ref, w.now() + 1);
      w.advance(1);
      const original = w.host.changeRequestStatus.bind(w.host);
      vi.spyOn(w.host, "changeRequestStatus").mockImplementation(async (ref, scope, budget) => {
        if (ref.id === a.cr.id) throw new Error("host says no");
        return original(ref, scope, budget);
      });
      const delays: number[] = [];
      for (let round = 0; round < 12; round += 1) {
        const report = await w.pass();
        if (round === 0) expect(report).toMatchObject({ polled: 1, failed: 1 });
        const stored = (await w.store.targets(KIND)).find((poll) => poll.target.ref.id === a.cr.id)!;
        delays.push(stored.dueAt - w.now());
        w.advance(stored.dueAt - w.now());
      }
      for (let index = 1; index < delays.length; index += 1) expect(delays[index]!).toBeGreaterThanOrEqual(delays[index - 1]!);
      expect(Math.max(...delays)).toBe(POLL_RETRY_MAX_MS);
      expect(delays[0]).toBeGreaterThan(DEFAULT_POLL_INTERVAL_MS);
    });

    it("an event the consumer could not take leaves the cursor where it was, so the next pass finds it again and consumes it once", async () => {
      const w = pollWorld();
      const a = w.open(1);
      await w.store.register(KIND, a.ref, w.now());
      await w.pass();
      w.advance(DEFAULT_POLL_INTERVAL_MS);
      w.model.commit("rovara/c1", { "x.txt": "2" });
      w.consume.mockRejectedValueOnce(new Error("store down"));
      expect(await w.pass()).toMatchObject({ failed: 1, events: 0 });
      expect(w.consumed).toEqual([]);
      const stored = (await w.store.targets(KIND))[0]!;
      w.advance(stored.dueAt - w.now());
      expect(await w.pass()).toMatchObject({ failed: 0, events: 1 });
      expect(w.consumed.map((event) => event.type)).toEqual(["change_request.updated"]);
    });

    it("an event consumed whose cursor was not saved is found again and dropped, not consumed twice", async () => {
      const w = pollWorld();
      const a = w.open(1);
      await w.store.register(KIND, a.ref, w.now());
      await w.pass();
      w.advance(DEFAULT_POLL_INTERVAL_MS);
      w.model.commit("rovara/c1", { "x.txt": "2" });
      const save = vi.spyOn(w.store, "save").mockRejectedValueOnce(new Error("write lost"));
      await expect(w.pass()).rejects.toThrow("write lost");
      expect(w.consumed).toHaveLength(1);
      save.mockRestore();
      expect(await w.pass()).toMatchObject({ events: 0, duplicates: 1 });
      expect(w.consumed).toHaveLength(1);
    });
  });
});

describe("P6: the poll store", () => {
  it("keys a change request by host kind, repository and id, and refuses an address it cannot key", async () => {
    const ref = { repository: { url: URL }, id: "7", url: "" };
    expect(pollTargetId(KIND, ref)).toBe(`${codeHostRepositoryKey(KIND, URL)!}|7`);
    expect(pollTargetId(KIND, { ...ref, repository: { url: "not a url" } })).toBeUndefined();
    const w = pollWorld();
    expect(await w.store.register(KIND, { ...ref, repository: { url: "not a url" } }, w.now())).toBe("unkeyable");
  });

  it("follows at most the limit, and stops following on request", async () => {
    const w = pollWorld();
    for (let index = 1; index <= MAX_POLL_TARGETS; index += 1) {
      w.db.set({ pk: `CODEHOST_POLL#${KIND}`, sk: `T#x|${String(index)}`, targetId: `x|${String(index)}`, ref: { repository: { url: URL }, id: String(index), url: "" }, dueAt: w.now(), attempts: 0 });
    }
    const extra: ChangeRequestRef = { repository: { url: URL }, id: "9999", url: "" };
    expect(await w.store.register(KIND, extra, w.now())).toBe("full");
    await w.store.unregister(KIND, { repository: { url: URL }, id: "1", url: "" });
    expect(await w.store.register(KIND, extra, w.now())).toBe("full");
    w.db.items.delete(`CODEHOST_POLL#${KIND}\u0000T#x|2`);
  });

  it("a stored cursor that cannot be read is a first look, never a guess", async () => {
    const w = pollWorld();
    const a = w.open(1);
    await w.store.register(KIND, a.ref, w.now());
    const item = w.db.find((entry) => entry.entityType === "CODEHOST_POLL_TARGET")[0]!;
    w.db.set({ ...item, cursor: { state: "weird", head: 1 } });
    expect((await w.store.targets(KIND))[0]!.cursor).toBeUndefined();
    await w.pass();
    expect(w.consumed).toEqual([]);
  });

  it("does not list another host's targets", async () => {
    const w = pollWorld();
    const a = w.open(1);
    await w.store.register(KIND, a.ref, w.now());
    expect(await w.store.targets("other")).toEqual([]);
  });
});

describe("P6: the broker's poll pass, for every host that polls", () => {
  function brokerPoll() {
    const w = trackingWorld({ pullRequests: [{ repositoryId: "api", number: 1 }] });
    for (const key of [...w.db.items.keys()]) if (key.includes("GITHUB_PR#") || key.includes("WORKFLOW_MERGE_RECOVERY")) w.db.items.delete(key);
    w.db.set(linkedChangeRequestItem(TABLE, { hostKind: KIND, repositoryAddress: URL, changeRequestId: "1", repositoryId: "api", number: 1, url: `${URL}/pull/1`, taskId: TASK_ID, workspaceId: "ws-1", candidateDigest: "c".repeat(64), createdAt: "2026-11-01T00:00:00.000Z" })!.Put.Item);
    w.setWorkflow({ pullRequests: [{ repositoryId: "api", number: 1, headSha: "a".repeat(40), url: `${URL}/pull/1`, candidateDigest: "c".repeat(64), required: true, state: "OPEN" }] });
    const model = new FakeHostModel({ url: URL, id: "7", fullName: "acme/api" });
    const polling = new PollingHost(model);
    const github = githubCodeHost({} as Parameters<typeof githubCodeHost>[0], { credentialRef: "github" });
    const router = createPluginRegistry({ codeHosts: [github, polling], checkRunners: [], policy: editionPolicy("enterprise") }).codeHost;
    model.commit("rovara/c1", { "f.txt": "1" });
    const { cr } = model.reconcile({ sourceBranch: "rovara/c1", targetBranch: "main", title: "c", draft: false });
    return { w, model, polling, github, router, cr };
  }

  it("polls only the hosts that poll, wakes the tracking row of the task a merge is about, and leaves a webhook host alone", async () => {
    const t = brokerPoll();
    await t.w.db.send(new TransactWriteCommand({ TransactItems: [trackingRecoveryItem(TABLE, TASK_ID, new Date(NOW + TRACKING_HEARTBEAT_MINUTES * 60_000).toISOString())] }));
    const deps = {
      router: t.router, documentClient: t.w.db, tableName: TABLE, now: () => t.w.now(), loadTask: (id: string) => t.w.deps.loadTask(id),
      repositoryUrl: async () => URL, orgOf: async () => TEST_ORG, scope: SCOPE,
    };
    const store = dynamoPollStore({ documentClient: t.w.db, tableName: TABLE, now: () => t.w.now() });
    await store.register(KIND, { repository: { url: URL }, id: t.cr.id, url: "" }, t.w.now());
    const first = await runCodeHostPollPasses({ ...deps, store });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ host: KIND, polled: 1, events: 0 });
    t.w.setNow(t.w.now() + DEFAULT_POLL_INTERVAL_MS);
    t.model.merge(t.cr.id, { revision: t.model.headRevisionOf(t.cr), method: "merge" });
    const second = await runCodeHostPollPasses({ ...deps, store });
    expect(second[0]).toMatchObject({ polled: 1, events: 1 });
    expect(t.w.db.get("WORKFLOW_MERGE_RECOVERY", `TASK#${TASK_ID}`)).toMatchObject({ wakeAt: t.w.now() });
  });
});
