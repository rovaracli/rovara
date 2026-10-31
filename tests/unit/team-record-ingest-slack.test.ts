import { describe, expect, it } from "vitest";
import { createSlackRecordTap, slackRetention, withChannelInfoCache, type SlackChannelInfo, type SlackRecordTapDependencies } from "../../packages/broker/src/team-record/sources/slack.js";
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
  const state = { optIn: false, unbound: false };
  const deps: SlackRecordTapDependencies = {
    edition, sink: w.sink, distiller: w.distiller, actors: w.actors, mode: w.mode, config: w.config,
    resolveWorkspace: async (team) => (team === TEAM ? { workspaceId: WS, project: "shop", ...(state.unbound ? { unbound: true as const } : {}) } : undefined),
    notesOptIn: async () => state.optIn,
    directory: { channelInfo: async (team, channel) => { lookups.push(channel); return channels[channel]; } },
  };
  return { w, tap: createSlackRecordTap(deps), lookups, deps, state };
}

const message = (over: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => ({
  type: "event_callback", team_id: TEAM, api_app_id: BOT_APP, event_id: "Ev1",
  event: { type: "message", channel: CH, user: USER, text: "we always pin the base image", ts: TS, ...over },
  ...envelope,
});

describe("Slack tap: retention by edition", () => {
  it("Public: Slack is live only by default; a channel row set to B, C or D never turns on storing or distilling by itself", async () => {
    for (const retention of ["B", "C", "D"] as const) {
      const { w, tap } = setup("public");
      w.config.set("slack", `slack:${TEAM}/${CH}`, { retention });
      expect(await tap(message())).toEqual({ outcome: "ignored", reason: "retention_a" });
      expect(w.distiller.received).toEqual([]);
      expect(w.sink.puts).toEqual([]);
    }
  });

  it("Public: B with the workspace's explicit opt-in sends the text to the distiller in memory, and the record stores nothing; C and D stay off even then", async () => {
    const { w, tap, state } = setup("public");
    state.optIn = true;
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "B" });
    const outcome = await tap(message({ text: `deploy with ${AWS_KEY}` }));
    expect(outcome).toEqual({ outcome: "recorded", retention: "B", stored: false });
    // Positive control: the distiller really got the (redacted) text; and the record got nothing at all.
    expect(w.distiller.received).toHaveLength(1);
    expect(w.distiller.received[0]!.text).toContain("deploy with");
    expect(w.distiller.received[0]!.text).not.toContain(AWS_KEY);
    expect(w.sink.puts).toEqual([]);
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "D" });
    expect(await tap(message({ ts: "1758657601.000200" }))).toEqual({ outcome: "ignored", reason: "retention_a" });
    expect(w.distiller.received).toHaveLength(1);
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
    expect(["A", "B", "C", "D"].map((r) => slackRetention("public", r as "A"))).toEqual(["A", "A", "A", "A"]);
    expect(["A", "B", "C", "D"].map((r) => slackRetention("public", r as "A", true))).toEqual(["A", "B", "A", "A"]);
    expect(["A", "B", "C", "D"].map((r) => slackRetention("enterprise", r as "A"))).toEqual(["A", "B", "C", "D"]);
  });
});

