// "Your private channels" for the Team record's pickers (source-row lane, task 11): the DeveloperIdentity function (the only holder of the bot token) answers `member-channels` with Slack's
// `users.conversations` for ONE Slack user and `types=private_channel`. With a bot token Slack returns only the private channels the bot and that user are both in. The broker reaches it through the
// same Lambda invoke as `channel-list`. No new token, secret, environment variable or permission.
import { describe, expect, it, vi } from "vitest";
import { MemberChannelsRequestSchema } from "@agentx/contracts";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { memberChannelsThroughLambda } from "../../packages/broker/src/aws/developer-routes/identity-lambda.js";
import { BOT_TOKEN, T0, TEAM, identityHarness, routeFetch } from "../support/developer-fakes.js";

type Raw = Record<string, unknown>;
const USER = "U0PERSON1";
const PRIVATE: Raw[] = [
  { id: "C0PRIVATE", name: "secret", is_channel: false, is_group: true, is_private: true },
  { id: "G0OLDGRP1", name: "old-group", is_group: true, is_private: true },
  { id: "C0CONNECT", name: "shared-private", is_group: true, is_private: true, is_ext_shared: true },
  { id: "C0PENDING", name: "pending-private", is_private: true, is_group: true, is_pending_ext_shared: true },
  // Things the call never asks for; dropped when Slack sends them anyway.
  { id: "C0PUBLIC1", name: "general", is_channel: true, is_private: false },
  { id: "D0DIRECT1", user: "U0OTHER01", is_im: true, is_private: true },
  { id: "G0GROUPDM", name: "mpdm-a--b-1", is_mpim: true, is_group: true, is_private: true },
  { id: "C0ODDKIND", name: "odd" },
  { id: "bad id", name: "bad", is_private: true, is_group: true },
  { name: "no-id", is_private: true, is_group: true },
  { id: "C0NONAME1", is_private: true, is_group: true },
];

/** A scripted users.conversations: `pages` are answered in order; every query is kept. */
function slack(options: { pages?: Raw[][]; error?: string; status?: number; down?: boolean } = {}) {
  const queries: Array<Record<string, string>> = [];
  let index = 0;
  const pages = options.pages ?? [PRIVATE];
  const fetch = routeFetch(async (url) => {
    if (url.pathname !== "/api/users.conversations") return undefined;
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

describe("member-channels: the private channels the bot and one person are both in", () => {
  it("asks users.conversations for that user, private channels only, without archived ones, 200 at a time", async () => {
    const { dir, queries } = slack();
    await dir.memberChannels(TEAM, USER);
    expect(queries).toEqual([{ user: USER, types: "private_channel", exclude_archived: "true", limit: "200" }]);
  });

  it("answers id, name, Slack Connect flag; keeps only private channels Slack states plainly; drops public channels, direct messages and anything without an id or name", async () => {
    const { dir } = slack();
    expect(await dir.memberChannels(TEAM, USER)).toEqual({
      ok: true,
      channels: [
        { id: "C0PRIVATE", name: "secret", kind: "private", extShared: false, joined: true },
        { id: "G0OLDGRP1", name: "old-group", kind: "private", extShared: false, joined: true },
        { id: "C0CONNECT", name: "shared-private", kind: "private", extShared: true, joined: true },
        { id: "C0PENDING", name: "pending-private", kind: "private", extShared: true, joined: true },
      ],
    });
  });

  it("reads one page and hands back Slack's cursor; the next call passes it on", async () => {
    const { dir, queries } = slack({ pages: [[PRIVATE[0]!], [PRIVATE[1]!]] });
    expect(await dir.memberChannels(TEAM, USER)).toEqual({ ok: true, channels: [{ id: "C0PRIVATE", name: "secret", kind: "private", extShared: false, joined: true }], next: "cursor-1=" });
    expect(await dir.memberChannels(TEAM, USER, { cursor: "cursor-1=" })).toEqual({ ok: true, channels: [{ id: "G0OLDGRP1", name: "old-group", kind: "private", extShared: false, joined: true }] });
    expect(queries[1]!.cursor).toBe("cursor-1=");
  });

  it("never lists more than 200 in a reply, whatever Slack sends", async () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ id: `C${String(index).padStart(8, "0")}`, name: `c${String(index)}`, is_group: true, is_private: true }));
    const answer = await slack({ pages: [many] }).dir.memberChannels(TEAM, USER);
    expect(answer.ok && answer.channels.length).toBe(200);
  });

  it("only for the install's own team, and only for a Slack user id: another team, none, or a made-up user is unavailable and Slack is not asked", async () => {
    const mine = slack();
    expect(await mine.dir.memberChannels("T0OTHER99", USER)).toEqual({ ok: false, error: "slack_unavailable" });
    expect(await mine.dir.memberChannels(TEAM, "not a user")).toEqual({ ok: false, error: "slack_unavailable" });
    expect(await mine.dir.memberChannels(TEAM, "C0PRIVATE")).toEqual({ ok: false, error: "slack_unavailable" });
    expect(mine.queries).toEqual([]);
    const none = slackDirectory({ teamId: undefined, botToken: async () => BOT_TOKEN, fetch: routeFetch(), now: () => T0 });
    expect(await none.memberChannels(TEAM, USER)).toEqual({ ok: false, error: "slack_unavailable" });
  });

  it("a Slack user who is not in this workspace (user_not_found) has no channels here: an empty list, not an error (a person may have several linked ids)", async () => {
    expect(await slack({ error: "user_not_found" }).dir.memberChannels(TEAM, USER)).toEqual({ ok: true, channels: [] });
  });

  it("a bot without the scope is missing_scope; any other refusal, and Slack being down, is slack_unavailable; only Slack's code is reported, never the token", async () => {
    const scope = slack({ error: "missing_scope" });
    expect(await scope.dir.memberChannels(TEAM, USER)).toEqual({ ok: false, error: "missing_scope" });
    expect(scope.problems).toEqual([{ method: "users.conversations", status: 200, error: "missing_scope" }]);
    for (const error of ["invalid_auth", "token_revoked", "invalid_cursor", "ratelimited"]) {
      expect(await slack({ error }).dir.memberChannels(TEAM, USER), error).toEqual({ ok: false, error: "slack_unavailable" });
    }
    expect(await slack({ down: true }).dir.memberChannels(TEAM, USER)).toEqual({ ok: false, error: "slack_unavailable" });
    expect(JSON.stringify(scope.problems)).not.toContain(BOT_TOKEN);
  });
});

