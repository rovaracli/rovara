// wire-team-record: the Slack ingress's side. It reads the channel's facts with the bot token and hands the verified event to the broker; Public text goes as a request/response invoke
// (never parked in Lambda's asynchronous queue), everything else asynchronously.
import { describe, expect, it } from "vitest";
import { TEAM_RECORD_SLACK_SOURCE, carriesText, createSlackForwarder, readChannelInfo, removalPayload, type SlackForwardEvent } from "../../../packages/broker/src/team-record/slack-forward.js";

type Answer = Record<string, unknown> | undefined;
const slack = (answers: Record<string, Answer>) => {
  const urls: string[] = [];
  const fetch = async (url: string, init: { headers: Record<string, string> }) => {
    urls.push(url);
    expect(init.headers.authorization).toBe("Bearer xoxb-test");
    const method = /api\/([a-z.]+)\?/.exec(url)![1]!;
    const answer = answers[method];
    return { ok: answer !== undefined, json: async () => answer ?? { ok: false } };
  };
  return { fetch, urls };
};
const info = (channel: Record<string, unknown>) => ({ ok: true, channel: { id: "C0123456789", ...channel } });
const message = (type = "message") => ({ type: "event_callback", team_id: "T0123456789", event: { type, channel: "C0123456789", user: "U0123456789", text: "hi", ts: "1761818400.000100" } });

describe("readChannelInfo", () => {
  it("reads public, private (with its members), DM and group DM, and Slack Connect", async () => {
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: slack({ "conversations.info": info({ is_channel: true }) }).fetch })).toStrictEqual({ kind: "public", extShared: false });
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: slack({ "conversations.info": info({ is_channel: true, is_ext_shared: true }) }).fetch })).toStrictEqual({ kind: "public", extShared: true });
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: slack({ "conversations.info": info({ is_channel: true, is_pending_ext_shared: true }) }).fetch })).toMatchObject({ extShared: true });
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: slack({ "conversations.info": info({ is_im: true }) }).fetch })).toMatchObject({ kind: "im" });
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: slack({ "conversations.info": info({ is_mpim: true }) }).fetch })).toMatchObject({ kind: "mpim" });
    const privateChannel = slack({ "conversations.info": info({ is_group: true, is_private: true }), "conversations.members": { ok: true, members: ["U0123456789", "U0123456780"], response_metadata: { next_cursor: "" } } });
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: privateChannel.fetch })).toStrictEqual({ kind: "private", extShared: false, memberIds: ["U0123456789", "U0123456780"] });
  });

  it("answers nothing for a reply Slack did not send, a different channel id, or an unclassifiable channel; and a member list that cannot be read in full is treated as shared", async () => {
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: slack({}).fetch })).toBeUndefined();
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: slack({ "conversations.info": info({ id: "C0999999999", is_channel: true }) }).fetch })).toBeUndefined();
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: slack({ "conversations.info": info({}) }).fetch })).toBeUndefined();
    const failing = slack({ "conversations.info": info({ is_group: true }) });
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: failing.fetch })).toStrictEqual({ kind: "private", extShared: true });
    const endless = slack({ "conversations.info": info({ is_group: true }), "conversations.members": { ok: true, members: ["U0123456789"], response_metadata: { next_cursor: "more" } } });
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch: endless.fetch })).toStrictEqual({ kind: "private", extShared: true });
  });

  it("never throws when the network does", async () => {
    const fetch = async () => { throw new Error("secret detail"); };
    expect(await readChannelInfo({ token: "xoxb-test", channelId: "C0123456789", fetch })).toBeUndefined();
  });
});

