// S3-9: the lighter flow's reviewer call and meter on Cloud (cloud/app/tier-review.ts). The money and fail-closed rules, each on fake ports: the meter refuses before any call when the task has no
// captured payer, no company-billed source serves a model, or the payer's budget has no room; the call is made only right after its own meter, for the same purpose and model, and never for another task.
import { describe, expect, it } from "vitest";
import type { Payer } from "@rovara-code/contracts";
import { REVIEW_LIMITS } from "../../packages/broker/src/model-proxy/protocol.js";
import { TIER_REVIEW_MAX_CALL_USD, TIER_REVIEW_TICKET_MS, TIER_REVIEW_UNPRICED_HOLD_USD, createCloudTierReview, tierReviewHoldUsd, type TierReviewPorts, type TierReviewRoute } from "../../packages/broker/src/cloud/app/tier-review.js";

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
}

function world(overrides: Partial<World> = {}) {
  const w: World = { clock: { now: 1_000_000 }, calls: [], logs: [], payers: new Map([["task-a", MEMBER], ["task-b", { kind: "project", project: "web" }]]), room: 10, route: ROUTE, ...overrides };
  const ports: TierReviewPorts = {
    task: async (taskId) => { await w.gate; const payer = w.payers.get(taskId); return payer === undefined ? undefined : { project: "web", payer }; },
    route: async () => w.route,
    room: async () => { if (w.room instanceof Error) throw w.room; return w.room; },
    call: async ({ taskId, payer, purpose, holdUsd, prompt }) => { w.calls.push({ taskId, payer, purpose, holdUsd, prompt }); return "[]"; },
  };
  const review = createCloudTierReview({ ports, now: () => w.clock.now, log: (event, fields) => { w.logs.push({ event, ...fields }); } });
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
    for (const room of [0, tierReviewHoldUsd(SONNET, 100) / 2]) {
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
    const room = tierReviewHoldUsd(SONNET, 100 + 8_000) * 1.01;
    const short = world({ room });
    expect(await short.tierReviewMeter(meterInput("task-a"))).toBe(true);
    await expect(short.tierReviewCall(ask("questions", "x".repeat(200_000)))).rejects.toThrow(/budget cannot take/u);

    for (const t of [aborted, long, short]) expect(t.w.calls).toEqual([]);
  });

  it("the hold: the model's worst case on its list price with the margin; a model with no list price holds the fixed estimate; the ceiling refuses a dearer call", async () => {
    expect(tierReviewHoldUsd({ provider: "anthropic", modelId: "acme-tuned-1" }, 1000)).toBe(TIER_REVIEW_UNPRICED_HOLD_USD);
    expect(tierReviewHoldUsd(SONNET, 1000)).toBeGreaterThan(0);
    const opus = { provider: "openai", modelId: "gpt-5-pro" };
    const huge = tierReviewHoldUsd(opus, REVIEW_LIMITS.userChars);
    expect(huge).toBeGreaterThan(TIER_REVIEW_MAX_CALL_USD);
    const t = world({ route: { ...ROUTE, model: opus }, room: 1_000 });
    expect(await t.tierReviewMeter({ ...meterInput("task-a"), promptChars: REVIEW_LIMITS.userChars })).toBe(false);
    expect(t.w.logs).toContainEqual(expect.objectContaining({ why: "too_dear" }));
  });
});
