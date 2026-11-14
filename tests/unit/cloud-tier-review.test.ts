// S3-9: the lighter flow's reviewer call and meter on Cloud (cloud/app/tier-review.ts). The money and fail-closed rules, each on fake ports: the meter refuses before any call when the task has no
// captured payer, no company-billed source serves a model, or the payer's budget has no room; the call is made only right after its own meter, for the same purpose and model, and never for another task.
import { describe, expect, it } from "vitest";
import type { Payer } from "@rovara-code/contracts";
import { REVIEW_LIMITS } from "../../packages/broker/src/model-proxy/protocol.js";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { TIER_REVIEW_MAX_CALL_USD, TIER_REVIEW_TICKET_MS, createCloudTierReview, tierReviewCallBlocked, tierReviewHoldUsd, type TierReviewPorts, type TierReviewRoute } from "../../packages/broker/src/cloud/app/tier-review.js";
import { memoryCallLedger, type MemoryCallLedger } from "../support/tier-review-calls.js";

const SONNET = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
const ROUTE: TierReviewRoute = { model: SONNET, alias: "org-src-sonnet", sourceId: "src_aaaaaaaaaaaaaaaaaaaa", api: "anthropic-messages" };
const MEMBER: Payer = { kind: "member", developerId: "a".repeat(64) };

interface World {
  clock: { now: number };
  calls: Array<{ taskId: string; payer: Payer; purpose: string; holdUsd: number; prompt: string }>;
  logs: Array<Record<string, unknown>>;
  payers: Map<string, Payer>;
  room: number | Error;
  route: TierReviewRoute | undefined;
  /** Held open while set: the next `task` read waits for it (two meters in flight). */
  gate?: Promise<void>;
  /** The host's deadline (epoch ms); undefined: no pass is running. Default: 14 minutes ahead. */
  deadline: number | undefined;
  ledger: MemoryCallLedger;
  /** What the port's call does: answer (default), or fail before or after the prompt is sent. */
  behaviour: "answer" | "fail_before_send" | "fail_after_send";
}

function world(overrides: Partial<World> = {}) {
  const w: World = { clock: { now: 1_000_000 }, calls: [], logs: [], payers: new Map([["task-a", MEMBER], ["task-b", { kind: "project", project: "web" }]]), room: 10, route: ROUTE, deadline: 1_000_000 + 14 * 60_000, ledger: memoryCallLedger(), behaviour: "answer", ...overrides };
  const ports: TierReviewPorts = {
    task: async (taskId) => { await w.gate; const payer = w.payers.get(taskId); return payer === undefined ? undefined : { project: "web", payer }; },
    route: async () => w.route,
    room: async () => { if (w.room instanceof Error) throw w.room; return w.room; },
    call: async ({ taskId, payer, purpose, holdUsd, prompt, sent }) => {
      if (w.behaviour === "fail_before_send") throw new Error("the key could not be minted");
      await sent();
      w.calls.push({ taskId, payer, purpose, holdUsd, prompt });
      if (w.behaviour === "fail_after_send") throw new Error("the provider dropped the connection");
      return "[]";
    },
    calls: w.ledger,
  };
  const review = createCloudTierReview({ ports, now: () => w.clock.now, deadline: () => w.deadline, log: (event, fields) => { w.logs.push({ event, ...fields }); } });
  return { w, ...review };
}
const signal = () => new AbortController().signal;
const ask = (purpose: "questions" | "code_review" | "security_review" = "questions", prompt = "the prompt") => ({ model: undefined, prompt, purpose, signal: signal() });
const meterInput = (taskId: string, purpose: "questions" | "code_review" | "security_review" = "questions") => ({ taskId, purpose, model: undefined, promptChars: 100 });

