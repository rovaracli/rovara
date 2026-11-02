// Live interaction A3 (LA-3): the glue in the chat service between a queued Ask and its hosted turn (`main.ts` starts the service when it is imported, so the glue is its own module, and `main.ts` is
// checked to use it). What is proved: the turn is a read-only, no-session answer turn for the broker's context; the model key is asked for on the Ask's own route and on no other; the Ask is remembered
// only while its turn runs (also when it throws); two Asks at once do not mix.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AskRef, AskTurnResult } from "../../packages/contracts/src/index.js";
import { createAskGlue } from "../../packages/slack-service/src/ask-glue.js";
import type { TurnInput } from "../../packages/slack-service/src/processor.js";

const REF: AskRef = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", sessionId: "ses_aaaaaaaaaaaaaaaaaaaa", askId: "ask_aaaaaaaaaaaaaaaaaaaa" };
const OTHER: AskRef = { orgId: "org_bbbbbbbbbbbbbbbbbbbb", sessionId: "ses_bbbbbbbbbbbbbbbbbbbb", askId: "ask_bbbbbbbbbbbbbbbbbbbb" };
const TURN: AskTurnResult = { workspaceId: "11111111-1111-4111-8111-111111111111", orchestratorInstructions: "Be brief.", taskContext: "RULES\nThe task data." };
const EVENT = "Ev0123456789abcdef0123456789abcdef";

describe("the Ask glue of the chat service", () => {
  it("runs a no-tools, no-session answer turn for the broker's context, under the Ask's own subject", async () => {
    const seen: Array<{ input: TurnInput; ask: AskRef }> = [];
    const glue = createAskGlue({ runTurn: async (input, ask) => { seen.push({ input, ask }); return "An answer."; } });
    const controller = new AbortController();
    const answer = await glue.runTurn(controller.signal)({ ref: REF, question: "Why was the retry added?", eventId: EVENT, turn: TURN });
    expect(answer).toBe("An answer.");
    expect(seen).toHaveLength(1);
    const { input, ask } = seen[0]!;
    expect(ask).toEqual(REF);
    expect(input).toMatchObject({
      subject: `ask:${REF.askId}`, workspaceId: TURN.workspaceId, orchestratorInstructions: "Be brief.", turnNote: "RULES\nThe task data.", answerOnly: true, signal: controller.signal,
    });
    // The question is the turn's text; the message names no real Slack thread, channel or person.
    expect(input.message).toMatchObject({ eventId: EVENT, text: "Why was the retry added?", userId: "U0000000000", thread: { teamId: "T0000000000", channelId: "C0000000000" } });
    // The conversation id and the tool request ids follow from the Ask and the event, so a redelivery repeats them.
    expect(input.conversationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(input.requestId()).not.toBe(input.requestId());
    const again = createAskGlue({ runTurn: async (second) => { expect(second.conversationId).toBe(input.conversationId); return "x"; } });
    await again.runTurn()({ ref: REF, question: "Q", eventId: EVENT, turn: TURN });
  });

  it("leaves out the abort signal when the turn is not handed off", async () => {
    let seen: TurnInput | undefined;
    const glue = createAskGlue({ runTurn: async (input) => { seen = input; return "ok"; } });
    await glue.runTurn()({ ref: REF, question: "Q", eventId: EVENT, turn: TURN });
    expect(seen).not.toHaveProperty("signal");
  });

  it("asks for the model key on the Ask's own route while the turn runs, and on no other route", async () => {
    let during: ReturnType<ReturnType<typeof createAskGlue>["accessRouteFor"]> | undefined;
    const glue = createAskGlue({ runTurn: async () => { during = glue.accessRouteFor({ eventId: EVENT }); return "ok"; } });
    await glue.runTurn()({ ref: REF, question: "Q", eventId: EVENT, turn: TURN });
    expect(during).toEqual({ orgId: REF.orgId, path: "/v1/asks/model-access", body: { sessionId: REF.sessionId, askId: REF.askId } });
    // Before and after: no Ask is running for the event, so no route (a thread's route is never made up for it).
    expect(() => glue.accessRouteFor({ eventId: EVENT })).toThrow("no ask is running for this turn");
    expect(() => glue.accessRouteFor({ eventId: "Ev9999999999999999999999999999999" })).toThrow("no ask is running for this turn");
    expect(glue.running()).toBe(0);
  });

  it("forgets the Ask when its turn throws, and passes the error on", async () => {
    const glue = createAskGlue({ runTurn: async () => { expect(glue.running()).toBe(1); throw new Error("model down"); } });
    await expect(glue.runTurn()({ ref: REF, question: "Q", eventId: EVENT, turn: TURN })).rejects.toThrow("model down");
    expect(glue.running()).toBe(0);
    expect(() => glue.accessRouteFor({ eventId: EVENT })).toThrow();
  });

  it("keeps two Asks running at once apart, each on its own route", async () => {
    const routes: Record<string, unknown> = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const glue = createAskGlue({ runTurn: async (input, ask) => { await gate; routes[ask.askId] = glue.accessRouteFor(input.message); return "ok"; } });
    const first = glue.runTurn()({ ref: REF, question: "Q1", eventId: EVENT, turn: TURN });
    const second = glue.runTurn()({ ref: OTHER, question: "Q2", eventId: "Ev1111111111111111111111111111111", turn: TURN });
    expect(glue.running()).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(routes[REF.askId]).toMatchObject({ orgId: REF.orgId, body: { askId: REF.askId } });
    expect(routes[OTHER.askId]).toMatchObject({ orgId: OTHER.orgId, body: { askId: OTHER.askId } });
    expect(glue.running()).toBe(0);
  });

  it("main.ts uses this glue for the Ask's model key and its turn, and holds no map of its own for them", () => {
    const main = readFileSync(new URL("../../packages/slack-service/src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("createAskGlue({ runTurn: (input, ask) => runTurn(input, ask) })");
    expect(main).toContain("accessRouteFor: (message) => askGlue.accessRouteFor(message)");
    expect(main).toContain("runTurn: askGlue.runTurn(handoff)");
    expect(main).not.toContain("askTurns");
  });
});
