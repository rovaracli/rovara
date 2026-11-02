// RULING Q53: readers project the existing routes; settings and permissions remain server-owned.
import { useMemo } from "react";
import { AppMeResponseReaderSchema, AppOrgMembersResponseReaderSchema, AppProjectDetailSchema, GithubConnectResponseReaderSchema, GithubInstallationsResponseReaderSchema, GithubRepositoriesResponseReaderSchema, CreateProjectBodySchema, CloudProjectCreatedResponseReaderSchema, RenameOrganizationBodySchema, RenameOrganizationResponseSchema, ProjectSettingsBodySchema, ProjectSettingsResponseSchema, ProjectSettingsUndoBodySchema, ProjectSetupCheckBodySchema, ProjectSetupCheckResponseSchema, CreateOrganizationInviteBodySchema, OrganizationInviteResponseSchema, ProjectRosterAddedResponseSchema, AgentDirectoryResponseReaderSchema, ProjectOverviewProjectSchema, AgentIdSchema, CreateProjectFromMetaBodySchema, SetupDraftResponseSchema, SetupDraftStartBodySchema, SetupApplyBodySchema, SetupApplyResponseSchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type SendResult } from "./client.js";
import { ApiError } from "./errors.js";
export function completed<T>(result: SendResult<T>): T {
 if (result.kind !== "done") throw new ApiError(409,"PENDING","This change needs confirmation. Check its status before continuing.");
 return result.value;
}
/** The gateway puts its own `requestId` in every answer; the proposal's contract is strict, so it is set aside and the rest is read exactly (a newer server's unknown words are refused, not guessed). */
function exactAnswer<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
 return { parse(value: unknown): T { if (typeof value !== "object" || value === null || Array.isArray(value)) return schema.parse(value);const own = { ...value } as Record<string, unknown>;delete own["requestId"];return schema.parse(own); } };
}
export function createOnboardingApi(host: AppHost) {
 const api=createApiClient(host), project=(name:string)=>"/v1/app/projects/"+encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name));
 return {
 me:()=>api.get("/v1/app/me",AppMeResponseReaderSchema), members:()=>api.get("/v1/app/org/members",AppOrgMembersResponseReaderSchema),
 rename:async(body:ReturnType<typeof RenameOrganizationBodySchema.parse>)=>completed(await api.send("PATCH","/v1/app/org",RenameOrganizationBodySchema.parse(body),RenameOrganizationResponseSchema)),
 installations:()=>api.get("/v1/app/github/installations",GithubInstallationsResponseReaderSchema),
 connect:async()=>completed(await api.send("POST","/v1/app/github/connect",{},GithubConnectResponseReaderSchema)),
 repositories:(installation:number)=>api.get("/v1/app/github/repositories?"+new URLSearchParams({installation:String(installation)}).toString(),GithubRepositoriesResponseReaderSchema),
 create:async(body:ReturnType<typeof CreateProjectBodySchema.parse>)=>completed(await api.send("POST","/v1/app/projects",CreateProjectBodySchema.parse(body),CloudProjectCreatedResponseReaderSchema)),
 createFromMeta:async(body:ReturnType<typeof CreateProjectFromMetaBodySchema.parse>)=>completed(await api.send("POST","/v1/app/projects",CreateProjectFromMetaBodySchema.parse(body),CloudProjectCreatedResponseReaderSchema)),
 project:(name:string)=>api.get(project(name),AppProjectDetailSchema),
 setupDraft:(name:string)=>api.get(project(name)+"/setup-draft",exactAnswer(SetupDraftResponseSchema)),
 startSetupDraft:(name:string,requestId:string)=>api.sendAnswer("POST",project(name)+"/setup-draft",SetupDraftStartBodySchema.parse({requestId}),exactAnswer(SetupDraftResponseSchema)),
 applySetupDraft:(name:string,body:ReturnType<typeof SetupApplyBodySchema.parse>)=>api.sendAnswer("POST",project(name)+"/setup-draft/apply",SetupApplyBodySchema.parse(body),exactAnswer(SetupApplyResponseSchema)),
 settings:async(name:string,body:ReturnType<typeof ProjectSettingsBodySchema.parse>)=>completed(await api.send("PUT",project(name)+"/settings",ProjectSettingsBodySchema.parse(body),ProjectSettingsResponseSchema)),
 undoSettings:async(name:string,body:ReturnType<typeof ProjectSettingsUndoBodySchema.parse>)=>completed(await api.send("POST",project(name)+"/settings/undo",ProjectSettingsUndoBodySchema.parse(body),ProjectSettingsResponseSchema)),
 check:async(name:string,requestId:string)=>completed(await api.send("POST",project(name)+"/setup-check",ProjectSetupCheckBodySchema.parse({requestId}),ProjectSetupCheckResponseSchema)),
 availableAgents:()=>api.get("/v1/app/agents?scope=all",AgentDirectoryResponseReaderSchema),
 agents:(name:string)=>api.get("/v1/app/agents?"+new URLSearchParams({project:name}).toString(),AgentDirectoryResponseReaderSchema),
 addAgent:async(name:string,id:string,requestId:string)=>completed(await api.send("PUT",project(name)+"/agents/"+encodeURIComponent(AgentIdSchema.parse(id)),{requestId},ProjectRosterAddedResponseSchema)),
 invite:async(body:ReturnType<typeof CreateOrganizationInviteBodySchema.parse>)=>completed(await api.send("POST","/v1/app/org/invites",CreateOrganizationInviteBodySchema.parse(body),OrganizationInviteResponseSchema)),
 };
}
export function useOnboardingApi(){const host=useAppHost();return useMemo(()=>createOnboardingApi(host),[host]);}
