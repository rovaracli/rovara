// R6: the Slack tap. `createSlackRecordTap` reads a Slack Events API delivery that the Slack ingress has already signature-checked, and
// writes to the Team record only what the source row for that channel allows.
//
// Slack's API terms (effective 10 Oct 2025, design CONTEXT decision 4) bind the Public edition: retention "the minimum necessary", no persistent
// copies or indexes, no cross-organisation use. So in Public the row is fixed at A (read live) or B (text goes to the distiller in memory;
// only distilled notes with permalinks survive). C and D (raw text kept) are Enterprise only. DMs and group DMs are Enterprise only and
// only when an admin added them. Slack Connect channels are refused in both editions.
import { cleanText, gate, isExcluded, isoOfSlackTs, linksOf, scalars, type GateDependencies } from "./common.js";
import type { ActorResolverPort, Audience, Edition, RecordDraft, RecordSinkPort, Retention, SourceConfig, TapLog, TransientDistillerPort } from "./ports.js";

export interface SlackChannelInfo {
  kind: "public" | "private" | "im" | "mpim";
  /** Slack Connect or otherwise shared with another organisation. */
  extShared: boolean;
  /** Present for private channels: the members now. */
  memberIds?: readonly string[];
}

export interface SlackDirectoryPort {
  /** `conversations.info` (plus `conversations.members` for a private channel). `undefined` or a throw means unknown, and unknown is not recorded. */
  channelInfo(teamId: string, channelId: string): Promise<SlackChannelInfo | undefined>;
  /** `chat.getPermalink`. Optional: without it a Slack app-redirect link is used. */
  permalink?(teamId: string, channelId: string, ts: string): Promise<string | undefined>;
}

export interface SlackRecordTapDependencies extends GateDependencies {
  edition: Edition;
  sink: RecordSinkPort;
  distiller: TransientDistillerPort;
  actors: ActorResolverPort;
  directory: SlackDirectoryPort;
  /** The org (workspace) a Slack team is bound to. An unbound team is not recorded. */
  resolveWorkspace(teamId: string): Promise<{ workspaceId: string; project?: string } | undefined>;
  log?: TapLog;
}

export type SlackTapOutcome =
  | { outcome: "recorded"; retention: Retention; stored: boolean }
  | { outcome: "deleted" | "acl_updated" | "scope_removed" | "audience_replaced" }
  | { outcome: "ignored"; reason: SlackIgnoreReason };

export type SlackIgnoreReason =
  | "not_event" | "malformed" | "unsupported_event" | "unsupported_subtype" | "own_message" | "external_user" | "ext_shared" | "unbound_team"
  | "channel_unknown" | "dm_not_allowed" | "no_source_row" | "excluded" | "empty_text" | "retention_a" | "refused" | "failed" | "public_private_unchanged";

const TEAM = /^[TE][A-Z0-9]{2,31}$/;
const CHANNEL = /^[CGD][A-Z0-9]{2,31}$/;
const USER = /^[UW][A-Z0-9]{2,31}$/;
const TS = /^\d{10}\.\d{1,9}$/;
const PRINCIPALS_MAX = 500;

export const slackScope = (teamId: string, channelId: string): string => `slack:${teamId}/${channelId}`;

/** The retention a Slack row may have. In Public it is A or B only: a stored C or D is read as B (the safer, not the missing, setting). */
export function slackRetention(edition: Edition, configured: Retention): Retention {
  if (edition === "enterprise") return configured;
  return configured === "A" ? "A" : "B";
}

