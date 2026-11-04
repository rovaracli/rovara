// The channels of the company's Slack workspace, for the Team record's pickers (source-row lane, task 10): the DeveloperIdentity function (the only holder of the bot token) answers `channel-list` with
// Slack's `conversations.list`, and the broker reaches it through the same Lambda invoke it already uses for `channel-class`. No new token, secret, environment variable or permission.
import { describe, expect, it, vi } from "vitest";
import { ChannelListRequestSchema } from "@agentx/contracts";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { channelListThroughLambda } from "../../packages/broker/src/aws/developer-routes/identity-lambda.js";
import { BOT_TOKEN, T0, TEAM, identityHarness, routeFetch } from "../support/developer-fakes.js";

type Raw = Record<string, unknown>;
const CHANNELS: Raw[] = [
  { id: "C0PUBLIC1", name: "general", is_channel: true, is_private: false, is_member: true },
  { id: "C0PRIVATE", name: "secret", is_channel: false, is_group: true, is_private: true, is_member: true },
  { id: "D0DIRECT1", user: "U0PERSON1", is_im: true, is_private: true },
  { id: "G0GROUPDM", name: "mpdm-a--b-1", is_mpim: true, is_group: true, is_private: true },
  { id: "C0CONNECT", name: "shared", is_channel: true, is_private: false, is_ext_shared: true, is_member: false },
  { id: "C0PENDING", name: "pending", is_channel: true, is_private: false, is_pending_ext_shared: true },
  { id: "C0ODDKIND", name: "odd" },
  { id: "bad id", name: "bad", is_channel: true, is_private: false },
  { name: "no-id", is_channel: true, is_private: false },
];

/** A scripted conversations.list: `pages` are answered in order; every query is kept. */
function slack(options: { pages?: Raw[][]; error?: string; status?: number; down?: boolean } = {}) {
  const queries: Array<Record<string, string>> = [];
  let index = 0;
  const pages = options.pages ?? [CHANNELS];
  const fetch = routeFetch(async (url) => {
    if (url.pathname !== "/api/conversations.list") return undefined;
    queries.push(Object.fromEntries(url.searchParams));
    if (options.down === true) throw new Error("offline");
    if (options.error !== undefined) return Response.json({ ok: false, error: options.error }, { status: options.status ?? 200 });
    const page = pages[index] ?? [];
    index += 1;
    return Response.json({ ok: true, channels: page, response_metadata: { next_cursor: index < pages.length ? `cursor-${String(index)}=` : "" } });
  });
  const problems: Array<{ method: string; status: number | undefined; error: string }> = [];
  const dir = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => T0, report: (problem) => { problems.push(problem); } });
  return { dir, fetch, queries, problems };
}

describe("channel-list: the directory lists the channels the bot can see", () => {
  it("answers id, name, kind, the Slack Connect flag and whether the bot has joined; leaves out what Slack did not state plainly, and every direct message", async () => {
    const { dir } = slack();
    const answer = await dir.channelList(TEAM);
    expect(answer).toEqual({
      ok: true,
      channels: [
        { id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: true },
        { id: "C0PRIVATE", name: "secret", kind: "private", extShared: false, joined: true },
        { id: "C0CONNECT", name: "shared", kind: "public", extShared: true, joined: false },
        { id: "C0PENDING", name: "pending", kind: "public", extShared: true, joined: false },
      ],
    });
  });

  it("is_member missing or not true is not joined (fail closed: the hint is shown, never a false 'joined')", async () => {
    const { dir } = slack({ pages: [[{ id: "C0NOFLAG1", name: "noflag", is_channel: true, is_private: false }, { id: "C0STRING1", name: "string", is_channel: true, is_private: false, is_member: "true" }, { id: "C0JOINED1", name: "joined", is_channel: true, is_private: false, is_member: true }]] });
    const answer = await dir.channelList(TEAM);
    expect(answer.ok && answer.channels.map((channel) => [channel.id, channel.joined])).toEqual([["C0NOFLAG1", false], ["C0STRING1", false], ["C0JOINED1", true]]);
  });

  it("asks for public and private channels only, never direct messages, without archived ones, 200 at a time", async () => {
    const plain = slack();
    await plain.dir.channelList(TEAM);
    expect(plain.queries[0]).toEqual({ types: "public_channel,private_channel", exclude_archived: "true", limit: "200" });
  });

  it("a direct message or group message Slack sends anyway is dropped (the bot sees only its own, so the picker never lists them)", async () => {
    const { dir } = slack();
    const answer = await dir.channelList(TEAM);
    expect(answer.ok && answer.channels.map((channel) => channel.kind).sort()).toEqual(["private", "public", "public", "public"]);
  });

  it("reads one page and hands back Slack's cursor; the next call passes it on", async () => {
    const { dir, queries } = slack({ pages: [[CHANNELS[0]!], [CHANNELS[1]!]] });
    expect(await dir.channelList(TEAM)).toEqual({ ok: true, channels: [{ id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: true }], next: "cursor-1=" });
    expect(await dir.channelList(TEAM, { cursor: "cursor-1=" })).toEqual({ ok: true, channels: [{ id: "C0PRIVATE", name: "secret", kind: "private", extShared: false, joined: true }] });
    expect(queries[1]!.cursor).toBe("cursor-1=");
  });

  it("never lists more than 200 in a reply, whatever Slack sends", async () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ id: `C${String(index).padStart(8, "0")}`, name: `c${String(index)}`, is_channel: true, is_private: false, is_member: true }));
    const { dir } = slack({ pages: [many] });
    const answer = await dir.channelList(TEAM);
    expect(answer.ok && answer.channels.length).toBe(200);
  });

  it("only for the install's own team: another team, or none, is unavailable and Slack is not asked", async () => {
    const mine = slack();
    expect(await mine.dir.channelList("T0OTHER99")).toEqual({ ok: false, error: "slack_unavailable" });
    expect(mine.queries).toEqual([]);
    const none = slackDirectory({ teamId: undefined, botToken: async () => BOT_TOKEN, fetch: routeFetch(), now: () => T0 });
    expect(await none.channelList(TEAM)).toEqual({ ok: false, error: "slack_unavailable" });
  });

  it("a bot without the scope to list is missing_scope; any other refusal, and Slack being down, is slack_unavailable; only Slack's code is reported, never the token", async () => {
    const scope = slack({ error: "missing_scope" });
    expect(await scope.dir.channelList(TEAM)).toEqual({ ok: false, error: "missing_scope" });
    expect(scope.problems).toEqual([{ method: "conversations.list", status: 200, error: "missing_scope" }]);
    for (const error of ["invalid_auth", "token_revoked", "invalid_cursor", "ratelimited"]) {
      expect(await slack({ error }).dir.channelList(TEAM), error).toEqual({ ok: false, error: "slack_unavailable" });
    }
    expect(await slack({ down: true }).dir.channelList(TEAM)).toEqual({ ok: false, error: "slack_unavailable" });
    expect(JSON.stringify(scope.problems)).not.toContain(BOT_TOKEN);
  });
});

