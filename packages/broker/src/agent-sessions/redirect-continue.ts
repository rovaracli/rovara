// Stop & redirect, phase 2 (live-interaction design 3.1): the restart after the stop. A hook in the broker's terminal-result path, and in the stuck-cancel path that blocks a stopped step, calls
// `continueRedirect(taskId)` once a run has ended. It reads the one redirect in flight for the task, judges the task by the facts the redirect recorded, and starts the step again with the
// instruction: or leaves it for the owner's Retry, or ends the redirect, with a fixed reason. Nothing here reads a secret, a tool or a budget, and the instruction is read only from the steer message
// the owner wrote, only to hand it to the restart.
//
// The restart is safe to race and to repeat:
//   - it starts from a record in the state `stopping` only, and takes the right to restart by moving it to `restarting` conditionally, so two hooks cannot both start the step;
//   - it starts the step only when the workflow is at exactly the revision the redirect recorded, blocked by the stop of exactly that step (a task that moved on is never restarted);
//   - the person is checked again as the task's owner or a co-owner (a take-over in between ends the redirect, it does not restart for the old owner), and the worker again for the feature;
//   - any failure to start leaves the step blocked with the instruction as a note (`left_blocked`: the owner's Retry reads it), never half started, and the sweep closes what nobody finished.
// The cap window is never reset (the restart keeps it) and a pause that waits for an approval is never skipped (the restart refuses over it).
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  REDIRECT_LEFT_BLOCKED_MESSAGE,
  REDIRECT_NOT_CARRIED_OUT_MESSAGE,
  REDIRECT_STOPPING_SWEEP_MINUTES,
  REDIRECT_TEXT_MAX_CHARS,
  WORKFLOW_BLOCK_REASONS,
  redactText,
  sessionEventId,
  type OwnerRedirectInvocation,
  type RedirectRecord,
  type RedirectState,
} from "@agentx/contracts";
import type { TransactItem } from "../agents/table-writes.js";
import type { AuditRuntime } from "../audit/outbox.js";
import { getItem } from "./stop.js";
import { taskKey, tryEffectiveTaskOwner, type DeveloperTaskRecord } from "../developer/task-records.js";
import { livePersonLabel } from "./live-steer.js";
import { mayRedirectTask, redirectOutcomeAudit, workerTakesRedirect, type RedirectConfig } from "./redirect.js";
import { needsCodingRestart, stoppedBlockReasons, type RedirectStep } from "./redirect-plan.js";
import { claimRedirect, endRedirect, listOpenRedirects, readOpenRedirect, readRedirect, redirectOpenKey, type RedirectStateDependencies } from "./redirect-state.js";
import { deliverSteerLive, readSteerMessage } from "./steer.js";
import { sessionEventItem } from "./store.js";

/**
 * The task module's restarts, acting as the person who redirected (a session actor: their project role, their payer, their cap window kept). Each throws when it could not start the step, and then
 * nothing was started. The instruction arrives as the owner's own words and is framed by whoever puts it in a prompt; none of these logs it.
 */
export interface RedirectRestartHost {
  /** Understand or Plan stopped: the step runs again; Plan gets the framed instruction as its retry note, Understand reads it as the message it is. */
  planning(task: DeveloperTaskRecord, record: RedirectRecord, instruction: string): Promise<void>;
  /** Coding stopped, keep the plan: the same step again from the current code, with the instruction in the invocation. */
  coding(task: DeveloperTaskRecord, record: RedirectRecord, ownerRedirect: OwnerRedirectInvocation): Promise<void>;
  /** The checks or the review stopped: coding runs, as a send-back to coding does, with the instruction in the invocation. */
  sendBack(task: DeveloperTaskRecord, record: RedirectRecord, ownerRedirect: OwnerRedirectInvocation): Promise<void>;
  /** Coding stopped, the plan changes: the workflow goes to planning with the instruction as the change, and the revised plan waits for the owner's approval. */
  revise(task: DeveloperTaskRecord, record: RedirectRecord, instruction: string): Promise<void>;
}