describe("createSlackForwarder", () => {
  const run = async (edition: "public" | "enterprise", payload: Record<string, unknown>, answers: Record<string, Answer> = { "conversations.info": info({ is_channel: true }) }) => {
    const sent: Array<{ event: SlackForwardEvent; wait: boolean }> = [];
    const api = slack(answers);
    await createSlackForwarder({ token: async () => "xoxb-test", fetch: api.fetch, edition, async invoke(event, wait) { sent.push({ event, wait }); } })(payload);
    return { sent, calls: api.urls.length };
  };

  it("Public sends message text as request/response so it is never parked in Lambda's asynchronous queue; Enterprise and non-text events go asynchronously", async () => {
    expect(carriesText(message("message"))).toBe(true);
    expect(carriesText(message("message_changed"))).toBe(true);
    expect(carriesText(message("member_left_channel"))).toBe(false);
    expect((await run("public", message("message"))).sent[0]!.wait).toBe(true);
    expect((await run("public", message("message_changed"))).sent[0]!.wait).toBe(true);
    expect((await run("public", message("member_joined_channel"))).sent[0]!.wait).toBe(false);
    expect((await run("enterprise", message("message"))).sent[0]!.wait).toBe(false);
  });

  it("forwards the verified event with the channel's facts, and with no facts when Slack gave none (the broker then records nothing)", async () => {
    const { sent } = await run("public", message());
    expect(sent[0]!.event).toMatchObject({ source: TEAM_RECORD_SLACK_SOURCE, channel: { teamId: "T0123456789", channelId: "C0123456789", info: { kind: "public", extShared: false } } });
    const none = await run("public", message(), {});
    expect(none.sent[0]!.event.channel).toBeUndefined();
  });

  it("reads a channel once for five minutes, except on membership and channel events, and asks nothing for a deleted channel", async () => {
    const sent: unknown[] = [];
    let now = 0;
    const api = slack({ "conversations.info": info({ is_channel: true }) });
    const forward = createSlackForwarder({ token: async () => "xoxb-test", fetch: api.fetch, edition: "enterprise", now: () => now, async invoke(event) { sent.push(event); } });
    await forward(message()); await forward(message());
    expect(api.urls).toHaveLength(1);
    await forward(message("member_left_channel"));
    expect(api.urls).toHaveLength(2);
    now = 400_000;
    await forward(message());
    expect(api.urls).toHaveLength(3);
    await forward(message("channel_deleted"));
    expect(api.urls).toHaveLength(3);
    expect(sent).toHaveLength(5);
  });

  it("sends nothing for a payload that is not an event callback of a real team, and lets an invoke failure reach the ingress's own guard", async () => {
    expect((await run("public", { type: "url_verification" })).sent).toStrictEqual([]);
    expect((await run("public", { ...message(), team_id: "nonsense" })).sent).toStrictEqual([]);
    await expect(createSlackForwarder({ token: async () => "xoxb-test", fetch: slack({ "conversations.info": info({ is_channel: true }) }).fetch, edition: "public", async invoke() { throw new Error("refused"); } })(message())).rejects.toThrow();
  });
});

