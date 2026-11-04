// What a Team record source write needs from the broker's own request (`team-record/source-write.ts`): the caller's company role and whether the session is a live browser one, the body (read
// only when a write asks for it), the audit outbox, and what Slack says a channel is. No second person, roster or fresh sign-in: every editor's change applies at once (owner decision 2026-11-04).
// The org is never taken from here: the record runtime takes it from the caller's session. Built only where the Team record is on (the one call site in `developer-routes.ts` is behind that switch).
import type { AdaptedHttpRequest } from "./../lambda.js";
import type { SourceWriteContext } from "../../team-record/source-write.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

type ChannelClassRead = NonNullable<NonNullable<DeveloperRouteDependencies["developer"]>["channelClass"]>;
const slackChannelOf = (read: ChannelClassRead): NonNullable<SourceWriteContext["slackChannel"]> => async (teamId, channelId) => {
  const answer = await read({ kind: "channel-class", teamId, channelId });
  if (!answer.ok) return undefined;
  return "channel" in answer ? answer.channel : "none";
};

export function recordWriteContextOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest): SourceWriteContext {
  return {
    orgRole: caller.orgRole,
    browserSession: caller.browserSession === true,
    body: () => jsonBody(request),
    ...(deps.audit === undefined ? {} : { audit: { audit: deps.audit } }),
    // What a Slack channel is, read fresh through DeveloperIdentity (it holds the bot token). Absent where the install has no such route: a Slack source then cannot be added.
    ...(deps.developer?.channelClass === undefined ? {} : { slackChannel: slackChannelOf(deps.developer.channelClass) }),
  };
}
