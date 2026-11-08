// SRL-5a: the sweep that asks GitHub to send a failed delete webhook again. The sweep never writes or removes a record row; it only asks GitHub (through the App) to redeliver
// the deliveries that carried a record removal and failed at our side, and the webhook's own tap does the delete. Design: .superpowers/sdd/srl5-github-delete-sweep/design.md.
import { describe, expect, it } from "vitest";
import { GITHUB_WEBHOOK_EVENTS } from "../../../packages/cli/src/init/github-app.js";
import {
  isRecordRemovalDelivery, runGithubRedelivery, RedeliveryStateConflict, REDELIVERY_MAX_ASKS, REDELIVERY_MAX_GAPS, REDELIVERY_MAX_TRACKED, REDELIVERY_MIN_GAP_MS, REDELIVERY_OVERLAP_MS, REDELIVERY_RETENTION_MS,
  type DeliveriesPort, type DeliveryEntry, type RedeliveryState, type RedeliveryStatePort,
} from "../../../packages/broker/src/team-record/github-redelivery.js";
import { githubEventsOf, RECORD_REMOVAL_DELIVERIES, type CodeHostRepo } from "../../../packages/broker/src/team-record/sources/index.js";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (time: number): string => new Date(time).toISOString();
const ago = (ms: number): string => iso(NOW - ms);
let counter = 0;
const guidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function entry(over: Partial<DeliveryEntry> & { age: number }): DeliveryEntry {
  counter += 1;
  const { age, ...rest } = over;
  return { id: 1_000 + counter, guid: guidOf(counter), deliveredAt: ago(age), redelivery: false, event: "issue_comment", action: "deleted", statusCode: 503, ...rest };
}

/** A fake GitHub: entries newest first, pages by position, and a redelivery adds a new entry (answered `answer`) at the top. */
function fakeGithub(initial: DeliveryEntry[], options: { answer?: number; noAttempt?: boolean; redeliverFails?: (id: number) => boolean; redeliverGone?: (id: number) => boolean; listFailsAt?: (cursor: string | undefined) => boolean; clock?: { now: number } } = {}) {
  const entries = [...initial].sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt));
  const calls = { list: [] as Array<string | undefined>, redeliver: [] as number[], signals: [] as Array<AbortSignal | undefined> };
  const clock = options.clock ?? { now: NOW };
  const port: DeliveriesPort = {
    async list({ cursor, perPage, signal }) {
      calls.list.push(cursor);
      calls.signals.push(signal);
      if (options.listFailsAt?.(cursor)) throw new Error("GitHub is down");
      const start = cursor === undefined ? 0 : Number(cursor.slice(1));
      const page = entries.slice(start, start + perPage);
      return { entries: page, ...(start + perPage < entries.length ? { next: `c${start + perPage}` } : {}) };
    },
    async redeliver(id) {
      calls.redeliver.push(id);
      if (options.redeliverFails?.(id)) throw new Error("GitHub refused");
      if (options.redeliverGone?.(id)) return "gone";
      const original = entries.find((candidate) => candidate.id === id);
      if (original === undefined) return "gone";
      if (options.noAttempt !== true) {
        counter += 1;
        entries.unshift({ ...original, id: 5_000 + counter, deliveredAt: iso(clock.now), redelivery: true, statusCode: options.answer ?? 200 });
      }
      return "requested";
    },
  };
  return { port, calls, entries, clock };
}

function memoryState(initial?: Omit<RedeliveryState, "version">) {
  const box: { value: RedeliveryState | undefined; saves: number; failSave?: boolean; failLoad?: boolean; conflictOnSave?: boolean } = { value: initial === undefined ? undefined : { ...initial, version: 1 }, saves: 0 };
  const port: RedeliveryStatePort = {
    async load() { if (box.failLoad) throw new Error("table down"); return box.value; },
    async save(next, previous) {
      if (box.failSave) throw new Error("table down");
      if (box.conflictOnSave || (box.value?.version ?? undefined) !== previous) throw new RedeliveryStateConflict();
      box.saves += 1;
      box.value = { ...next, version: (previous ?? 0) + 1 };
    },
  };
  return { box, port };
}

