// Setup and test health: what the browser reads and sends for a project's known-failing marks. There is no configurable company approval count.
// Strict shapes for `/v1/app/projects/{name}/known-failing`; readers keep fields a newer server adds. The app never invents test ids.
import { z } from "zod";
import { forwardReader } from "./forward-reader.js";
import { TEST_ID_MAX } from "./test-id.js";

// The one test id (contracts `test-id.ts`): the same string the nightly run, the evidence pack and the marks use.
const TestId = z.string().min(1).max(TEST_ID_MAX);
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
