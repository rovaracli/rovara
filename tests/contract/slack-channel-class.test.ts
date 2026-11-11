// What Slack says a channel IS, for the Team record's source rows (source-row lane, task 7): the DeveloperIdentity function (the only holder of the bot token) answers `channel-class` fresh, and the broker
// reaches it through the same Lambda invoke it already uses for channel names. No new token, secret, environment variable or permission.
import { describe, expect, it, vi } from "vitest";
import { ChannelClassRequestSchema } from "@rovara-code/contracts";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { channelClassThroughLambda } from "../../packages/broker/src/aws/developer-routes/identity-lambda.js";
import { BOT_TOKEN, T0, TEAM, fakeSlack, identityHarness, routeFetch } from "../support/developer-fakes.js";

const INFO = {
  C0PUBLIC1: { name: "general", isPrivate: false, raw: { is_channel: true } },
  C0PRIVATE: { name: "secret", isPrivate: true, raw: { is_channel: true, is_group: true } },
  D0DIRECT1: { name: "ignored", raw: { name: undefined, is_im: true, is_private: true } },
  G0GROUPDM: { name: "mpdm-a--b-1", isPrivate: true, raw: { is_mpim: true, is_group: true } },
  C0CONNECT: { name: "shared", isPrivate: false, raw: { is_channel: true, is_ext_shared: true } },
  C0PENDING: { name: "pending", isPrivate: false, raw: { is_channel: true, is_pending_ext_shared: true } },
  C0ODDKIND: { name: "odd", raw: {} },
  C0MISMTCH: { name: "mismatch", isPrivate: false, raw: { id: "C0SOMEONE", is_channel: true } },
};
function directory(options: { teamId?: string | undefined } = {}) {
  const problems: Array<{ method: string; status: number | undefined; error: string }> = [];
  const fake = fakeSlack({ users: [], channelInfo: INFO });
  const fetch = routeFetch(fake.handler);
  const dir = slackDirectory({ teamId: "teamId" in options ? options.teamId : TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => T0, report: (problem) => { problems.push(problem); } });
  return { dir, fake, fetch, problems };
}
const infoCalls = (fetch: { calls: string[] }) => fetch.calls.filter((call) => call.includes("conversations.info")).length;

describe("channel-class: the directory reads the channel fresh and classifies it", () => {
  it("public, private, DM, group DM and Slack Connect (shared or pending shared)", async () => {
    const { dir } = directory();
    expect(await dir.channelClass(TEAM, "C0PUBLIC1")).toEqual({ ok: true, channel: { kind: "public", extShared: false } });
    expect(await dir.channelClass(TEAM, "C0PRIVATE")).toEqual({ ok: true, channel: { kind: "private", extShared: false } });
    expect(await dir.channelClass(TEAM, "D0DIRECT1")).toEqual({ ok: true, channel: { kind: "im", extShared: false } });
    expect(await dir.channelClass(TEAM, "G0GROUPDM")).toEqual({ ok: true, channel: { kind: "mpim", extShared: false } });
    expect(await dir.channelClass(TEAM, "C0CONNECT")).toEqual({ ok: true, channel: { kind: "public", extShared: true } });
    expect(await dir.channelClass(TEAM, "C0PENDING")).toEqual({ ok: true, channel: { kind: "public", extShared: true } });
  });

  it("is never cached: a channel made private is private on the next ask", async () => {
    const { dir, fetch } = directory();
    await dir.channelClass(TEAM, "C0PUBLIC1");
    await dir.channelClass(TEAM, "C0PUBLIC1");
    expect(infoCalls(fetch)).toBe(2);
  });

  it("a channel Slack does not know is { ok: true } without a channel", async () => {
    const { dir } = directory();
    expect(await dir.channelClass(TEAM, "C0NOBODY1")).toEqual({ ok: true });
  });

  it("fails closed: another team than the install's, no team configured, Slack down, a kind Slack did not state, an id that does not match", async () => {
    const mine = directory();
    expect(await mine.dir.channelClass("T0OTHER99", "C0PUBLIC1")).toEqual({ ok: false, error: "slack_unavailable" });
    expect(infoCalls(mine.fetch)).toBe(0);
    expect(await directory({ teamId: undefined }).dir.channelClass(TEAM, "C0PUBLIC1")).toEqual({ ok: false, error: "slack_unavailable" });
    // SRL-14: a channel Slack shows but that cannot be classified is refused like one Rovara cannot see ({ ok: true } without a channel), not a different and faster 503.
    for (const channel of ["C0ODDKIND", "C0MISMTCH"]) expect(await mine.dir.channelClass(TEAM, channel), channel).toEqual({ ok: true });
    mine.fake.state.down = true;
    expect(await mine.dir.channelClass(TEAM, "C0PUBLIC1")).toEqual({ ok: false, error: "slack_unavailable" });
  });

  it("reports a token problem by Slack's own code, never the token", async () => {
    const problems: Array<{ method: string; status: number | undefined; error: string }> = [];
    const fetch = routeFetch(async (url) => (url.pathname === "/api/conversations.info" ? Response.json({ ok: false, error: "missing_scope" }) : undefined));
    const dir = slackDirectory({ teamId: TEAM, botToken: async () => BOT_TOKEN, fetch, now: () => T0, report: (problem) => { problems.push(problem); } });
    expect(await dir.channelClass(TEAM, "D0DIRECT1")).toEqual({ ok: false, error: "slack_unavailable" });
    expect(problems).toEqual([{ method: "conversations.info", status: 200, error: "missing_scope" }]);
    expect(JSON.stringify(problems)).not.toContain(BOT_TOKEN);
  });
});