describe("the meter refuses before any call (fail closed, zero calls)", () => {
  it("a task with no captured payer: refused, and the call that would follow is not made", async () => {
    const t = world();
    expect(await t.tierReviewMeter(meterInput("task-unknown"))).toBe(false);
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/not metered/u);
    expect(t.w.calls).toEqual([]);
    expect(t.w.logs).toContainEqual(expect.objectContaining({ event: "tier_review.refused", why: "no_payer" }));
  });

  it("no company-billed source serves a model (the provider is missing or down): refused, zero calls", async () => {
    const t = world({ route: undefined });
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(false);
    await expect(t.tierReviewCall(ask())).rejects.toThrow();
    expect(t.w.calls).toEqual([]);
  });

  it("the payer's month is used up (the budget read refuses): refused with its code, zero calls", async () => {
    const t = world({ room: Object.assign(new Error("used up"), { code: "ORG_BUDGET_EXCEEDED" }) });
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(false);
    await expect(t.tierReviewCall(ask())).rejects.toThrow();
    expect(t.w.calls).toEqual([]);
    expect(t.w.logs).toContainEqual(expect.objectContaining({ why: "no_budget:ORG_BUDGET_EXCEEDED" }));
  });

  it("a room smaller than the call could hold, or none at all: refused, zero calls", async () => {
    for (const room of [0, tierReviewHoldUsd(SONNET, 100)! / 2]) {
      const t = world({ room });
      expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(false);
      await expect(t.tierReviewCall(ask())).rejects.toThrow();
      expect(t.w.calls).toEqual([]);
    }
  });

  it("a port that throws is a refusal, never a pass", async () => {
    const t = world();
    t.w.payers = { get: () => { throw new Error("table down"); } } as never;
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(false);
    expect(t.w.calls).toEqual([]);
  });
});

describe("the call is made only right after its own meter, charged to that task's payer", () => {
  it("metered: the one call goes to the port with the task's payer, project, route and a hold sized to the prompt", async () => {
    const t = world();
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(true);
    expect(await t.tierReviewCall(ask("questions", "x".repeat(1000)))).toBe("[]");
    expect(t.w.calls).toHaveLength(1);
    expect(t.w.calls[0]).toMatchObject({ taskId: "task-a", payer: MEMBER, purpose: "questions", holdUsd: tierReviewHoldUsd(SONNET, 1000) });
  });

  it("a ticket is used once: a second call without a meter is refused", async () => {
    const t = world();
    await t.tierReviewMeter(meterInput("task-a"));
    await t.tierReviewCall(ask());
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/not metered/u);
    expect(t.w.calls).toHaveLength(1);
  });

  it("a call for another purpose or model than its meter is refused", async () => {
    const t = world();
    await t.tierReviewMeter(meterInput("task-a", "questions"));
    await expect(t.tierReviewCall(ask("security_review"))).rejects.toThrow(/does not match/u);
    await t.tierReviewMeter(meterInput("task-a", "questions"));
    await expect(t.tierReviewCall({ ...ask("questions"), model: SONNET })).rejects.toThrow(/does not match/u);
    expect(t.w.calls).toEqual([]);
  });

  it("a ticket older than its window (its call never came) is not used", async () => {
    const t = world();
    await t.tierReviewMeter(meterInput("task-a"));
    t.w.clock.now += TIER_REVIEW_TICKET_MS;
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/not metered/u);
    expect(t.w.calls).toEqual([]);
  });

  it("the ticket's window is ten seconds, whatever the constant says: a call 10 s after its meter is refused, one 9.9 s after is made", async () => {
    expect(TIER_REVIEW_TICKET_MS).toBe(10_000);
    const late = world();
    await late.tierReviewMeter(meterInput("task-a"));
    late.w.clock.now += 10_000;
    await expect(late.tierReviewCall(ask())).rejects.toThrow(/not metered/u);
    const prompt = world();
    await prompt.tierReviewMeter(meterInput("task-a"));
    prompt.w.clock.now += 9_900;
    await expect(prompt.tierReviewCall(ask())).resolves.toBe("[]");
  });

  it("two tasks never swap tickets: while task A's ticket waits for its call, task B's meter refuses, and A's call is charged to A", async () => {
    const t = world();
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(true);
    expect(await t.tierReviewMeter(meterInput("task-b"))).toBe(false);
    await t.tierReviewCall(ask());
    expect(t.w.calls.map((call) => call.taskId)).toEqual(["task-a"]);
    // A's ticket is used: B may now be metered and called, and is charged to B's own payer.
    expect(await t.tierReviewMeter(meterInput("task-b"))).toBe(true);
    await t.tierReviewCall(ask());
    expect(t.w.calls.map((call) => [call.taskId, call.payer.kind])).toEqual([["task-a", "member"], ["task-b", "project"]]);
  });

  it("two meters in flight at once: the second refuses, so no call can take the other task's ticket", async () => {
    const t = world();
    let open!: () => void;
    t.w.gate = new Promise<void>((resolve) => { open = resolve; });
    const first = t.tierReviewMeter(meterInput("task-a"));
    expect(await t.tierReviewMeter(meterInput("task-b"))).toBe(false);
    // A call made while a meter is still running is refused too.
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/not metered/u);
    open();
    expect(await first).toBe(true);
  });

  it("an aborted signal, a prompt over the reviewer limit, a hold over the per-call ceiling or over the metered room: refused before the port", async () => {
    const aborted = world();
    await aborted.tierReviewMeter(meterInput("task-a"));
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.tierReviewCall({ ...ask(), signal: controller.signal })).rejects.toThrow(/time ran out/u);

    const long = world();
    await long.tierReviewMeter(meterInput("task-a"));
    await expect(long.tierReviewCall(ask("questions", "x".repeat(REVIEW_LIMITS.userChars + 1)))).rejects.toThrow(/too large/u);

    // A prompt far bigger than the meter was told (the patch's size): its hold is over the room the meter saw.
    const room = tierReviewHoldUsd(SONNET, 100 + 8_000)! * 1.01;
    const short = world({ room });
    expect(await short.tierReviewMeter(meterInput("task-a"))).toBe(true);
    await expect(short.tierReviewCall(ask("questions", "x".repeat(200_000)))).rejects.toThrow(/budget cannot take/u);

    for (const t of [aborted, long, short]) expect(t.w.calls).toEqual([]);
  });

  it("the hold: the model's worst case on its list price with the margin; a model with no list price has none (it is never called); the ceiling refuses a dearer call", async () => {
    expect(tierReviewHoldUsd({ provider: "anthropic", modelId: "acme-tuned-1" }, 1000)).toBeUndefined();
    expect(tierReviewHoldUsd(SONNET, 1000)).toBeGreaterThan(0);
    const opus = { provider: "openai", modelId: "gpt-5-pro" };
    const huge = tierReviewHoldUsd(opus, REVIEW_LIMITS.userChars);
    expect(huge).toBeGreaterThan(TIER_REVIEW_MAX_CALL_USD);
    const t = world({ route: { ...ROUTE, model: opus }, room: 1_000 });
    expect(await t.tierReviewMeter({ ...meterInput("task-a"), promptChars: REVIEW_LIMITS.userChars })).toBe(false);
    expect(t.w.logs).toContainEqual(expect.objectContaining({ why: "too_dear" }));
  });
});


