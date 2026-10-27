import { AppTrialSchema } from "./app-nav.js";
import { z } from "zod";
import { DISPLAY_NAME_MAX_CODE_POINTS, containsEmailAddress, isReservedDisplayName } from "./display-name.js";
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

/** Exact existing GET /v1/app/org/members response from listOrganizationMembers. No provider subjects or issuer metadata. */
export const AppOrgMembersResponseSchema = z.object({ members: z.array(z.object({
  developerId: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), role: OrgRoleSchema,
  /** Owners and admins only (release 0.4.16, owner decision "option A"): a member sees names and roles, nothing more. */
  email: z.string().optional(), joinedAt: z.string().optional(), identities: z.array(DeveloperSignInMethodSchema).optional(),
}).strict()) }).strict();
export const AppOrgMembersResponseReaderSchema = forwardReader(AppOrgMembersResponseSchema);

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
