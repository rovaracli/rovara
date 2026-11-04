// Start from inside Slack (Team record source-row lane, task 12), at the two live Slack doors: the events ingress ("@Rovara learn from this channel", and Rovara added to a private channel) and the
// interactivity handler (the Add press). Real handlers, a strict Slack double, a stand-in for the broker that records exactly what the ingress sent it. The identity is only ever what the VERIFIED Slack request says.
import { createHmac } from "node:crypto";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackIngressHandler } from "../../packages/broker/src/aws/slack-ingress.js";
import { createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";
import { botInvite, isHandedOffLearnPress, isLearnFromChannel, isTeamRecordSlackAddEvent, learnAddHandler, runHandedOffLearnPress, type HandedOffLearnPress, LEARN_ADD_ACTION, LEARN_PROJECT_ACTION, LEARN_PROJECT_BLOCK, LEARN_RETENTION_ACTION, LEARN_RETENTION_BLOCK, SLACK_ADD_WORDS, type SlackAddAnswer, type SlackAddAskInput } from "../../packages/broker/src/team-record/slack-add.js";
import { StrictSlackWeb } from "../support/strict-slack.js";
import { TEST_ORG } from "../support/orgs.js";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const team = "T0BSHLLUGBD", channel = "C0123456789", privateChannel = "G0PRIVATE01", bot = "U0BOT000001", maya = "U0123456789", sam = "U0456789012";
const nowSeconds = 1_758_657_600;
const threadTs = "1695500000.000001";
const RESPONSE_URL = "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc";

const signedEvent = (payload: unknown, secret = signingSecret) => {
  const body = JSON.stringify(payload);
  const timestamp = String(nowSeconds);
  return { version: "2.0", rawPath: "/v1/slack/events", isBase64Encoded: false, body, headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}` }, requestContext: { requestId: "request", http: { method: "POST" } } };
};
const signedInteraction = (payload: unknown) => {
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(nowSeconds);
  return { rawPath: "/v1/slack/interactions", body: raw, headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}` } };
};

let counter = 0;
const mention = (text: string, options: { user?: string; eventId?: string; extra?: Record<string, unknown>; channelId?: string } = {}) => ({
  type: "event_callback", team_id: team, event_id: options.eventId ?? `Ev${String(counter++).padStart(6, "0")}`,
  authorizations: [{ team_id: team, user_id: bot, is_bot: true }],
  event: { type: "app_mention", user: options.user ?? maya, team, channel: options.channelId ?? channel, ts: threadTs, text: `<@${bot}> ${text}`, ...options.extra },
});
const joined = (options: { user?: string; inviter?: string | undefined; channelType?: string; channelId?: string; eventId?: string; eventTeam?: string } = {}) => ({
  type: "event_callback", team_id: team, event_id: options.eventId ?? `Ev${String(counter++).padStart(6, "0")}`,
  authorizations: [{ team_id: team, user_id: bot, is_bot: true }],
  event: { type: "member_joined_channel", user: options.user ?? bot, channel: options.channelId ?? privateChannel, channel_type: options.channelType ?? "G", team: options.eventTeam ?? team, ...(options.inviter === undefined && "inviter" in options ? {} : { inviter: options.inviter ?? maya }), event_ts: "1695500001.000100" },
});

const PROMPT = { text: "Add this channel to a project's team record?", blocks: [{ type: "section", text: { type: "mrkdwn", text: `Add <#${channel}> to a project's team record?` } }] };

function rig(options: { learn?: false | ((input: SlackAddAskInput) => Promise<SlackAddAnswer>); bound?: boolean; claimed?: Set<string> } = {}) {
  const slack = new StrictSlackWeb();
  const queued: Array<{ text?: string }> = [];
  const asked: SlackAddAskInput[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const claimed = options.claimed ?? new Set<string>();
  const learn = options.learn;
  const ingress = createSlackIngressHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    resolveOrg: async () => TEST_ORG,
    getBinding: async (_org, teamId, channelId) => options.bound === false ? undefined : ({ teamId, channelId, projectName: "payments", updatedAt: "2026-09-23T21:00:00.000Z" }),
    claimEvent: async (eventId) => { if (claimed.has(eventId)) return false; claimed.add(eventId); return true; },
    releaseEvent: async () => undefined,
    changePending: async () => 1,
    enqueue: async (message) => { queued.push(message); },
    postMessage: async (input) => { slack.post(input); },
    ...(learn === false ? {} : { recordLearn: {
      ask: async (input: SlackAddAskInput) => { asked.push(input); return await (learn ?? (async () => ({ show: PROMPT })))(input); },
      postEphemeral: async (input: { channel: string; threadTs?: string; user: string; text: string; blocks?: Array<Record<string, unknown>> }) => {
        slack.postEphemeral({ channel: input.channel, user: input.user, text: input.text, ...(input.threadTs === undefined ? {} : { threadTs: input.threadTs }), ...(input.blocks === undefined ? {} : { blocks: input.blocks }) });
      },
    } }),
    now: () => nowSeconds * 1000,
    log: (event, fields) => { logs.push({ event, fields }); },
  });
  return { slack, queued, asked, logs, ingress, say: (payload: unknown) => ingress(signedEvent(payload)) };
}

