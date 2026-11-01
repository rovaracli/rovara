// R6: the Slack tap. `createSlackRecordTap` reads a Slack Events API delivery that the Slack ingress has already signature-checked, and
// writes to the Team record only what the source row for that channel allows.
//
// Slack's API terms (effective 10 Oct 2025, design CONTEXT decision 4) bind the Public edition: retention "the minimum necessary", no persistent
// copies or indexes, no cross-organisation use. Owner decision Q4: in Public, Slack is read LIVE ONLY (A) by default. "Notes with links" (B: the
// text goes to the distiller in memory, only distilled notes with permalinks survive) is an explicit, labelled workspace-level opt-in held until legal
// review; a channel row alone never turns it on, and C and D (raw text kept) do not exist in Public. DMs and group DMs are Enterprise only and only
// when an admin added them. Slack Connect channels are refused in both editions. A delete, a deleted channel and an uninstall are always honoured.
import { cleanText, gate, isExcluded, isoOfSlackTs, linksOf, scalars, type GateDependencies } from "./common.js";
import { lowestTrust, type ActorResolverPort, type Audience, type Edition, type RecordDraft, type RecordSinkPort, type Retention, type SourceConfig, type TapLog, type TransientDistillerPort } from "./ports.js";

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
  /** Forgets a cached answer: called on membership, conversion, sharing and id-change events. */
  invalidate?(teamId: string, channelId: string): void;
}

/** `channelInfo` answers are kept for `ttlMs` per team and channel (default 5 minutes), so a busy channel costs one Slack call, not one per message. Unknown answers are not cached. */
export function withChannelInfoCache(directory: SlackDirectoryPort, options: { ttlMs?: number; now?: () => number; maxEntries?: number } = {}): SlackDirectoryPort {
  const ttl = options.ttlMs ?? 300_000;
  const now = options.now ?? Date.now;
  const max = options.maxEntries ?? 5_000;
  const cache = new Map<string, { at: number; info: SlackChannelInfo }>();
  return {
    ...(directory.permalink === undefined ? {} : { permalink: directory.permalink.bind(directory) }),
    async channelInfo(teamId, channelId) {
      const key = `${teamId}/${channelId}`;
      const hit = cache.get(key);
      if (hit !== undefined && now() - hit.at < ttl) return hit.info;
      const info = await directory.channelInfo(teamId, channelId);
      if (info !== undefined) {
        if (cache.size >= max) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: now(), info });
      }
      return info;
    },
    invalidate(teamId, channelId) {
      cache.delete(`${teamId}/${channelId}`);
      directory.invalidate?.(teamId, channelId);
    },
  };
}

export interface SlackRecordTapDependencies extends GateDependencies {
  edition: Edition;
  sink: RecordSinkPort;
  distiller: TransientDistillerPort;
  actors: ActorResolverPort;
  directory: SlackDirectoryPort;
  /**
   * The org (workspace) a Slack team is bound to. An unbound team is not recorded. A team that WAS bound and no longer is should answer with
   * `unbound: true` and its old workspace: its deletes and its uninstall are still honoured, and nothing else is read.
   */
  resolveWorkspace(teamId: string): Promise<{ workspaceId: string; project?: string; unbound?: true } | undefined>;
  /** The workspace-level opt-in to "notes with links" (retention B) in the Public edition. Absent or false: Slack is read live only. Never consulted in Enterprise. */
  notesOptIn?(workspaceId: string): Promise<boolean>;
  /** Enterprise only: keep what was recorded when the app is uninstalled (the customer's own retention choice). Public always removes it. */
  keepOnUninstall?: boolean;
  log?: TapLog;
}

export type SlackTapOutcome =
  | { outcome: "recorded"; retention: Retention; stored: boolean }
  | { outcome: "deleted" | "acl_updated" | "scope_removed" | "audience_replaced" | "team_removed" }
  | { outcome: "ignored"; reason: SlackIgnoreReason };

export type SlackIgnoreReason =
  | "not_event" | "malformed" | "unsupported_event" | "unsupported_subtype" | "own_message" | "external_user" | "ext_shared" | "unbound_team"
  | "channel_unknown" | "dm_not_allowed" | "no_source_row" | "excluded" | "empty_text" | "retention_a" | "refused" | "failed" | "public_private_unchanged" | "team_unbound_deletes_only" | "kept_by_policy";

