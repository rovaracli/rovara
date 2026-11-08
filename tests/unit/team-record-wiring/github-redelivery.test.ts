// SRL-5a: the sweep that asks GitHub to send a failed delete webhook again. The sweep never writes or removes a record row; it only asks GitHub (through the App) to redeliver
// the deliveries that carried a record removal and failed at our side, and the webhook's own tap does the delete. Design: .superpowers/sdd/srl5-github-delete-sweep/design.md.
import { describe, expect, it } from "vitest";
import {
  isRecordRemovalDelivery, runGithubRedelivery, REDELIVERY_MAX_ATTEMPTS, REDELIVERY_MIN_GAP_MS, REDELIVERY_OVERLAP_MS,
  type DeliveriesPort, type DeliveryEntry, type RedeliveryState, type RedeliveryStatePort,
} from "../../../packages/broker/src/team-record/github-redelivery.js";
import { githubEventsOf, type CodeHostRepo } from "../../../packages/broker/src/team-record/sources/index.js";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
let counter = 0;
const guidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function entry(over: Partial<DeliveryEntry> & { age: number }): DeliveryEntry {
  counter += 1;
  const { age, ...rest } = over;
  return { id: 1_000 + counter, guid: guidOf(counter), deliveredAt: ago(age), redelivery: false, event: "issue_comment", action: "deleted", statusCode: 503, ...rest };
}

/** A fake GitHub: entries newest first, pages by position, and a redelivery adds a new entry (answered `answer`) at the top. */
function fakeGithub(initial: DeliveryEntry[], options: { answer?: number; redeliverFails?: (id: number) => boolean; listFailsAt?: (cursor: string | undefined) => boolean; now?: () => number } = {}) {
  const entries = [...initial].sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt));
  const calls = { list: [] as Array<string | undefined>, redeliver: [] as number[] };
  const clock = options.now ?? (() => NOW);
  const port: DeliveriesPort = {
    async list({ cursor, perPage }) {
      calls.list.push(cursor);
      if (options.listFailsAt?.(cursor)) throw new Error("GitHub is down");
      const start = cursor === undefined ? 0 : Number(cursor.slice(1));
      const page = entries.slice(start, start + perPage);
      return { entries: page, ...(start + perPage < entries.length ? { next: `c${start + perPage}` } : {}) };
    },
    async redeliver(id) {
      calls.redeliver.push(id);
      if (options.redeliverFails?.(id)) throw new Error("GitHub refused");
      const original = entries.find((candidate) => candidate.id === id);
      if (original === undefined) return "gone";
      counter += 1;
      entries.unshift({ ...original, id: 5_000 + counter, deliveredAt: new Date(clock()).toISOString(), redelivery: true, statusCode: options.answer ?? 200 });
      return "requested";
    },
  };
  return { port, calls, entries };
}

function memoryState(initial?: RedeliveryState) {
  const box: { value: RedeliveryState | undefined; saves: number; failSave?: boolean; failLoad?: boolean } = { value: initial, saves: 0 };
  const port: RedeliveryStatePort = {
    async load() { if (box.failLoad) throw new Error("table down"); return box.value; },
    async save(next) { if (box.failSave) throw new Error("table down"); box.saves += 1; box.value = next; },
  };
  return { box, port };
}

const run = (github: ReturnType<typeof fakeGithub>, state: ReturnType<typeof memoryState>, extra: Partial<Parameters<typeof runGithubRedelivery>[0]> = {}, budgetMs = 5_000) =>
  runGithubRedelivery({ deliveries: github.port, state: state.port, now: () => NOW, ...extra }, { budgetMs });