describe("the phrase", () => {
  it("is matched exactly after the mention: trimmed, case-insensitive; anything else is not it", () => {
    for (const text of ["learn from this channel", "  Learn From This Channel  ", "LEARN FROM THIS CHANNEL", "\tlearn from this channel\n"]) expect(isLearnFromChannel(text), text).toBe(true);
    for (const text of ["learn from this channel please", "please learn from this channel", "learn from this channel.", "learn from this channel!", "learn from  this channel", "learn from this", "learn from this channels", "", "chat: learn from this channel", "learn from this channel\nand more", "learn from the channel"]) expect(isLearnFromChannel(text), text).toBe(false);
  });
});

describe("the switch is off (no record wiring): the phrase is an ordinary mention, exactly as before", () => {
  it("goes to the normal handling; nothing is asked, nothing is shown", async () => {
    const r = rig({ learn: false });
    const reply = await r.say(mention("learn from this channel"));
    expect(reply.statusCode).toBe(200);
    expect(r.queued).toHaveLength(1);
    expect(r.queued[0]!.text).toBe("learn from this channel");
    expect(r.slack.ephemerals).toHaveLength(0);
    expect(r.asked).toHaveLength(0);
  });

  it("in an unbound channel it is ignored as always (channel_not_bound), and a membership event is ignored as before", async () => {
    const r = rig({ learn: false, bound: false });
    expect((await r.say(mention("learn from this channel"))).statusCode).toBe(200);
    expect(r.queued).toHaveLength(0);
    expect(r.logs.map((entry) => entry.fields.reason)).toContain("channel_not_bound");
    r.logs.length = 0;
    expect((await r.say(joined())).statusCode).toBe(200);
    expect(r.logs.map((entry) => entry.fields.reason)).toEqual(["not_app_mention"]);
    expect(r.slack.ephemerals).toHaveLength(0);
  });
});

describe("the switch is off: the event types the manifest now subscribes to are ignored, as an unsubscribed app never sent them", () => {
  it("answers each with 200, queues and shows nothing", async () => {
    const r = rig({ learn: false });
    for (const event of [
      { type: "member_left_channel", user: maya, channel: privateChannel, channel_type: "G", team },
      { type: "channel_deleted", channel: privateChannel },
      { type: "channel_id_changed", old_channel_id: privateChannel, new_channel_id: "G0NEWCHAN01" },
      { type: "channel_shared", connected_team_id: "T0OTHER000", channel: privateChannel },
      { type: "app_uninstalled" },
      { type: "tokens_revoked", tokens: { bot: [bot] } },
    ]) {
      const reply = await r.say({ type: "event_callback", team_id: team, event_id: `Ev${String(counter++).padStart(6, "0")}`, authorizations: [{ team_id: team, user_id: bot, is_bot: true }], event });
      expect(reply.statusCode, event.type).toBe(200);
    }
    expect(r.queued).toHaveLength(0);
    expect(r.slack.ephemerals).toHaveLength(0);
    expect(r.asked).toHaveLength(0);
  });
});

