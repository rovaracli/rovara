import { AppTrialSchema } from "./app-nav.js";
import { z } from "zod";
import { OrgRoleSchema, OrgIdSchema } from "./org.js";
import { DISPLAY_NAME_MAX_CODE_POINTS, containsEmailAddress, isReservedDisplayName } from "./display-name.js";
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

/** Optional expectedRole selects the reviewed console path; omitted preserves released CLI requests. */
export const OrgMemberRoleChangeBodySchema = z.object({ requestId: z.string().uuid(), role: OrgRoleSchema, expectedRole: OrgRoleSchema.optional() }).strict();
export const OrgMemberRoleChangeResponseSchema = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), role: OrgRoleSchema }).strict();
export const OrgMemberRoleChangeResponseReaderSchema = forwardReader(OrgMemberRoleChangeResponseSchema);

// ---- member removal (v1.1)

const MemberRemovalPersonSchema = z.object({ developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().max(200) }).strict();
/** A bounded count: 1000 means "1000 or more". */
const RemovalCountSchema = z.number().int().min(0).max(1000);
const RemovalDutiesSchema = z.object({
  wasRole: OrgRoleSchema,
  /** The projects they hold a grant on. */
  projectGrants: RemovalCountSchema,
  /** The projects they are a maintainer of by grant: shown, never moved. */
  maintainerProjects: RemovalCountSchema,
  /** Invites they created that are still open (the first page of the invite list): shown, never revoked here. */
  invitesCreated: RemovalCountSchema,
}).strict();

/** `GET /v1/app/org/members/{id}/removal-preview`: who is removed, who takes over, what moves to them, what ends and what is left for an admin. */
export const MemberRemovalPreviewSchema = z.object({
  member: MemberRemovalPersonSchema.extend({ role: OrgRoleSchema }).strict(),
  successor: MemberRemovalPersonSchema,
  moves: z.object({ agents: RemovalCountSchema, skills: RemovalCountSchema, chains: RemovalCountSchema, triggers: RemovalCountSchema, approvals: RemovalCountSchema, spendRequests: RemovalCountSchema }).strict(),
  ends: z.array(z.string().max(300)).max(20),
  duties: RemovalDutiesSchema,
  warnings: z.array(z.string().max(300)).max(10),
}).strict();
export const MemberRemovalPreviewReaderSchema = forwardReader(MemberRemovalPreviewSchema);

/** `POST /v1/app/org/members/{id}/removal`. */
export const MemberRemovalStartedSchema = z.object({ removalId: z.string().uuid(), state: z.enum(["STARTED", "DONE", "CANCELLED_REJOINED"]), message: z.string().max(500) }).strict();
export const MemberRemovalStartedReaderSchema = forwardReader(MemberRemovalStartedSchema);

/** `GET /v1/app/org/removals/{removalId}`. */
export const MemberRemovalStatusSchema = z.object({
  removalId: z.string().uuid(), state: z.enum(["STARTED", "DONE", "CANCELLED_REJOINED"]), removedAt: z.string().datetime(),
  member: MemberRemovalPersonSchema.extend({ role: OrgRoleSchema }).strict(), successor: MemberRemovalPersonSchema.optional(), by: z.string().max(200),
  duties: RemovalDutiesSchema,
}).strict();
export const MemberRemovalStatusReaderSchema = forwardReader(MemberRemovalStatusSchema);

/** Pending indexed invites only. Historical unindexed invites may still exist; never return bearer material. */
export const AppOrgInvitesResponseSchema = z.object({
 invites: z.array(z.object({ inviteId: z.string().uuid(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), role: z.enum(["admin", "member"]), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), createdBy: z.string().regex(/^[a-f0-9]{64}$/), destination: z.discriminatedUnion("kind", [z.object({ kind: z.literal("link") }).strict(), z.object({ kind: z.literal("email"), label: z.string().max(260) }).strict()]) }).strict()).max(50),
 unavailableCount: z.number().int().min(0).max(50).optional(), coverage: z.enum(["indexed_only", "indexed_only_partial"]), checkedAt: z.string().datetime(), nextCursor: z.string().max(512).optional(),
}).strict();
export const AppOrgInvitesResponseReaderSchema = forwardReader(AppOrgInvitesResponseSchema);


// Lane A: explicit canonical invite review/recovery; no destination, bearer or acceptor data.
export const OrgInvitePublicIdSchema = z.string().uuid();
export const AppOrgInviteStatusSchema = z.object({
 orgId: OrgIdSchema, inviteId: OrgInvitePublicIdSchema,
 revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), role: z.enum(["admin", "member"]),
 status: z.enum(["pending", "accepted", "revoked", "expired"]), expiresAt: z.string().datetime(), checkedAt: z.string().datetime(), revokedAt: z.string().datetime().optional(),
}).strict().superRefine((value, context) => { if ((value.status === "revoked") !== (value.revokedAt !== undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Invite status could not be verified." }); });
/** Control characters and format characters (bidi controls, zero-width spaces, tag characters) other than ZWNJ and ZWJ, which scripts and emoji sequences need. */
const NAME_UNSAFE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}]/u;

/**
 * `PUT /v1/app/me/name` (release 0.4.16): the name the signed-in person chooses for themselves. 1 to 80 characters after trimming, no control characters, no email
 * address, at least one letter or number. The person is the session's, never anything the body carries, so the body holds the name and nothing else.
 */
export const SetMyNameBodySchema = z.object({
  name: z.string()
    .refine((value) => !NAME_UNSAFE.test(value), "must not contain control characters")
    .transform((value) => value.replace(/\s+/gu, " ").trim())
    .refine((value) => value.length > 0 && Array.from(value).length <= DISPLAY_NAME_MAX_CODE_POINTS, `must have 1 to ${String(DISPLAY_NAME_MAX_CODE_POINTS)} characters`)
    .refine((value) => !containsEmailAddress(value), "must not be an email address")
    .refine((value) => /[\p{L}\p{N}]/u.test(value), "must have a letter or a number")
    .refine((value) => !isReservedDisplayName(value), "can't look like a placeholder name such as Member 3fa9c1d2"),
}).strict();
export type SetMyNameBody = z.output<typeof SetMyNameBodySchema>;

/** `PUT /v1/app/me/name`: the name now stored, always chosen. */
export const SetMyNameResponseSchema = z.object({ name: z.string().min(1).max(200), nameChosen: z.literal(true) }).strict();
export type SetMyNameResponse = z.infer<typeof SetMyNameResponseSchema>;
export const SetMyNameResponseReaderSchema = forwardReader(SetMyNameResponseSchema);
