// Slack's People directory for a test task: Maya (the owner) and the given people, all in the project's channel. Lets a test make someone a viewer through the People flow, as the old page's tests do.
import { SLACK_OIDC_ISSUER, type TaskPeopleDisplayReadRequest, type TaskPersonProofRequest } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import type { CheckTaskPerson } from "../../packages/broker/src/developer/task-people.js";
import type { Developer } from "./developer-task-broker.js";
import { SLACK_CHANNEL } from "./slack-broker.js";
import { SLACK_MAYA } from "./workflow-e2e.js";

/** Slack's People directory for Maya and Sam (the old page's People tests use the same one), so the owner can make Sam a viewer. */
export function taskPeopleDirectory(others: readonly Developer[]) {
  const names = new Map([[SLACK_MAYA.slackUserId!, SLACK_MAYA.name], ...others.map((who) => [who.slackUserId!, who.name] as [string, string])]);
  const proof = async (request: TaskPersonProofRequest) => {
    const name = names.get(request.slackUserId);
    if (name === undefined) return { ok: false as const, error: "ineligible" as const };
    return { ok: true as const, user: { id: request.slackUserId, teamId: "T0BSHLLUGBD", name }, memberOf: request.channelIds.filter((channelId) => channelId === SLACK_CHANNEL) };
  };
  const display = async (request: TaskPeopleDisplayReadRequest) => request.operation === "proof"
    ? { operation: "proof" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: await proof(request.request) }
    : { operation: "directory" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
      users: [...names].map(([id, name]) => ({ id, teamId: "T0BSHLLUGBD", name, memberOf: request.request.channelIds.filter((channelId) => channelId === SLACK_CHANNEL) })) } };
  const check: CheckTaskPerson = async (task, developerId) => {
    const entry = [...names].find(([slackUserId]) => developerIdForSlackUser(slackUserId) === developerId);
    if (entry === undefined) throw new Error("fresh task person proof is unavailable");
    const [slackUserId, name] = entry;
    return { subject: { developerId, slackUserId }, identity: { developerId, slackUserId, name, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUserId },
      eligible: true, channelMember: task.share === undefined || task.share.channelId === SLACK_CHANNEL };
  };
  return { proof, display, check };
}