describe("the switch is on", () => {
  it("any other mention text keeps today's handling (it is queued as a request; the prompt is not asked)", async () => {
    const r = rig();
    for (const text of ["learn from this channel please", "learn from this channel.", "what is this channel for", "learn", "chat: learn from this channel"]) {
      const before = r.queued.length;
      expect((await r.say(mention(text))).statusCode, text).toBe(200);
      expect(r.queued.length, text).toBe(before + 1);
    }
    expect(r.asked).toHaveLength(0);
    expect(r.slack.ephemerals).toHaveLength(0);
  });

  it("the exact phrase asks the Team record with the VERIFIED user, team and channel, and shows the answer privately to that person; it is not queued and nothing is posted for everyone", async () => {
    const r = rig();
    expect((await r.say(mention("Learn from this channel", { user: sam }))).statusCode).toBe(200);
    expect(r.asked).toEqual([{ teamId: team, userId: sam, channelId: channel, trigger: "phrase" }]);
    expect(r.slack.ephemerals).toHaveLength(1);
    expect(r.slack.ephemerals[0]).toMatchObject({ channel, user: sam, text: PROMPT.text, blocks: PROMPT.blocks });
    expect(r.queued).toHaveLength(0);
    expect(r.slack.posts).toHaveLength(0);
  });

  it("a user or channel written inside the message text changes nothing: the identity is the signed event's", async () => {
    const r = rig();
    await r.say({ ...mention(`learn from this channel`, { user: maya }), event: { ...mention("x").event, user: maya, text: `<@${bot}> learn from this channel <@${sam}> <#C0OTHER0001>` } });
    expect(r.asked).toHaveLength(0); // extra words: not the phrase
    await r.say(mention("learn from this channel", { user: maya }));
    expect(r.asked).toEqual([{ teamId: team, userId: maya, channelId: channel, trigger: "phrase" }]);
  });

  it("works in a channel no project is bound to (that is the point); an unsigned or wrongly signed request asks nothing", async () => {
    const r = rig({ bound: false });
    await r.say(mention("learn from this channel"));
    expect(r.asked).toHaveLength(1);
    expect(r.slack.ephemerals).toHaveLength(1);
    const bad = await r.ingress(signedEvent(mention("learn from this channel"), "0123456789abcdef0123456789abcdef"));
    expect(bad.statusCode).toBe(401);
    expect(r.asked).toHaveLength(1);
  });

  it("a message another app posted, or one with no user, is not the phrase", async () => {
    const r = rig();
    await r.say(mention("learn from this channel", { extra: { bot_id: "B0123" } }));
    await r.say(mention("learn from this channel", { extra: { subtype: "message_changed" } }));
    expect(r.asked).toHaveLength(0);
    expect(r.slack.ephemerals).toHaveLength(0);
  });

  it("Slack's redelivery of the same event shows the prompt once", async () => {
    const r = rig();
    const payload = mention("learn from this channel", { eventId: "EvSAME" });
    await r.say(payload);
    await r.say(payload);
    expect(r.asked).toHaveLength(1);
    expect(r.slack.ephemerals).toHaveLength(1);
  });

  it("an answer of 'none' shows nothing; a Team record that fails says so privately and fixed, and Slack is not asked to retry", async () => {
    const quiet = rig({ learn: async () => ({ none: true }) });
    expect((await quiet.say(mention("learn from this channel"))).statusCode).toBe(200);
    expect(quiet.slack.ephemerals).toHaveLength(0);
    expect(quiet.queued).toHaveLength(0);
    const broken = rig({ learn: async () => { throw new Error("secret internal detail"); } });
    expect((await broken.say(mention("learn from this channel"))).statusCode).toBe(200);
    expect(broken.slack.ephemerals).toHaveLength(1);
    expect(broken.slack.ephemerals[0]!.text).toBe(SLACK_ADD_WORDS.unavailable);
    expect(JSON.stringify(broken.logs)).not.toContain("secret internal detail");
    expect(broken.queued).toHaveLength(0);
  });

  it("a failed ephemeral post never makes Slack retry", async () => {
    const r = rig();
    r.slack.failNext("chat.postEphemeral", "channel_not_found");
    expect((await r.say(mention("learn from this channel"))).statusCode).toBe(200);
  });
});