export function createSlackRecordTap(deps: SlackRecordTapDependencies): (payload: unknown) => Promise<SlackTapOutcome> {
  const log: TapLog = deps.log ?? (() => undefined);
  const ignored = (reason: SlackIgnoreReason): SlackTapOutcome => ({ outcome: "ignored", reason });

  return async (payload) => {
    try {
      return await handle(payload);
    } catch {
      // Recording is never allowed to fail the Slack delivery that carried it, and no error text is logged.
      log("record.slack_failed", {});
      return ignored("failed");
    }
  };

  async function handle(payload: unknown): Promise<SlackTapOutcome> {
    const body = asRecord(payload);
    if (body.type !== "event_callback") return ignored("not_event");
    const teamId = body.team_id;
    const event = asRecord(body.event);
    if (typeof teamId !== "string" || !TEAM.test(teamId) || typeof event.type !== "string") return ignored("malformed");
    const bound = await deps.resolveWorkspace(teamId);
    if (bound === undefined) return ignored("unbound_team");

    switch (event.type) {
      case "channel_deleted": {
        const channelId = event.channel;
        if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return ignored("malformed");
        await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope: slackScope(teamId, channelId), cause: "source_deleted" });
        return { outcome: "scope_removed" };
      }
      case "channel_shared": {
        // The channel became a Slack Connect channel: what was recorded from it is removed, and nothing more is recorded.
        const channelId = event.channel;
        if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return ignored("malformed");
        await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope: slackScope(teamId, channelId), cause: "excluded" });
        return { outcome: "scope_removed" };
      }
      case "member_joined_channel":
      case "member_left_channel":
        return membership(bound.workspaceId, teamId, event);
      case "channel_convert_to_private":
      case "channel_convert_to_public":
        return conversion(bound, teamId, event);
      case "message":
        return message(bound, teamId, body, event);
      default:
        return ignored("unsupported_event");
    }
  }

  async function membership(workspaceId: string, teamId: string, event: Record<string, unknown>): Promise<SlackTapOutcome> {
    const channelId = event.channel;
    const userId = event.user;
    if (typeof channelId !== "string" || !CHANNEL.test(channelId) || typeof userId !== "string" || !USER.test(userId)) return ignored("malformed");
    // Only a private channel's audience is a member list; a public channel's snapshot does not change when someone joins.
    if (event.channel_type !== "G" && !channelId.startsWith("G")) return ignored("public_private_unchanged");
    const at = isoOfSlackTs(event.event_ts) ?? new Date().toISOString();
    const scope = slackScope(teamId, channelId);
    await deps.sink.changePrincipals({ workspaceId, scope, ...(event.type === "member_joined_channel" ? { add: [userId] } : { remove: [userId] }), at });
    return { outcome: "acl_updated" };
  }

  async function conversion(bound: { workspaceId: string }, teamId: string, event: Record<string, unknown>): Promise<SlackTapOutcome> {
    const channelId = event.channel;
    if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return ignored("malformed");
    const info = await deps.directory.channelInfo(teamId, channelId);
    if (info === undefined || (info.kind !== "private" && info.kind !== "public")) return ignored("channel_unknown");
    if (info.extShared) {
      await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope: slackScope(teamId, channelId), cause: "excluded" });
      return { outcome: "scope_removed" };
    }
    const at = new Date().toISOString();
    const config = await deps.config.get(bound.workspaceId, "slack", slackScope(teamId, channelId)).catch(() => undefined);
    await deps.sink.replaceScopeAudience({ workspaceId: bound.workspaceId, scope: slackScope(teamId, channelId), audience: audienceOf(teamId, channelId, info, config, at), at });
    return { outcome: "audience_replaced" };
  }

  async function message(bound: { workspaceId: string; project?: string }, teamId: string, envelope: Record<string, unknown>, event: Record<string, unknown>): Promise<SlackTapOutcome> {
    const channelId = event.channel;
    if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return ignored("malformed");
    if (envelope.is_ext_shared_channel === true) return ignored("ext_shared");
    const subtype = event.subtype;

    if (subtype === "message_deleted") {
      const deletedTs = event.deleted_ts;
      if (typeof deletedTs !== "string" || !TS.test(deletedTs)) return ignored("malformed");
      // A delete is honoured whatever the mode or the source row says now.
      await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, sourceIds: [messageId(channelId, deletedTs)], cause: "source_deleted" });
      return { outcome: "deleted" };
    }

    let source: Record<string, unknown>;
    let version: string;
    if (subtype === undefined || subtype === "thread_broadcast" || subtype === "file_share") {
      source = event;
      version = typeof event.ts === "string" ? `m:${event.ts}` : "";
    } else if (subtype === "message_changed") {
      source = asRecord(event.message);
      const edited = asRecord(source.edited);
      version = `e:${typeof edited.ts === "string" ? edited.ts : typeof event.ts === "string" ? event.ts : ""}`;
    } else {
      return ignored("unsupported_subtype");
    }
    const ts = source.ts;
    const userId = source.user;
    if (typeof ts !== "string" || !TS.test(ts) || version === "" || version.endsWith(":")) return ignored("malformed");
    if (typeof userId !== "string" || !USER.test(userId)) return ignored("malformed");
    // Rovara's own posts are never recorded; another bot's are recorded as system text.
    const ownApp = typeof envelope.api_app_id === "string" && (source.app_id === envelope.api_app_id || asRecord(source.bot_profile).app_id === envelope.api_app_id);
    if (ownApp) return ignored("own_message");
    const userTeam = source.user_team ?? source.team ?? event.user_team;
    if (typeof userTeam === "string" && userTeam !== teamId) return ignored("external_user");
    const isBot = "bot_id" in source || "app_id" in source || "bot_profile" in source;

    const info = await deps.directory.channelInfo(teamId, channelId).catch(() => undefined);
    if (info === undefined) return ignored("channel_unknown");
    if (info.extShared) {
      await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope: slackScope(teamId, channelId), cause: "excluded" });
      return ignored("ext_shared");
    }
    if ((info.kind === "im" || info.kind === "mpim") && deps.edition !== "enterprise") return ignored("dm_not_allowed");

    const scope = slackScope(teamId, channelId);
    const config = await gate(deps, { workspaceId: bound.workspaceId, ...(bound.project === undefined ? {} : { project: bound.project }), source: "slack", scope });
    if (config === undefined) return ignored("no_source_row");
    if (isExcluded(config, userId)) return ignored("excluded");
    const retention = slackRetention(deps.edition, config.retention);
    // Retention A: read live when needed. Nothing is kept, and nothing is distilled.
    if (retention === "A") return ignored("retention_a");

    const text = cleanText(source.text);
    if (text === undefined) return ignored("empty_text");
    const at = isoOfSlackTs(ts) ?? new Date().toISOString();
    const link = await permalinkOf(teamId, channelId, ts);
    const who = await deps.actors.resolve({ workspaceId: bound.workspaceId, project: bound.project ?? config.project, system: `slack:${teamId}`, sourceId: userId, isBot });
    const threadTs = typeof source.thread_ts === "string" && TS.test(source.thread_ts) && source.thread_ts !== ts ? source.thread_ts : undefined;
    const project = bound.project ?? config.project;
    const draft: RecordDraft & { text: string } = {
      workspaceId: bound.workspaceId, ...(project === undefined ? {} : { project }), source: "slack", kind: "slack.message", occurredAt: at,
      sourceRef: { system: teamId, id: messageId(channelId, ts), url: link, ...(threadTs === undefined ? {} : { parentId: messageId(channelId, threadTs) }), version },
      actor: { sourceId: userId, ...(who.developerId === undefined ? {} : { developerId: who.developerId }), trust: isBot ? "system" : who.trust },
      trust: isBot ? "system" : who.trust, audience: audienceOf(teamId, channelId, info, config, at), text,
      structured: scalars({ channelKind: info.kind, edited: subtype === "message_changed", threadReply: threadTs !== undefined }),
      links: linksOf(link), retention,
    };

    if (retention === "B") {
      // Process then drop: the text reaches the distiller in memory and the pipeline stores no raw text.
      const outcome = await deps.distiller.distillTransient(draft);
      return outcome.accepted ? { outcome: "recorded", retention, stored: false } : ignored("refused");
    }
    const outcome = await deps.sink.put(draft);
    if (outcome.status === "refused") return ignored("refused");
    return { outcome: "recorded", retention, stored: outcome.status === "stored" };
  }

  async function permalinkOf(teamId: string, channelId: string, ts: string): Promise<string> {
    try {
      const link = await deps.directory.permalink?.(teamId, channelId, ts);
      if (link !== undefined) return link;
    } catch {
      // Fall through to the redirect link.
    }
    return `https://slack.com/app_redirect?team=${teamId}&channel=${channelId}&message_ts=${ts}`;
  }
}

const messageId = (channelId: string, ts: string): string => `${channelId}/${ts}`;

/** Public channel: the team's snapshot, or the whole project when the admin said so. Private: the members now (a list over 500 keeps the first 500: the rest are denied, which is the safe side). */
function audienceOf(teamId: string, channelId: string, info: SlackChannelInfo, config: SourceConfig | undefined, at: string): Audience {
  const scope = slackScope(teamId, channelId);
  if (info.kind === "public") {
    if (config?.audienceDefault === "project") return { kind: "project" };
    return { kind: "restricted", acl: { source: "slack", scope, groups: [teamId], capturedAt: at, liveCheck: "none" } };
  }
  return { kind: "restricted", acl: { source: "slack", scope, principals: [...(info.memberIds ?? [])].slice(0, PRINCIPALS_MAX), capturedAt: at, liveCheck: "none" } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
