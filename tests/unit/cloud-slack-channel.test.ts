// Convergence lane A8 (H1): Cloud's Slack on the channel point. Characterization tests pin what today's Slack code does (the mention rules, the Web API calls, the escaping, the explicit-member rule, the stored
// binding rows); the adapter and its sink are then shown to do the same, with a second company, and registering it is shown to switch nothing.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore, createAdapterRegistry } from "@rovara-code/broker/ports";
import type { ChannelWork } from "@rovara-code/broker/core/channel";
import { ChannelEventSchema, channelEventId, type ChannelEvent, type InboundMessage, type OrgId } from "@rovara-code/contracts";
import { parseMention } from "../../packages/broker/src/aws/slack-ingress.js";
import { chatPostEphemeral, chatPostMessage } from "../../packages/broker/src/aws/slack-web.js";
import { slackBindingItem } from "../../packages/broker/src/org/slack-binding.js";
import {
  CLOUD_SLACK_NO_THREAD, CloudSlackChannel, createCloudSlackSink, inboundFromQueuedSlackRequest, registerCloudSlackChannel, renderCloudSlackEvent, slackEscape,
} from "../../packages/broker/src/plugins/channel/slack-cloud/index.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TEAM = "T0AAAAAAA";
const OTHER_TEAM = "T0BBBBBBB";
const CHANNEL = "C0AAAAAAA";
const THREAD = "1731300000.000100";
const BOT = "UBOT00001";
const PERSON = "U0PERSON1";
const DEVELOPER = "d".repeat(64);
const TOKEN = ["xoxb", "test", "token"].join("-");

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }
function fakeSlack() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, ts: "1731300001.000200", channel: CHANNEL }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const payload = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "event_callback", team_id: TEAM, event_id: "Ev0AAAAAAAA", authorizations: [{ user_id: BOT, is_bot: true }], api_app_id: "A0APP0001",
  event: { type: "app_mention", user: PERSON, text: `<@${BOT}> add a retry`, ts: THREAD, channel: CHANNEL, team: TEAM, user_team: TEAM, ...event }, ...extra,
});

describe("today's mention rules (characterization)", () => {
  it("reads a person's mention of the bot in a channel", () => {
    const mention = parseMention(payload({}));
    expect(mention).toMatchObject({ kind: "mention", eventId: "Ev0AAAAAAAA", userId: PERSON, text: `<@${BOT}> add a retry`, thread: { teamId: TEAM, channelId: CHANNEL, threadTs: THREAD }, botUserId: BOT, appPosted: false });
  });

  it("ignores the bot's own message, an external-organization person, a direct message, and a malformed event", () => {
    expect(parseMention(payload({ user: BOT }))).toEqual({ reason: "own_message" });
    expect(parseMention(payload({ user_team: OTHER_TEAM }))).toEqual({ reason: "external_organization_user" });
    expect(parseMention(payload({ channel: "D0DIRECT01" }))).toEqual({ reason: "not_a_channel" });
    expect(parseMention(payload({ user: "bad id" }))).toEqual({ reason: "malformed_event" });
    expect(parseMention(payload({ type: "reaction_added" }))).toEqual({ reason: "not_app_mention" });
  });

  it("reads a plain message only as a thread reply", () => {
    expect(parseMention(payload({ type: "message" }))).toEqual({ reason: "not_app_mention" });
    expect(parseMention(payload({ type: "message", thread_ts: THREAD, ts: "1731300002.000300" }))).toMatchObject({ kind: "message", isThreadReply: true });
  });

  it("hands the same request to the sink that its queue carries: the inbound message is the queued request, field for field", () => {
    const mention = parseMention(payload({}));
    if ("reason" in mention) throw new Error("not a mention");
    const inbound = inboundFromQueuedSlackRequest({ version: 1, eventId: mention.eventId, thread: mention.thread, userId: mention.userId, text: "add a retry", receivedAt: "2026-11-11T12:00:00.000Z" });
    expect(inbound).toMatchObject({
      version: 2, channel: "slack", eventId: "Ev0AAAAAAAA", text: "add a retry",
      conversation: { channel: "slack", tenant: TEAM, space: CHANNEL, thread: THREAD }, actor: { channel: "slack", tenant: TEAM, userId: PERSON },
    });
  });
});

