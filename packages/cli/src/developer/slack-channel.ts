// `rovara --project <name> slack bind --channel <C...>` and `slack unbind` (release 0.4.17): an org owner or admin binds one of their projects to a Slack
// channel with their own developer sign-in (`PUT|DELETE /v1/app/projects/{name}/slack-channel`). The control plane decides who may; this names the project
// and the channel and prints what happened and what to do next. The bot's name is not something the control plane tells a developer, so the next step
// says it in general words.
import { randomUUID } from "node:crypto";
import { ProjectSlackChannelRemoveResponseSchema, ProjectSlackChannelResponseSchema } from "@agentx/contracts";
import { sanitizeServerText } from "../auth.js";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

const clean = sanitizeServerText;
const slackChannelPath = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/slack-channel`;

export interface SlackChannelResult { env: string; url: string; project: string; teamId: string; channelId: string; changed: boolean }

export async function projectSlackBind(deps: DeveloperSessionDeps, env: string | undefined, project: string, channelId: string, teamId?: string): Promise<SlackChannelResult> {
  const { env: resolved, url, body } = await developerRequest(deps, env, slackChannelPath(project), ProjectSlackChannelResponseSchema, {
    method: "PUT", body: { requestId: randomUUID(), channelId, ...(teamId === undefined ? {} : { teamId }) }, explain: true,
  });
  return { env: resolved, url, project, teamId: body.binding.teamId, channelId: body.binding.channelId, changed: body.changed };
}

export async function projectSlackUnbind(deps: DeveloperSessionDeps, env: string | undefined, project: string, channelId: string, teamId?: string): Promise<SlackChannelResult> {
  const { env: resolved, url, body } = await developerRequest(deps, env, slackChannelPath(project), ProjectSlackChannelRemoveResponseSchema, {
    method: "DELETE", body: { requestId: randomUUID(), channelId, ...(teamId === undefined ? {} : { teamId }) }, explain: true,
  });
  return { env: resolved, url, project, teamId: body.teamId, channelId: body.channelId, changed: body.removed };
}

export const INVITE_BOT_LINE = "Next step: invite the Rovara bot to that channel in Slack (type /invite and pick the Rovara app), so it can read and answer there.";

export function slackBindText(result: SlackChannelResult): string {
  const project = clean(result.project);
  const channel = clean(result.channelId);
  return result.changed
    ? `Bound Slack channel ${channel} to ${project} on ${result.env}.\n${INVITE_BOT_LINE}\n`
    : `Slack channel ${channel} was already bound to ${project}; nothing changed.\n${INVITE_BOT_LINE}\n`;
}

export function slackUnbindText(result: SlackChannelResult): string {
  const project = clean(result.project);
  const channel = clean(result.channelId);
  return result.changed
    ? `Unbound Slack channel ${channel} from ${project} on ${result.env}. Threads already started keep their workspaces.\n`
    : `Slack channel ${channel} was not bound to ${project}; nothing changed.\n`;
}