describe("review survivors: the per-call ceiling, the margin", () => {
  it("the $5 ceiling refuses at the CALL too: a meter that saw a small patch, then a prompt whose hold is over $5, is not sent (whatever the room)", async () => {
    expect(TIER_REVIEW_MAX_CALL_USD).toBe(5);
    const opus = { provider: "openai", modelId: "gpt-5-pro" };
    const t = world({ route: { ...ROUTE, model: opus }, room: 1_000 });
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(true);
    // A prompt whose worst case is between $5 and the room: only the ceiling refuses it.
    let chars = 1_000;
    while ((tierReviewHoldUsd(opus, chars) ?? 0) <= 5) chars *= 2;
    expect(tierReviewHoldUsd(opus, chars)!).toBeLessThan(1_000);
    expect(chars).toBeLessThanOrEqual(REVIEW_LIMITS.userChars);
    await expect(t.tierReviewCall(ask("questions", "x".repeat(chars)))).rejects.toThrow(/more than one call may/u);
    expect(t.w.calls).toEqual([]);
  });

  it("the hold is the worst case on the list price times 1.25 (rounded up to a millionth of a dollar)", () => {
    const price = listPricesPerMillion(SONNET)!;
    const bytes = 40_000;
    const worst = ((bytes + 256) * price.input + 8_000 * price.output) / 1_000_000;
    expect(tierReviewHoldUsd(SONNET, bytes)).toBe(Math.ceil(worst * 1.25 * 1e6) / 1e6);
  });
});