describe("removals go to the durable queue as ids only, before any Slack lookup", () => {
  const deleted = { type: "event_callback", team_id: "T0123456789", api_app_id: "A0123456789", event: { type: "message", subtype: "message_deleted", channel: "C0123456789", deleted_ts: "1761818400.000100", ts: "1761818500.000100", previous_message: { text: "SECRET old words", user: "U0123456789" } } };
  const tombstone = { type: "event_callback", team_id: "T0123456789", event: { type: "message", subtype: "message_changed", channel: "C0123456789", ts: "1761818500.000100", message: { ts: "1761818400.000100", subtype: "tombstone", text: "SECRET old words" }, previous_message: { text: "SECRET old words" } } };

  it("cuts a deleted message and a tombstone edit down to ids: the old words never leave the ingress", async () => {
    for (const payload of [deleted, tombstone]) {
      const cut = removalPayload(payload)!;
      expect(JSON.stringify(cut)).not.toContain("SECRET");
      expect(cut).toMatchObject({ type: "event_callback", team_id: "T0123456789" });
    }
    expect(removalPayload(deleted)).toMatchObject({ event: { subtype: "message_deleted", deleted_ts: "1761818400.000100" } });
    expect(removalPayload(tombstone)).toMatchObject({ event: { subtype: "message_changed", message: { ts: "1761818400.000100", subtype: "tombstone" } } });
    for (const type of ["channel_deleted", "channel_shared", "channel_id_changed", "app_uninstalled", "tokens_revoked"]) expect(removalPayload({ type: "event_callback", team_id: "T0123456789", event: { type, channel: "C0123456789" } }), type).toBeDefined();
    expect(removalPayload(message())).toBeUndefined();
    expect(removalPayload({ ...message("message_changed"), event: { type: "message", subtype: "message_changed", message: { ts: "1761818400.000100", text: "edited" } } })).toBeUndefined();
  });

  it("sends a removal to the queue with NO Slack call and NO invoke, in Public and Enterprise", async () => {
    for (const edition of ["public", "enterprise"] as const) {
      const queued: Array<Record<string, unknown>> = [];
      const invoked: unknown[] = [];
      const api = slack({ "conversations.info": info({ is_channel: true }) });
      await createSlackForwarder({ token: async () => { throw new Error("no token needed"); }, fetch: api.fetch, edition, async invoke(event) { invoked.push(event); }, async sendRemoval(payload) { queued.push(payload); } })(deleted);
      expect(api.urls, edition).toStrictEqual([]);
      expect(invoked, edition).toStrictEqual([]);
      expect(queued, edition).toHaveLength(1);
      expect(JSON.stringify(queued)).not.toContain("SECRET");
    }
  });

  it("a queue that fails falls back to an Event invoke of the broker (retried by Lambda) with the same ids-only payload, in Public and Enterprise", async () => {
    for (const edition of ["public", "enterprise"] as const) {
      const invoked: Array<{ event: SlackForwardEvent; wait: boolean }> = [];
      const api = slack({ "conversations.info": info({ is_channel: true }) });
      await createSlackForwarder({ token: async () => { throw new Error("no token needed"); }, fetch: api.fetch, edition, async invoke(event, wait) { invoked.push({ event, wait }); }, async sendRemoval() { throw new Error("queue down"); } })(deleted);
      expect(api.urls, edition).toStrictEqual([]);
      expect(invoked, edition).toHaveLength(1);
      expect(invoked[0]!.wait, edition).toBe(false);
      expect(invoked[0]!.event.source).toBe(TEAM_RECORD_SLACK_SOURCE);
      expect(invoked[0]!.event.channel, edition).toBeUndefined();
      expect(invoked[0]!.event.payload, edition).toStrictEqual(removalPayload(deleted));
      expect(JSON.stringify(invoked)).not.toContain("SECRET");
    }
  });

  it("a queue that does not answer in time falls back to the Event invoke as well", async () => {
    const invoked: unknown[] = [];
    await createSlackForwarder({ token: async () => "xoxb-test", fetch: slack({}).fetch, edition: "public", removalQueueMs: 20, async invoke(event) { invoked.push(event); }, sendRemoval: () => new Promise(() => undefined) })(tombstone);
    expect(invoked).toHaveLength(1);
    expect(JSON.stringify(invoked)).not.toContain("SECRET");
  });

  it("a removal that neither the queue nor the invoke accepts reaches the ingress's own guard instead of being dropped silently", async () => {
    await expect(createSlackForwarder({ token: async () => "xoxb-test", fetch: slack({}).fetch, edition: "public", async invoke() { throw new Error("invoke down"); }, async sendRemoval() { throw new Error("queue down"); } })(deleted)).rejects.toThrow();
    await expect(createSlackForwarder({ token: async () => "xoxb-test", fetch: slack({}).fetch, edition: "public", removalInvokeMs: 20, invoke: () => new Promise(() => undefined), async sendRemoval() { throw new Error("queue down"); } })(deleted)).rejects.toThrow();
  });

  it("with no queue configured a removal goes by the Event invoke", async () => {
    const invoked: Array<{ wait: boolean }> = [];
    await createSlackForwarder({ token: async () => "xoxb-test", fetch: slack({}).fetch, edition: "enterprise", async invoke(_event, wait) { invoked.push({ wait }); } })(deleted);
    expect(invoked).toStrictEqual([{ wait: false }]);
  });
});
