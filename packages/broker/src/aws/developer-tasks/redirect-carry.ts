// Stop & redirect, the Retry that keeps the instruction (LR-2). A redirect's restart gives the run the owner's instruction (to a coding run in its invocation, to planning and Understand framed in the prompt) and
// marks the thread note as given, so a run that then fails and is retried with a plain Retry would otherwise lose it. This finds the instruction still in force for a blocked step, so the Retry can give it again.
//
// In force means all of these, read from the table now: the task's latest redirect restarted its step (not left it stopped, which the Retry's thread notes already cover); the workflow is blocked at the stage
// that restart leaves it at, after the restart; and no decision has been made since the restart except the restart's own send-back (an approval, a send-back or an automatic retry starts a new attempt, for
// which the instruction was not meant). The text is read from the owner's own steer message, only if it is still theirs and still there, as the restart reads it.
import { REDIRECT_TEXT_MAX_CHARS, redactText, type OwnerRedirectInvocation, type RedirectRecord } from "@agentx/contracts";
import { livePersonLabel } from "../../agent-sessions/live-steer.js";
import { listTaskRedirects } from "../../agent-sessions/redirect-state.js";
import { readSteerMessage } from "../../agent-sessions/steer.js";
import type { DeveloperTaskRecord } from "../../developer/task-records.js";
import { redirectRestartRequestId } from "./redirect-frame.js";
import type { DeveloperTaskRouteDependencies } from "./types.js";

/** The stage a restarted step is at: Understand and Plan again, a send-back from the checks or the review at coding, coding at coding. A changed plan is not carried (the plan's revision holds it). */
function restartedStage(record: Pick<RedirectRecord, "step" | "mode">): string | undefined {
  if (record.step === "UNDERSTAND" || record.step === "PLAN") return record.step;
  if (record.step === "VERIFY" || record.step === "REVIEW") return "IMPLEMENT";
  return record.step === "IMPLEMENT" && record.mode === "keep_plan" ? "IMPLEMENT" : undefined;
}

export interface CarriedRedirect {
  record: RedirectRecord;
  /** The owner's words, as the restart read them. */
  text: string;
  /** For a coding run: the instruction as the invocation carries it (the worker frames it). */
  ownerRedirect: OwnerRedirectInvocation;
}

/** The redirect instruction still in force for the task's blocked step, or undefined. Never throws: a read that fails carries nothing (the Retry then behaves as it always did). */
export async function carriedRedirect(deps: Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "now">, task: DeveloperTaskRecord): Promise<CarriedRedirect | undefined> {
  try {
    const workflow = task.workflow;
    if (workflow === undefined || workflow.state !== "BLOCKED") return undefined;
    const stateDeps = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
    const latest = (await listTaskRedirects(stateDeps, task.taskId))[0];
    if (latest === undefined || latest.state !== "restarted" || latest.orgId !== task.orgId) return undefined;
    if (restartedStage(latest) !== workflow.stage || workflow.revision <= latest.blockedRevision) return undefined;
    const own = redirectRestartRequestId(latest);
    if (workflow.decisions.some((decision) => decision.workflowRevision > latest.blockedRevision && decision.requestId !== own)) return undefined;
    const message = await readSteerMessage(stateDeps, latest.orgId, latest.sessionId, latest.messageId);
    if (message === undefined || message.author.developerId !== latest.actorId || message.deletedAt !== undefined) return undefined;
    const text = redactText(message.text).trim().slice(0, REDIRECT_TEXT_MAX_CHARS).trim();
    if (text === "") return undefined;
    return { record: latest, text, ownerRedirect: { messageId: latest.messageId, sender: livePersonLabel(latest.actorId), text } };
  } catch {
    return undefined;
  }
}