const run = (github: ReturnType<typeof fakeGithub>, state: ReturnType<typeof memoryState>, extra: Partial<Parameters<typeof runGithubRedelivery>[0]> = {}, budgetMs = 5_000) =>
  runGithubRedelivery({ deliveries: github.port, state: state.port, now: () => github.clock.now, ...extra }, { budgetMs });
/** One hourly run at `time` (the fake GitHub's clock moves with it). */
const runAt = (github: ReturnType<typeof fakeGithub>, state: ReturnType<typeof memoryState>, time: number, extra: Partial<Parameters<typeof runGithubRedelivery>[0]> = {}) => { github.clock.now = time; return run(github, state, extra); };

describe("which deliveries are record removals", () => {
  it("is a comment delete (both comment events) or a repository delete or transfer, and nothing else", () => {
    expect(isRecordRemovalDelivery("issue_comment", "deleted")).toBe(true);
    expect(isRecordRemovalDelivery("pull_request_review_comment", "deleted")).toBe(true);
    expect(isRecordRemovalDelivery("repository", "deleted")).toBe(true);
    expect(isRecordRemovalDelivery("repository", "transferred")).toBe(true);
    for (const [event, action] of [["issue_comment", "created"], ["issue_comment", "edited"], ["pull_request_review_comment", "edited"], ["repository", "renamed"], ["pull_request", "closed"], ["push", null], ["issue_comment", null], ["installation", "deleted"], ["issues", "deleted"], ["constructor", "deleted"]] as const) {
      expect(isRecordRemovalDelivery(event, action)).toBe(false);
    }
  });

  it("agrees with the tap: every removal delivery maps to a removal event, and nothing else the tap maps is a removal (drift guard)", () => {
    const repo: CodeHostRepo = { host: "github", id: "1", fullName: "acme/app", isPrivate: true, workspaceId: "org_x" };
    const comment = { id: 7, html_url: "https://github.com/acme/app/pull/3#issuecomment-7", body: "x", user: { id: 1, login: "a" }, updated_at: "2026-11-08T10:00:00Z" };
    const payloads: Array<[string, string, unknown]> = [
      ["issue_comment", "deleted", { comment, issue: { number: 3, pull_request: {} } }],
      ["pull_request_review_comment", "deleted", { comment, pull_request: { number: 3 } }],
      ["repository", "deleted", {}], ["repository", "transferred", {}],
      ["issue_comment", "created", { comment, issue: { number: 3, pull_request: {} } }],
      ["issue_comment", "edited", { comment, issue: { number: 3, pull_request: {} } }],
      ["pull_request_review_comment", "created", { comment, pull_request: { number: 3 } }],
      ["repository", "renamed", {}], ["repository", "archived", {}],
    ];
    for (const [event, action, payload] of payloads) {
      const mapped = githubEventsOf(event, action, payload, repo, "2026-11-08T10:00:00.000Z", guidOf(1));
      const removes = mapped.some((candidate) => candidate.type === "repository" || (candidate.type === "comment" && candidate.action === "deleted"));
      expect({ event, action, removes }).toEqual({ event, action, removes: isRecordRemovalDelivery(event, action) });
    }
  });

  it("the GitHub App is subscribed to every event a removal arrives in (without `repository`, GitHub never delivers a repository delete, and no redelivery can bring it back)", () => {
    const subscribed: readonly string[] = GITHUB_WEBHOOK_EVENTS;
    expect(Object.keys(RECORD_REMOVAL_DELIVERIES).filter((event) => !subscribed.includes(event))).toEqual([]);
    expect(subscribed).toContain("repository");
  });
});

