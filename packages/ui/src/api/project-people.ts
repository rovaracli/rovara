// A project's People tab (lane exp/project-people): the roster with the viewer's powers, adding, changing and removing a person, inviting someone into the project, and the project's merge rules (code settings).
// The server decides who may do what and says so in `viewer`; this file only sends and reads. Every write is sent once from the browser session (`retry: "never"`) under the revision the page read, with a request
// id the caller keeps for a repeat. The readers are the contract's shapes with Cloud's FOUR project roles: Code's roster reader would strip a member's `projectRole` and refuse a `collaborator` in the powers.
// It is imported only by the People tab's own chunk (ProjectPeopleTab), never by the initial load.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  AppOrgMembersResponseReaderSchema, CloudProjectRoleSchema, CodeSettingsResponseReaderSchema, ProjectOverviewProjectSchema, ReviewedInviteCreateBodySchema, ReviewedInviteCreateResponseSchema,
  type CloudProjectRole,
} from "@agentx/cloud-contracts/web";
import { useAppHost, type AppHost } from "../host.js";
import { createApiClient, type SendResult } from "./client.js";
import { ApiError } from "./errors.js";

const NEVER = { retry: "never" } as const;
/** A role as the server sent it: one of Cloud's four, or `unknown` for any other (a role a newer server adds), so one odd row never makes the whole roster unreadable. */
const roleOrUnknown = z.union([CloudProjectRoleSchema, z.string().transform((): "unknown" => "unknown")]);
type RoleOrUnknown = z.output<typeof roleOrUnknown>;
/** The roles a picker may offer: the known four only, whatever the server lists. */
const knownRoles = (list: readonly RoleOrUnknown[]): CloudProjectRole[] => list.filter((role): role is CloudProjectRole => role !== "unknown");
export const peopleViewerReader = z.looseObject({
  role: roleOrUnknown, /** The exact role, when the server says it (`role` is the three-role floor). */ projectRole: roleOrUnknown.optional(), canManageMembers: z.boolean(), assignableRoles: z.array(roleOrUnknown).transform(knownRoles), canInvite: z.boolean(), invitableRoles: z.array(roleOrUnknown).transform(knownRoles), canEditCodeSettings: z.boolean(), canConfirmSelfApproval: z.boolean(),
});
const memberReader = z.looseObject({ developerId: z.string(), name: z.string(), email: z.string().optional(), role: z.string(), projectRole: roleOrUnknown.optional(), source: z.string(), grantedBy: z.looseObject({ developerId: z.string(), name: z.string() }).optional() });
export const peopleViewReader = z.looseObject({ project: z.string(), members: z.array(memberReader), revision: z.number().int().nonnegative(), viewer: peopleViewerReader });
export type PeopleView = z.output<typeof peopleViewReader>;
export type PeopleMember = PeopleView["members"][number];
const changeReader = z.looseObject({ member: z.looseObject({ developerId: z.string(), role: z.string() }), revision: z.number().int().nonnegative() });
const removeReader = z.looseObject({ developerId: z.string(), removed: z.boolean(), revision: z.number().int().nonnegative() });

export const peoplePath = (project: string): string => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/people";
export const codeSettingsPath = (project: string): string => "/v1/app/projects/" + encodeURIComponent(ProjectOverviewProjectSchema.shape.name.parse(project)) + "/code-settings";
export const peopleKey = (project: string) => ["project", project, "people"] as const;
export const codeSettingsKey = (project: string) => ["project", project, "code-settings"] as const;
export const orgMembersKey = ["org-members-for-project-people"] as const;

/** The roles a person's own row may hold, in the order the project lists them. */
export const ROLE_CHOICES: readonly CloudProjectRole[] = ["maintainer", "contributor", "collaborator", "viewer"];

/** What a write that lost a race (the roster moved since the page read it) is: the server's 409 `CHANGE_STALE`. */
export const isStale = (error: unknown): boolean => error instanceof ApiError && (error.status === 409 || error.code === "CHANGE_STALE");

export function createProjectPeopleApi(host: AppHost) {
  const api = createApiClient(host);
  const personPath = (project: string, developerId: string) => peoplePath(project) + "/" + encodeURIComponent(z.string().regex(/^[a-f0-9]{64}$/).parse(developerId));
  const one = async <T>(sent: Promise<SendResult<T>>): Promise<T> => { const result = await sent;if (result.kind !== "done") throw new ApiError(502, "INVALID_RESPONSE", "This change is waiting for confirmation. Reload this page to check its status.");return result.value; };
  return {
    people: (project: string) => api.get(peoplePath(project), peopleViewReader),
    /** Give a company member a role in the project (adds them, or changes their role). */
    setRole: (project: string, developerId: string, input: { requestId: string; role: CloudProjectRole; expectedRevision: number }) =>
      one(api.send("PUT", personPath(project, developerId), { requestId: input.requestId, role: input.role, expectedRevision: input.expectedRevision }, changeReader, NEVER)),
    remove: (project: string, developerId: string, input: { requestId: string; expectedRevision: number }) =>
      one(api.send("DELETE", personPath(project, developerId), { requestId: input.requestId, expectedRevision: input.expectedRevision }, removeReader, NEVER)),
    /** The company's people, names only, for the add picker. */
    companyMembers: () => api.get("/v1/app/org/members", AppOrgMembersResponseReaderSchema),
    /** An invite that also adds the person to this project. The body is the contract's own; the server's refusal text is kept. */
    invite: async (input: { requestId: string; project: string; role: "maintainer" | "contributor" | "viewer"; email?: string }) => {
      const body = ReviewedInviteCreateBodySchema.parse({ requestId: input.requestId, role: "member", ...(input.email === undefined ? {} : { email: input.email, sendEmail: true }), project: { name: input.project, role: input.role } });
      return api.sendAnswer("POST", "/v1/app/org/invites/reviewed", body, ReviewedInviteCreateResponseSchema, NEVER);
    },
    codeSettings: async (project: string) => (await api.get(codeSettingsPath(project), CodeSettingsResponseReaderSchema)).settings,
    /** The merge method, the reviewers and self-approval. Turning self-approval ON answers 202 and waits for an owner or admin (`needs_confirmation`). */
    putCodeSettings: (project: string, input: { requestId: string; expectedRevision: number; allowSelfApproval?: boolean; mergeMethod?: "squash" | "merge"; codeReviewers?: string[] }) =>
      api.send("PUT", codeSettingsPath(project), input, CodeSettingsResponseReaderSchema, NEVER),
  };
}
export type ProjectPeopleApi = ReturnType<typeof createProjectPeopleApi>;
export function useProjectPeopleApi(): ProjectPeopleApi { const host = useAppHost();return useMemo(() => createProjectPeopleApi(host), [host]); }
export function useProjectPeople(project: string) { const api = useProjectPeopleApi();return useQuery({ queryKey: peopleKey(project), queryFn: () => api.people(project), retry: false }); }
export function useCodeSettings(project: string, enabled: boolean) { const api = useProjectPeopleApi();return useQuery({ queryKey: codeSettingsKey(project), queryFn: () => api.codeSettings(project), enabled, retry: false, refetchOnWindowFocus: false }); }
/** Company members for the add picker (read when the dialog opens). */
export function useCompanyMembers(enabled: boolean) { const api = useProjectPeopleApi();return useQuery({ queryKey: orgMembersKey, queryFn: () => api.companyMembers(), enabled, retry: false, refetchOnWindowFocus: false }); }
