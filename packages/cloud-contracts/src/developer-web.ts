import { AppTrialSchema } from "./app-nav.js";
import { z } from "zod";
import { OrgRoleSchema } from "./org.js";
import { InviteProjectSchema } from "./invite-creation.js";
import { forwardReader, OrgIdSchema } from "@rovara-code/contracts";
export const DeveloperSignInMethodSchema = z.enum(["slack", "oidc", "cloud", "github", "saml"]);
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
    /** Never an email address (release 0.4.16): the name the person chose, else the sign-in provider's real name, else a placeholder such as "Member 3fa9". */
    name: z.string().min(1).max(200),
    /** The person's own email: theirs to see, never shown to others. */
    email: z.string().optional(),
    orgRole: OrgRoleSchema,
    /** True once the person chose their name; false while it is the provider's or a placeholder (the web app then asks once). Absent from a control plane that predates it. */
    nameChosen: z.boolean().optional(),
  }),
  org: z.object({ orgId: z.string(), name: z.string(), plan: z.string(), trial: AppTrialSchema.optional(), nameIsDefault: z.boolean().optional() }),
  identities: z.array(LinkedIdentitySchema),
  /** UX1: the sign-in methods this person may link from the web app (the method is on here). Absent from an older control plane. */
  linkable: z.object({ slack: z.boolean(), github: z.boolean() }).optional(),
});
export type AppMeResponse = z.infer<typeof AppMeResponseSchema>;


export const AppMeResponseReaderSchema = forwardReader(AppMeResponseSchema);

/** Org directory: active members see id/name/role; live owners/admins additionally receive private details. */
export const AppOrgMembersResponseSchema = z.object({ members: z.array(z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), email: z.string().optional(), role: z.enum(["owner", "admin", "member", "auditor", "unknown"]), joinedAt: z.string().optional(), identities: z.array(DeveloperSignInMethodSchema).optional() }).strict()) }).strict();
export const AppOrgMembersResponseReaderSchema = forwardReader(AppOrgMembersResponseSchema);

/** Lookup is exact and org scoped. Input is a body, never a URL query or a list filter. */
export const OrgMemberLookupBodySchema = z.object({ email: z.string().trim().max(254).email().refine(value => !value.includes("*"), "Enter a complete email address.") }).strict();
export const OrgMemberLookupResponseSchema = z.object({ match: z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string() }).strict().nullable() }).strict();

export const OrgMemberLookupResponseReaderSchema = forwardReader(OrgMemberLookupResponseSchema);

/** Optional expectedRole selects the reviewed console path; omitted preserves released CLI requests. */
export const OrgMemberRoleChangeBodySchema = z.object({ requestId: z.string().uuid(), role: OrgRoleSchema, expectedRole: OrgRoleSchema.optional() }).strict();
export const OrgMemberRoleChangeResponseSchema = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), role: OrgRoleSchema }).strict();
export const OrgMemberRoleChangeResponseReaderSchema = forwardReader(OrgMemberRoleChangeResponseSchema);

/** Pending indexed invites only. Historical unindexed invites may still exist; never return bearer material. */
export const AppOrgInvitesResponseSchema = z.object({
 invites: z.array(z.object({ inviteId: z.string().uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), role: z.enum(["admin", "member"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), createdBy: z.string().regex(/^[a-f0-9]{64}$/), destination: z.discriminatedUnion("kind", [z.object({ kind: z.literal("link") }).strict(), z.object({ kind: z.literal("email"), label: z.string().max(260) }).strict()]),
  /** A-31: the project the invite also adds the person to, and their role there. */
  project: InviteProjectSchema.optional() }).strict()).max(50),
 unavailableCount: z.number().int().min(0).max(50).optional(),
 /** UX1: whether this install can email an invite (its sign-in notice sender is set up). Absent from an older control plane: copy only. */
 emailDelivery: z.boolean().optional(),
 coverage: z.enum(["indexed_only", "indexed_only_partial"]), checkedAt: z.string().datetime(), nextCursor: z.string().max(512).optional(),
}).strict();
export const AppOrgInvitesResponseReaderSchema = forwardReader(AppOrgInvitesResponseSchema);


// Lane A: explicit canonical invite review/recovery; no destination, bearer or acceptor data.
export const OrgInvitePublicIdSchema = z.string().uuid();
export const AppOrgInviteStatusSchema = z.object({
 orgId: OrgIdSchema, inviteId: OrgInvitePublicIdSchema,
 revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), role: z.enum(["admin", "member"]),
 status: z.enum(["pending", "accepted", "revoked", "expired"]), expiresAt: z.string().datetime(), checkedAt: z.string().datetime(), revokedAt: z.string().datetime().optional(),
}).strict().superRefine((value, context) => { if ((value.status === "revoked") !== (value.revokedAt !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invite status could not be verified." }); });