describe("Slack tap: what is never recorded", () => {
  it("refuses Slack Connect channels in both editions, and removes what was recorded when a channel becomes one", async () => {
    for (const edition of ["public", "enterprise"] as const) {
      const { w, tap, state } = setup(edition);
      state.optIn = true;
      w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "B" });
      expect(await tap(message({}, { is_ext_shared_channel: true }))).toEqual({ outcome: "ignored", reason: "ext_shared" });
      expect(w.sink.tombstones).toMatchObject([{ scope: `slack:${TEAM}/${CH}`, cause: "excluded" }]);
      const shared = setup(edition, { [CH]: { kind: "public", extShared: true } });
      shared.state.optIn = true;
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

  it("a delete inside a channel flagged as Slack Connect is still honoured", async () => {
    const { w, tap } = setup("enterprise");
    const outcome = await tap({ type: "event_callback", team_id: TEAM, is_ext_shared_channel: true, event: { type: "message", subtype: "message_deleted", channel: CH, deleted_ts: TS, ts: "1758658000.000100" } });
    expect(outcome).toEqual({ outcome: "deleted" });
    expect(w.sink.tombstones).toMatchObject([{ sourceIds: [`${CH}/${TS}`] }]);
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
    w.config.set("slack", `slack:${TEAM}/C0UNKNOWN001`, { retention: "C" });
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
    // The same item id with a new version: the sink replaces the old text with the new.
    expect(w.sink.puts.map((draft) => [draft.sourceRef.id, draft.sourceRef.version])).toEqual([[`${CH}/${TS}`, "e:1758657900.000000"]]);
    expect(w.sink.puts[0]!.structured).toMatchObject({ edited: true });
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

  it("replaces a channel's audience on the message subtypes Slack really sends for a conversion", async () => {
    const channels: Record<string, SlackChannelInfo> = { [CH]: { kind: "private", extShared: false, memberIds: [USER] } };
    const { w, tap } = setup("enterprise", channels);
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", subtype: "channel_convert_to_private", channel: CH, user: USER, ts: "1758658100.000100", text: "converted" } })).toEqual({ outcome: "audience_replaced" });
    expect(w.sink.audienceReplacements[0]).toMatchObject({ scope: `slack:${TEAM}/${CH}`, audience: { kind: "restricted", acl: { principals: [USER] } } });
    // And the conversion message itself is not recorded as a message.
    expect(w.sink.puts).toEqual([]);
  });

  it("going private with Slack unreachable leaves nobody with access instead of the old audience; going public with Slack unreachable changes nothing", async () => {
    const { w, tap } = setup("enterprise", {});
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", subtype: "channel_convert_to_private", channel: CH } });
    expect(w.sink.audienceReplacements[0]).toMatchObject({ audience: { kind: "restricted", acl: { principals: [] } } });
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", subtype: "channel_convert_to_public", channel: CH } })).toEqual({ outcome: "ignored", reason: "channel_unknown" });
    expect(w.sink.audienceReplacements).toHaveLength(1);
  });

  it("removes rows taken under the old id when a channel's id changes", async () => {
    const { w, tap } = setup("enterprise");
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "channel_id_changed", old_channel_id: PRIV, new_channel_id: "G0NEWID0001" } })).toEqual({ outcome: "scope_removed" });
    expect(w.sink.tombstones).toMatchObject([{ scope: `slack:${TEAM}/${PRIV}`, cause: "source_deleted" }]);
  });
});

describe("Slack tap: deletions, edits and uninstall", () => {
  it("a deleted thread parent (an edit to a tombstone message) removes the original text instead of storing a new version", async () => {
    const { w, tap } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    await tap(message());
    expect(w.sink.puts).toHaveLength(1);
    const outcome = await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", subtype: "message_changed", channel: CH, ts: "1758658200.000100", message: { type: "message", subtype: "tombstone", user: "USLACKBOT", text: "This message was deleted.", ts: TS, thread_ts: TS } } });
    expect(outcome).toEqual({ outcome: "deleted" });
    expect(w.sink.tombstones).toMatchObject([{ sourceIds: [`${CH}/${TS}`], cause: "source_deleted" }]);
    expect(w.sink.puts).toHaveLength(1);
  });

  it("an edit leaves only the edited text in the record (a new version replaces the old one's text)", async () => {
    const { w, tap } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    await tap(message({ text: "the password is hunter2-ish" }));
    await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", subtype: "message_changed", channel: CH, ts: "1758657900.000100", message: { type: "message", user: USER, text: "removed", ts: TS, edited: { user: USER, ts: "1758657900.000000" } } } });
    expect(w.sink.puts.map((draft) => draft.text)).toEqual(["removed"]);
  });

  it("an uninstall removes everything of the team in Public; Enterprise removes it unless the customer's own policy keeps it; revoking only a user token does nothing", async () => {
    const pub = setup("public");
    expect(await pub.tap({ type: "event_callback", team_id: TEAM, event: { type: "app_uninstalled" } })).toEqual({ outcome: "team_removed" });
    expect(pub.w.sink.tombstones).toMatchObject([{ system: TEAM, scope: `slack:${TEAM}`, cause: "source_deleted" }]);
    const ent = setup("enterprise");
    expect(await ent.tap({ type: "event_callback", team_id: TEAM, event: { type: "tokens_revoked", tokens: { bot: ["U0BOT000001"] } } })).toEqual({ outcome: "team_removed" });
    expect(await ent.tap({ type: "event_callback", team_id: TEAM, event: { type: "tokens_revoked", tokens: { oauth: ["U0ALICE0001"] } } })).toEqual({ outcome: "ignored", reason: "unsupported_event" });
    expect(ent.w.sink.tombstones).toHaveLength(1);
    const kept = createSlackRecordTap({ ...ent.deps, keepOnUninstall: true });
    expect(await kept({ type: "event_callback", team_id: TEAM, event: { type: "app_uninstalled" } })).toEqual({ outcome: "ignored", reason: "kept_by_policy" });
    // A keep policy is Enterprise's own: Public ignores it.
    const pubKeep = createSlackRecordTap({ ...pub.deps, keepOnUninstall: true });
    await pubKeep({ type: "event_callback", team_id: TEAM, event: { type: "app_uninstalled" } });
    expect(pub.w.sink.tombstones).toHaveLength(2);
  });

  it("a team that is no longer bound still has its deletes and uninstall honoured, and nothing else read", async () => {
    const { w, tap, state } = setup("enterprise");
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    state.unbound = true;
    expect(await tap(message())).toEqual({ outcome: "ignored", reason: "team_unbound_deletes_only" });
    expect(w.sink.puts).toEqual([]);
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "message", subtype: "message_deleted", channel: CH, deleted_ts: TS } })).toEqual({ outcome: "deleted" });
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "app_uninstalled" } })).toEqual({ outcome: "team_removed" });
    expect(await tap({ type: "event_callback", team_id: TEAM, event: { type: "member_joined_channel", channel: PRIV, channel_type: "G", user: "U0CAROL0001" } })).toEqual({ outcome: "ignored", reason: "team_unbound_deletes_only" });
  });
});

