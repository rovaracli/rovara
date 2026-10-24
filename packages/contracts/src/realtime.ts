// Realtime notices (Plan 5 Task 8): what is published over AppSync Events, the channel names, and the short-lived token that lets a client connect. A notice carries
// ids and numbers only; every detail is read again, through the session's own access check, when a client acts on it. Names in a channel hold only characters
// AppSync Events accepts (a segment is at most 50 of `[A-Za-z0-9-]`, starting and ending with a letter or digit), and never a person's id, a project's name or a
// title: those are hashed or cut to their id body.
import { z } from "zod";
import { DeviceIdSchema, SessionEventIdSchema, SessionIdSchema, type SessionId } from "./agent-sessions.js";
import type { OrgId } from "./org.js";

/** The one channel namespace of the events API. */
export const REALTIME_NAMESPACE = "rovara";
/** The audience of a realtime token: a developer access token is never accepted by the authorizer, and a realtime token is never a sign-in. */
export const REALTIME_TOKEN_AUDIENCE = "rovara-realtime";
export const REALTIME_TOKEN_ISSUER = "rovara-broker";
/** A token names at most this many project channels; a person with more carries `projects: "lookup"`, which keeps the signing input small (KMS signs at most 4096 bytes). */
export const REALTIME_TOKEN_PROJECTS_MAX = 25;

const CountSchema = z.number().int().min(0);

/** One change notice. Strict: ids and numbers only. */
export const RealtimeNoticeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.updated"), sessionId: SessionIdSchema, revision: CountSchema }).strict(),
  z.object({ type: z.literal("session.event"), sessionId: SessionIdSchema, eventId: SessionEventIdSchema }).strict(),
  z.object({ type: z.literal("home.changed"), revision: CountSchema }).strict(),
  z.object({ type: z.literal("device.command"), deviceId: DeviceIdSchema, seq: CountSchema }).strict(),
]);
export type RealtimeNotice = z.infer<typeof RealtimeNoticeSchema>;

// ---- channels

/** The org's id without `org_`: the org segment of every channel. */
const orgBody = (orgId: OrgId): string => {
  const body = /^org_([0-9a-z]{20})$/u.exec(orgId)?.[1];
  if (body === undefined) throw new Error("an org id is org_ and 20 letters or digits");
  return body;
};

/** A session's segment: `s-` and the id's body, or `c-` and the body of a chain run's id. */
export function sessionSegment(sessionId: SessionId): string {
  const matched = /^(ses|crn)_([0-9a-z]{20})$/u.exec(sessionId);
  if (matched === null) throw new Error("not a session id");
  return `${matched[1] === "crn" ? "c" : "s"}-${matched[2]!}`;
}

export const channel = (orgId: OrgId, kind: "u" | "s" | "p", segment: string) => `/${REALTIME_NAMESPACE}/o-${orgBody(orgId)}/${kind}/${segment}`;
export const sessionChannel = (orgId: OrgId, sessionId: SessionId): string => channel(orgId, "s", sessionSegment(sessionId));

export type RealtimeChannel =
  | { kind: "user"; orgBody: string; segment: string }
  | { kind: "session"; orgBody: string; segment: string }
  | { kind: "project"; orgBody: string; segment: string };

const SEGMENT_RULES = { u: /^d-[0-9a-f]{40}$/u, s: /^[sc]-[0-9a-z]{20}$/u, p: /^p-[0-9a-f]{40}$/u } as const;
const KINDS = { u: "user", s: "session", p: "project" } as const;

/**
 * A channel as this module makes them, or undefined: exactly `/rovara/o-<org>/<u|s|p>/<segment>`, each segment of the shape its kind has. A `*`, a missing or extra
 * segment, a segment of another kind's shape and a namespace other than `rovara` are all refused.
 */
export function parseRealtimeChannel(value: string): RealtimeChannel | undefined {
  const parts = value.split("/");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== REALTIME_NAMESPACE) return undefined;
  const org = /^o-([0-9a-z]{20})$/u.exec(parts[2]!)?.[1];
  const kind = parts[3] as keyof typeof KINDS;
  if (org === undefined || !(kind in KINDS) || !SEGMENT_RULES[kind].test(parts[4]!)) return undefined;
  return { kind: KINDS[kind], orgBody: org, segment: parts[4]! };
}

// ---- the token and its answer

/** What a realtime token says (besides `iss`, `aud`, `iat`, `nbf`, `exp` and `jti`). `projects` is the project segments the person had a role on, or `"lookup"` when there are more than `REALTIME_TOKEN_PROJECTS_MAX`. */
export const RealtimeTokenClaimsSchema = z.object({
  org: z.string().regex(/^org_[0-9a-z]{20}$/u),
  sub: z.string().regex(/^[a-f0-9]{64}$/u),
  projects: z.union([z.array(z.string().regex(/^p-[0-9a-f]{40}$/u)).max(REALTIME_TOKEN_PROJECTS_MAX), z.literal("lookup")]),
}).passthrough();
export type RealtimeTokenClaims = z.infer<typeof RealtimeTokenClaimsSchema>;

export const RealtimeTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
  endpoint: z.string(),
  channels: z.object({ user: z.string(), projects: z.record(z.string(), z.string()) }).strict(),
}).strict();
export type RealtimeTokenResponse = z.infer<typeof RealtimeTokenResponseSchema>;

/** What the broker asks the sign-in function to sign (the broker holds no signing right): who the token is for and the project segments they have a role on. */
export const RealtimeTokenRequestSchema = z.object({
  kind: z.literal("realtime-token"),
  orgId: z.string().regex(/^org_[0-9a-z]{20}$/u),
  developerId: z.string().regex(/^[a-f0-9]{64}$/u),
  projects: z.union([z.array(z.string().regex(/^p-[0-9a-f]{40}$/u)).max(REALTIME_TOKEN_PROJECTS_MAX), z.literal("lookup")]),
}).strict();
export type RealtimeTokenRequest = Omit<z.infer<typeof RealtimeTokenRequestSchema>, "orgId"> & { orgId: OrgId };
export type RealtimeTokenAnswer = { ok: true; token: string; expiresAt: string } | { ok: false; error: "invalid_request" | "unavailable" };

// ---- the changes feed

/** A notice an old share left in the feed (Task 4): who shared a session, and how to undo it. Ids only. */
export const SessionSharedNoticeSchema = z.object({
  type: z.literal("session_shared"),
  sessionId: SessionIdSchema,
  revision: CountSchema,
  by: z.string().regex(/^[a-f0-9]{64}$/u),
  undo: z.object({ principalKey: z.string().min(1).max(200) }).strict(),
}).strict();
export type SessionSharedNotice = z.infer<typeof SessionSharedNoticeSchema>;

/**
 * What `GET /v1/app/changes` gives for one notice: the notice, when it was made, and its `sk`, the notice's own place in the feed (it is also a cursor).
 * The feed holds its cursor back by `CHANGES_SETTLE_MS`, so a notice made in the last 30 seconds can be given more than once: **a client drops repeats by `sk`**
 * (the same notice always has the same `sk`, so keeping the first or the last copy gives the same result).
 */
export type ChangesFeedEntry = (RealtimeNotice | SessionSharedNotice) & { at: string; sk: string };
export interface ChangesFeedPage {
  notices: ChangesFeedEntry[];
  /** The cursor to ask with next time: never newer than `CHANGES_SETTLE_MS` behind now, so what it leaves out of the next page is given again (see `ChangesFeedEntry`). */
  next: string;
  /** The cursor was older than the feed keeps: reload what you show, then carry on from `next`. */
  reset?: true;
}
