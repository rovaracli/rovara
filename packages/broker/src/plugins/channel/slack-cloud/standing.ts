// Convergence lane A8 (H1): the concrete person rule for the Slack channel sink (`personOf`), reduced from today's `slackRequesterStanding` (0.5.14, switch `sm`). Nothing here is called by a live path.
//
//   - It is called with NO options: not `allowUnlinked` (a person with no company is refused, never taken for the workspace's company's implicit member) and not `allowReadOnly` (an Auditor is refused: a chat message starts work).
//     `tests/unit/cloud-slack-standing.test.ts` pins that, so a later edit that adds either option fails there.
//   - It answers the SURVIVOR's developer id (the last id of the walk): a person merged into another is that other, and the company's explicit-member record is the survivor's.
//   - It serves nobody unless the switch is exactly the closed value (`require`, the default and what an absent or unknown value reads as). `warn` and `0` are rollback modes of the OLD path (they serve an implicit member); the channel
//     point never serves an implicit member in any mode.
//   - Every refusal is a throw with today's code (`SLACK_ACCOUNT_NOT_LINKED`, `REMOVED_FROM_ORG`, `FORBIDDEN`), which the sink reads as "nobody". The words today's Slack says for each are the switch-on lane's (see the open item in the A8 report).
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { SLACK_ACCOUNT_NOT_LINKED_MESSAGE, slackRequesterStanding } from "../../../aws/broker/dependency-wiring.js";
import { slackMemberRule, type SlackMemberRule } from "../../../org/slack-explicit-members.js";

type StandingDependencies = Parameters<typeof slackRequesterStanding>[0];

export interface SlackStandingSeams {
  /** Tests: the rule under the name it has. Default: today's `slackRequesterStanding`. */
  standing?: (dependencies: StandingDependencies, userId: string, teamOrg: OrgId, ...options: unknown[]) => Promise<{ ids: string[] }>;
  /** Tests: the switch. Default: the broker's own reading of `sm`. */
  rule?: () => SlackMemberRule;
}

/** `standingOf` for `createCloudSlackSink`: the person a Slack account is in `orgId`, or a throw. */
export function slackStandingOf(dependencies: StandingDependencies, seams: SlackStandingSeams = {}): (orgId: OrgId, slackUserId: string) => Promise<string> {
  const standing = seams.standing ?? slackRequesterStanding;
  const rule = seams.rule ?? (() => slackMemberRule());
  return async (orgId, slackUserId) => {
    if (rule() !== "require") throw agentXError("SLACK_ACCOUNT_NOT_LINKED", SLACK_ACCOUNT_NOT_LINKED_MESSAGE);
    const { ids } = await standing(dependencies, slackUserId, orgId);
    const survivor = ids.at(-1);
    if (survivor === undefined) throw agentXError("SLACK_ACCOUNT_NOT_LINKED", SLACK_ACCOUNT_NOT_LINKED_MESSAGE);
    return survivor;
  };
}