const TEAM = /^[TE][A-Z0-9]{2,31}$/;
const CHANNEL = /^[CGD][A-Z0-9]{2,31}$/;
const USER = /^[UW][A-Z0-9]{2,31}$/;
const TS = /^\d{10}\.\d{1,9}$/;
const PRINCIPALS_MAX = 500;

export const slackScope = (teamId: string, channelId: string): string => `slack:${teamId}/${channelId}`;
/** Everything of one Slack team: a scope matches itself and every scope under it. */
export const slackTeamScope = (teamId: string): string => `slack:${teamId}`;

/**
 * The retention a Slack row may have. Public: A (live only) unless the workspace opted in to notes with links, and then at most B; a stored C or D is
 * read as A, the safe side, never as the opt-in. Enterprise: as configured.
 */
export function slackRetention(edition: Edition, configured: Retention, notesOptIn = false): Retention {
  if (edition === "enterprise") return configured;
  return configured === "B" && notesOptIn ? "B" : "A";
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
    // A team that is no longer bound: only removals are honoured.
    const active = bound.unbound !== true;

    switch (event.type) {
      case "channel_deleted": {
        const channelId = event.channel;
        if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return ignored("malformed");
        await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope: slackScope(teamId, channelId), cause: "source_deleted" });
        deps.directory.invalidate?.(teamId, channelId);
        return { outcome: "scope_removed" };
      }
      case "channel_shared": {
        // The channel became a Slack Connect channel: what was recorded from it is removed, and nothing more is recorded.
        const channelId = event.channel;
        if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return ignored("malformed");
        await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope: slackScope(teamId, channelId), cause: "excluded" });
        deps.directory.invalidate?.(teamId, channelId);
        return { outcome: "scope_removed" };
      }
      case "channel_id_changed": {
        // Sharing a private channel changes its id: rows taken under the old id would never match the new scope, so they are removed.
        const oldId = event.old_channel_id;
        if (typeof oldId !== "string" || !CHANNEL.test(oldId)) return ignored("malformed");
        await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope: slackScope(teamId, oldId), cause: "source_deleted" });
        deps.directory.invalidate?.(teamId, oldId);
        return { outcome: "scope_removed" };
      }
      case "app_uninstalled":
        return uninstalled(bound, teamId);
      case "tokens_revoked": {
        // Only the bot token going away ends Rovara's access to the team.
        const bots = asRecord(event.tokens).bot;
        return Array.isArray(bots) && bots.length > 0 ? uninstalled(bound, teamId) : ignored("unsupported_event");
      }
      case "member_joined_channel":
      case "member_left_channel":
        return active ? membership(bound.workspaceId, teamId, event) : ignored("team_unbound_deletes_only");
      case "channel_convert_to_private":
      case "channel_convert_to_public":
        return active ? conversion(bound, teamId, event, event.type === "channel_convert_to_private") : ignored("team_unbound_deletes_only");
      case "message":
        return message(bound, teamId, body, event);
      default:
        return ignored("unsupported_event");
    }
  }

  /** The app was uninstalled: Slack's terms expect what came from the team to go. Public always removes it; Enterprise may keep it by the customer's own policy. */
  async function uninstalled(bound: { workspaceId: string }, teamId: string): Promise<SlackTapOutcome> {
    if (deps.edition === "enterprise" && deps.keepOnUninstall === true) return ignored("kept_by_policy");
    await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope: slackTeamScope(teamId), cause: "source_deleted" });
    return { outcome: "team_removed" };
  }

  async function membership(workspaceId: string, teamId: string, event: Record<string, unknown>): Promise<SlackTapOutcome> {
    const channelId = event.channel;
    const userId = event.user;
    if (typeof channelId !== "string" || !CHANNEL.test(channelId) || typeof userId !== "string" || !USER.test(userId)) return ignored("malformed");
    // Only a private channel's audience is a member list; a public channel's snapshot does not change when someone joins.
    if (event.channel_type !== "G" && !channelId.startsWith("G")) return ignored("public_private_unchanged");
    const at = isoOfSlackTs(event.event_ts) ?? new Date().toISOString();
    const scope = slackScope(teamId, channelId);
    deps.directory.invalidate?.(teamId, channelId);
    // Before the first member event of a place (the app's own invite comes before any message), seed its access record from the full member list as Slack has it now. The list's
    // time is the time it was READ, which is what a snapshot's `capturedAt` must mean.
    await deps.sink.ensureAccessSeed?.({
      workspaceId, scope,
      read: async () => {
        const info = await deps.directory.channelInfo(teamId, channelId);
        return info !== undefined && info.kind === "private" && info.extShared !== true ? audienceOf(teamId, channelId, info, undefined, new Date().toISOString()) : undefined;
      },
    });
    await deps.sink.changePrincipals({ workspaceId, scope, ...(event.type === "member_joined_channel" ? { add: [userId] } : { remove: [userId] }), at });
    return { outcome: "acl_updated" };
  }

  async function conversion(bound: { workspaceId: string }, teamId: string, event: Record<string, unknown>, toPrivate: boolean): Promise<SlackTapOutcome> {
    const channelId = event.channel;
    if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return ignored("malformed");
    deps.directory.invalidate?.(teamId, channelId);
    const info = await deps.directory.channelInfo(teamId, channelId).catch(() => undefined);
    const scope = slackScope(teamId, channelId);
    // Slack's own time for the event (the member events use it too), so the order of changes is Slack's against Slack's, never the broker clock against Slack's.
    const at = isoOfSlackTs(event.event_ts) ?? new Date().toISOString();
    if (info?.extShared === true) {
      await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope, cause: "excluded" });
      return { outcome: "scope_removed" };
    }
    if (info === undefined || (info.kind !== "private" && info.kind !== "public")) {
      // Unknown answer. Going private must never leave the old, wider audience: nobody sees the rows until the next member list is read.
      if (!toPrivate) return ignored("channel_unknown");
      await deps.sink.replaceScopeAudience({ workspaceId: bound.workspaceId, scope, audience: { kind: "restricted", acl: { source: "slack", scope, principals: [], capturedAt: at, liveCheck: "none" } }, at });
      return { outcome: "audience_replaced" };
    }
    const config = await deps.config.get(bound.workspaceId, "slack", scope).catch(() => undefined);
    await deps.sink.replaceScopeAudience({ workspaceId: bound.workspaceId, scope, audience: audienceOf(teamId, channelId, info, config, at), at });
    return { outcome: "audience_replaced" };
  }

  async function message(bound: { workspaceId: string; project?: string; unbound?: true }, teamId: string, envelope: Record<string, unknown>, event: Record<string, unknown>): Promise<SlackTapOutcome> {
    const channelId = event.channel;
    if (typeof channelId !== "string" || !CHANNEL.test(channelId)) return ignored("malformed");
    const subtype = event.subtype;

    // Conversions arrive as message subtypes (Slack's `message` event with subtype channel_convert_to_private / _public).
    if (subtype === "channel_convert_to_private" || subtype === "channel_convert_to_public") {
      return bound.unbound === true ? ignored("team_unbound_deletes_only") : conversion(bound, teamId, event, subtype === "channel_convert_to_private");
    }

    // Deletes come first, before every other check (Slack Connect, mode, source row, retention): what was recorded must go.
    const edited = asRecord(event.message);
    if (subtype === "message_deleted" || (subtype === "message_changed" && edited.subtype === "tombstone")) {
      const deletedTs = subtype === "message_deleted" ? event.deleted_ts : edited.ts;
      if (typeof deletedTs !== "string" || !TS.test(deletedTs)) return ignored("malformed");
      // A deleted thread parent that has replies arrives as an edit to a tombstone message: the original text must go too.
      await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, sourceIds: [messageId(channelId, deletedTs)], cause: "source_deleted" });
      return { outcome: "deleted" };
    }
    if (bound.unbound === true) return ignored("team_unbound_deletes_only");

    let source: Record<string, unknown>;
    let version: string;
    let versionAt: string | undefined;
    if (subtype === undefined || subtype === "thread_broadcast" || subtype === "file_share") {
      source = event;
      version = typeof event.ts === "string" ? `m:${event.ts}` : "";
    } else if (subtype === "message_changed") {
      source = edited;
      const editInfo = asRecord(source.edited);
      const editTs = typeof editInfo.ts === "string" ? editInfo.ts : typeof event.ts === "string" ? event.ts : "";
      version = `e:${editTs}`;
      versionAt = isoOfSlackTs(editTs);
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
    // A direct message is Enterprise only; its id says so without asking Slack.
    if (channelId.startsWith("D") && deps.edition !== "enterprise") return ignored("dm_not_allowed");

    // The cheap checks first: most channels have no source row, and no Slack call is made for them.
    const scope = slackScope(teamId, channelId);
    const config = await gate(deps, { workspaceId: bound.workspaceId, ...(bound.project === undefined ? {} : { project: bound.project }), source: "slack", scope });
    if (config === undefined) return ignored("no_source_row");
    if (envelope.is_ext_shared_channel === true) {
      await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope, cause: "excluded" });
      return ignored("ext_shared");
    }
    if (isExcluded(config, userId)) return ignored("excluded");
    let optIn = false;
    if (deps.edition === "public" && config.retention === "B") optIn = await (deps.notesOptIn?.(bound.workspaceId) ?? Promise.resolve(false)).catch(() => false);
    const retention = slackRetention(deps.edition, config.retention, optIn);
    // Retention A: read live when needed. Nothing is kept, nothing is distilled.
    if (retention === "A") return ignored("retention_a");

    const info = await deps.directory.channelInfo(teamId, channelId).catch(() => undefined);
    if (info === undefined) return ignored("channel_unknown");
    if (info.extShared) {
      await deps.sink.tombstone({ workspaceId: bound.workspaceId, system: teamId, scope, cause: "excluded" });
      return ignored("ext_shared");
    }
    if ((info.kind === "im" || info.kind === "mpim") && deps.edition !== "enterprise") return ignored("dm_not_allowed");

    const text = cleanText(source.text);
    if (text === undefined) return ignored("empty_text");
    const at = isoOfSlackTs(ts) ?? new Date().toISOString();
    const link = await permalinkOf(teamId, channelId, ts);
    const who = await deps.actors.resolve({ workspaceId: bound.workspaceId, project: bound.project ?? config.project, system: `slack:${teamId}`, sourceId: userId, isBot });
    // A bot never RAISES trust: a message with a bot id and a user (a workflow form, an app posting for a person) is as trusted as the lower of the bot (`system`) and that user,
    // so a guest or unlinked person cannot become `system` by posting through an app. The resolver answers `system` for any bot, so the user is asked as a person too.
    const trust = isBot ? lowestTrust("system", (await deps.actors.resolve({ workspaceId: bound.workspaceId, project: bound.project ?? config.project, system: `slack:${teamId}`, sourceId: userId })).trust) : who.trust;
    // Attachments and shared messages are other people's words inside this message: the record counts them as an outsider's unless it is told better.
    const hasAttachments = Array.isArray(source.attachments) && source.attachments.length > 0;
    const threadTs = typeof source.thread_ts === "string" && TS.test(source.thread_ts) && source.thread_ts !== ts ? source.thread_ts : undefined;
    const project = bound.project ?? config.project;
    const draft: RecordDraft & { text: string } = {
      workspaceId: bound.workspaceId, ...(project === undefined ? {} : { project }), source: "slack", kind: "slack.message", occurredAt: at,
      sourceRef: { system: teamId, id: messageId(channelId, ts), url: link, ...(threadTs === undefined ? {} : { parentId: messageId(channelId, threadTs) }), version, ...(versionAt === undefined ? {} : { versionAt }) },
      actor: { sourceId: userId, ...(who.developerId === undefined ? {} : { developerId: who.developerId }), trust },
      trust, scope, pieceTrusts: [trust], audience: audienceOf(teamId, channelId, info, config, at), text,
      structured: scalars({ channelKind: info.kind, edited: subtype === "message_changed", threadReply: threadTs !== undefined }),
      links: linksOf(link), retention, ...(hasAttachments ? { hasAttachments: true } : {}),
    };

    if (retention === "B") {
      // Process then drop: the text reaches the distiller (a queue with minimal retention in production) and the pipeline stores no raw text.
      const outcome = await deps.distiller.distillTransient(draft);
      return outcome.accepted ? { outcome: "recorded", retention, stored: false } : ignored("refused");
    }
    const outcome = await deps.sink.put(draft);
    if (outcome.status === "refused") return ignored("refused");
    return { outcome: "recorded", retention, stored: outcome.status === "stored" || outcome.status === "queued" };
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
