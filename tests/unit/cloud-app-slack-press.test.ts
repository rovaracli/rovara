// S3 review L-2: a press on a card the core posted reaches the company's channel sink (cloud/app/entry.ts `createCoreSlackPressConsumer`), through the ingress's handler (`corePressHandler`) and the broker's
// `core-slack-press` event, with the switch on or off. The sink and the gate are the real ones (the shared rig, A6's real approvers and A8's real Slack adapter).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bindChannelSpace, postApprovalCard } from "@rovara-code/broker/core/channel";
import { type CloudApp, CORE_CARD_ACTION_PREFIX, CORE_SLACK_PRESS_ACTION, PRESS_FAILED_WORDS, PRESS_TAKEN_WORDS, corePressHandler, createCoreSlackPressConsumer, isCoreSlackPressEvent, type CoreSlackPress } from "../../packages/broker/src/cloud/app/index.js";
import { CLOUD_SLACK_ACTION_PREFIX } from "../../packages/broker/src/plugins/channel/slack-cloud/adapter.js";
import { PEOPLE_ORG, SLACK_TEAM } from "../support/cloud-people-world.js";
import { plannedTask, rig, type Rig } from "../support/cloud-core-rig.js";

const conversation = { channel: "slack", tenant: SLACK_TEAM, space: "C0CHAN", thread: "1695500000.000001" } as const;