describe("channel-list: the request shape and the Lambda wire", () => {
  it("is exact: the install's team and an optional cursor; nothing else (no way to ask for direct messages)", () => {
    expect(ChannelListRequestSchema.safeParse({ kind: "channel-list", teamId: TEAM }).success).toBe(true);
    expect(ChannelListRequestSchema.safeParse({ kind: "channel-list", teamId: TEAM, cursor: "dGVhbTpDMDYx=" }).success).toBe(true);
    for (const bad of [{ teamId: "x" }, { teamId: TEAM, includeDirect: true }, { teamId: TEAM, cursor: "a b" }, { teamId: TEAM, cursor: "x".repeat(400) }, { teamId: TEAM, extra: 1 }]) {
      expect(ChannelListRequestSchema.safeParse({ kind: "channel-list", ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the identity function answers it, and a malformed request is invalid_request", async () => {
    const identity = identityHarness({ channelInfo: { C0PUBLIC1: { name: "general", isPrivate: false, raw: { is_channel: true, is_member: true } } } });
    expect(await identity.handler({ kind: "channel-list", teamId: TEAM })).toEqual({ ok: true, channels: [{ id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: true }] });
    expect(await identity.handler({ kind: "channel-list", teamId: TEAM, includeDirect: true } as never)).toEqual({ ok: false, error: "invalid_request" });
  });

  it("the broker's wire reaches the identity function end to end and keeps the cursor and the missing-scope answer", async () => {
    const identity = identityHarness({ channelInfo: { C0PUBLIC1: { name: "general", isPrivate: false, raw: { is_channel: true, is_member: true } } } });
    const invoke = async (payload: Uint8Array) => ({ Payload: new TextEncoder().encode(JSON.stringify(await identity.handler(JSON.parse(new TextDecoder().decode(payload)) as never))) });
    expect(await channelListThroughLambda(invoke)({ kind: "channel-list", teamId: TEAM })).toEqual({ ok: true, channels: [{ id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: true }] });
    const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });
    const request = { kind: "channel-list", teamId: TEAM } as const;
    expect(await channelListThroughLambda(async () => reply({ ok: true, channels: [], next: "abc=" }))(request)).toEqual({ ok: true, channels: [], next: "abc=" });
    expect(await channelListThroughLambda(async () => reply({ ok: false, error: "missing_scope" }))(request)).toEqual({ ok: false, error: "missing_scope" });
  });

  it("anything it does not understand is slack_unavailable (fail closed); an identity function that has no channel-list answers invalid_request, which is unavailable too", async () => {
    const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });
    const request = { kind: "channel-list", teamId: TEAM } as const;
    const unavailable = { ok: false, error: "slack_unavailable" };
    for (const body of [{ ok: true }, { ok: true, channels: "x" }, { ok: false, error: "slack_unavailable" }, { ok: false, error: "weird_code" }, "junk"]) {
      expect(await channelListThroughLambda(async () => reply(body))(request), JSON.stringify(body)).toEqual(unavailable);
    }
    // Entries that do not have the shape are left out, not guessed at.
    const answer = await channelListThroughLambda(async () => reply({ ok: true, channels: [{ id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: false }, { id: "C0X", name: 1, kind: "public", extShared: false, joined: false }, { id: "C0Y1", name: "y", kind: "weird", extShared: false, joined: false }, { id: "C0Z1", name: "z", kind: "public", extShared: false }, { id: "D0DM1", name: "dm", kind: "im", extShared: false, joined: true }, "x"] }))(request);
    expect(answer).toEqual({ ok: true, channels: [{ id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: false }] });
    expect(await channelListThroughLambda(async () => reply({ ok: false, error: "invalid_request" }))(request)).toEqual({ ok: false, error: "invalid_request" });
    expect(await channelListThroughLambda(vi.fn(async () => { throw new Error("no route"); }))(request)).toEqual(unavailable);
    expect(await channelListThroughLambda(async () => ({ FunctionError: "Unhandled" }))(request)).toEqual(unavailable);
  });
});