describe("Rovara invited to a private channel", () => {
  it("asks for the INVITER, privately, with no thread, and posts nothing for everyone", async () => {
    const r = rig();
    expect((await r.say(joined({ inviter: sam }))).statusCode).toBe(200);
    expect(r.asked).toEqual([{ teamId: team, userId: sam, channelId: privateChannel, trigger: "invite" }]);
    expect(r.slack.ephemerals).toHaveLength(1);
    expect(r.slack.ephemerals[0]).toMatchObject({ channel: privateChannel, user: sam, blocks: PROMPT.blocks });
    expect(r.slack.ephemerals[0]!.threadTs).toBeUndefined();
    expect(r.slack.posts).toHaveLength(0);
    expect(r.queued).toHaveLength(0);
  });

  it("does not trust channel_type: a private channel made after March 2021 has a C id and channel_type C, and the ingress still asks (the broker reads Slack's own flags); a public C channel is asked about too", async () => {
    const r = rig();
    await r.say(joined({ channelId: "C0NEWPRIVATE", channelType: "C", inviter: sam }));
    await r.say(joined({ channelId: channel, channelType: "C", inviter: maya }));
    expect(r.asked).toEqual([
      { teamId: team, userId: sam, channelId: "C0NEWPRIVATE", trigger: "invite" },
      { teamId: team, userId: maya, channelId: channel, trigger: "invite" },
    ]);
    expect(r.slack.ephemerals.map((entry) => [entry.channel, entry.user])).toEqual([["C0NEWPRIVATE", sam], [channel, maya]]);
  });

  it("is only for Rovara itself joining a channel with a person who invited it; every other join is left alone", async () => {
    const r = rig();
    for (const payload of [
      joined({ user: maya, inviter: sam }), // somebody else joined
      joined({ inviter: undefined }), // no inviter (it joined by itself)
      joined({ inviter: bot }), // the bot inviting itself
      joined({ inviter: "not-a-user" }),
      joined({ eventTeam: "T0OTHER000" }), // another workspace's event
      joined({ channelId: "D0DIRECT01" }),
    ]) expect((await r.say(payload)).statusCode).toBe(200);
    expect(r.asked).toHaveLength(0);
    expect(r.slack.ephemerals).toHaveLength(0);
  });

  it("the same event delivered twice shows once; with the record off the event is ignored as before", async () => {
    const r = rig();
    const payload = joined({ eventId: "EvJOIN", inviter: maya });
    await r.say(payload);
    await r.say(payload);
    expect(r.asked).toHaveLength(1);
    expect(r.slack.ephemerals).toHaveLength(1);
    const off = rig({ learn: false });
    await off.say(joined({ inviter: maya }));
    expect(off.slack.ephemerals).toHaveLength(0);
  });

  it("botInvite reads only the verified payload's own fields", () => {
    const invite = botInvite(joined({ inviter: sam }));
    expect(invite).toMatchObject({ teamId: team, channelId: privateChannel, inviterId: sam });
    expect(invite?.eventId).toMatch(/^Ev/u);
    expect(botInvite(mention("learn from this channel"))).toBeUndefined();
  });
});

// ---- the Add press

const selectState = (project: string | undefined, retention: string | undefined) => ({ values: {
  ...(project === undefined ? {} : { [LEARN_PROJECT_BLOCK]: { [LEARN_PROJECT_ACTION]: { type: "static_select", selected_option: { value: project } } } }),
  ...(retention === undefined ? {} : { [LEARN_RETENTION_BLOCK]: { [LEARN_RETENTION_ACTION]: { type: "static_select", selected_option: { value: retention } } } }),
} });

function pressRig(answer: (event: Record<string, unknown>) => Promise<{ statusCode?: number; body?: string }>) {
  const sent: Array<Record<string, unknown>> = [];
  const ephemerals: Array<{ url: string; text: string }> = [];
  const replaced: Array<{ url: string; text: string; blocks?: unknown }> = [];
  const handedOff: HandedOffLearnPress[] = [];
  const flags = { handOffFails: false };
  const interactivity = createSlackInteractivityHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    handlers: [learnAddHandler({
      // The press is acknowledged at once: the work is handed to an asynchronous invoke (as Lambda would carry it: JSON), run by `run` below.
      handOff: async (event) => { if (flags.handOffFails) throw new Error("not handed over"); handedOff.push(JSON.parse(JSON.stringify(event)) as HandedOffLearnPress); },
      respondEphemeral: async (url, text) => { ephemerals.push({ url, text }); },
    })],
    respondEphemeral: async (url, text) => { ephemerals.push({ url, text }); },
    now: () => nowSeconds * 1000,
  });
  const press = async (options: { user?: string; userTeam?: string; workspace?: string; value?: string; state?: unknown; actionId?: string; triggerId?: string; channelId?: string } = {}) => interactivity(signedInteraction({
    type: "block_actions", team: { id: options.workspace ?? team }, user: { id: options.user ?? maya, team_id: options.userTeam ?? team },
    container: { type: "message", message_ts: "1695500002.000009", channel_id: options.channelId ?? channel, is_ephemeral: true },
    response_url: RESPONSE_URL, trigger_id: options.triggerId ?? "13.37.abc", state: options.state ?? selectState("web", "C"),
    actions: [{ action_id: options.actionId ?? LEARN_ADD_ACTION, value: options.value ?? "tok-0000", block_id: "b", action_ts: "1695500003.000100" }],
  }));
  /** The asynchronous invoke the press handed off, as the Lambda runs it. */
  const run = async () => {
    const event = handedOff.shift();
    if (event === undefined) throw new Error("nothing was handed off");
    expect(isHandedOffLearnPress(event)).toBe(true);
    return runHandedOffLearnPress({
      invokeBroker: async (brokerEvent) => { sent.push(brokerEvent); return await answer(brokerEvent); },
      respondEphemeral: async (url, text) => { ephemerals.push({ url, text }); },
      respondReplace: async (url, message) => { replaced.push({ url, ...message }); },
    }, event);
  };
  return { press, run, sent, ephemerals, replaced, interactivity, handedOff, flags };
}
const reply = (body: unknown) => async () => ({ statusCode: 200, body: JSON.stringify(body) });

