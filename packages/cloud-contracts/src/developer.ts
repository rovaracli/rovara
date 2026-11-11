// Spec 025 phase 25a: the developer sign-in's shared names and wire shapes. The CLI parses server
// responses with the non-strict schemas here, so a newer control plane can add fields.
import { z } from "zod";
import { DeveloperProjectSchema, DeveloperWorkspaceSchema, SlackUserIdSchema } from "@rovara-code/contracts";
import { OrgRoleSchema } from "./org.js";

export { DeveloperSignInMethodSchema, type DeveloperSignInMethod } from "./developer-web.js";
import { DeveloperSignInMethodSchema } from "./developer-web.js";

export const DeveloperSummarySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(200),
  provider: DeveloperSignInMethodSchema,
  slackUserId: SlackUserIdSchema.optional(),
  email: z.string().email().optional(),
  /** The developer's role in their org; absent from a control plane that predates it. */
  orgRole: OrgRoleSchema.optional(),
});
export type DeveloperSummary = z.infer<typeof DeveloperSummarySchema>;

export { LinkedIdentitySchema, type LinkedIdentity, AppMeResponseSchema, type AppMeResponse } from "./developer-web.js";
import { LinkedIdentitySchema } from "./developer-web.js";

/** `DELETE /v1/app/me/identities/{provider}`: the sign-in methods still linked after one was removed (Plan 2, Task 8). */
export const UnlinkIdentityAppResponseSchema = z.object({ identities: z.array(LinkedIdentitySchema) });
export type UnlinkIdentityAppResponse = z.infer<typeof UnlinkIdentityAppResponseSchema>;

export const DeveloperProjectsResponseSchema = z.object({
  developer: DeveloperSummarySchema,
  projects: z.array(DeveloperProjectSchema),
  notices: z.array(z.enum(["slack_unavailable"])),
});
export type DeveloperProjectsResponse = z.infer<typeof DeveloperProjectsResponseSchema>;

/** The projects the caller may use, each with the workspaces that exist in it, newest first. */
export const DeveloperWorkspacesResponseSchema = z.object({
  developer: DeveloperSummarySchema,
  projects: z.array(DeveloperProjectSchema),
  workspaces: z.array(DeveloperWorkspaceSchema),
  notices: z.array(z.enum(["slack_unavailable"])),
});
export type DeveloperWorkspacesResponse = z.infer<typeof DeveloperWorkspacesResponseSchema>;