describe("the happy path", () => {
  it("asks GitHub to send a failed comment delete again, tracks it with its first failure, and moves the watermark to now", async () => {
    const failed = entry({ age: 2 * HOUR, statusCode: 503 });
    const github = fakeGithub([failed]);
    const state = memoryState();
    const outcome = await run(github, state);
    expect(github.calls.redeliver).toEqual([failed.id]);
    expect(outcome).toMatchObject({ status: "ok", redelivered: 1, failed: 0, gone: 0, tracked: 1 });
    expect(state.box.value).toMatchObject({ watermark: iso(NOW), gaps: [], tracked: [{ guid: failed.guid, firstFailedAt: failed.deliveredAt, asks: 1, askedAt: iso(NOW) }] });
  });

  it("redelivers a repository delete and a transfer, a review comment delete, and every way a removal can fail at our side: a timeout, refused connection, 4xx (a rotated secret, a broken route) and 5xx", async () => {
    const codes = [0, 400, 401, 403, 404, 408, 422, 429, 500, 502, 503];
    const wanted = codes.map((statusCode) => entry({ age: HOUR, statusCode }));
    wanted.push(entry({ age: HOUR, event: "repository", action: "deleted", statusCode: 500 }), entry({ age: HOUR, event: "repository", action: "transferred", statusCode: 502 }), entry({ age: HOUR, event: "pull_request_review_comment", action: "deleted", statusCode: 0 }));
    const github = fakeGithub(wanted);
    await run(github, memoryState());
    expect(github.calls.redeliver.sort()).toEqual(wanted.map((item) => item.id).sort());
  });

  it("leaves alone what is not a failed record removal: a 2xx, other events and other actions", async () => {
    const ignored = [
      entry({ age: HOUR, statusCode: 200 }), entry({ age: HOUR, statusCode: 202 }),
      entry({ age: HOUR, action: "created" }), entry({ age: HOUR, action: "edited" }), entry({ age: HOUR, action: null }),
      entry({ age: HOUR, event: "push", action: null }), entry({ age: HOUR, event: "pull_request", action: "closed" }), entry({ age: HOUR, event: "repository", action: "renamed", statusCode: 500 }),
    ];
    const github = fakeGithub(ignored);
    const outcome = await run(github, memoryState());
    expect(github.calls.redeliver).toEqual([]);
    expect(outcome).toMatchObject({ status: "ok", redelivered: 0, tracked: 0 });
  });

  it("does nothing, and fails nothing, when there are no deliveries at all", async () => {
    const github = fakeGithub([]);
    const state = memoryState();
    expect(await run(github, state)).toMatchObject({ status: "ok", redelivered: 0, failed: 0 });
    expect(state.box.value?.watermark).toBe(iso(NOW));
  });

  it("gives every list call and every redelivery a signal that ends at the sweep's deadline, so one hanging call cannot outlast the budget", async () => {
    const github = fakeGithub([entry({ age: 2 * HOUR })]);
    await run(github, memoryState(), {}, 4_000);
    expect(github.calls.signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});

describe("it is idempotent and tracks a removal until an attempt succeeds", () => {
  it("a guid that a later attempt delivered (2xx) is not asked for again", async () => {
    const original = entry({ age: 5 * HOUR, statusCode: 503 });
    const later = entry({ age: 3 * HOUR, guid: original.guid, redelivery: true, statusCode: 200 });
    const github = fakeGithub([original, later]);
    await run(github, memoryState());
    expect(github.calls.redeliver).toEqual([]);
  });

  it("two runs in a row ask once, and a tracked removal is forgotten once an attempt is seen to succeed", async () => {
    const failed = entry({ age: 2 * HOUR });
    const github = fakeGithub([failed], { answer: 200 });
    const state = memoryState();
    await run(github, state);
    expect(state.box.value?.tracked).toHaveLength(1);
    await run(github, state);
    expect(github.calls.redeliver).toEqual([failed.id]);
    expect(state.box.value?.tracked).toEqual([]);
  });

  it("a redelivery that fails again at our side is asked again by the next hourly run, about the NEWEST attempt, and not by a run that follows within the minimum gap", async () => {
    const failed = entry({ age: 2 * HOUR });
    const github = fakeGithub([failed], { answer: 503 });
    const state = memoryState();
    await runAt(github, state, NOW);
    expect(github.calls.redeliver).toHaveLength(1);
    await runAt(github, state, NOW + 5 * MIN);
    expect(github.calls.redeliver).toHaveLength(1);
    await runAt(github, state, NOW + HOUR);
    expect(github.calls.redeliver).toHaveLength(2);
    expect(github.calls.redeliver[1]).not.toBe(failed.id);
  });

  it("a request GitHub accepted but never made an attempt for is asked again after the minimum gap, even though its original failure is by then below the scan window (M5)", async () => {
    const failed = entry({ age: 2 * HOUR });
    const github = fakeGithub([failed], { noAttempt: true });
    const state = memoryState();
    await runAt(github, state, NOW);
    expect(github.calls.redeliver).toEqual([failed.id]);
    // 3 hours later the original is far below watermark - overlap, yet it is still tracked and asked.
    await runAt(github, state, NOW + 3 * HOUR);
    expect(github.calls.redeliver).toEqual([failed.id, failed.id]);
    expect(state.box.value?.tracked[0]).toMatchObject({ asks: 2 });
  });

  it("an entry younger than the minimum gap is tracked but left for the next run; a run 5 minutes later (a Lambda retry) still waits, the normal hourly run asks (overlap is not below the gap)", async () => {
    expect(REDELIVERY_OVERLAP_MS).toBeGreaterThanOrEqual(REDELIVERY_MIN_GAP_MS);
    const fresh = entry({ age: REDELIVERY_MIN_GAP_MS - 10 * MIN });
    const github = fakeGithub([fresh], { noAttempt: true });
    const state = memoryState();
    await runAt(github, state, NOW);
    expect(github.calls.redeliver).toEqual([]);
    await runAt(github, state, NOW + 5 * MIN);
    expect(github.calls.redeliver).toEqual([]);
    await runAt(github, state, NOW + HOUR);
    expect(github.calls.redeliver).toEqual([fresh.id]);
  });

  it("looks back no further than the watermark less the overlap for NEW failures, so the work stays proportional to the time since the last run", async () => {
    const recent = entry({ age: HOUR });
    const old = entry({ age: 30 * HOUR });
    const github = fakeGithub([recent, old]);
    const state = memoryState({ watermark: ago(2 * HOUR), gaps: [], tracked: [] });
    await run(github, state);
    expect(github.calls.redeliver).toEqual([recent.id]);
    expect(Date.parse(old.deliveredAt)).toBeLessThan(NOW - 2 * HOUR - REDELIVERY_OVERLAP_MS);
  });

  it("with no watermark (the first run) it goes back through everything GitHub still holds, and asks for each failed removal", async () => {
    const items = [entry({ age: 70 * HOUR }), entry({ age: 40 * HOUR }), entry({ age: 2 * HOUR })];
    const github = fakeGithub(items);
    await run(github, memoryState());
    expect(github.calls.redeliver.sort()).toEqual(items.map((item) => item.id).sort());
  });

  it("asks for at most the per-run limit and the rest wait in the tracked list (nothing is lost, nothing is rescanned)", async () => {
    const items = [entry({ age: 5 * HOUR }), entry({ age: 4 * HOUR }), entry({ age: 3 * HOUR })];
    const github = fakeGithub(items, { answer: 200 });
    const state = memoryState();
    const first = await run(github, state, { maxRedeliveries: 2 });
    expect(github.calls.redeliver).toHaveLength(2);
    expect(first.deferred).toBe(1);
    expect(state.box.value?.tracked).toHaveLength(3);
    await runAt(github, state, NOW + HOUR, { maxRedeliveries: 2 });
    expect(new Set(github.calls.redeliver)).toEqual(new Set(items.map((item) => item.id)));
  });
});

describe("a removal that always fails cannot starve the others, and is given up on when GitHub forgets it (M6)", () => {
  it("over several simulated hours, a NEW failure is asked in its first run even when more always-failing removals than the per-run limit are older", async () => {
    const stuck = Array.from({ length: 4 }, () => entry({ age: 10 * HOUR }));
    const github = fakeGithub(stuck, { answer: 503 });
    const state = memoryState();
    const options = { maxRedeliveries: 2 };
    await runAt(github, state, NOW, options);
    await runAt(github, state, NOW + HOUR, options);
    await runAt(github, state, NOW + 2 * HOUR, options);
    // A new delete fails at hour 3.
    const fresh = entry({ age: 0, deliveredAt: iso(NOW + 3 * HOUR - 40 * MIN), statusCode: 503 });
    github.entries.unshift(fresh);
    const before = github.calls.redeliver.length;
    await runAt(github, state, NOW + 3 * HOUR, options);
    expect(github.calls.redeliver.slice(before)).toContain(fresh.id);
  });

  it("stops asking about a removal three days after its first failure, and counts it as given up", async () => {
    const failed = entry({ age: 2 * HOUR });
    const github = fakeGithub([failed], { answer: 503 });
    const state = memoryState();
    await runAt(github, state, NOW);
    const asked = github.calls.redeliver.length;
    const outcome = await runAt(github, state, NOW + REDELIVERY_RETENTION_MS);
    expect(outcome.exhausted).toBe(1);
    expect(github.calls.redeliver).toHaveLength(asked);
    expect(state.box.value?.tracked).toEqual([]);
  });

  it("stops after the most asks", async () => {
    const failed = entry({ age: 2 * HOUR });
    const github = fakeGithub([failed]);
    const state = memoryState({ watermark: ago(HOUR), gaps: [], tracked: [{ guid: failed.guid, entryId: failed.id, lastAt: failed.deliveredAt, firstFailedAt: failed.deliveredAt, asks: REDELIVERY_MAX_ASKS, askedAt: ago(2 * HOUR) }] });
    const outcome = await run(github, state);
    expect(outcome.exhausted).toBe(1);
    expect(github.calls.redeliver).toEqual([]);
  });

  it("a failed removal that cannot be tracked (the list is full) holds the watermark at it, so the next run finds it again", async () => {
    const tracked = Array.from({ length: REDELIVERY_MAX_TRACKED }, (_, index) => ({ guid: guidOf(10_000 + index), entryId: 90_000 + index, lastAt: ago(HOUR), firstFailedAt: ago(HOUR), asks: 1, askedAt: ago(HOUR) }));
    const extra = entry({ age: HOUR / 2 });
    const github = fakeGithub([extra]);
    const state = memoryState({ watermark: ago(2 * HOUR), gaps: [], tracked });
    const outcome = await run(github, state, { maxRedeliveries: 0 });
    expect(outcome.untracked).toBe(1);
    expect(Date.parse(state.box.value!.watermark!)).toBeLessThanOrEqual(Date.parse(extra.deliveredAt));
  });
});

describe("errors never delete anything and never lose a failed delete", () => {
  it("a redelivery request that fails is counted, the others still go, and the failed one stays tracked and is asked again", async () => {
    const bad = entry({ age: 4 * HOUR });
    const good = entry({ age: 3 * HOUR });
    const github = fakeGithub([bad, good], { redeliverFails: (id) => id === bad.id, answer: 200 });
    const state = memoryState();
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ status: "failed", redelivered: 1, failed: 1 });
    expect(state.box.value?.tracked.map((item) => item.guid)).toContain(bad.guid);
    const healed = fakeGithub(github.entries.filter((item) => !item.redelivery), { answer: 200 });
    await runAt(healed, state, NOW + HOUR);
    expect(healed.calls.redeliver).toContain(bad.id);
  });

  it("GitHub being down on the first page changes nothing and asks for nothing", async () => {
    const github = fakeGithub([entry({ age: 2 * HOUR })], { listFailsAt: () => true });
    const state = memoryState({ watermark: ago(3 * HOUR), gaps: [], tracked: [] });
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ status: "failed" });
    expect(github.calls.redeliver).toEqual([]);
    expect(state.box.saves).toBe(0);
  });

  it("a state that cannot be read does nothing (it would otherwise look like a first run)", async () => {
    const github = fakeGithub([entry({ age: 2 * HOUR })]);
    const state = memoryState();
    state.box.failLoad = true;
    expect(await run(github, state)).toMatchObject({ status: "failed" });
    expect(github.calls.list).toEqual([]);
    expect(github.calls.redeliver).toEqual([]);
  });

  it("a state that cannot be saved is a failure (the next run asks again, which is harmless)", async () => {
    const github = fakeGithub([entry({ age: 2 * HOUR })]);
    const state = memoryState();
    state.box.failSave = true;
    expect(await run(github, state)).toMatchObject({ status: "failed", redelivered: 1 });
  });

  it("a run that finds another run saved first drops its own state and says so, instead of writing over the other's gaps and tracked list", async () => {
    const github = fakeGithub([entry({ age: 2 * HOUR })]);
    const state = memoryState({ watermark: ago(HOUR), gaps: [], tracked: [] });
    state.box.conflictOnSave = true;
    const before = JSON.stringify(state.box.value);
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ status: "ok", conflict: true });
    expect(JSON.stringify(state.box.value)).toBe(before);
  });

  it("GitHub saying it no longer has a delivery (404) is done and counted as gone, not as redelivered", async () => {
    const gone = entry({ age: 2 * HOUR });
    const github = fakeGithub([gone], { redeliverGone: () => true });
    const state = memoryState();
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ status: "ok", failed: 0, redelivered: 0, gone: 1, tracked: 0 });
    expect(state.box.value?.tracked).toEqual([]);
  });

  it("any other answer to a redelivery request, a 422 (\"spammed\") included, is a failure that keeps the removal tracked", async () => {
    const spammed = entry({ age: 2 * HOUR });
    const github = fakeGithub([spammed], { redeliverFails: () => true });
    const state = memoryState();
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ status: "failed", failed: 1, gone: 0, redelivered: 0 });
    expect(state.box.value?.tracked).toHaveLength(1);
  });

  it("never calls anything but the list and the redelivery: no record port is even passed in", async () => {
    const github = fakeGithub([entry({ age: 2 * HOUR })]);
    const keys = Object.keys({ deliveries: github.port, state: memoryState().port, now: () => NOW });
    expect(keys).toEqual(["deliveries", "state", "now"]);
  });
});

