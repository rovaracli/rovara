import { describe, expect, it } from "vitest";
import { createSlackRecordTap, slackRetention, type SlackChannelInfo, type SlackRecordTapDependencies } from "../../packages/broker/src/team-record/sources/slack.js";
import { world, WS } from "../support/team-record-ingest-fakes.js";

const TEAM = "T0TEAM00001";
const CH = "C0123456789";
const PRIV = "G0123456789";
const DM = "D0123456789";
const USER = "U0ALICE0001";
const BOT_APP = "A0ROVARA001";
const AWS_KEY = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
const TS = "1758657600.000200";

function setup(edition: "public" | "enterprise" = "public", channels: Record<string, SlackChannelInfo> = { [CH]: { kind: "public", extShared: false }, [PRIV]: { kind: "private", extShared: false, memberIds: ["U0ALICE0001", "U0BOB000001"] }, [DM]: { kind: "im", extShared: false } }) {
  const w = world();
  w.actors.members.set(USER, "dev-alice");
  const lookups: string[] = [];
  const deps: SlackRecordTapDependencies = {
    edition, sink: w.sink, distiller: w.distiller, actors: w.actors, mode: w.mode, config: w.config,
    resolveWorkspace: async (team) => (team === TEAM ? { workspaceId: WS, project: "shop" } : undefined),
    directory: { channelInfo: async (team, channel) => { lookups.push(channel); return channels[channel]; } },
  };
  return { w, tap: createSlackRecordTap(deps), lookups, deps };
}