describe("channel-class: the request shape and the Lambda wire", () => {
  it("accepts a DM id (D...) and refuses anything else, including extra fields", () => {
    expect(ChannelClassRequestSchema.safeParse({ kind: "channel-class", teamId: TEAM, channelId: "D0DIRECT1" }).success).toBe(true);
    for (const bad of [{ teamId: "x", channelId: "C0PUBLIC1" }, { teamId: TEAM, channelId: "c0public1" }, { teamId: TEAM, channelId: "U0PERSON1" }, { teamId: TEAM, channelId: "C0PUBLIC1", extra: 1 }]) {
      expect(ChannelClassRequestSchema.safeParse({ kind: "channel-class", ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("the identity function answers it, and a malformed request is invalid_request", async () => {
    const identity = identityHarness({ channelInfo: INFO });
    expect(await identity.handler({ kind: "channel-class", teamId: TEAM, channelId: "D0DIRECT1" })).toEqual({ ok: true, channel: { kind: "im", extShared: false } });
    expect(await identity.handler({ kind: "channel-class", teamId: TEAM, channelId: "nope" } as never)).toEqual({ ok: false, error: "invalid_request" });
  });

  it("the broker's wire reaches the identity function end to end, and keeps the kind and the shared flag", async () => {
    const identity = identityHarness({ channelInfo: INFO });
    const invoke = async (payload: Uint8Array) => ({ Payload: new TextEncoder().encode(JSON.stringify(await identity.handler(JSON.parse(new TextDecoder().decode(payload)) as never))) });
    expect(await channelClassThroughLambda(invoke)({ kind: "channel-class", teamId: TEAM, channelId: "C0CONNECT" })).toEqual({ ok: true, channel: { kind: "public", extShared: true } });
    expect(await channelClassThroughLambda(invoke)({ kind: "channel-class", teamId: TEAM, channelId: "C0NOBODY1" })).toEqual({ ok: true });
  });

  it("anything it does not understand is slack_unavailable (fail closed)", async () => {
    const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });
    const request = { kind: "channel-class", teamId: TEAM, channelId: "C0PUBLIC1" } as const;
    for (const body of [{ ok: true, channel: { kind: "weird", extShared: false } }, { ok: true, channel: { kind: "public" } }, { ok: true, channel: "x" }, { ok: false, error: "slack_unavailable" }, "junk"]) {
      expect(await channelClassThroughLambda(async () => reply(body))(request), JSON.stringify(body)).toEqual({ ok: false, error: "slack_unavailable" });
    }
    expect(await channelClassThroughLambda(vi.fn(async () => { throw new Error("no route"); }))(request)).toEqual({ ok: false, error: "slack_unavailable" });
    expect(await channelClassThroughLambda(async () => ({ FunctionError: "Unhandled" }))(request)).toEqual({ ok: false, error: "slack_unavailable" });
  });
});
