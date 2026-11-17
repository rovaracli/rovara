// Guided onboarding PR 11: Add to Slack, a project's Slack channel, Connect Linear and a project's Linear team. Cloud's server answers every route; the browser
// never names a company, and the outcome of a Slack or Linear round trip is kept by Cloud for this sign-in (read once with `…/result`).
import { useMemo } from "react";
import {
 ConnectStartBodySchema, LinearClearResponseReaderSchema, LinearConnectResultSchema, LinearConnectStartResponseReaderSchema, LinearDisconnectResponseReaderSchema, LinearPickBodySchema,
 LinearPickResponseReaderSchema, LinearProjectTeamResponseReaderSchema, LinearStatusResponseReaderSchema, ProjectOverviewProjectSchema, SlackChannelsResponseReaderSchema,
 SlackDisconnectResponseReaderSchema, SlackInstallResultSchema, SlackInstallStartResponseReaderSchema, SlackLinkBodySchema, SlackLinkResponseReaderSchema,
 SlackProjectChannelResponseReaderSchema, SlackUnlinkResponseReaderSchema, SlackWorkspaceResponseReaderSchema,
} from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient } from "./client.js";

export function createIntegrationsApi(host: AppHost) {
 const api = createApiClient(host), never = { retry: "never" as const };
 const project = (name: string) => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name));
 /** The app page a connect comes back to: this page's path (no query), when it is a plain app page; else Cloud's default (onboarding). */
 const back = () => { const path = host.currentPath().split(/[?#]/, 1)[0]!;const parsed = ConnectStartBodySchema.safeParse({ back: path });return parsed.success ? parsed.data : {}; };
 return {
  slackInstall: () => api.sendAnswer("POST", "/v1/app/slack/install", back(), SlackInstallStartResponseReaderSchema, never),
  slackResult: () => api.sendAnswer("POST", "/v1/app/slack/install/result", {}, SlackInstallResultSchema, never),
  slackStatus: () => api.get("/v1/app/slack", SlackWorkspaceResponseReaderSchema),
  slackDisconnect: () => api.sendAnswer("POST", "/v1/app/slack/disconnect", {}, SlackDisconnectResponseReaderSchema, never),
  slackChannels: (name: string, cursor?: string) => api.get("/v1/app/slack/channels?" + new URLSearchParams({ project: ProjectOverviewProjectSchema.shape.name.parse(name), ...(cursor === undefined ? {} : { cursor }) }).toString(), SlackChannelsResponseReaderSchema),
  projectChannel: (name: string) => api.get(`${project(name)}/slack/channel`, SlackProjectChannelResponseReaderSchema),
  linkChannel: (name: string, channelId: string, check = false) => check
   ? api.sendAnswer("POST", `${project(name)}/slack/channel/check`, SlackLinkBodySchema.parse({ channelId }), SlackLinkResponseReaderSchema, never)
   : api.sendAnswer("PUT", `${project(name)}/slack/channel`, SlackLinkBodySchema.parse({ channelId }), SlackLinkResponseReaderSchema, never),
  unlinkChannel: (name: string) => api.sendAnswer("DELETE", `${project(name)}/slack/channel`, undefined, SlackUnlinkResponseReaderSchema, never),
  linearConnect: () => api.sendAnswer("POST", "/v1/app/linear/connect", back(), LinearConnectStartResponseReaderSchema, never),
  linearResult: () => api.sendAnswer("POST", "/v1/app/linear/connect/result", {}, LinearConnectResultSchema, never),
  linearStatus: () => api.get("/v1/app/linear", LinearStatusResponseReaderSchema),
  linearDisconnect: () => api.sendAnswer("DELETE", "/v1/app/linear", undefined, LinearDisconnectResponseReaderSchema, never),
  projectTeam: (name: string) => api.get(`${project(name)}/linear`, LinearProjectTeamResponseReaderSchema),
  pickTeam: (name: string, teamId: string) => api.sendAnswer("PUT", `${project(name)}/linear`, LinearPickBodySchema.parse({ teamId }), LinearPickResponseReaderSchema, never),
  clearTeam: (name: string) => api.sendAnswer("DELETE", `${project(name)}/linear`, undefined, LinearClearResponseReaderSchema, never),
 };
}
export function useIntegrationsApi() { const host = useAppHost();return useMemo(() => createIntegrationsApi(host), [host]); }