async function posted(r: Rig, taskId: string) {
  const runtime = await r.app.runtimeFor(PEOPLE_ORG);
  const found = (await runtime.inbound.clientGate!.requirement(PEOPLE_ORG, "workflow-document", taskId))!;
  const adapter = (await r.app.registry()).get("channel", "slack")!;
  const card = await postApprovalCard({ store: r.world.store, orgId: PEOPLE_ORG, now: () => r.world.clock.now, companyOf: async () => PEOPLE_ORG },
    { channel: "slack", adapter, conversation, kind: "plan_approval", subject: { type: "workflow-document", id: taskId }, revision: found.revision, artifactDigest: found.artifactDigest, risk: "low", text: "ready", actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REQUEST_CHANGES", label: "Stop and redirect" }] });
  return { found, card };
}

const press = (over: Partial<CoreSlackPress> & { value: string; actionId: string; userId: string }): CoreSlackPress => ({
  userTeamId: SLACK_TEAM, workspaceTeamId: SLACK_TEAM, teamId: SLACK_TEAM, channelId: conversation.space, threadTs: conversation.thread, messageTs: conversation.thread, actionTs: "1695500009.000009", ...over,
});
const valueOf = (card: { requestId: string }, found: { revision: number; artifactDigest: string }, decision: string) => JSON.stringify({ r: card.requestId, v: found.revision, d: found.artifactDigest, o: decision });

for (const state of ["on", "off"] as const) {
  describe(`a press on a core card, switch ${state}`, () => {
    async function setup() {
      const r = await rig({ slack: true });
      await bindChannelSpace({ store: r.world.store, orgId: PEOPLE_ORG, now: () => r.world.clock.now }, { channel: "slack", tenant: SLACK_TEAM, space: "C0CHAN" }, "payments");
      const { member } = r.people.people;
      r.people.linkSlack(member);
      r.people.signedInAgo(member, 60_000);
      r.standing.set(member.developerId, "owner");
      const { taskId } = await plannedTask(r);
      const app = state === "on" ? r.app : r.rebuild({ env: {}, serveStamped: true });
      const consume = createCoreSlackPressConsumer({ app, orgOfTeam: async (team) => (team === SLACK_TEAM ? PEOPLE_ORG : undefined), log: () => undefined });
      return { r, member, taskId, consume, ...(await posted(r, taskId)) };
    }
    const decisions = async (r: Rig, taskId: string) => ((await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))?.workflow as { decisions: unknown[] }).decisions;

    it("a linked member's Approve press is decided through the sink and the gate", async () => {
      const { r, member, taskId, consume, found, card } = await setup();
      expect(await consume(press({ actionId: `${CORE_CARD_ACTION_PREFIX}APPROVE`, value: valueOf(card, found, "APPROVE"), userId: member.slackUserId! }))).toEqual({ enabled: true, text: PRESS_TAKEN_WORDS });
      expect(await decisions(r, taskId)).toHaveLength(1);
    });

    it("the same press again is the same decision (nothing is decided twice)", async () => {
      const { r, member, taskId, consume, found, card } = await setup();
      const again = press({ actionId: `${CORE_CARD_ACTION_PREFIX}APPROVE`, value: valueOf(card, found, "APPROVE"), userId: member.slackUserId! });
      await consume(again);
      await consume(again);
      expect(await decisions(r, taskId)).toHaveLength(1);
    });

    it("a request-changes press (Stop and redirect) is the sink's too", async () => {
      const { r, member, taskId, consume, found, card } = await setup();
      expect(await consume(press({ actionId: `${CORE_CARD_ACTION_PREFIX}REQUEST_CHANGES`, value: valueOf(card, found, "REQUEST_CHANGES"), userId: member.slackUserId! }))).toMatchObject({ enabled: true });
      expect(await decisions(r, taskId)).toMatchObject([{ decision: "REQUEST_CHANGES" }]);
    });

    it("an account nobody linked decides nothing", async () => {
      const { r, taskId, consume, found, card } = await setup();
      await consume(press({ actionId: `${CORE_CARD_ACTION_PREFIX}APPROVE`, value: valueOf(card, found, "APPROVE"), userId: "U0NOBODY01" }));
      expect(await decisions(r, taskId)).toEqual([]);
    });
  });
}

describe("what is not a press on a core card is not taken", () => {
  async function consumer() {
    const r = await rig({ slack: true });
    return { r, consume: createCoreSlackPressConsumer({ app: r.app, orgOfTeam: async (team) => (team === SLACK_TEAM ? PEOPLE_ORG : undefined), log: () => undefined }) };
  }
  const good = { r: "11111111-1111-4111-8111-111111111111", v: 1, d: "a".repeat(64), o: "APPROVE" };

  it("an action that is not the core's, a value that is not strict JSON of the card's fields, a button that disagrees with its value, an unbound workspace: enabled false", async () => {
    const { consume } = await consumer();
    const base = { actionId: `${CORE_CARD_ACTION_PREFIX}APPROVE`, value: JSON.stringify(good), userId: "U0MEMBER01" };
    expect(await consume(press({ ...base, actionId: "agentx_workflow_close" }))).toEqual({ enabled: false });
    expect(await consume(press({ ...base, value: "not json" }))).toEqual({ enabled: false });
    expect(await consume(press({ ...base, value: JSON.stringify({ ...good, extra: 1 }) }))).toEqual({ enabled: false });
    expect(await consume(press({ ...base, value: JSON.stringify({ ...good, d: "short" }) }))).toEqual({ enabled: false });
    expect(await consume(press({ ...base, actionId: `${CORE_CARD_ACTION_PREFIX}REJECT` }))).toEqual({ enabled: false });
    expect(await consume(press({ ...base, teamId: "T0UNBOUND" }))).toEqual({ enabled: false });
    expect(await consume({ ...base, bogus: true } as never)).toEqual({ enabled: false });
  });

  it("a root that neither has the switch on nor serves stamped tasks takes nothing", async () => {
    const r = await rig({ slack: true });
    const old = r.rebuild({ env: {} });
    const consume = createCoreSlackPressConsumer({ app: old, orgOfTeam: async () => PEOPLE_ORG, log: () => undefined });
    expect(await consume(press({ actionId: `${CORE_CARD_ACTION_PREFIX}APPROVE`, value: JSON.stringify(good), userId: "U0MEMBER01" }))).toEqual({ enabled: false });
  });

  it("a press on a card the sink does not know is answered in words, never an error", async () => {
    const { consume } = await consumer();
    const answer = await consume(press({ actionId: `${CORE_CARD_ACTION_PREFIX}APPROVE`, value: JSON.stringify(good), userId: "U0MEMBER01" }));
    expect(answer).toMatchObject({ enabled: true });
    expect([PRESS_TAKEN_WORDS, PRESS_FAILED_WORDS]).toContain((answer as { text: string }).text);
  });

  it("a root that cannot be built is told in words", async () => {
    const r = await rig({ slack: true });
    const broken = Object.create(r.app, { runtimeFor: { value: async () => { throw new Error("point empty"); } } }) as CloudApp;
    const consume = createCoreSlackPressConsumer({ app: broken, orgOfTeam: async () => PEOPLE_ORG, log: () => undefined });
    expect(await consume(press({ actionId: `${CORE_CARD_ACTION_PREFIX}APPROVE`, value: JSON.stringify(good), userId: "U0MEMBER01" }))).toEqual({ enabled: true, text: PRESS_FAILED_WORDS });
  });
});

describe("the ingress's handler and the broker's event", () => {
  it("the core's button prefix is the adapter's, and the event shape is the one the broker recognises", () => {
    expect(CORE_CARD_ACTION_PREFIX).toBe(CLOUD_SLACK_ACTION_PREFIX);
    expect(isCoreSlackPressEvent({ source: "agentx.slack-ingress", action: CORE_SLACK_PRESS_ACTION, press: {} })).toBe(true);
    expect(isCoreSlackPressEvent({ source: "agentx.slack-ingress", action: CORE_SLACK_PRESS_ACTION, press: {}, requestContext: {} })).toBe(false);
    expect(isCoreSlackPressEvent({ source: "someone-else", action: CORE_SLACK_PRESS_ACTION, press: {} })).toBe(false);
  });

  it("the handler takes only the core's buttons, hands the press to the broker and says privately what it answers; an answer that is not the broker's is the unknown button", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const said: string[] = [];
    let reply: { statusCode?: number; body?: string } = { statusCode: 200, body: JSON.stringify({ enabled: true, text: "Got it." }) };
    const handler = corePressHandler({ invokeBroker: async (event) => { sent.push(event); return reply; }, respondEphemeral: async (_url, text) => { said.push(text); }, unknownButtonText: "unknown" });
    expect(handler.matches(`${CORE_CARD_ACTION_PREFIX}APPROVE`)).toBe(true);
    expect(handler.matches("agentx_workflow_close")).toBe(false);
    const action = { actionId: `${CORE_CARD_ACTION_PREFIX}APPROVE`, value: "{}", userId: "U1", userTeamId: "T1", workspaceTeamId: "T1", thread: { teamId: "T1", channelId: "C1", threadTs: "1.1" }, messageTs: "1.1", actionTs: "2.2", responseUrl: "https://hooks.example.test/x" };
    await handler.handle(action);
    expect(sent[0]).toMatchObject({ source: "agentx.slack-ingress", action: CORE_SLACK_PRESS_ACTION, press: { teamId: "T1", channelId: "C1", threadTs: "1.1", userId: "U1", actionTs: "2.2" } });
    expect(said).toEqual(["Got it."]);
    reply = { statusCode: 200, body: JSON.stringify({ enabled: false }) };
    await handler.handle(action);
    reply = { statusCode: 500, body: "oops" };
    await handler.handle(action);
    expect(said.slice(1)).toEqual(["unknown", "unknown"]);
  });

  it("the interactivity Lambda registers the handler and the broker answers the event (read from the source)", () => {
    expect(readFileSync("packages/broker/src/aws/slack-interactivity.ts", "utf8")).toMatch(/handlers: \[\.\.\.recordHandlers, \.\.\.coreHandlers,/u);
    expect(readFileSync("packages/broker/src/aws/broker/handler.ts", "utf8")).toContain("coreEntry.slackPress(event.press)");
  });
});
