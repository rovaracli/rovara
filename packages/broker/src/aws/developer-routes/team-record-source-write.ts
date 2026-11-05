// What a Team record source write needs from the broker's own request (`team-record/source-write.ts`): the caller's company role and whether the session is a live browser one, the body (read
// only when a write asks for it), the audit outbox, and what Slack says a channel is. No second person, roster or fresh sign-in: every editor's change applies at once (owner decision 2026-11-04).
// The org is never taken from here: the record runtime takes it from the caller's session. Built only where the Team record is on (the one call site in `developer-routes.ts` is behind that switch).
import type { AdaptedHttpRequest } from "./../lambda.js";
import type { SourceWriteContext } from "../../team-record/source-write.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

type ChannelClassRead = NonNullable<NonNullable<DeveloperRouteDependencies["developer"]>["channelClass"]>;
export const slackChannelOf = (read: ChannelClassRead): NonNullable<SourceWriteContext["slackChannel"]> => async (teamId, channelId) => {
  const answer = await read({ kind: "channel-class", teamId, channelId });
  if (!answer.ok) return undefined;
  return "channel" in answer ? answer.channel : "none";
};

type ChannelListRead = NonNullable<NonNullable<DeveloperRouteDependencies["developer"]>["channelList"]>;
/** The Slack picker's page, from DeveloperIdentity's `channel-list`: a missing scope keeps its own word, every other failure (an identity function that does not know the request included) is plain unavailable. */
const slackChannelsOf = (read: ChannelListRead, teamId: string): NonNullable<SourceWriteContext["slackChannels"]> => async (input) => {
  const answer = await read({ kind: "channel-list", teamId, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  if (answer.ok) return { ok: true, channels: answer.channels, ...(answer.next === undefined ? {} : { next: answer.next }) };
  return { ok: false, error: answer.error === "missing_scope" ? "missing_scope" : "unavailable" };
};

type MemberChannelsRead = NonNullable<NonNullable<DeveloperRouteDependencies["developer"]>["memberChannels"]>;
/** "Your private channels", from DeveloperIdentity's `member-channels`: the user id is the one the route chose from the editor's own linked ids. Same answers as the public page. */
const slackMemberChannelsOf = (read: MemberChannelsRead): NonNullable<SourceWriteContext["slackMemberChannels"]> => async (input) => {
  const answer = await read({ kind: "member-channels", teamId: input.teamId, userId: input.userId, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) });
  if (answer.ok) return { ok: true, channels: answer.channels, ...(answer.next === undefined ? {} : { next: answer.next }) };
  return { ok: false, error: answer.error === "missing_scope" ? "missing_scope" : "unavailable" };
};

/** Whether one Slack user (always one of the editor's own linked ids, chosen by the route) is in a channel, from DeveloperIdentity's `channel-members`: the same read the Slack-side Add uses. Unreadable is `undefined`. */
const slackMemberOf = (developer: NonNullable<DeveloperRouteDependencies["developer"]>): NonNullable<SourceWriteContext["slackMember"]> => async (userId, channelId) => {
  const answer = await developer.channelMembers({ kind: "channel-members", slackUserId: userId, channelIds: [channelId] });
  return answer.ok ? answer.memberOf.includes(channelId) : undefined;
};

export function recordWriteContextOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest): SourceWriteContext {
  return {
    orgRole: caller.orgRole,
    browserSession: caller.browserSession === true,
    body: () => jsonBody(request),
    ...(deps.audit === undefined ? {} : { audit: { audit: deps.audit } }),
    // What a Slack channel is, read fresh through DeveloperIdentity (it holds the bot token). Absent where the install has no such route: a Slack source then cannot be added.
    ...(deps.developer?.channelClass === undefined ? {} : { slackChannel: slackChannelOf(deps.developer.channelClass) }),
    // Whether the editor is in a private channel they add (their own linked Slack ids, through DeveloperIdentity's `channel-members`). Absent: a private channel cannot be added from the web.
    ...(deps.developer?.channelMembers === undefined ? {} : { slackMember: slackMemberOf(deps.developer) }),
    // The pickers: this install's Slack team and a page of the channels the bot sees in it (read fresh through DeveloperIdentity). The route lists them only for the company the team is bound to.
    ...(deps.developer?.slackTeamId === undefined ? {} : { slackTeamId: deps.developer.slackTeamId }),
    ...(deps.developer?.channelList === undefined || deps.developer.slackTeamId === undefined ? {} : { slackChannels: slackChannelsOf(deps.developer.channelList, deps.developer.slackTeamId) }),
    ...(deps.developer?.memberChannels === undefined || deps.developer.slackTeamId === undefined ? {} : { slackMemberChannels: slackMemberChannelsOf(deps.developer.memberChannels) }),
  };
}