describe("today's Web API calls and escaping (characterization), and the adapter's", () => {
  const event = (data: object, type = "progress", thread = THREAD): ChannelEvent => ChannelEventSchema.parse({
    version: 1, id: channelEventId(), type, channel: "slack", conversation: { channel: "slack", tenant: TEAM, space: CHANNEL, thread }, createdAt: "2026-11-11T12:00:00.000Z", data,
  });
  const adapter = (slack: ReturnType<typeof fakeSlack>, serves: (team: string) => Promise<boolean> = async (team) => team === TEAM) =>
    new CloudSlackChannel({ projects: ["web"], botToken: async () => TOKEN, serves, fetch: slack.fetchImpl });

  it("posts the very request today's code posts: same URL, headers and body, unfurls off", async () => {
    const today = fakeSlack();
    await chatPostMessage(TOKEN, { channel: CHANNEL, threadTs: THREAD, text: "Working on it." }, today.fetchImpl);
    const ours = fakeSlack();
    await adapter(ours).deliver(event({ text: "Working on it." }));
    expect(ours.calls).toEqual(today.calls);
    expect(ours.calls[0]!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(ours.calls[0]!.body).toMatchObject({ unfurl_links: false, unfurl_media: false, thread_ts: THREAD });
  });

  it("sends a private notice the way today's ephemeral call does, to the person only", async () => {
    const today = fakeSlack();
    await chatPostEphemeral(TOKEN, { channel: CHANNEL, threadTs: THREAD, user: PERSON, text: "Only you." }, today.fetchImpl);
    const ours = fakeSlack();
    await adapter(ours).deliver(event({ text: "Only you.", onlyTo: PERSON }));
    expect(ours.calls).toEqual(today.calls);
  });

  it("posts at the top of a space when the thread is the no-thread id", async () => {
    const ours = fakeSlack();
    await adapter(ours).deliver(event({ text: "Hello." }, "progress", CLOUD_SLACK_NO_THREAD));
    expect(ours.calls[0]!.body["thread_ts"]).toBeUndefined();
  });

  it("escapes only & < > as the notifier does, so a task's words never become a mention or a link", async () => {
    expect(slackEscape("<!channel> & <@U0PERSON1> <https://x.test|y>")).toBe("&lt;!channel&gt; &amp; &lt;@U0PERSON1&gt; &lt;https://x.test|y&gt;");
    const ours = fakeSlack();
    await adapter(ours).deliver(event({ text: "<!channel> fix & ship" }));
    expect(ours.calls[0]!.body["text"]).toBe("&lt;!channel&gt; fix &amp; ship");
  });

  it("keeps a message within the length it advertises, never cutting an escape in half", () => {
    const rendered = renderCloudSlackEvent(event({ text: `${"a".repeat(2_990)}&&&&&&&&` }), 3_000)!;
    expect([...rendered.text].length).toBeLessThanOrEqual(3_000);
    expect(rendered.text).not.toMatch(/&[a-z]{0,3}…$/u);
  });

  it("sends a card for a kind that asks for a sign-in with no decision buttons, and a plain one with them", () => {
    const card = (actions?: object[]) => event({ text: "Approve the plan.", kind: "plan_approval", requestId: crypto.randomUUID(), expectedRevision: 2, artifactDigest: "a".repeat(64), taskUrl: "https://rovara.example.test/t/1", ...(actions === undefined ? {} : { actions }) }, "approval_request");
    const buttonsOf = (rendered: ReturnType<typeof renderCloudSlackEvent>): string[] => ((rendered!.blocks![1] as { elements: Array<{ action_id: string }> }).elements).map((element) => element.action_id);
    expect(buttonsOf(renderCloudSlackEvent(card(), 3_000))).toEqual(["rovara_open_task"]);
    expect(buttonsOf(renderCloudSlackEvent(card([{ decision: "APPROVE", label: "Approve" }]), 3_000))).toEqual(["rovara_decide_APPROVE", "rovara_open_task"]);
  });

  it("drops a repeat of an event id, as an at-least-once adapter must", async () => {
    const ours = fakeSlack();
    const same = event({ text: "Once." });
    const sender = adapter(ours);
    await sender.deliver(same);
    await sender.deliver(same);
    expect(ours.calls).toHaveLength(1);
  });

  it("refuses a workspace it does not serve, or cannot check, and posts nothing (fail closed)", async () => {
    for (const serves of [async () => false, async (): Promise<boolean> => { throw new Error("lookup failed"); }]) {
      const ours = fakeSlack();
      const sender = adapter(ours, serves);
      await expect(sender.deliver(event({ text: "x" }))).rejects.toMatchObject({ name: "CloudSlackError", code: "wrong_workspace" });
      expect(ours.calls).toEqual([]);
    }
    const ours = fakeSlack();
    const other = ChannelEventSchema.parse({ ...event({ text: "x" }), conversation: { channel: "slack", tenant: OTHER_TEAM, space: CHANNEL, thread: THREAD } });
    await expect(adapter(ours).deliver(other)).rejects.toMatchObject({ code: "wrong_workspace" });
    expect(ours.calls).toEqual([]);
  });

  it("does not carry the token into an error: Slack's code only", async () => {
    const failing = (async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })) as unknown as typeof fetch;
    const sender = new CloudSlackChannel({ projects: ["web"], botToken: async () => TOKEN, serves: async () => true, fetch: failing });
    const error: unknown = await sender.deliver(event({ text: "x" })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain("channel_not_found");
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });
});

