import type { TaskClosePreview, TaskClosePreviewResponse } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import { isAccessEnded, servedReadState } from "../../api/served-read.js";
import { RETAINED_CLOSE_WORDS } from "../../safe-action.js";

/** The slice of a react-query result the Close preview rules read (the shared served-read rules take the same fields). */
export interface PreviewRead { data: TaskClosePreviewResponse | undefined; dataUpdatedAt: number; isError: boolean; error: unknown; isPending: boolean; failureCount?: number; failureReason?: unknown }

type Settled =
 | { kind: "reading" } | { kind: "denied" } | { kind: "not_served" } | { kind: "unreadable" }
 | { kind: "got"; value: TaskClosePreviewResponse; staleSince: number | undefined };

/** Code's own sentence for a close route the core engine on this install does not serve (cloud-server core-task-actions.ts CORE_NOT_YET): hosted Code answers the DEV preview read with 404 NOT_FOUND and exactly this. */
export const CORE_NOT_YET_WORDS = "That is not on the core engine on this install yet.";
/** What the person is told, truthfully, when Code cannot show the Close preview (older Code, hosted core without the route, or no inspection yet). */
export const NOT_CHECKED_WORDS = "Rovara can't check this task for unpublished work yet. Closing may discard changes that aren't in a pull request.";
/**
 * The answers that mean "this Code does not serve the Close preview": Cloud's 501 NOT_ON_CODE_YET (older Code's missing route), or Code's EXACT 404 NOT_FOUND
 * "That is not on the core engine on this install yet." that hosted Code gives today. Never inferred from any other failure: every other 404 is an access signal.
 */
export const previewNotServed = (error: unknown): boolean => error instanceof ApiError && (error.status === 501 && error.code === "NOT_ON_CODE_YET" || error.status === 404 && error.code === "NOT_FOUND" && error.message === CORE_NOT_YET_WORDS);

/** Shared served-read policy (DEC 254zzz324): a transient failure keeps the last facts with their time; 401/403/404 clear them. */
function settle(read: PreviewRead): Settled {
 const served = servedReadState(read);
 if (served.data !== undefined) return { kind: "got", value: served.data, staleSince: served.staleSince };
 if (read.isError || (read.failureCount ?? 0) > 0) {
  if (previewNotServed(read.error)) return { kind: "not_served" };
  if (isAccessEnded(read.error) || isAccessEnded(read.failureReason)) return { kind: "denied" };
  return read.isError ? { kind: "unreadable" } : { kind: "reading" };
 }
 return { kind: "reading" };
}

export type CloseView =
 | { kind: "reading" }
 /** 401 / 403 / 404: the cached preview is gone and nothing may be sent. */
 | { kind: "denied" }
 /** A failed first read (503 / network / unreadable): no facts to show, nothing may be sent. */
 | { kind: "unreadable" }
 /** Code has no preview route: the legacy close, only on this served answer. */
 | { kind: "legacy" }
 /** Code has not inspected the workspace yet: only the legacy first ask (which starts that check) is offered, never a discard. */
 | { kind: "inspect" }
 | { kind: "busy" }
 /** The close preview shows unpublished work but the discard preview cannot be shown yet: nothing destructive is offered. */
 | { kind: "discard_unavailable"; findings: TaskClosePreview["unpublished"]; staleSince: number | undefined }
 /** The task changed between the two reads: review again. */
 | { kind: "changed" }
 | { kind: "review"; preview: TaskClosePreview; discard: boolean; staleSince: number | undefined };

/** What the dialog shows for the two preview reads. `discard` is only consulted when the close preview holds unpublished work. */
export function chooseCloseView(close: PreviewRead, discard: PreviewRead): CloseView {
 const first = settle(close);
 if (first.kind !== "got") return first.kind === "not_served" ? { kind: "legacy" } : first;
 const answer = first.value;
 if (answer.preview === null) return answer.unavailable === "unsupported" ? { kind: "legacy" } : answer.unavailable === "busy" ? { kind: "busy" } : { kind: "inspect" };
 // Each preview must be the one that was asked for: a close preview is never bound as a discard, nor the reverse.
 if (answer.preview.action !== "close") return { kind: "unreadable" };
 if (answer.preview.unpublished.length === 0) return { kind: "review", preview: answer.preview, discard: false, staleSince: first.staleSince };
 const second = settle(discard);
 if (second.kind === "reading" || second.kind === "denied" || second.kind === "unreadable") return second.kind === "reading" ? { kind: "reading" } : second;
 if (second.kind === "not_served") return { kind: "discard_unavailable", findings: answer.preview.unpublished, staleSince: first.staleSince };
 const other = second.value;
 if (other.preview === null) return { kind: "discard_unavailable", findings: answer.preview.unpublished, staleSince: first.staleSince };
 if (other.preview.action !== "discard") return { kind: "unreadable" };
 if (other.preview.unpublished.length === 0) return { kind: "changed" };
 // A kept (stale) read of either preview disables the destructive button: the earlier of the two times is shown.
 const times = [first.staleSince, second.staleSince].filter((time): time is number => time !== undefined);
 return { kind: "review", preview: other.preview, discard: true, staleSince: times.length === 0 ? undefined : Math.min(...times) };
}

/** Whether a failed close is Code's DEC 254zzz347 refusal (exact status, code and sentence); any other WORKSPACE_BUSY is not. */
export const isRetainedCloseRefusal = (failure: unknown): boolean => failure instanceof ApiError && failure.status === 409 && failure.code === "WORKSPACE_BUSY" && RETAINED_CLOSE_WORDS.test(failure.message);

/** Code's sentence without its /v1/dev link: the person reads it with a control that opens the Cloud preview instead. */
export const RETAINED_CLOSE_LEAD = "This workspace is retained. ";
export const RETAINED_CLOSE_LINK = "Review the Close preview";
export const RETAINED_CLOSE_TAIL = " before closing it.";

const REASON_WORDS: Record<TaskClosePreview["unpublished"][number]["reasons"][number], string> = {
 worktree_changes: "changes not yet committed",
 untracked_files: "new files not yet committed",
 unpushed_head: "commits not yet pushed",
 unpushed_branch: "a branch not yet pushed",
};
export const reasonWords = (reasons: TaskClosePreview["unpublished"][number]["reasons"]): string => reasons.map(reason => REASON_WORDS[reason]).join("; ");

export const CLOSE_PREVIEW_STATUS_WORDS: Record<TaskClosePreview["taskStatus"], string> = {
 STARTING: "Starting", RUNNING: "Running", SUCCEEDED: "Finished", FAILED: "Failed", CANCELLED: "Stopped", INTERRUPTED: "Interrupted", CLOSED: "Closed",
};
export const CLOSE_PREVIEW_WORKSPACE_WORDS: Record<TaskClosePreview["workspace"]["status"], string> = {
 PREPARING: "Being prepared", READY: "Ready", PREPARATION_FAILED: "Preparation failed", BUSY: "Busy", UNHEALTHY: "Unhealthy", STOPPED: "Stopped", RESUMING: "Resuming", CLOSING: "Closing", CLOSED: "Closed", UNPREPARED: "Not prepared",
};
