// What a Team record source write needs from the broker's own request (`team-record/source-write.ts`): the caller's company role and whether the session is a live browser one, the body (read
// only when a write asks for it), the audit outbox, the shared second-person check bound to the company's records, the roster of who may approve, and the fresh sign-in check. The org is never
// taken from here: the record runtime takes it from the caller's session. Built only where the Team record is on (the one call site in `developer-routes.ts` is behind that switch).
import type { AdaptedHttpRequest } from "./../lambda.js";
import { readApproverRoster } from "../../org/second-person-evidence.js";
import { secondPersonFromRecords } from "../../org/test-environment.js";
import type { SourceWriteContext } from "../../team-record/source-write.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

type ChannelClassRead = NonNullable<NonNullable<DeveloperRouteDependencies["developer"]>["channelClass"]>;
const slackChannelOf = (read: ChannelClassRead): NonNullable<SourceWriteContext["slackChannel"]> => async (teamId, channelId) => {
  const answer = await read({ kind: "channel-class", teamId, channelId });
  if (!answer.ok) return undefined;
  return "channel" in answer ? answer.channel : "none";
};

export function recordWriteContextOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest): SourceWriteContext {
  const signInTableName = deps.developer?.signInTableName;
  const evidence = signInTableName === undefined || signInTableName === "" ? undefined : { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now };
  return {
    orgRole: caller.orgRole,
    browserSession: caller.browserSession === true,
    body: () => jsonBody(request),
    ...(deps.audit === undefined ? {} : { audit: { audit: deps.audit } }),
    ...(evidence === undefined ? {} : {
      secondPerson: secondPersonFromRecords({ ...evidence, soleOwnerTable: deps.teamRecord?.table }),
      roster: (scope) => readApproverRoster(evidence, scope),
    }),
    // What a Slack channel is, read fresh through DeveloperIdentity (it holds the bot token). Absent where the install has no such route: a Slack source then cannot be added.
    ...(deps.developer?.channelClass === undefined ? {} : { slackChannel: slackChannelOf(deps.developer.channelClass) }),
    freshSignIn: async () => { await requireFreshSignIn(deps, caller); },
  };
}