const message = (over: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => ({
  type: "event_callback", team_id: TEAM, api_app_id: BOT_APP, event_id: "Ev1",
  event: { type: "message", channel: CH, user: USER, text: "we always pin the base image", ts: TS, ...over },
  ...envelope,
});

describe("Slack tap: retention by edition", () => {
  it("Public: a row set to D is read as B, so the text reaches the distiller in memory and the record stores nothing", async () => {
    const { w, tap } = setup("public");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "D" });
    const outcome = await tap(message({ text: `deploy with ${AWS_KEY}` }));
    expect(outcome).toEqual({ outcome: "recorded", retention: "B", stored: false });
    // Positive control: the distiller really got the (redacted) text; and the record got nothing at all.
    expect(w.distiller.received).toHaveLength(1);
    expect(w.distiller.received[0]!.text).toContain("deploy with");
    expect(w.distiller.received[0]!.text).not.toContain(AWS_KEY);
    expect(w.sink.puts).toEqual([]);
  });

  it("Public: A reads live only; nothing is distilled or stored", async () => {
    const { w, tap } = setup("public");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "A" });
    expect(await tap(message())).toEqual({ outcome: "ignored", reason: "retention_a" });
    expect(w.distiller.received).toEqual([]);
    expect(w.sink.puts).toEqual([]);
  });

  it("Enterprise: C and D keep the text in the record, with the ACL snapshot", async () => {
    const { w, tap } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${PRIV}`, { retention: "C" });
    const outcome = await tap(message({ channel: PRIV }));
    expect(outcome).toEqual({ outcome: "recorded", retention: "C", stored: true });
    expect(w.distiller.received).toEqual([]);
    const draft = w.sink.puts[0]!;
    expect(draft).toMatchObject({ kind: "slack.message", source: "slack", workspaceId: WS, project: "shop", trust: "member", retention: "C" });
    expect(draft.text).toContain("pin the base image");
    expect(draft.audience).toMatchObject({ kind: "restricted", acl: { source: "slack", scope: `slack:${TEAM}/${PRIV}`, principals: ["U0ALICE0001", "U0BOB000001"] } });
    expect(draft.sourceRef).toMatchObject({ system: TEAM, id: `${PRIV}/${TS}`, version: `m:${TS}` });
    expect(draft.links[0]).toContain(`channel=${PRIV}`);
  });

  it("a public channel gets the team group snapshot, or the project when the admin said so", async () => {
    const { w, tap } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "D" });
    await tap(message());
    expect(w.sink.puts[0]!.audience).toMatchObject({ kind: "restricted", acl: { groups: [TEAM] } });
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "D", audienceDefault: "project" });
    await tap(message({ ts: "1758657700.000200" }));
    expect(w.sink.puts[1]!.audience).toEqual({ kind: "project" });
  });

  it("clamps retention in one place", () => {
    expect(["A", "B", "C", "D"].map((r) => slackRetention("public", r as "A"))).toEqual(["A", "B", "B", "B"]);
    expect(["A", "B", "C", "D"].map((r) => slackRetention("enterprise", r as "A"))).toEqual(["A", "B", "C", "D"]);
  });
});

describe("Slack tap: what is never recorded", () => {
  it("refuses Slack Connect channels in both editions, and removes what was recorded when a channel becomes one", async () => {
    for (const edition of ["public", "enterprise"] as const) {
      const { w, tap } = setup(edition);
      w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "B" });
      expect(await tap(message({}, { is_ext_shared_channel: true }))).toEqual({ outcome: "ignored", reason: "ext_shared" });
      const shared = setup(edition, { [CH]: { kind: "public", extShared: true } });
      shared.w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "B" });
      expect(await shared.tap(message())).toEqual({ outcome: "ignored", reason: "ext_shared" });
      expect(shared.w.distiller.received).toEqual([]);
      expect(shared.w.sink.tombstones).toMatchObject([{ scope: `slack:${TEAM}/${CH}`, cause: "excluded" }]);
      expect(w.distiller.received).toEqual([]);
    }
    const { w, tap } = setup("enterprise");
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "channel_shared", channel: CH } })).toEqual({ outcome: "scope_removed" });
    expect(w.sink.tombstones[0]).toMatchObject({ scope: `slack:${TEAM}/${CH}`, cause: "excluded" });
  });

  it("DMs are Enterprise only, and then only when an admin added the row", async () => {
    const pub = setup("public");
    pub.w.config.set("slack", `slack:${TEAM}/${DM}`, { retention: "B" });
    expect(await pub.tap(message({ channel: DM }))).toEqual({ outcome: "ignored", reason: "dm_not_allowed" });
    const ent = setup("enterprise");
    expect(await ent.tap(message({ channel: DM }))).toEqual({ outcome: "ignored", reason: "no_source_row" });
    ent.w.config.set("slack", `slack:${TEAM}/${DM}`, { retention: "C" });
    expect(await ent.tap(message({ channel: DM }))).toMatchObject({ outcome: "recorded", stored: true });
  });

  it("ignores unlisted channels, a disabled row, the mode off, excluded people, empty text, and another organisation's user", async () => {
    const { w, tap } = setup("enterprise");
    expect(await tap(message())).toEqual({ outcome: "ignored", reason: "no_source_row" });
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C", enabled: false });
    expect(await tap(message())).toEqual({ outcome: "ignored", reason: "no_source_row" });
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C", exclude: [USER] });
    expect(await tap(message())).toEqual({ outcome: "ignored", reason: "excluded" });
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    expect(await tap(message({ text: "​ \u0007" }))).toEqual({ outcome: "ignored", reason: "empty_text" });
    expect(await tap(message({ user_team: "T0OTHER0001" }))).toEqual({ outcome: "ignored", reason: "external_user" });
    w.mode.on = false;
    expect(await tap(message())).toEqual({ outcome: "ignored", reason: "no_source_row" });
    expect(w.sink.puts).toEqual([]);
  });

  it("ignores Rovara's own posts, records another bot as system text, and an unbound team or unknown channel is not recorded", async () => {
    const { w, tap } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    expect(await tap(message({ app_id: BOT_APP, bot_id: "B1" }))).toEqual({ outcome: "ignored", reason: "own_message" });
    await tap(message({ app_id: "A0OTHER0001", bot_id: "B2", ts: "1758657601.000200" }));
    expect(w.sink.puts[0]!.trust).toBe("system");
    expect(await tap({ ...message(), team_id: "T0UNBOUND01" })).toEqual({ outcome: "ignored", reason: "unbound_team" });
    expect(await tap(message({ channel: "C0UNKNOWN001" }))).toEqual({ outcome: "ignored", reason: "channel_unknown" });
    expect(w.sink.puts).toHaveLength(1);
  });

  it("maps an unlinked Slack person to outsider", async () => {
    const { w, tap } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    await tap(message({ user: "U0STRANGER01" }));
    expect(w.sink.puts[0]!.trust).toBe("outsider");
    expect(w.sink.puts[0]!.audience.kind).toBe("restricted");
  });

  it("never throws: a failing directory, source row read or sink is a quiet ignore", async () => {
    const { w, tap, deps } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    w.sink.failPut = true;
    expect(await tap(message())).toEqual({ outcome: "ignored", reason: "failed" });
    const broken = createSlackRecordTap({ ...deps, directory: { channelInfo: async () => { throw new Error("slack down"); } } });
    expect(await broken(message())).toEqual({ outcome: "ignored", reason: "channel_unknown" });
    w.config.throws = true;
    w.sink.failPut = false;
    expect(await tap(message())).toEqual({ outcome: "ignored", reason: "no_source_row" });
    expect(await tap("garbage")).toEqual({ outcome: "ignored", reason: "not_event" });
  });
});

describe("Slack tap: edits, deletes and membership", () => {
  it("records an edit as a new version of the same message", async () => {
    const { w, tap } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    await tap(message());
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", subtype: "message_changed", channel: CH, ts: "1758657900.000100", message: { type: "message", user: USER, text: "we pin the base image by digest", ts: TS, edited: { user: USER, ts: "1758657900.000000" } } } });
    expect(w.sink.puts.map((draft) => draft.sourceRef.id)).toEqual([`${CH}/${TS}`, `${CH}/${TS}`]);
    expect(w.sink.puts.map((draft) => draft.sourceRef.version)).toEqual([`m:${TS}`, "e:1758657900.000000"]);
    expect(w.sink.puts[1]!.structured).toMatchObject({ edited: true });
  });

  it("propagates a delete, and a channel delete, whatever the mode or the row says now", async () => {
    const { w, tap } = setup("public");
    w.mode.on = false;
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", subtype: "message_deleted", channel: CH, deleted_ts: TS, ts: "1758658000.000100" } })).toEqual({ outcome: "deleted" });
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "channel_deleted", channel: CH } })).toEqual({ outcome: "scope_removed" });
    expect(w.sink.tombstones).toMatchObject([
      { system: TEAM, sourceIds: [`${CH}/${TS}`], cause: "source_deleted" },
      { system: TEAM, scope: `slack:${TEAM}/${CH}`, cause: "source_deleted" },
    ]);
  });

  it("refreshes a private channel's members on join and leave, and leaves a public channel alone", async () => {
    const { w, tap } = setup("enterprise");
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "member_joined_channel", channel: PRIV, channel_type: "G", user: "U0CAROL0001", event_ts: TS } });
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "member_left_channel", channel: PRIV, channel_type: "G", user: "U0BOB000001", event_ts: TS } });
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "member_joined_channel", channel: CH, channel_type: "C", user: "U0CAROL0001" } })).toEqual({ outcome: "ignored", reason: "public_private_unchanged" });
    expect(w.sink.principalChanges).toMatchObject([
      { scope: `slack:${TEAM}/${PRIV}`, add: ["U0CAROL0001"] },
      { scope: `slack:${TEAM}/${PRIV}`, remove: ["U0BOB000001"] },
    ]);
  });

  it("replaces a channel's audience when it changes between public and private", async () => {
    const channels: Record<string, SlackChannelInfo> = { [CH]: { kind: "private", extShared: false, memberIds: [USER] } };
    const { w, tap } = setup("enterprise", channels);
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "channel_convert_to_private", channel: CH } });
    expect(w.sink.audienceReplacements[0]).toMatchObject({ scope: `slack:${TEAM}/${CH}`, audience: { kind: "restricted", acl: { principals: [USER] } } });
  });
});