describe("Slack tap: the work done per message", () => {
  it("asks Slack nothing for a channel with no source row, or for a live-only row", async () => {
    const { w, tap, lookups } = setup("enterprise");
    await tap(message());
    expect(lookups).toEqual([]);
    const pub = setup("public");
    pub.w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "B" });
    await pub.tap(message());
    expect(pub.lookups).toEqual([]);
    w.config.set("slack", `slack:${TEAM}/${CH}`, { retention: "C" });
    await tap(message());
    expect(lookups).toEqual([CH]);
  });

  it("keeps channel answers for five minutes and forgets them on membership and conversion events", async () => {
    let calls = 0;
    let clock = 0;
    const cached = withChannelInfoCache({ channelInfo: async () => { calls += 1; return { kind: "public", extShared: false }; } }, { ttlMs: 300_000, now: () => clock });
    await cached.channelInfo(TEAM, CH);
    await cached.channelInfo(TEAM, CH);
    expect(calls).toBe(1);
    clock = 299_999;
    await cached.channelInfo(TEAM, CH);
    expect(calls).toBe(1);
    clock = 300_001;
    await cached.channelInfo(TEAM, CH);
    expect(calls).toBe(2);
    cached.invalidate!(TEAM, CH);
    await cached.channelInfo(TEAM, CH);
    expect(calls).toBe(3);
    // An unknown answer is not cached.
    let known = false;
    const flaky = withChannelInfoCache({ channelInfo: async () => (known ? { kind: "public" as const, extShared: false } : undefined) });
    expect(await flaky.channelInfo(TEAM, CH)).toBeUndefined();
    known = true;
    expect(await flaky.channelInfo(TEAM, CH)).toBeDefined();
  });

  it("invalidates the cached channel answer when someone joins, so a new member list is read", async () => {
    const invalidated: string[] = [];
    const { tap, deps } = setup("enterprise");
    const spy = createSlackRecordTap({ ...deps, directory: { channelInfo: (team, channel) => deps.directory.channelInfo(team, channel), invalidate: (team, channel) => { invalidated.push(`${team}/${channel}`); } } });
    await spy({ type: "event_callback", team_id: TEAM, event: { type: "member_joined_channel", channel: PRIV, channel_type: "G", user: "U0CAROL0001" } });
    expect(invalidated).toEqual([`${TEAM}/${PRIV}`]);
    void tap;
  });
});