/** What ending a redirect needs: the table, its audit outbox and a log. */
export interface RedirectEndDependencies extends RedirectStateDependencies {
  audit?: AuditRuntime;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

export interface RedirectContinueDependencies extends RedirectEndDependencies {
  config: Pick<RedirectConfig, "workerFeatures">;
  host: RedirectRestartHost;
}

/** What one call did: nothing to do, not yet, or the state the redirect ended in. */
export type ContinueOutcome = "none" | "waiting" | Exclude<RedirectState, "stopping" | "restarting">;

const isoOf = (ms: number) => new Date(ms).toISOString();
const warn = (deps: Pick<RedirectEndDependencies, "log">, entry: Record<string, unknown>) => (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);

type Judgement = { kind: "wait" } | { kind: "go" } | { kind: "end"; to: "failed" | "left_blocked" };

/**
 * Whether the stop has landed on exactly what the redirect recorded. `wait`: not yet (the run is still ending); `go`: the step is stopped by this stop; `end`: it never will be (the task moved
 * on, or the step is blocked for another reason), with the state the redirect ends in. Pure.
 */
export function judgeRedirect(record: RedirectRecord, task: DeveloperTaskRecord | undefined): Judgement {
  const workflow = task?.workflow;
  if (task === undefined || task.closedAt !== undefined || workflow === undefined || workflow.stage === "CLOSED" || workflow.stage === "MERGED" || workflow.state === "COMPLETE") return { kind: "end", to: "failed" };
  if (workflow.revision < record.blockedRevision) return { kind: "wait" };
  if (workflow.revision > record.blockedRevision || workflow.stage !== record.step) return { kind: "end", to: "failed" };
  // At exactly the recorded revision: the stop must be what blocked the step. A step that is still running or waiting at that revision is not stopped yet.
  if (workflow.state !== "BLOCKED") return { kind: "wait" };
  // A step that was blocked already when the redirect came restarts from any block but a pause for budget (that waits for an approval); a step the redirect stopped restarts only from that stop.
  if (record.kind === "blocked") return workflow.blockReason === WORKFLOW_BLOCK_REASONS.budgetPaused ? { kind: "end", to: "left_blocked" } : { kind: "go" };
  const reasons = stoppedBlockReasons(record.step as RedirectStep);
  return workflow.blockReason !== undefined && reasons.includes(workflow.blockReason) ? { kind: "go" } : { kind: "end", to: "left_blocked" };
}

/** The line a redirect that did not restart leaves on the session's timeline (fixed words, never the instruction): the step is left stopped (`left_blocked`: press Retry) or nothing was stopped (`failed`). Best effort: the state of the redirect is the record. */
async function tellEnded(deps: RedirectEndDependencies, record: RedirectRecord, to: "left_blocked" | "failed"): Promise<void> {
  try {
    const item: TransactItem = sessionEventItem(deps, { orgId: record.orgId, sessionId: record.sessionId }, {
      eventId: sessionEventId("redirect_left_blocked", record.requestId), at: isoOf(deps.now()), type: "status", actor: { kind: "agent" }, text: to === "left_blocked" ? REDIRECT_LEFT_BLOCKED_MESSAGE : REDIRECT_NOT_CARRIED_OUT_MESSAGE,
    });
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [item] }));
  } catch {
    // Already told, or the session is gone: nothing more to do.
  }
}

/** Ends the redirect (from `from`) with its audit item, and tells the session when the step was left stopped. Answers whether this call ended it. */
async function finish(deps: RedirectEndDependencies, record: RedirectRecord, from: readonly RedirectState[], to: Exclude<RedirectState, "stopping" | "restarting">): Promise<boolean> {
  const outcome = to === "restarted" || to === "revise_started" || to === "left_blocked" ? to : "refused";
  const audit = await redirectOutcomeAudit(deps, record, outcome, isoOf(deps.now()));
  const ended = await endRedirect(deps, record, from, to, audit);
  if (ended && (to === "left_blocked" || to === "failed")) await tellEnded(deps, record, to);
  return ended;
}

/**
 * Carries on a redirect for a task once a run of it has ended. Never throws (a terminal result must not fail for it); logs only names. Answers what it did.
 */
export async function continueRedirect(deps: RedirectContinueDependencies, taskId: string): Promise<ContinueOutcome> {
  try {
    return await continueOnce(deps, taskId);
  } catch (error) {
    warn(deps, { event: "redirect.continue_failed", taskId, error: error instanceof Error ? error.name : "unknown" });
    return "none";
  }
}

async function continueOnce(deps: RedirectContinueDependencies, taskId: string): Promise<ContinueOutcome> {
  const open = await readOpenRedirect(deps, taskId);
  if (open === undefined) return "none";
  const record = await readRedirect(deps, taskId, open.requestId);
  if (record === undefined) {
    // A marker whose record is gone or unreadable can never be carried out: it is taken away so the next redirect is not refused for it.
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: redirectOpenKey(taskId), ConditionExpression: "requestId = :id", ExpressionAttributeValues: { ":id": open.requestId } } }] })).catch(() => undefined);
    return "none";
  }
  // Only a redirect that is still stopping is carried on; another call is restarting it, or it ended.
  if (record.state !== "stopping") return "none";
  const task = (await getItem(deps, taskKey(taskId))) as DeveloperTaskRecord | undefined;
  const sameOrg = task !== undefined && task.orgId === record.orgId;
  const judgement = judgeRedirect(record, sameOrg ? task : undefined);
  if (judgement.kind === "wait") return "waiting";
  if (judgement.kind === "end") return (await finish(deps, record, ["stopping"], judgement.to)) ? judgement.to : "none";
  return restart(deps, record, task!);
}