describe("which deliveries are record removals", () => {
  it("is a comment delete (both comment events) or a repository delete or transfer, and nothing else", () => {
    expect(isRecordRemovalDelivery("issue_comment", "deleted")).toBe(true);
    expect(isRecordRemovalDelivery("pull_request_review_comment", "deleted")).toBe(true);
    expect(isRecordRemovalDelivery("repository", "deleted")).toBe(true);
    expect(isRecordRemovalDelivery("repository", "transferred")).toBe(true);
    for (const [event, action] of [["issue_comment", "created"], ["issue_comment", "edited"], ["pull_request_review_comment", "edited"], ["repository", "renamed"], ["pull_request", "closed"], ["push", null], ["issue_comment", null], ["installation", "deleted"], ["issues", "deleted"]] as const) {
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
});

describe("the happy path", () => {
  it("asks GitHub to send a failed comment delete again, and moves the watermark to now", async () => {
    const failed = entry({ age: 2 * HOUR, statusCode: 503 });
    const github = fakeGithub([failed]);
    const state = memoryState();
    const outcome = await run(github, state);
    expect(github.calls.redeliver).toEqual([failed.id]);
    expect(outcome).toMatchObject({ status: "ok", redelivered: 1, failed: 0 });
    expect(state.box.value).toEqual({ watermark: new Date(NOW).toISOString(), gaps: [] });
  });

  it("redelivers a repository delete and a transfer, a review comment delete, and a timeout, refused connection, 408, 429 and 5xx", async () => {
    const wanted = [
      entry({ age: HOUR, event: "repository", action: "deleted", statusCode: 500 }),
      entry({ age: HOUR, event: "repository", action: "transferred", statusCode: 502 }),
      entry({ age: HOUR, event: "pull_request_review_comment", action: "deleted", statusCode: 0 }),
      entry({ age: HOUR, statusCode: 408 }),
      entry({ age: HOUR, statusCode: 429 }),
    ];
    const github = fakeGithub(wanted);
    await run(github, memoryState());
    expect(github.calls.redeliver.sort()).toEqual(wanted.map((item) => item.id).sort());
  });

  it("leaves alone what is not a failed record removal: a 2xx, our own 4xx refusals, other events and other actions", async () => {
    const ignored = [
      entry({ age: HOUR, statusCode: 200 }), entry({ age: HOUR, statusCode: 202 }),
      entry({ age: HOUR, statusCode: 400 }), entry({ age: HOUR, statusCode: 401 }), entry({ age: HOUR, statusCode: 403 }), entry({ age: HOUR, statusCode: 404 }),
      entry({ age: HOUR, action: "created" }), entry({ age: HOUR, action: "edited" }), entry({ age: HOUR, action: null }),
      entry({ age: HOUR, event: "push", action: null }), entry({ age: HOUR, event: "pull_request", action: "closed" }),
    ];
    const github = fakeGithub(ignored);
    const outcome = await run(github, memoryState());
    expect(github.calls.redeliver).toEqual([]);
    expect(outcome).toMatchObject({ status: "ok", redelivered: 0 });
  });

  it("does nothing, and fails nothing, when there are no deliveries at all", async () => {
    const github = fakeGithub([]);
    const state = memoryState();
    expect(await run(github, state)).toMatchObject({ status: "ok", redelivered: 0, failed: 0 });
    expect(state.box.value?.watermark).toBe(new Date(NOW).toISOString());
  });
});

describe("it is idempotent and bounded", () => {
  it("a guid that a later attempt delivered (2xx) is not asked for again", async () => {
    const original = entry({ age: 5 * HOUR, statusCode: 503 });
    const later = entry({ age: 3 * HOUR, guid: original.guid, redelivery: true, statusCode: 200 });
    const github = fakeGithub([original, later]);
    await run(github, memoryState());
    expect(github.calls.redeliver).toEqual([]);
  });

  it("two runs in a row ask once: the redelivery that succeeded is seen by the second run", async () => {
    const failed = entry({ age: 2 * HOUR });
    const github = fakeGithub([failed], { answer: 200 });
    const state = memoryState();
    await run(github, state);
    await run(github, state);
    expect(github.calls.redeliver).toEqual([failed.id]);
  });

  it("a redelivery that fails again at our side is asked again by the next run, but not by a run that follows at once", async () => {
    const failed = entry({ age: 2 * HOUR });
    let clock = NOW;
    const github = fakeGithub([failed], { answer: 503, now: () => clock });
    const state = memoryState();
    const at = (time: number) => runGithubRedelivery({ deliveries: github.port, state: state.port, now: () => time }, { budgetMs: 5_000 });
    await at(clock);
    expect(github.calls.redeliver).toHaveLength(1);
    // Ten minutes later: the newest attempt is inside the minimum gap.
    clock = NOW + 10 * MIN;
    await at(clock);
    expect(github.calls.redeliver).toHaveLength(1);
    // An hour later: asked again, and the attempt asked about is the NEWEST one (the redelivery), not the first.
    clock = NOW + HOUR;
    await at(clock);
    expect(github.calls.redeliver).toHaveLength(2);
    expect(github.calls.redeliver[1]).not.toBe(failed.id);
  });

  it("an attempt newer than the minimum gap is left for the next run", async () => {
    const fresh = entry({ age: REDELIVERY_MIN_GAP_MS - MIN });
    const github = fakeGithub([fresh]);
    await run(github, memoryState());
    expect(github.calls.redeliver).toEqual([]);
  });

  it("stops after the most attempts a guid may have had", async () => {
    const guid = guidOf(900);
    const attempts = Array.from({ length: REDELIVERY_MAX_ATTEMPTS }, (_, index) => entry({ age: HOUR + index * MIN, guid, statusCode: 503, redelivery: index > 0 }));
    const github = fakeGithub(attempts);
    const outcome = await run(github, memoryState());
    expect(github.calls.redeliver).toEqual([]);
    expect(outcome.exhausted).toBe(1);
  });

  it("looks back no further than the watermark less the overlap, so the work stays proportional to the time since the last run", async () => {
    const recent = entry({ age: HOUR });
    const old = entry({ age: 30 * HOUR });
    const github = fakeGithub([recent, old]);
    const state = memoryState({ watermark: ago(2 * HOUR), gaps: [] });
    await run(github, state);
    expect(github.calls.redeliver).toEqual([recent.id]);
    // The entry older than watermark - overlap was never needed.
    expect(Date.parse(old.deliveredAt)).toBeLessThan(NOW - 2 * HOUR - REDELIVERY_OVERLAP_MS);
  });

  it("with no watermark (the first run) it goes back through everything GitHub still holds, and asks for each failed removal", async () => {
    const items = [entry({ age: 70 * HOUR }), entry({ age: 40 * HOUR }), entry({ age: 2 * HOUR })];
    const github = fakeGithub(items);
    await run(github, memoryState());
    expect(github.calls.redeliver.sort()).toEqual(items.map((item) => item.id).sort());
  });

  it("asks for at most the per-run limit, oldest first, and holds the watermark at the first one it left, so the next run finishes", async () => {
    const items = [entry({ age: 5 * HOUR }), entry({ age: 4 * HOUR }), entry({ age: 3 * HOUR })];
    const github = fakeGithub(items, { answer: 200 });
    const state = memoryState();
    const first = await run(github, state, { maxRedeliveries: 2 });
    expect(github.calls.redeliver).toEqual([items[0]!.id, items[1]!.id]);
    expect(first.deferred).toBe(1);
    expect(Date.parse(state.box.value!.watermark!)).toBeLessThanOrEqual(Date.parse(items[2]!.deliveredAt));
    await run(github, state, { maxRedeliveries: 2 });
    expect(github.calls.redeliver).toHaveLength(3);
    expect(github.calls.redeliver[2]).toBe(items[2]!.id);
  });
});

describe("errors never delete anything and never lose a failed delete", () => {
  it("a redelivery request that fails is counted, the others still go, and the watermark stays at the failed delivery so the next run asks again", async () => {
    const bad = entry({ age: 4 * HOUR });
    const good = entry({ age: 3 * HOUR });
    const github = fakeGithub([bad, good], { redeliverFails: (id) => id === bad.id, answer: 200 });
    const state = memoryState();
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ status: "failed", redelivered: 1, failed: 1 });
    expect(github.calls.redeliver.sort()).toEqual([bad.id, good.id].sort());
    expect(Date.parse(state.box.value!.watermark!)).toBeLessThanOrEqual(Date.parse(bad.deliveredAt));
    // GitHub works again.
    const healed = fakeGithub(github.entries.filter((item) => !item.redelivery), { answer: 200 });
    await run(healed, state);
    expect(healed.calls.redeliver).toContain(bad.id);
  });

  it("GitHub being down on the first page changes nothing and asks for nothing", async () => {
    const github = fakeGithub([entry({ age: 2 * HOUR })], { listFailsAt: () => true });
    const state = memoryState({ watermark: ago(3 * HOUR), gaps: [] });
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

  it("a delivery GitHub no longer has is done, not a failure", async () => {
    const gone = entry({ age: 2 * HOUR });
    const github = fakeGithub([gone]);
    github.port.redeliver = async () => "gone";
    const outcome = await run(github, memoryState());
    expect(outcome).toMatchObject({ status: "ok", failed: 0 });
  });

  it("never calls anything but the list and the redelivery: no record port is even passed in", async () => {
    const github = fakeGithub([entry({ age: 2 * HOUR })]);
    const keys = Object.keys({ deliveries: github.port, state: memoryState().port, now: () => NOW });
    expect(keys).toEqual(["deliveries", "state", "now"]);
  });
});

describe("a busy hour is carried over as gaps instead of being skipped", () => {
  it("stops at the page limit, saves where it stopped, and the next run scans that part first and still redelivers what it finds there", async () => {
    // 250 deliveries, the oldest two are failed removals. 100 a page, 2 pages allowed.
    const filler = Array.from({ length: 248 }, (_, index) => entry({ age: HOUR + index * 1000, statusCode: 200 }));
    const lost = [entry({ age: 20 * HOUR, statusCode: 503 }), entry({ age: 21 * HOUR, statusCode: 503 })];
    const github = fakeGithub([...filler, ...lost], { answer: 200 });
    const state = memoryState();
    const first = await run(github, state, { maxPages: 2 });
    expect(first).toMatchObject({ status: "ok", gaps: 1 });
    expect(github.calls.redeliver).toEqual([]);
    expect(state.box.value?.gaps).toHaveLength(1);
    expect(state.box.value?.watermark).toBe(new Date(NOW).toISOString());
    await run(github, state, { maxPages: 2 });
    expect(github.calls.redeliver.sort()).toEqual(lost.map((item) => item.id).sort());
    expect(state.box.value?.gaps).toEqual([]);
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
    const state = memoryState({ watermark: ago(2 * HOUR), gaps: [kept, forgotten] });
    const outcome = await run(github, state);
    expect(outcome).toMatchObject({ gaps: 1, droppedGaps: 1 });
    expect(state.box.value?.gaps).toEqual([kept]);
  });

  it("holds at most eight gaps and says so when it drops one", async () => {
    const gaps = Array.from({ length: 8 }, (_, index) => ({ cursor: `c${900 + index}`, from: ago((index + 2) * HOUR), until: ago((index + 3) * HOUR) }));
    const filler = Array.from({ length: 150 }, (_, index) => entry({ age: HOUR / 2 + index * 1000, statusCode: 200 }));
    const github = fakeGithub(filler, { listFailsAt: (cursor) => cursor !== undefined && cursor.startsWith("c9") });
    const state = memoryState({ watermark: ago(3 * HOUR), gaps });
    const outcome = await run(github, state, { maxPages: 1 });
    expect(state.box.value!.gaps.length).toBeLessThanOrEqual(8);
    expect(outcome.droppedGaps).toBeGreaterThanOrEqual(1);
  });

  it("stops listing when the time budget is spent, and keeps the rest as a gap", async () => {
    let clock = NOW;
    const filler = Array.from({ length: 300 }, (_, index) => entry({ age: HOUR + index * 1000, statusCode: 200 }));
    const github = fakeGithub(filler);
    const original = github.port.list.bind(github.port);
    github.port.list = async (input) => { const answer = await original(input); clock += 3_000; return answer; };
    const state = memoryState();
    const outcome = await runGithubRedelivery({ deliveries: github.port, state: state.port, now: () => clock }, { budgetMs: 5_000 });
    expect(outcome.gaps).toBe(1);
    expect(github.calls.list.length).toBeLessThan(3);
  });
});