describe("the sink: the company, the person (explicit members) and the binding", () => {
  function world(standing: (orgId: OrgId, slackUserId: string) => Promise<string>) {
    const store = new MemoryDocumentStore();
    const slack = fakeSlack();
    const adapter = new CloudSlackChannel({ projects: ["web", "api"], botToken: async () => TOKEN, serves: async () => true, fetch: slack.fetchImpl });
    const worked: Array<{ orgId: OrgId; projectName: string; personId: string; text: string }> = [];
    const work: ChannelWork = {
      async message(item) { worked.push({ orgId: item.orgId, projectName: item.projectName, personId: item.personId, text: item.message.text }); },
      async decide() { return { status: "refused", reason: "not_open" }; },
    };
    const teams = new Map<string, OrgId>([[TEAM, A], [OTHER_TEAM, B]]);
    const sink = createCloudSlackSink({ adapter, store, now: () => Date.UTC(2026, 10, 11, 12), work, orgOfTeam: async (team) => teams.get(team), standingOf: standing, linkWords: (code) => `Link with ${code}.`, log: () => undefined });
    return { store, slack, sink, worked, adapter };
  }
  const bind = async (store: MemoryDocumentStore, orgId: OrgId, team = TEAM, project = "web") => { await store.put({ item: slackBindingItem(orgId, { teamId: team, channelId: CHANNEL, projectName: project, updatedAt: "2026-11-01T00:00:00.000Z" }, DEVELOPER) as never }); };
  const message = (eventId = "Ev0AAAAAAAA", tenant = TEAM, userId = PERSON): InboundMessage => inboundFromQueuedSlackRequest({ version: 1, eventId, thread: { teamId: tenant, channelId: CHANNEL, threadTs: THREAD }, userId, text: "add a retry", receivedAt: "2026-11-11T12:00:00.000Z" });

  it("runs a message from an explicit member of the company the workspace is bound to, in a space bound by today's bind, as that person", async () => {
    const { store, sink, worked, slack } = world(async () => DEVELOPER);
    await bind(store, A);
    await sink.message(message());
    expect(worked).toEqual([{ orgId: A, projectName: "web", personId: DEVELOPER, text: "add a retry" }]);
    // And acknowledges it, through the same Web API call as today.
    expect(slack.calls.map((call) => call.url)).toEqual(["https://slack.com/api/chat.postMessage"]);
  });

  it("runs nothing for a person the explicit-member rule refuses, and tells that account privately how to link (once)", async () => {
    const { store, sink, worked, slack } = world(async () => { throw new Error("SLACK_ACCOUNT_NOT_LINKED"); });
    await bind(store, A);
    await sink.message(message());
    await sink.message(message("Ev0BBBBBBBB"));
    expect(worked).toEqual([]);
    const posts = slack.calls.filter((call) => call.url.endsWith("chat.postEphemeral"));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ user: PERSON });
    expect(String(posts[0]!.body["text"])).toContain("Link with ");
  });

  it("runs nothing when the rule answers something that is not a person id (fail closed)", async () => {
    for (const answer of ["", "U0PERSON1", "D".repeat(64)]) {
      const { store, sink, worked } = world(async () => answer);
      await bind(store, A);
      await sink.message(message());
      expect(worked, answer).toEqual([]);
    }
  });

  it("is judged in the company the workspace is bound to: a person who is a member of another company is refused there", async () => {
    const seen: OrgId[] = [];
    const { store, sink, worked } = world(async (orgId) => { seen.push(orgId); if (orgId !== B) throw new Error("FORBIDDEN"); return DEVELOPER; });
    await bind(store, A);
    await bind(store, B, OTHER_TEAM);
    await sink.message(message());
    expect(seen).toEqual([A]);
    expect(worked).toEqual([]);
  });

  it("runs a message in the company ITS workspace is bound to, with that company's binding and project, when two companies bind the same channel id", async () => {
    const seen: OrgId[] = [];
    const { store, sink, worked } = world(async (orgId) => { seen.push(orgId); return DEVELOPER; });
    await bind(store, A, TEAM, "web");
    await bind(store, B, OTHER_TEAM, "api");
    await sink.message(message("Ev0EEEEEEEE", OTHER_TEAM));
    await sink.message(message("Ev0FFFFFFFF", TEAM));
    expect(worked.map((item) => [item.orgId, item.projectName])).toEqual([[B, "api"], [A, "web"]]);
    expect(seen).toEqual([B, A]);
  });

  it("runs nothing for a workspace no company bound, and nothing for a space only ANOTHER company bound", async () => {
    const one = world(async () => DEVELOPER);
    // Company A has a binding for this very channel id, but a workspace no company bound is nobody's: nothing runs (a fallback to a first company would run it).
    await bind(one.store, A, "T0UNBOUND9");
    await bind(one.store, A, TEAM);
    await one.sink.message(message("Ev0CCCCCCCC", "T0UNBOUND9"));
    expect(one.worked).toEqual([]);
    await one.sink.message(message("Ev0CCCCCCCD", TEAM));
    expect(one.worked).toHaveLength(1);
    const two = world(async () => DEVELOPER);
    await bind(two.store, B, TEAM);
    await two.sink.message(message());
    expect(two.worked).toEqual([]);
    // The positive control: bound for the right company, the same message runs.
    await bind(two.store, A, TEAM);
    await two.sink.message(message("Ev0DDDDDDDD"));
    expect(two.worked).toHaveLength(1);
  });

  it("serves only the projects the adapter was registered for", async () => {
    const { store, sink, worked } = world(async () => DEVELOPER);
    await bind(store, A, TEAM, "payments");
    await sink.message(message());
    expect(worked).toEqual([]);
  });

  it("runs a repeated Slack event once", async () => {
    const { store, sink, worked } = world(async () => DEVELOPER);
    await bind(store, A);
    await sink.message(message());
    await sink.message(message());
    expect(worked).toHaveLength(1);
  });

  it("refuses an account of another workspace than the conversation's (a guest from a shared channel)", async () => {
    const { store, sink, worked } = world(async () => DEVELOPER);
    await bind(store, A);
    const guest = { ...message(), actor: { channel: "slack", tenant: OTHER_TEAM, userId: PERSON } } as InboundMessage;
    await sink.message(guest);
    expect(worked).toEqual([]);
  });
});

describe("registering changes nothing", () => {
  it("adds one adapter at the channel point under `slack`, and does not call Slack or read a token", () => {
    const registry = createAdapterRegistry();
    let tokenReads = 0;
    const slack = fakeSlack();
    const adapter = registerCloudSlackChannel(registry, { projects: ["web"], botToken: async () => { tokenReads += 1; return TOKEN; }, serves: async () => true, fetch: slack.fetchImpl });
    expect(registry.get("channel", "slack")).toBe(adapter);
    expect(registry.names("channel")).toEqual(["slack"]);
    expect(tokenReads).toBe(0);
    expect(slack.calls).toEqual([]);
    expect("start" in adapter).toBe(false);
    expect(adapter.stepUp).toEqual(["plan_approval", "admin"]);
  });
});