describe("a busy hour is carried over as gaps instead of being skipped", () => {
  it("stops at the page limit, saves where it stopped, and the next run scans that part first and still redelivers what it finds there", async () => {
    const filler = Array.from({ length: 248 }, (_, index) => entry({ age: HOUR + index * 1000, statusCode: 200 }));
    const lost = [entry({ age: 20 * HOUR, statusCode: 503 }), entry({ age: 21 * HOUR, statusCode: 503 })];
    const github = fakeGithub([...filler, ...lost], { answer: 200 });
    const state = memoryState();
    const first = await run(github, state, { maxPages: 2 });
    expect(first).toMatchObject({ status: "ok", gaps: 1 });
    expect(github.calls.redeliver).toEqual([]);
    expect(state.box.value?.gaps).toHaveLength(1);
    expect(state.box.value?.watermark).toBe(iso(NOW));
    await run(github, state, { maxPages: 2 });
    expect(github.calls.redeliver.sort()).toEqual(lost.map((item) => item.id).sort());
    expect(state.box.value?.gaps).toEqual([]);
  });

  it("a failed removal found only inside a saved gap's range is tracked and asked (a mutation that only looked at the newest part would miss it)", async () => {
    const filler = Array.from({ length: 150 }, (_, index) => entry({ age: HOUR + index * 1000, statusCode: 200 }));
    const inGap = entry({ age: 15 * HOUR, statusCode: 503 });
    const github = fakeGithub([...filler, inGap], { answer: 200 });
    const state = memoryState({ watermark: ago(30 * MIN), gaps: [{ cursor: "c100", from: ago(HOUR + 100_000), until: ago(30 * HOUR) }], tracked: [] });
    await run(github, state);
    expect(github.calls.redeliver).toContain(inGap.id);
  });

  it("a page that fails to load in the middle of a scan becomes a gap, and what was read before it is still acted on", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => entry({ age: HOUR + index * 1000, statusCode: 200 }));
    const failed = entry({ age: HOUR / 2, statusCode: 503 });
    const older = entry({ age: 30 * HOUR, statusCode: 503 });
    let down = true;
    const github = fakeGithub([failed, ...filler, older], { answer: 200, listFailsAt: (cursor) => down && cursor !== undefined });
    const state = memoryState();
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ status: "failed", gaps: 1 });
    expect(github.calls.redeliver).toEqual([failed.id]);
    down = false;
    await run(github, state);
    expect(github.calls.redeliver).toContain(older.id);
    expect(state.box.value?.gaps).toEqual([]);
  });

  it("keeps a saved gap when its page cannot be read, and drops one GitHub has certainly forgotten (older than three days)", async () => {
    const github = fakeGithub([entry({ age: HOUR, statusCode: 200 })], { listFailsAt: (cursor) => cursor === "c999" });
    const kept = { cursor: "c999", from: ago(10 * HOUR), until: ago(20 * HOUR) };
    const forgotten = { cursor: "c888", from: ago(80 * HOUR), until: ago(90 * HOUR) };
    const state = memoryState({ watermark: ago(2 * HOUR), gaps: [kept, forgotten], tracked: [] });
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ gaps: 1, droppedGaps: 1 });
    expect(state.box.value?.gaps).toEqual([kept]);
  });

  it("holds at most eight gaps, keeps the OLDEST (GitHub forgets them first) and drops the newest, saying how many (L9)", async () => {
    const gaps = Array.from({ length: 8 }, (_, index) => ({ cursor: `c${900 + index}`, from: ago((index + 10) * HOUR), until: ago((index + 11) * HOUR) }));
    const filler = Array.from({ length: 150 }, (_, index) => entry({ age: HOUR / 2 + index * 1000, statusCode: 200 }));
    const github = fakeGithub(filler, { listFailsAt: (cursor) => cursor !== undefined && cursor.startsWith("c9") });
    const state = memoryState({ watermark: ago(3 * HOUR), gaps, tracked: [] });
    const outcome = await run(github, state, { maxPages: 1 });
    expect(state.box.value!.gaps).toHaveLength(REDELIVERY_MAX_GAPS);
    expect(outcome.droppedGaps).toBeGreaterThanOrEqual(1);
    expect(outcome.status).toBe("failed");
    // The oldest saved gap is still there; the newly made (newest) gap is the one that went.
    expect(state.box.value!.gaps.map((gap) => gap.cursor)).toContain("c907");
    expect(state.box.value!.gaps.some((gap) => gap.cursor === "c100")).toBe(false);
  });

  it("stops listing when the time budget is spent, and keeps the rest as a gap", async () => {
    const clock = { now: NOW };
    const filler = Array.from({ length: 300 }, (_, index) => entry({ age: HOUR + index * 1000, statusCode: 200 }));
    const github = fakeGithub(filler, { clock });
    const original = github.port.list.bind(github.port);
    github.port.list = async (input) => { const answer = await original(input); clock.now += 3_000; return answer; };
    const state = memoryState();
    const outcome = await run(github, state, {}, 5_000);
    expect(outcome.gaps).toBe(1);
    expect(github.calls.list.length).toBeLessThan(3);
  });
});
