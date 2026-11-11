// Rovara Code (Plan 6 Task 20): the `merged` milestone. The save that moves a task to MERGED adds these items to its transaction, so the milestone exists exactly when the merge is
// recorded, once, whichever path recorded it (a webhook, the merge sweep, or a pushed fix found merged). It lists every merged pull request and the session's bindings, which is what
// Plan 9's handlers read to close the Linear issue (found again through `sessionForSurface`) and to post the Slack line. Handlers are told after the commit.
import { SessionIdSchema, type CodeMilestone, type OrgId } from "@rovara-code/contracts";
import { type WorkflowSnapshot } from "@agentx/cloud-contracts";
import type { TransactItem } from "../agents/table-writes.js";
import { mergedLines } from "./merged-lines.js";
import { codeMilestoneItems } from "./milestones.js";
import { sessionBindingsOf, type SessionBindingReader } from "./session-bindings.js";

/** The milestone's text holds at most this many characters. */
const TEXT_MAX = 500;
/** A task has one merged milestone. */
const MERGED_MILESTONE_NUMBER = 1;

const isMerged = (workflow: WorkflowSnapshot): boolean => workflow.stage === "MERGED" && workflow.state === "COMPLETE" && workflow.outcome === "MERGED";

/** The milestone's text: `Merged: <url>` for each pull request, cut at a line (with a count of the rest) when there are too many for 500 characters. */
function textOf(lines: readonly string[]): string {
  for (let kept = lines.length; kept > 0; kept -= 1) {
    const text = [...lines.slice(0, kept), ...(kept < lines.length ? [`and ${String(lines.length - kept)} more`] : [])].join("\n");
    if (text.length <= TEXT_MAX) return text;
  }
  return "Merged.";
}

/**
 * The items that record a task's merge as a milestone: none unless `after` is the move to MERGED (and `before` was not already there), and none for a task whose org is unknown. The
 * session's bindings are read now, and a read that fails is thrown, so the move to MERGED is not recorded without them (the save is tried again; a Linear close is never lost).
 */
export async function mergedMilestoneItems(
  table: SessionBindingReader,
  task: { taskId: string; orgId?: OrgId | undefined; sessionId?: string | undefined },
  before: WorkflowSnapshot,
  after: WorkflowSnapshot,
  now: string,
): Promise<TransactItem[]> {
  if (!isMerged(after) || isMerged(before) || task.orgId === undefined) return [];
  const merged = (after.pullRequests ?? []).filter((pullRequest) => pullRequest.state === "MERGED");
  const lines = mergedLines(merged);
  const session = SessionIdSchema.safeParse(task.sessionId);
  const bindings = session.success ? await sessionBindingsOf(table, task.orgId, session.data) : [];
  const milestone: CodeMilestone = {
    kind: "merged", orgId: task.orgId, taskId: task.taskId, ...(session.success ? { sessionId: session.data } : {}), at: now, text: textOf(lines),
    ...(merged.length === 0 ? {} : { pullRequests: merged.map((pullRequest) => ({ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url })) }),
    ...(bindings.length === 0 ? {} : { bindings }),
  };
  return codeMilestoneItems({ tableName: table.tableName }, milestone, MERGED_MILESTONE_NUMBER, { definitionVersion: after.definitionVersion });
}
