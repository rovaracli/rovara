import { createHash } from "node:crypto";
import { type OrgId } from "./org.js";
import type { CodeSettingsChangedNoticeSchema, SessionSharedNoticeSchema} from "./realtime.js";
import { channel, type RealtimeNotice } from "./realtime.js";
import { z } from "zod";

/** The audience of a realtime token: a developer access token is never accepted by the authorizer, and a realtime token is never a sign-in. */
export const REALTIME_TOKEN_AUDIENCE = "rovara-realtime";

export const REALTIME_TOKEN_ISSUER = "rovara-broker";

/** A token names at most this many project channels; a person with more carries `projects: "lookup"`, which keeps the signing input small (KMS signs at most 4096 bytes). */
export const REALTIME_TOKEN_PROJECTS_MAX = 25;

// ---- channels

const sha40 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 40);

/** A person's segment: the first 40 hex of the SHA-256 of their id, so no developer id is in a channel name. */
export const userSegment = (developerId: string): string => `d-${sha40(developerId)}`;

/** A project's segment: the first 40 hex of the SHA-256 of the org and the name (a name may be 63 characters and end in `-`, so it is never in a channel). */
export const projectSegment = (orgId: OrgId, project: string): string => `p-${sha40(`${orgId}\n${project}`)}`;

export const userChannel = (orgId: OrgId, developerId: string): string => channel(orgId, "u", userSegment(developerId));

export const projectChannel = (orgId: OrgId, project: string): string => channel(orgId, "p", projectSegment(orgId, project));

// ---- the token and its answer

/** What a realtime token says (besides `iss`, `aud`, `iat`, `nbf`, `exp` and `jti`). `projects` is the project segments the person had a role on, or `"lookup"` when there are more than `REALTIME_TOKEN_PROJECTS_MAX`. */
export const RealtimeTokenClaimsSchema = z.object({
  org: z.string().regex(/^org_[0-9a-z]{20}$/u),
  sub: z.string().regex(/^[a-f0-9]{64}$/u),
  projects: z.union([z.array(z.string().regex(/^p-[0-9a-f]{40}$/u)).max(REALTIME_TOKEN_PROJECTS_MAX), z.literal("lookup")]),
}).passthrough();

export type RealtimeTokenClaims = z.infer<typeof RealtimeTokenClaimsSchema>;

/** What the broker asks the sign-in function to sign (the broker holds no signing right): who the token is for and the project segments they have a role on. */
export const RealtimeTokenRequestSchema = z.object({
  kind: z.literal("realtime-token"),
  orgId: z.string().regex(/^org_[0-9a-z]{20}$/u),
  developerId: z.string().regex(/^[a-f0-9]{64}$/u),
  projects: z.union([z.array(z.string().regex(/^p-[0-9a-f]{40}$/u)).max(REALTIME_TOKEN_PROJECTS_MAX), z.literal("lookup")]),
}).strict();

export type RealtimeTokenRequest = Omit<z.infer<typeof RealtimeTokenRequestSchema>, "orgId"> & { orgId: OrgId };

export type RealtimeTokenAnswer = { ok: true; token: string; expiresAt: string } | { ok: false; error: "invalid_request" | "unavailable" };

export type SessionSharedNotice = z.infer<typeof SessionSharedNoticeSchema>;
export type CodeSettingsChangedNotice = z.infer<typeof CodeSettingsChangedNoticeSchema>;

/**
 * What `GET /v1/app/changes` gives for one notice: the notice, when it was made, and its `sk`, the notice's own place in the feed (it is also a cursor).
 * The feed holds its cursor back by `CHANGES_SETTLE_MS`, so a notice made in the last 30 seconds can be given more than once: **a client drops repeats by `sk`**
 * (the same notice always has the same `sk`, so keeping the first or the last copy gives the same result).
 */
export type ChangesFeedEntry = (RealtimeNotice | SessionSharedNotice | CodeSettingsChangedNotice) & { at: string; sk: string };

export interface ChangesFeedPage {
  notices: ChangesFeedEntry[];
  /** The cursor to ask with next time: never newer than `CHANGES_SETTLE_MS` behind now, so what it leaves out of the next page is given again (see `ChangesFeedEntry`). */
  next: string;
  /** The cursor was older than the feed keeps: reload what you show, then carry on from `next`. */
  reset?: true;
}

export { REALTIME_NAMESPACE, RealtimeNoticeSchema, type RealtimeNotice, sessionSegment, channel, sessionChannel, type RealtimeChannel, parseRealtimeChannel, RealtimeTokenResponseSchema, type RealtimeTokenResponse, SessionSharedNoticeSchema, CodeSettingsChangedNoticeSchema } from "./realtime.js";
