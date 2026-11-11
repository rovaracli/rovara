import { developerIdForSlackUser } from "./admin-actions.js";
import { SLACK_WORKFLOW_SESSION_ID } from "../developer/task-records.js";
import type { OrgId } from "@rovara-code/contracts";
import type { DeveloperCaller } from "./developer-routes.js";

/** Stable AgentX identity for a Slack user, paired with their Slack ID for channel membership checks. */
/** `orgId`: the org the Slack user belongs to (ruling R1), resolved by the caller. */
export function slackWorkflowCaller(userId: string, orgId: OrgId): DeveloperCaller {
  return {
    developerId: developerIdForSlackUser(userId),
    sessionId: SLACK_WORKFLOW_SESSION_ID,
    amr: "slack",
    name: `Slack user ${userId}`,
    slackUserId: userId,
    orgId,
    // A Slack workflow acts as the task, never as an org administrator.
    orgRole: "member",
  };
}
