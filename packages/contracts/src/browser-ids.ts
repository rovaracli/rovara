// The id and reference schemas that browser-safe contracts (`rovara-code.ts`) need, defined where nothing imports a Node module. The modules that used to
// define them (org.ts, chains.ts, slack.ts, agent-sessions.ts) import and re-export them, so there is one definition of each.
import { z } from "zod";

export const OrgIdSchema = z.string().regex(/^org_[0-9a-z]{20}$/);
export type OrgId = z.infer<typeof OrgIdSchema>;

export const ChainRunIdSchema = z.string().regex(/^crn_[0-9a-z]{20}$/);
export type ChainRunId = z.infer<typeof ChainRunIdSchema>;

export const SlackTeamIdSchema = z.string().regex(/^[TE][A-Z0-9]{2,31}$/);
export const SlackChannelIdSchema = z.string().regex(/^[CG][A-Z0-9]{2,31}$/);
export const SlackMessageTimestampSchema = z.string().regex(/^\d{10}\.\d{6}$/);

const LINEAR_ISSUE_ID_MAX = 64;
const LINEAR_URL_MAX = 2048;
export const SESSION_ID_PATTERN = /^ses_[0-9a-z]{20}$/;

/** A session id: `ses_` for a task or local session, the chain run's own id for a chain session (Plan 4 pins `sessionId = ChainRunId`). */
export const SessionIdSchema = z.union([z.string().regex(SESSION_ID_PATTERN), ChainRunIdSchema]);
export type SessionId = z.infer<typeof SessionIdSchema>;

/** The outside place a session is bound to: one Slack thread or one Linear issue, at `BINDING#<kind>` (Plan 9 posts through it). */
export const SessionBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("slack_thread"), teamId: SlackTeamIdSchema, channelId: SlackChannelIdSchema, threadTs: SlackMessageTimestampSchema }).strict(),
  z
    .object({
      kind: z.literal("linear_issue"),
      issueId: z.string().regex(new RegExp(`^[A-Za-z0-9_-]{1,${String(LINEAR_ISSUE_ID_MAX)}}$`)),
      url: z.string().url().max(LINEAR_URL_MAX).refine((value) => value.startsWith("https://"), "must be an https link"),
    })
    .strict(),
]);
export type SessionBinding = z.infer<typeof SessionBindingSchema>;
