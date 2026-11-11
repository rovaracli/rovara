// srv/needs-broker-ui-2: how a finished session ended, for the Finished list (`SessionTile.finishedAs`, in `session-views.ts`), and the status model's reason for a task that needed no code change.
// Cloud's own names (Rovara Code's contracts have neither yet). Browser-safe: nothing here imports a Node module.
import { z } from "zod";

/**
 * How a finished session ended, in the words a Finished list can show (UX): `merged` (its pull request was merged), `closed` (its owner closed it without finishing), `finished_no_code`
 * (a question that needed no code change), and `finished` for everything else, including every outcome this build does not recognise. Mapped from stored outcomes only, never guessed.
 */
export const FINISHED_AS = ["merged", "closed", "finished_no_code", "finished"] as const;
export const FinishedAsSchema = z.enum(FINISHED_AS);
export type FinishedAs = z.infer<typeof FinishedAsSchema>;

/** The reason a task that needed no code change reads Closed with: the one stored outcome that says "finished with no code" (`finishedAsOf` in the broker maps it; the status model writes it). */
export const TASK_STATUS_ANSWERED_REASON = "Answered: no code change was needed";
