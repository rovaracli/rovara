import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

/**
 * L4-B5: "Decisions and answers" on the session page. Cloud answers `GET /v1/app/sessions/{id}/log` from Rovara Code's task log (`GET /v1/app/sessions/{codeSession}/log`) as the signed-in person: Code decides who may
 * read it (the task's readers) and Cloud passes its refusals through. The task's Code session id comes from Code's own task read for Cloud's session record, never from the browser. What Cloud keeps of Code's log is the
 * questions, the answers and the decisions (nothing of the plan summary, the milestones or the pull requests, which the page shows elsewhere), in the fields below and no others.
 */
export const SESSION_LOG_ENTRIES_MAX = 200;
export const SESSION_LOG_TEXT_MAX = 500;
export const SESSION_LOG_PERSON_MAX = 80;

/** Where an answer or a decision was given (Code's `TASK_LOG_SURFACES`) and how it reads in a sentence. */
export const SESSION_LOG_SURFACE_WORDS = { web: "on the Rovara page", slack: "in Slack", linear: "in Linear", jira: "in Jira", github: "on GitHub", cli: "in the terminal", mcp: "in an AI tool" } as const;
export const SessionLogSurfaceSchema = z.enum(["web", "slack", "linear", "jira", "github", "cli", "mcp"]);

const KeySchema = z.string().regex(/^[a-z_]{2,20}:[A-Za-z0-9._#:-]{1,120}$/u);
const Plain = (max: number) => z.string().min(1).max(max);
const Base = { key: KeySchema, at: z.string().datetime() } as const;
const IdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/u);

const QuestionShape = { ...Base, kind: z.literal("question"), questionId: IdSchema, round: z.number().int().min(0), text: Plain(SESSION_LOG_TEXT_MAX), choices: z.array(Plain(80)).min(1).max(4).optional() };
const AnswerShape = { ...Base, kind: z.literal("answer"), questionId: IdSchema, round: z.number().int().min(0), text: Plain(SESSION_LOG_TEXT_MAX), by: Plain(SESSION_LOG_PERSON_MAX), surface: SessionLogSurfaceSchema };
const ApprovalShape = {
  ...Base, kind: z.literal("approval"), what: z.enum(["plan", "requirements", "design", "pull_request"]), outcome: z.enum(["approved", "changes_requested", "rejected"]),
  by: Plain(SESSION_LOG_PERSON_MAX), surface: SessionLogSurfaceSchema,
};

/** An entry as Cloud answers it: exactly these fields. */
export const SessionLogEntrySchema = z.discriminatedUnion("kind", [z.object(QuestionShape).strict(), z.object(AnswerShape).strict(), z.object(ApprovalShape).strict()]);
/** An entry as the page reads it: the same fields, and a member a newer Cloud adds is dropped rather than refused. */
export const SessionLogEntryReadSchema = z.discriminatedUnion("kind", [z.object(QuestionShape), z.object(AnswerShape), z.object(ApprovalShape)]);
export type SessionLogEntry = z.infer<typeof SessionLogEntrySchema>;

/** `GET /v1/app/sessions/{id}/log`: oldest first. */
export const SessionLogResponseSchema = z.object({ entries: z.array(SessionLogEntrySchema).max(SESSION_LOG_ENTRIES_MAX) }).strict();
export type SessionLogResponse = z.infer<typeof SessionLogResponseSchema>;
export const SessionLogResponseReaderSchema = forwardReader(SessionLogResponseSchema);
