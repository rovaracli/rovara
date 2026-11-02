// Setup and test health (KF-1 and the "always two people" screen): what the browser reads and sends for the project's known-failing marks and the company setting that decides who may mark tests as already failing.
// Strict shapes for the routes `/v1/app/projects/{name}/known-failing` and `/v1/app/org/known-failing-policy`; the readers keep fields a newer server adds. Words, ids, counts and the test ids a maintainer already sees on the Fix setup card; never output.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

const TestId = z.string().min(1).max(200);
const CheckId = z.string().min(1).max(64);
/** A person's id as the app shows it, and the day-and-time a mark was made. */
const PersonId = z.string().min(1).max(200);

export const KnownFailingMarkViewSchema = z.object({
  name: TestId, checkId: CheckId, markedBy: PersonId, markedByName: z.string().min(1).max(200), markedAt: z.string().datetime(), epoch: z.number().int().min(1), markedByYou: z.boolean(),
}).strict();
export const KnownFailingMarksAnswerSchema = z.object({ max: z.number().int().min(1), marks: z.array(KnownFailingMarkViewSchema).max(500) }).strict();
export type KnownFailingMarksAnswer = z.infer<typeof KnownFailingMarksAnswerSchema>;
export const KnownFailingMarksAnswerReaderSchema = forwardReader(KnownFailingMarksAnswerSchema);

/** Undo one mark: named by everything stored with it, so a mark that changed since the list was shown matches nothing. */
export const KnownFailingUndoBodySchema = z.object({
  action: z.literal("undo"), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u), name: TestId, checkId: CheckId, markedBy: PersonId, markedAt: z.string().datetime(), epoch: z.number().int().min(1),
}).strict();
export type KnownFailingUndoBody = z.infer<typeof KnownFailingUndoBodySchema>;
export const KnownFailingUndoAnswerSchema = KnownFailingMarksAnswerSchema.extend({ status: z.literal("done") }).strict();
export const KnownFailingUndoAnswerReaderSchema = forwardReader(KnownFailingUndoAnswerSchema);

// ---- the company setting "always two people"

export const KnownFailingPolicyStateSchema = z.object({
  alwaysTwoPeople: z.boolean(),
  /** A proposal to turn it off is waiting for a different admin. */
  pendingLoosening: z.boolean(),
  /** Only an admin is told which proposal it is and whether it is theirs. */
  pending: z.object({ changeId: z.string().min(1).max(100), proposedByYou: z.boolean(), expiresAt: z.string().datetime() }).strict().optional(),
}).strict();
export type KnownFailingPolicyState = z.infer<typeof KnownFailingPolicyStateSchema>;
export const KnownFailingPolicyStateReaderSchema = forwardReader(KnownFailingPolicyStateSchema);

export const KnownFailingPolicyBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), alwaysTwoPeople: z.boolean() }).strict(),
  z.object({ action: z.literal("approve"), changeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u) }).strict(),
]);
export type KnownFailingPolicyBody = z.infer<typeof KnownFailingPolicyBodySchema>;
/** 200 `applied` (turning it on, or a different admin approving turning it off) or 202 `needs_approval` (turning it off waits for a different admin). */
export const KnownFailingPolicyAnswerSchema = z.discriminatedUnion("status", [
  KnownFailingPolicyStateSchema.extend({ status: z.literal("applied") }).strict(),
  KnownFailingPolicyStateSchema.extend({ status: z.literal("needs_approval"), changeId: z.string().min(1).max(100) }).strict(),
]);
export const KnownFailingPolicyAnswerReaderSchema = forwardReader(KnownFailingPolicyAnswerSchema);