describe("H1a: no call is started that the host could not wait for", () => {
  it("no deadline (no tier pass is running here: the broker, any other job): the meter refuses no_time, zero calls, no key", async () => {
    const t = world({ deadline: undefined });
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(false);
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/not metered/u);
    expect(t.w.calls).toEqual([]);
    expect(t.w.ledger.writes).toEqual([]);
    expect(t.w.logs).toContainEqual(expect.objectContaining({ event: "tier_review.refused", why: "no_time" }));
  });

  it("less than 140 s left (the reviewer's 120 s wait and the function's 130 s): refused; exactly 140 s: metered and called", async () => {
    const short = world();
    short.w.deadline = short.w.clock.now + 139_999;
    expect(await short.tierReviewMeter(meterInput("task-a"))).toBe(false);
    expect(short.w.logs).toContainEqual(expect.objectContaining({ why: "no_time" }));
    const enough = world();
    enough.w.deadline = enough.w.clock.now + 140_000;
    expect(await enough.tierReviewMeter(meterInput("task-a"))).toBe(true);
    await expect(enough.tierReviewCall(ask())).resolves.toBe("[]");
  });

  it("the time ran short between the meter and the call: the call is refused before any claim or key", async () => {
    const t = world();
    t.w.deadline = t.w.clock.now + 145_000;
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(true);
    t.w.clock.now += 6_000;
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/time ran out/u);
    expect(t.w.ledger.writes).toEqual([]);
    expect(t.w.calls).toEqual([]);
  });
});

describe("H1b: one reviewer call at a time per task and purpose, durably", () => {
  it("the claim is written before the call, `sent` before the prompt leaves, and the outcome after", async () => {
    const t = world();
    await t.tierReviewMeter(meterInput("task-a"));
    await t.tierReviewCall(ask());
    expect(t.w.ledger.writes).toEqual(["claim:task-a:questions", "mark:sent", "mark:answered"]);
    expect(t.w.ledger.rows.get("task-a|questions")).toMatchObject({ status: "answered" });
  });

  it("a call whose host died mid-call (claimed or sent, no outcome) holds its task and purpose for 10 minutes: the meter refuses (no key, no call), then frees it", async () => {
    for (const status of ["started", "sent"] as const) {
      const t = world();
      t.w.ledger.rows.set("task-a|questions", { callId: "dead", status, startedAt: t.w.clock.now - 60_000 });
      expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(false);
      expect(t.w.logs).toContainEqual(expect.objectContaining({ why: "in_flight" }));
      // Another purpose of the same task is not held.
      expect(await t.tierReviewMeter(meterInput("task-a", "code_review"))).toBe(true);
      await t.tierReviewCall(ask("code_review"));
      // Ten minutes after the dead call started, it is free again.
      t.w.clock.now += 9 * 60_000 - 1;
      expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(false);
      t.w.clock.now += 1;
      expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(true);
    }
  });

  it("two passes that both metered (the read said free): the second claim is refused and makes no call", async () => {
    const t = world();
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(true);
    // Another pass (another container) claims the same task and purpose between this meter and its call.
    await t.w.ledger.claim({ taskId: "task-a", purpose: "questions", callId: "other", at: t.w.clock.now });
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/still running/u);
    expect(t.w.calls).toEqual([]);
  });

  it("Code's fast-fail retry of a call that FAILED AFTER IT WAS SENT is refused (the provider may have billed it); a call that failed before sending may be retried", async () => {
    const sentThenFailed = world({ behaviour: "fail_after_send" });
    await sentThenFailed.tierReviewMeter(meterInput("task-a"));
    await expect(sentThenFailed.tierReviewCall(ask())).rejects.toThrow(/dropped/u);
    expect(sentThenFailed.w.ledger.rows.get("task-a|questions")).toMatchObject({ status: "failed_sent" });
    sentThenFailed.w.clock.now += 1_000;
    expect(await sentThenFailed.tierReviewMeter(meterInput("task-a"))).toBe(false);
    expect(sentThenFailed.w.logs).toContainEqual(expect.objectContaining({ why: "sent_and_failed" }));
    expect(sentThenFailed.w.calls).toHaveLength(1);
    // A later pass may ask again once the first backoff (5 minutes from the failure) is over, not before.
    sentThenFailed.w.clock.now += 5 * 60_000 - 1_001;
    expect(await sentThenFailed.tierReviewMeter(meterInput("task-a"))).toBe(false);
    sentThenFailed.w.clock.now += 1;
    sentThenFailed.w.behaviour = "answer";
    expect(await sentThenFailed.tierReviewMeter(meterInput("task-a"))).toBe(true);

    const unsent = world({ behaviour: "fail_before_send" });
    await unsent.tierReviewMeter(meterInput("task-a"));
    await expect(unsent.tierReviewCall(ask())).rejects.toThrow(/could not be minted/u);
    expect(unsent.w.ledger.rows.get("task-a|questions")).toMatchObject({ status: "failed_unsent" });
    unsent.w.clock.now += 1_000;
    expect(await unsent.tierReviewMeter(meterInput("task-a"))).toBe(true);
  });

  it("a `sent` record that cannot be written stops the call before the prompt leaves", async () => {
    const t = world();
    const mark = t.w.ledger.mark.bind(t.w.ledger);
    t.w.ledger.mark = async (input) => { if (input.status === "sent") throw new Error("table down"); await mark(input); };
    await t.tierReviewMeter(meterInput("task-a"));
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/table down/u);
    expect(t.w.calls).toEqual([]);
    expect(t.w.ledger.rows.get("task-a|questions")).toMatchObject({ status: "failed_unsent" });
  });

  it("the rule itself: answered and failed-unsent free at once; failed-sent after its backoff (5 min after the 1st failure, 20 min after the 2nd); started or sent after 10 minutes", () => {
    const now = 10_000_000;
    expect(tierReviewCallBlocked(undefined, now)).toBeUndefined();
    expect(tierReviewCallBlocked({ callId: "c", status: "answered", startedAt: now, endedAt: now }, now)).toBeUndefined();
    expect(tierReviewCallBlocked({ callId: "c", status: "failed_unsent", startedAt: now, endedAt: now }, now)).toBeUndefined();
    expect(tierReviewCallBlocked({ callId: "c", status: "failed_sent", startedAt: now - 5, endedAt: now - 299_999, failures: 1 }, now)).toBe("sent_and_failed");
    expect(tierReviewCallBlocked({ callId: "c", status: "failed_sent", startedAt: now - 5, endedAt: now - 300_000, failures: 1 }, now)).toBeUndefined();
    expect(tierReviewCallBlocked({ callId: "c", status: "failed_sent", startedAt: now - 5, endedAt: now - 1_199_999, failures: 2 }, now)).toBe("sent_and_failed");
    expect(tierReviewCallBlocked({ callId: "c", status: "failed_sent", startedAt: now - 5, endedAt: now - 1_200_000, failures: 2 }, now)).toBeUndefined();
    expect(tierReviewCallBlocked({ callId: "c", status: "sent", startedAt: now - 599_999 }, now)).toBe("in_flight");
    expect(tierReviewCallBlocked({ callId: "c", status: "started", startedAt: now - 600_000 }, now)).toBeUndefined();
  });
});