async function restart(deps: RedirectContinueDependencies, record: RedirectRecord, task: DeveloperTaskRecord): Promise<ContinueOutcome> {
  // The person must still own the task. A take-over or a removed co-owner between the stop and now ends the redirect: the step stays stopped, the instruction stays a note.
  const owner = tryEffectiveTaskOwner(task)?.developerId;
  if (!await mayRedirectTask(deps, task, record.actorId, owner === record.actorId)) return (await finish(deps, record, ["stopping"], "failed")) ? "failed" : "none";
  // A coding run carries the instruction only to a worker that binds it (the re-approval stop). One that does not, or cannot be asked now, leaves the step stopped.
  if (needsCodingRestart(record.step as RedirectStep, record.mode) && !await workerTakesRedirect(deps.config, task)) return (await finish(deps, record, ["stopping"], "left_blocked")) ? "left_blocked" : "none";
  // The instruction: the steer message the person wrote, only if it is theirs and still there. Nothing else is ever sent as the owner's word.
  const message = await readSteerMessage(deps, record.orgId, record.sessionId, record.messageId);
  const text = message === undefined || message.author.developerId !== record.actorId || message.deletedAt !== undefined ? "" : redactText(message.text).trim().slice(0, REDIRECT_TEXT_MAX_CHARS).trim();
  if (text === "") return (await finish(deps, record, ["stopping"], "left_blocked")) ? "left_blocked" : "none";
  // The right to restart: of two hooks that got here, one.
  if (!await claimRedirect(deps, record)) return "none";
  const ownerRedirect: OwnerRedirectInvocation = { messageId: record.messageId, sender: livePersonLabel(record.actorId), text };
  try {
    let to: "restarted" | "revise_started" = "restarted";
    if (record.step === "UNDERSTAND" || record.step === "PLAN") await deps.host.planning(task, record, text);
    else if (record.step === "IMPLEMENT" && record.mode === "change_plan") { await deps.host.revise(task, record, text); to = "revise_started"; }
    else if (record.step === "IMPLEMENT") await deps.host.coding(task, record, ownerRedirect);
    else await deps.host.sendBack(task, record, ownerRedirect);
    // Whatever happens next, the step was started: the redirect ends as that, and the message is told it was given.
    const ended = await finish(deps, record, ["restarting"], to);
    if (record.step === "IMPLEMENT" || record.step === "VERIFY" || record.step === "REVIEW") await deliverSteerLive(deps, record.orgId, record.sessionId, record.messageId, record.taskId);
    return ended ? to : "none";
  } catch (error) {
    warn(deps, { event: "redirect.restart_failed", taskId: record.taskId, step: record.step, error: error instanceof Error ? error.name : "unknown" });
    return (await finish(deps, record, ["restarting"], "left_blocked")) ? "left_blocked" : "none";
  }
}

/** How many open redirects one sweep looks at. */
const SWEEP_PAGE = 50;

/**
 * Carries on the redirects whose stop landed where no hook ran (see `carryOn`), then closes the ones nobody finished: one still `stopping` or `restarting` after `REDIRECT_STOPPING_SWEEP_MINUTES` ends `left_blocked` (the step stays as the stop left it, the instruction stays a note
 * for the owner's Retry), and a marker without a live record is taken away. Never restarts a step: a redirect that old is the owner's to repeat. Answers how many it closed. Bounded to one page.
 */
export async function sweepStoppingRedirects(deps: RedirectEndDependencies, carryOn?: (taskId: string) => Promise<unknown>): Promise<number> {
  let closed = 0;
  const cutoff = deps.now() - REDIRECT_STOPPING_SWEEP_MINUTES * 60_000;
  for (const open of await listOpenRedirects(deps, SWEEP_PAGE)) {
    try {
      // The stop may have landed where no hook runs (the Reconciler Lambda blocks a step whose cancel got stuck, and registers no continuation): the sweep, which runs in the broker, carries the redirect on.
      if (carryOn !== undefined) await carryOn(open.taskId);
      // Read again after carrying on: what is judged is the redirect's phase now.
      const record = await readRedirect(deps, open.taskId, open.requestId);
      if (record === undefined || (record.state !== "stopping" && record.state !== "restarting")) {
        await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: deps.tableName, Key: redirectOpenKey(open.taskId), ConditionExpression: "requestId = :id", ExpressionAttributeValues: { ":id": open.requestId } } }] })).catch(() => undefined);
        continue;
      }
      // A redirect waiting for its stop is timed from when it was made; one being restarted from when its restart was claimed (a stop that took long to land must not make a fresh restart look old).
      const since = record.state === "restarting" ? Date.parse(record.claimedAt ?? record.createdAt) : Date.parse(open.createdAt);
      if (since > cutoff) continue;
      let to: "left_blocked" | "restarted" | "failed" = "left_blocked";
      if (record.state === "restarting") {
        // A restart that committed and died before it ended the record left the workflow past the stop: that run is going, so it is not "left blocked".
        const task = (await getItem(deps, taskKey(open.taskId))) as DeveloperTaskRecord | undefined;
        const workflow = task?.workflow;
        if (workflow !== undefined && workflow.revision > record.blockedRevision) to = workflow.state === "RUNNING" && workflow.revision === record.blockedRevision + 1 ? "restarted" : "failed";
      }
      // Conditional on the phase that was read: a redirect whose restart started or ended meanwhile is left alone.
      if (await finish(deps, record, [record.state], to)) closed += 1;
    } catch (error) {
      warn(deps, { event: "redirect.sweep_failed", taskId: open.taskId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return closed;
}