describe("member-channels: the request shape and the Lambda wire", () => {
  it("is exact: the install's team, one Slack user id and an optional cursor; nothing else", () => {
    expect(MemberChannelsRequestSchema.safeParse({ kind: "member-channels", teamId: TEAM, userId: USER }).success).toBe(true);
    expect(MemberChannelsRequestSchema.safeParse({ kind: "member-channels", teamId: TEAM, userId: USER, cursor: "dGVhbTpDMDYx=" }).success).toBe(true);
    for (const bad of [{ teamId: "x", userId: USER }, { teamId: TEAM }, { teamId: TEAM, userId: "C0PRIVATE" }, { teamId: TEAM, userId: USER, cursor: "a b" }, { teamId: TEAM, userId: USER, types: "public_channel" }, { teamId: TEAM, userId: USER, extra: 1 }]) {
      expect(MemberChannelsRequestSchema.safeParse({ kind: "member-channels", ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the identity function answers it from users.conversations, and a malformed request is invalid_request", async () => {
    const identity = identityHarness({ userChannels: { [USER]: [PRIVATE[0]!, PRIVATE[4]!] } });
    expect(await identity.handler({ kind: "member-channels", teamId: TEAM, userId: USER })).toEqual({ ok: true, channels: [{ id: "C0PRIVATE", name: "secret", kind: "private", extShared: false, joined: true }] });
    expect(await identity.handler({ kind: "member-channels", teamId: TEAM, userId: "U0NOTHERE" })).toEqual({ ok: true, channels: [] });
    expect(await identity.handler({ kind: "member-channels", teamId: TEAM } as never)).toEqual({ ok: false, error: "invalid_request" });
    expect(await identity.handler({ kind: "member-channels", teamId: TEAM, userId: USER, types: "public_channel" } as never)).toEqual({ ok: false, error: "invalid_request" });
    // The listing a person of another workspace would see is never the bot's: the only user asked about is the one named.
    expect(identity.fetch.calls.filter((call) => call.includes("users.conversations"))).toHaveLength(2);
  });

  it("the broker's wire reaches the identity function end to end and keeps the cursor and the missing-scope answer", async () => {
    const identity = identityHarness({ userChannels: { [USER]: [PRIVATE[0]!] } });
    const invoke = async (payload: Uint8Array) => ({ Payload: new TextEncoder().encode(JSON.stringify(await identity.handler(JSON.parse(new TextDecoder().decode(payload)) as never))) });
    expect(await memberChannelsThroughLambda(invoke)({ kind: "member-channels", teamId: TEAM, userId: USER })).toEqual({ ok: true, channels: [{ id: "C0PRIVATE", name: "secret", kind: "private", extShared: false, joined: true }] });
    const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });
    const request = { kind: "member-channels", teamId: TEAM, userId: USER } as const;
    expect(await memberChannelsThroughLambda(async () => reply({ ok: true, channels: [], next: "abc=" }))(request)).toEqual({ ok: true, channels: [], next: "abc=" });
    expect(await memberChannelsThroughLambda(async () => reply({ ok: false, error: "missing_scope" }))(request)).toEqual({ ok: false, error: "missing_scope" });
  });

  it("anything it does not understand is slack_unavailable (fail closed); an identity function that has no member-channels answers invalid_request, which is unavailable too", async () => {
    const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });
    const request = { kind: "member-channels", teamId: TEAM, userId: USER } as const;
    const unavailable = { ok: false, error: "slack_unavailable" };
    for (const body of [{ ok: true }, { ok: true, channels: "x" }, { ok: false, error: "slack_unavailable" }, { ok: false, error: "weird_code" }, "junk"]) {
      expect(await memberChannelsThroughLambda(async () => reply(body))(request), JSON.stringify(body)).toEqual(unavailable);
    }
    // Only private entries pass: a public channel in the reply is dropped on the broker side too, and an entry without the shape is left out.
    expect(await memberChannelsThroughLambda(async () => reply({ ok: true, channels: [
      { id: "C0PRIVATE", name: "secret", kind: "private", extShared: false, joined: true },
      { id: "C0PUBLIC1", name: "general", kind: "public", extShared: false, joined: true },
      { id: "D0DIRECT1", name: "x", kind: "im", extShared: false, joined: true },
      { id: "C0X", name: 1, kind: "private", extShared: false, joined: true },
    ] }))(request)).toEqual({ ok: true, channels: [{ id: "C0PRIVATE", name: "secret", kind: "private", extShared: false, joined: true }] });
    expect(await memberChannelsThroughLambda(async () => reply({ ok: false, error: "invalid_request" }))(request)).toEqual({ ok: false, error: "invalid_request" });
    expect(await memberChannelsThroughLambda(vi.fn(async () => { throw new Error("no route"); }))(request)).toEqual(unavailable);
    expect(await memberChannelsThroughLambda(async () => ({ FunctionError: "Unhandled" }))(request)).toEqual(unavailable);
  });
});