describe("attempt cap and backoff: calls that failed AFTER being sent (the provider may bill each)", () => {
  /** One pass of a task whose reviewer call fails after it was sent: meter, then call. Answers what the meter said. */
  const failingPass = async (t: ReturnType<typeof world>): Promise<boolean> => {
    t.w.deadline = t.w.clock.now + 14 * 60_000;
    if (!(await t.tierReviewMeter(meterInput("task-a")))) return false;
    await expect(t.tierReviewCall(ask())).rejects.toThrow(/dropped/u);
    return true;
  };

  it("a persistently failing task is called at most 3 times in its day: after 5 min, after 20 min, then `too_many_failures` (no key, no call)", async () => {
    const t = world({ behaviour: "fail_after_send" });
    expect(await failingPass(t)).toBe(true);
    expect(t.w.ledger.rows.get("task-a|questions")).toMatchObject({ status: "failed_sent", failures: 1 });
    // The schedule ticks again at once and a minute on: held by the first backoff.
    t.w.clock.now += 60_000;
    expect(await failingPass(t)).toBe(false);
    t.w.clock.now += 4 * 60_000;
    expect(await failingPass(t)).toBe(true);
    expect(t.w.ledger.rows.get("task-a|questions")).toMatchObject({ failures: 2 });
    // The second backoff is 20 minutes, not 5.
    t.w.clock.now += 5 * 60_000;
    expect(await failingPass(t)).toBe(false);
    t.w.clock.now += 15 * 60_000 - 1;
    expect(await failingPass(t)).toBe(false);
    t.w.clock.now += 1;
    expect(await failingPass(t)).toBe(true);
    expect(t.w.ledger.rows.get("task-a|questions")).toMatchObject({ failures: 3 });
    expect(t.w.calls).toHaveLength(3);
    // The cap: no pass, however much later within the row's day, makes a fourth call.
    for (const later of [1_000, 60 * 60_000, 23 * 60 * 60_000]) {
      t.w.clock.now += later;
      t.w.logs.length = 0;
      expect(await failingPass(t)).toBe(false);
      expect(t.w.logs).toContainEqual(expect.objectContaining({ event: "tier_review.refused", why: "too_many_failures" }));
    }
    expect(t.w.calls).toHaveLength(3);
    // Another purpose of the same task has its own row, and is not capped.
    expect(await t.tierReviewMeter(meterInput("task-a", "code_review"))).toBe(true);
  });

  it("the cap holds even when the meter's read said free: the claim refuses a capped row (no call)", async () => {
    const t = world();
    t.w.ledger.rows.set("task-a|questions", { callId: "old", status: "failed_sent", startedAt: 1, endedAt: 2, failures: 3 });
    expect(await t.w.ledger.claim({ taskId: "task-a", purpose: "questions", callId: "x", at: t.w.clock.now })).toBe(false);
  });

  it("failures before the send (unsent) are not counted, and an answered outcome resets the count", async () => {
    const unsent = world({ behaviour: "fail_before_send" });
    for (let pass = 0; pass < 5; pass += 1) {
      expect(await unsent.tierReviewMeter(meterInput("task-a"))).toBe(true);
      await expect(unsent.tierReviewCall(ask())).rejects.toThrow(/could not be minted/u);
    }
    expect(unsent.w.ledger.rows.get("task-a|questions")?.failures ?? 0).toBe(0);

    const t = world({ behaviour: "fail_after_send" });
    expect(await failingPass(t)).toBe(true);
    t.w.clock.now += 5 * 60_000;
    expect(await failingPass(t)).toBe(true);
    expect(t.w.ledger.rows.get("task-a|questions")).toMatchObject({ failures: 2 });
    t.w.clock.now += 20 * 60_000;
    t.w.behaviour = "answer";
    t.w.deadline = t.w.clock.now + 14 * 60_000;
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(true);
    await t.tierReviewCall(ask());
    expect(t.w.ledger.rows.get("task-a|questions")).toMatchObject({ status: "answered", failures: 0 });
    // The count started over: three more failures are allowed again, with the first backoff.
    t.w.behaviour = "fail_after_send";
    expect(await failingPass(t)).toBe(true);
    t.w.clock.now += 5 * 60_000;
    expect(await failingPass(t)).toBe(true);
    t.w.clock.now += 20 * 60_000;
    expect(await failingPass(t)).toBe(true);
    expect(t.w.ledger.rows.get("task-a|questions")).toMatchObject({ failures: 3 });
  });

  it("an answered outcome recorded for a capped row lifts the cap (a late answer of a call that was still in flight)", async () => {
    const t = world();
    t.w.ledger.rows.set("task-a|questions", { callId: "late", status: "sent", startedAt: t.w.clock.now - 1, failures: 2 });
    await t.w.ledger.mark({ taskId: "task-a", purpose: "questions", callId: "late", status: "answered", at: t.w.clock.now });
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(true);
  });

  it("the rule over every state: failures and status decide, the cap beats everything but an answer", () => {
    const now = 100_000_000;
    const states = ["started", "sent", "answered", "failed_unsent", "failed_sent"] as const;
    for (const status of states) {
      for (const failures of [undefined, 0, 1, 2, 3, 4]) {
        for (const age of [0, 299_999, 300_000, 1_199_999, 1_200_000, 599_999, 600_000]) {
          const row = { callId: "c", status, startedAt: now - age, endedAt: now - age, ...(failures === undefined ? {} : { failures }) };
          const counted = Math.max(failures ?? 0, status === "failed_sent" ? 1 : 0);
          const blocked = tierReviewCallBlocked(row, now);
          if (status === "answered") expect(blocked, JSON.stringify(row)).toBeUndefined();
          else if (counted >= 3) expect(blocked, JSON.stringify(row)).toBe("too_many_failures");
          else if (status === "failed_unsent") expect(blocked, JSON.stringify(row)).toBeUndefined();
          else if (status === "failed_sent") expect(blocked, JSON.stringify(row)).toBe(age < (counted >= 2 ? 1_200_000 : 300_000) ? "sent_and_failed" : undefined);
          else expect(blocked, JSON.stringify(row)).toBe(age < 600_000 ? "in_flight" : undefined);
        }
      }
    }
  });
});

describe("M3: a model with no list price is never called", () => {
  it("the meter refuses `unpriced`, zero calls", async () => {
    const t = world({ route: { ...ROUTE, model: { provider: "anthropic", modelId: "acme-tuned-1" } } });
    expect(await t.tierReviewMeter(meterInput("task-a"))).toBe(false);
    expect(t.w.logs).toContainEqual(expect.objectContaining({ why: "unpriced" }));
    expect(t.w.calls).toEqual([]);
  });
});
