import { z } from "zod";
import { CountSchema, DeviceIdSchema, type OrgId, SessionEventIdSchema, type SessionId, SessionIdSchema } from "@rovara-code/contracts";

/** The one channel namespace of the events API. */
export const REALTIME_NAMESPACE = "rovara";

/** One change notice. Strict: ids and numbers only. */
export const RealtimeNoticeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.updated"), sessionId: SessionIdSchema, revision: CountSchema }).strict(),
  z.object({ type: z.literal("session.event"), sessionId: SessionIdSchema, eventId: SessionEventIdSchema }).strict(),
  z.object({ type: z.literal("home.changed"), revision: CountSchema }).strict(),
  z.object({ type: z.literal("device.command"), deviceId: DeviceIdSchema, seq: CountSchema }).strict(),
]);

export type RealtimeNotice = z.infer<typeof RealtimeNoticeSchema>;

export const orgBody = (orgId: OrgId): string => {
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

export const SEGMENT_RULES = { u: /^d-[0-9a-f]{40}$/u, s: /^[sc]-[0-9a-z]{20}$/u, p: /^p-[0-9a-f]{40}$/u } as const;

export const KINDS = { u: "user", s: "session", p: "project" } as const;

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

export const RealtimeTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
  endpoint: z.string(),
  channels: z.object({ user: z.string(), projects: z.record(z.string(), z.string()) }).strict(),
}).strict();

export type RealtimeTokenResponse = z.infer<typeof RealtimeTokenResponseSchema>;

// ---- the changes feed

/** A notice that a project's code settings changed (Plan 6 Task 19), left in the feed of the project's other maintainers: the project, the revision and who decided it. */
export const CodeSettingsChangedNoticeSchema = z.object({
  type: z.literal("code_settings.changed"),
  project: z.string().min(1).max(63),
  revision: CountSchema,
  by: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

/** A notice an old share left in the feed (Task 4): who shared a session, and how to undo it. Ids only. */
export const SessionSharedNoticeSchema = z.object({
  type: z.literal("session_shared"),
  sessionId: SessionIdSchema,
  revision: CountSchema,
  by: z.string().regex(/^[a-f0-9]{64}$/u),
  undo: z.object({ principalKey: z.string().min(1).max(200) }).strict(),
}).strict();