describe("the Add button", () => {
  it("hands the broker exactly what the verified press says: team, user, channel, the prompt's token, the chosen project and retention, and the interaction id", async () => {
    const r = pressRig(reply({ text: SLACK_ADD_WORDS.added, final: true }));
    expect((await r.press({ user: sam, value: "tok-1111", state: selectState("api", "A"), triggerId: "999.888.xyz" })).statusCode).toBe(200);
    // Slack is answered at once: the broker has not been asked yet, and nothing has been said to the person.
    expect(r.sent).toHaveLength(0);
    expect(r.ephemerals).toHaveLength(0);
    expect(r.handedOff).toHaveLength(1);
    expect(await r.run()).toBe("final");
    expect(r.sent).toEqual([{ source: "agentx.slack-ingress", action: "team-record-slack-add", step: "press", teamId: team, userId: sam, channelId: channel, token: "tok-1111", project: "api", retention: "A", interactionId: "999.888.xyz" }]);
    expect(isTeamRecordSlackAddEvent(JSON.parse(JSON.stringify(r.sent[0])))).toBe(true);
    // A final answer replaces the prompt (the button goes away).
    expect(r.replaced).toMatchObject([{ url: RESPONSE_URL, text: SLACK_ADD_WORDS.added }]);
    expect(r.ephemerals).toHaveLength(0);
  });

  it("a choice that was never made is sent as missing, never invented; a non-final answer is said privately and the prompt stays", async () => {
    const r = pressRig(reply({ text: SLACK_ADD_WORDS.chooseProject, final: false }));
    await r.press({ state: selectState(undefined, undefined) });
    expect(await r.run()).toBe("open");
    expect(r.sent[0]).not.toHaveProperty("project");
    expect(r.sent[0]).not.toHaveProperty("retention");
    expect(r.ephemerals).toEqual([{ url: RESPONSE_URL, text: SLACK_ADD_WORDS.chooseProject }]);
    expect(r.replaced).toHaveLength(0);
  });

  it("a press from a member of another workspace, or through another workspace's team, never reaches the broker", async () => {
    const r = pressRig(reply({ text: SLACK_ADD_WORDS.added, final: true }));
    await r.press({ userTeam: "T0OTHER000" });
    await r.press({ workspace: "T0OTHER000", userTeam: team });
    expect(r.sent).toHaveLength(0);
    expect(r.handedOff).toHaveLength(0);
    expect(r.ephemerals.map((entry) => entry.text)).toEqual([SLACK_ADD_WORDS.otherWorkspace, SLACK_ADD_WORDS.otherWorkspace]);
  });

  it("a broker that fails or answers nonsense says 'try again' privately, with no detail", async () => {
    for (const answer of [async () => { throw new Error("internal detail"); }, async () => ({ statusCode: 500, body: "boom" }), reply({ unexpected: true }), async () => ({ statusCode: 200, body: "not json" })]) {
      const r = pressRig(answer);
      expect((await r.press()).statusCode).toBe(200);
      expect(await r.run()).toBe("failed");
      expect(r.ephemerals).toEqual([{ url: RESPONSE_URL, text: SLACK_ADD_WORDS.unavailable }]);
      expect(r.replaced).toHaveLength(0);
    }
  });

  it("a press that could not be handed over says 'try again' privately and asks nothing", async () => {
    const r = pressRig(reply({ text: "x", final: true }));
    r.flags.handOffFails = true;
    expect((await r.press()).statusCode).toBe(200);
    expect(r.ephemerals).toEqual([{ url: RESPONSE_URL, text: SLACK_ADD_WORDS.unavailable }]);
    expect(r.sent).toHaveLength(0);
  });

  it("the hand-off is recognised only as Slack's own response URL and a well-formed press, never an HTTP request", async () => {
    const r = pressRig(reply({ text: "x", final: true }));
    await r.press();
    const good = JSON.parse(JSON.stringify(r.handedOff[0])) as Record<string, unknown>;
    expect(isHandedOffLearnPress(good)).toBe(true);
    for (const bad of [{ ...good, responseUrl: "https://evil.example/x" }, { ...good, responseUrl: "http://hooks.slack.com/x" }, { ...good, requestContext: {} }, { ...good, source: "agentx.slack-ingress" }, { ...good, press: { ...(good.press as object), teamId: "x" } }, { ...good, press: { ...(good.press as object), token: "" } }, null]) {
      expect(isHandedOffLearnPress(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("choosing in a menu (no button value) is acknowledged and asks nothing", async () => {
    const r = pressRig(reply({ text: "x", final: true }));
    const response = await r.interactivity(signedInteraction({
      type: "block_actions", team: { id: team }, user: { id: maya, team_id: team }, container: { type: "message", message_ts: "1695500002.000009", channel_id: channel, is_ephemeral: true },
      response_url: RESPONSE_URL, trigger_id: "1.2.3", state: selectState("web", "C"), actions: [{ action_id: LEARN_PROJECT_ACTION, block_id: LEARN_PROJECT_BLOCK, type: "static_select", selected_option: { value: "web" } }],
    }));
    expect(response.statusCode).toBe(200);
    expect(r.sent).toHaveLength(0);
    expect(r.handedOff).toHaveLength(0);
    expect(r.ephemerals).toHaveLength(0);
  });

  it("only the Add button's action carries the message's menu state; every other button's action is exactly as before", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const interactivity = createSlackInteractivityHandler({
      secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
      handlers: [{ matches: () => true, handle: async (action) => { seen.push({ ...action }); } }],
      respondEphemeral: async () => undefined,
      now: () => nowSeconds * 1000,
    });
    const payload = (actionId: string, state?: unknown) => signedInteraction({
      type: "block_actions", team: { id: team }, user: { id: maya, team_id: team }, container: { type: "message", message_ts: "1695500002.000009", channel_id: channel, is_ephemeral: true },
      response_url: RESPONSE_URL, trigger_id: "1.2.3", ...(state === undefined ? {} : { state }), actions: [{ action_id: actionId, value: "v", block_id: "b", action_ts: "1695500003.000100" }],
    });
    await interactivity(payload("rovara_other_button", selectState("web", "C")));
    await interactivity(payload(LEARN_ADD_ACTION, selectState("web", "C")));
    await interactivity(payload(LEARN_ADD_ACTION));
    expect(seen).toHaveLength(3);
    expect(seen[0]).not.toHaveProperty("stateValues");
    expect(seen[1]).toHaveProperty("stateValues");
    expect(seen[2]).not.toHaveProperty("stateValues");
  });

  it("another button is not this handler's", async () => {
    const r = pressRig(reply({ text: "x", final: true }));
    await r.press({ actionId: "rovara_something_else" });
    expect(r.sent).toHaveLength(0);
  });
});

describe("the broker's event", () => {
  it("is recognised only as a direct invoke from the ingress with well-formed ids", () => {
    const good = { source: "agentx.slack-ingress", action: "team-record-slack-add", step: "ask", teamId: team, userId: maya, channelId: channel, trigger: "phrase" };
    expect(isTeamRecordSlackAddEvent(good)).toBe(true);
    for (const bad of [{ ...good, source: "other" }, { ...good, requestContext: {} }, { ...good, teamId: "x" }, { ...good, userId: "u" }, { ...good, channelId: "D0DIRECT01" }, { ...good, step: "other" }, { ...good, trigger: "other" }, { ...good, action: "chatgpt-command" }, null, "text"]) {
      expect(isTeamRecordSlackAddEvent(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isTeamRecordSlackAddEvent({ source: "agentx.slack-ingress", action: "team-record-slack-add", step: "press", teamId: team, userId: maya, channelId: channel, token: "tok", interactionId: "1.2" })).toBe(true);
  });

  it("a SlackAddAnswer is a prompt or nothing", () => {
    const shown: SlackAddAnswer = { show: { text: "x" } };
    const none: SlackAddAnswer = { none: true };
    expect([shown, none]).toHaveLength(2);
  });
});

// Final review 3, minor 1: the handed-off press (an asynchronous invoke of the ingress Lambda by the interactivity handler) is dispatched only where the record's switch is on, so with it off a direct invoke is exactly what it was
// before the feature: an event of an unknown shape, never a press, and nothing is sent to the broker or posted to a Slack response URL.
describe("the switch gates the handed-off press at both Lambda doors", () => {
  const environment = { ...process.env };
  afterEach(() => { process.env = { ...environment }; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });
  const press = (): HandedOffLearnPress => ({
    source: "agentx.slack-interactivity", action: "team-record-slack-add-press", responseUrl: RESPONSE_URL,
    press: { teamId: team, userId: maya, channelId: channel, token: "tok-0000", project: "web", retention: "C", interactionId: "1.2.3" },
  });

  function wire(recordOn: boolean) {
    process.env.STATE_TABLE_NAME = "state"; process.env.SLACK_THREADS_TABLE_NAME = "threads";
    process.env.SLACK_REQUEST_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/requests.fifo";
    process.env.SLACK_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:slack";
    process.env.AWS_REGION = "us-east-1"; process.env.BROKER_FUNCTION_NAME = "broker";
    if (recordOn) process.env.TEAM_RECORD_ENABLED = "1"; else delete process.env.TEAM_RECORD_ENABLED;
    const invoked: unknown[] = [], posted: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation((async () => ({ SecretString: JSON.stringify({ signingSecret, botToken: "xoxb-test" }) })) as never);
    vi.spyOn(SQSClient.prototype, "send").mockImplementation((async () => ({})) as never);
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation((async () => ({})) as never);
    vi.spyOn(LambdaClient.prototype, "send").mockImplementation((async (command: { input: { Payload?: Uint8Array } }) => {
      invoked.push(JSON.parse(Buffer.from(command.input.Payload ?? new Uint8Array()).toString("utf8")));
      return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: JSON.stringify({ text: SLACK_ADD_WORDS.added, final: true }) })) };
    }) as never);
    vi.stubGlobal("fetch", async (url: string) => { posted.push(String(url)); return new Response("ok", { status: 200 }); });
    return { invoked, posted };
  }
  const settled = async (run: () => Promise<unknown>): Promise<unknown> => { try { return await run(); } catch { return "threw"; } };

  it("the interactivity Lambda: with the switch on the press is run (the broker is asked, the response URL answered); with it off nothing is", async () => {
    const on = wire(true);
    const { createAwsSlackInteractivityHandler } = await import("../../packages/broker/src/aws/slack-interactivity.js");
    expect(await createAwsSlackInteractivityHandler()(press())).toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "final" }) });
    expect(on.invoked).toHaveLength(1);
    expect(on.posted.some((url) => url.startsWith("https://hooks.slack.com/"))).toBe(true);
    vi.restoreAllMocks();
    const off = wire(false);
    const answer = await settled(() => createAwsSlackInteractivityHandler()(press()));
    expect(JSON.stringify(answer)).not.toContain("outcome");
    expect(off.invoked).toEqual([]);
    expect(off.posted).toEqual([]);
  });

  it("the ingress Lambda's entry point: with the switch on it hands the press to the interactivity handler; with it off it does not", async () => {
    const on = wire(true);
    vi.resetModules();
    const onEntry = (await import("../../packages/broker/src/aws/slack-ingress.js")).handler;
    expect(await onEntry(press())).toMatchObject({ statusCode: 200, body: JSON.stringify({ outcome: "final" }) });
    expect(on.invoked).toHaveLength(1);
    vi.restoreAllMocks(); vi.resetModules();
    const off = wire(false);
    const offEntry = (await import("../../packages/broker/src/aws/slack-ingress.js")).handler;
    const answer = await settled(() => offEntry(press()));
    expect(JSON.stringify(answer)).not.toContain("outcome");
    expect(off.invoked).toEqual([]);
    expect(off.posted).toEqual([]);
  });
});
