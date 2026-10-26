import { AppTrialSchema } from "./app-nav.js";
import { z } from "zod";
import { OrgRoleSchema } from "./org.js";
import { forwardReader } from "./session-views.js";
export const DeveloperSignInMethodSchema = z.enum(["slack", "oidc", "cloud", "github"]);
export type DeveloperSignInMethod = z.infer<typeof DeveloperSignInMethodSchema>;
/**
 * One sign-in method linked to a developer (`GET /v1/app/me`). It names the method and what the person recognises it by, never the
 * provider's issuer or subject.
 */
export const LinkedIdentitySchema = z.object({
  provider: DeveloperSignInMethodSchema,
  email: z.string().optional(),
  login: z.string().optional(),
  linkedAt: z.string(),
  lastSignInAt: z.string(),
});
export type LinkedIdentity = z.infer<typeof LinkedIdentitySchema>;

/** `GET /v1/app/me`: who the signed-in developer is, their org, and every sign-in method linked to them. */
export const AppMeResponseSchema = z.object({
  csrf: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  developer: z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().min(1).max(200),
    email: z.string().optional(),
    orgRole: OrgRoleSchema,
  }),
  org: z.object({ orgId: z.string(), name: z.string(), plan: z.string(), trial: AppTrialSchema.optional(), nameIsDefault: z.boolean().optional() }),
  identities: z.array(LinkedIdentitySchema),
});
export type AppMeResponse = z.infer<typeof AppMeResponseSchema>;


export const AppMeResponseReaderSchema = forwardReader(AppMeResponseSchema);

/** Org directory: active members see id/name/role; live owners/admins additionally receive private details. */
export const AppOrgMembersResponseSchema = z.object({ members: z.array(z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), email: z.string().optional(), role: z.enum(["owner", "admin", "member", "unknown"]), joinedAt: z.string().optional(), identities: z.array(DeveloperSignInMethodSchema).optional() }).strict()) }).strict();
export const AppOrgMembersResponseReaderSchema = forwardReader(AppOrgMembersResponseSchema);

/** Lookup is exact and org scoped. Input is a body, never a URL query or a list filter. */
export const OrgMemberLookupBodySchema = z.object({ email: z.string().trim().max(254).email().refine(value => !value.includes("*"), "Enter a complete email address.") }).strict();
export const OrgMemberLookupResponseSchema = z.object({ match: z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string() }).strict().nullable() }).strict();

export const OrgMemberLookupResponseReaderSchema = forwardReader(OrgMemberLookupResponseSchema);
