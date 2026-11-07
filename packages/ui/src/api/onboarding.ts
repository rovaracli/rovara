// RULING Q53: readers project the existing routes; settings and permissions remain server-owned.
import { useMemo } from "react";
import { AppMeResponseReaderSchema, AppOrgMembersResponseReaderSchema, AppProjectDetailSchema, GithubConnectResponseReaderSchema, GithubInstallationsResponseReaderSchema, GithubRepositoriesResponseReaderSchema, CreateProjectBodySchema, CloudProjectCreatedResponseReaderSchema, RenameOrganizationBodySchema, RenameOrganizationResponseSchema, ProjectSettingsBodySchema, ProjectSettingsResponseSchema, ProjectSettingsUndoBodySchema, ProjectSetupCheckBodySchema, ProjectSetupCheckResponseSchema, CreateOrganizationInviteBodySchema, OrganizationInviteResponseSchema, ProjectRosterAddedResponseSchema, AgentDirectoryResponseReaderSchema, ProjectOverviewProjectSchema, AgentIdSchema, CreateProjectFromMetaBodySchema, SetupDraftResponseSchema, SetupDraftStartBodySchema, SetupApplyBodySchema, SetupApplyResponseSchema } from "@agentx/contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type SendResult } from "./client.js";
import { ApiError } from "./errors.js";
/** UX-4b: a change that waits for someone's confirmation says so with where to go, instead of a refusal with no way on. The page shows the confirmation link when the server gave one. */
export class PendingChangeError extends ApiError {
 constructor(readonly pendingConfirmUrl: string | undefined, readonly costApproval: boolean) {
  super(409, "PENDING", costApproval ? "This change waits for an administrator's approval of its cost. It goes ahead once they approve it on their Decisions page." : pendingConfirmUrl === undefined ? "This change waits for another person's confirmation on their Decisions page. Check again once they have confirmed it." : "This change waits for a confirmation. Open the confirmation to finish it, then check again.");
 }
}
export function completed<T>(result: SendResult<T>): T {
 if (result.kind === "needs_confirmation") throw new PendingChangeError(result.confirmUrl, false);
 if (result.kind !== "done") throw new PendingChangeError(undefined, true);
 return result.value;
}
/** The gateway puts its own `requestId` in every answer; the proposal's contract is strict, so it is set aside and the rest is read exactly (a newer server's unknown words are refused, not guessed). */
function exactAnswer<T>(schema: { parse(value: unknown): T }): { parse(value: unknown): T } {
 return { parse(value: unknown): T { if (typeof value !== "object" || value === null || Array.isArray(value)) return schema.parse(value);const own = { ...value } as Record<string, unknown>;delete own["requestId"];return schema.parse(own); } };
}
const TypedCommandsReader = { parse(value: unknown): { proposalDigest: string; message: string } {
 const own = value as { proposalDigest?: unknown; message?: unknown } | null;
 if (typeof own?.proposalDigest !== "string" || !/^[a-f0-9]{64}$/u.test(own.proposalDigest) || typeof own.message !== "string") throw new ApiError(502, "INVALID_RESPONSE", "Rovara returned an unreadable response. Reload this page.");
 return { proposalDigest: own.proposalDigest, message: own.message.slice(0, 300) };
} };
export function createOnboardingApi(host: AppHost) {
 const api=createApiClient(host), project=(name:string)=>"/v1/app/projects/"+encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(name));
 return {
 me:()=>api.get("/v1/app/me",AppMeResponseReaderSchema), members:()=>api.get("/v1/app/org/members",AppOrgMembersResponseReaderSchema),
 rename:async(body:ReturnType<typeof RenameOrganizationBodySchema.parse>)=>completed(await api.send("PATCH","/v1/app/org",RenameOrganizationBodySchema.parse(body),RenameOrganizationResponseSchema)),
 installations:()=>api.get("/v1/app/github/installations",GithubInstallationsResponseReaderSchema),
 // UX3: a connect started from the Connections page says so, so the pages at its end go back there (a fixed choice; onboarding when left out).
 connect:async(returnTo?:"/app/onboard"|"/app/admin/connections")=>completed(await api.send("POST","/v1/app/github/connect",returnTo==="/app/admin/connections"?{returnTo}:{},GithubConnectResponseReaderSchema)),
 repositories:(installation:number)=>api.get("/v1/app/github/repositories?"+new URLSearchParams({installation:String(installation)}).toString(),GithubRepositoriesResponseReaderSchema),
 create:async(body:ReturnType<typeof CreateProjectBodySchema.parse>)=>completed(await api.send("POST","/v1/app/projects",CreateProjectBodySchema.parse(body),CloudProjectCreatedResponseReaderSchema)),
 createFromMeta:async(body:ReturnType<typeof CreateProjectFromMetaBodySchema.parse>)=>completed(await api.send("POST","/v1/app/projects",CreateProjectFromMetaBodySchema.parse(body),CloudProjectCreatedResponseReaderSchema)),
 project:(name:string)=>api.get(project(name),AppProjectDetailSchema),
 setupDraft:(name:string)=>api.get(project(name)+"/setup-draft",exactAnswer(SetupDraftResponseSchema)),
 startSetupDraft:(name:string,requestId:string)=>api.sendAnswer("POST",project(name)+"/setup-draft",SetupDraftStartBodySchema.parse({requestId}),exactAnswer(SetupDraftResponseSchema)),
 applySetupDraft:(name:string,body:ReturnType<typeof SetupApplyBodySchema.parse>)=>api.sendAnswer("POST",project(name)+"/setup-draft/apply",SetupApplyBodySchema.parse(body),exactAnswer(SetupApplyResponseSchema)),
 settings:async(name:string,body:ReturnType<typeof ProjectSettingsBodySchema.parse>)=>completed(await api.send("PUT",project(name)+"/settings",ProjectSettingsBodySchema.parse(body),ProjectSettingsResponseSchema)),
 undoSettings:async(name:string,body:ReturnType<typeof ProjectSettingsUndoBodySchema.parse>)=>completed(await api.send("POST",project(name)+"/settings/undo",ProjectSettingsUndoBodySchema.parse(body),ProjectSettingsResponseSchema)),
 /** Owner decision 11: typed setup and test commands become the person's edited test environment proposal (proved, then approved there), never a direct save. A 404 means the test environment is off here. */
 typedCommands:(name:string,body:{requestId:string;expectedRevision:number;setupCommands:string[];testCommands:string[]})=>api.sendAnswer("POST",project(name)+"/setup-draft/typed",body,TypedCommandsReader,{retry:"never"}),
 check:async(name:string,requestId:string)=>completed(await api.send("POST",project(name)+"/setup-check",ProjectSetupCheckBodySchema.parse({requestId}),ProjectSetupCheckResponseSchema)),
 availableAgents:()=>api.get("/v1/app/agents?scope=all",AgentDirectoryResponseReaderSchema),
 agents:(name:string)=>api.get("/v1/app/agents?"+new URLSearchParams({project:name}).toString(),AgentDirectoryResponseReaderSchema),
 addAgent:async(name:string,id:string,requestId:string)=>completed(await api.send("PUT",project(name)+"/agents/"+encodeURIComponent(AgentIdSchema.parse(id)),{requestId},ProjectRosterAddedResponseSchema)),
 invite:async(body:ReturnType<typeof CreateOrganizationInviteBodySchema.parse>)=>completed(await api.send("POST","/v1/app/org/invites",CreateOrganizationInviteBodySchema.parse(body),OrganizationInviteResponseSchema)),
 };
}
export function useOnboardingApi(){const host=useAppHost();return useMemo(()=>createOnboardingApi(host),[host]);}
