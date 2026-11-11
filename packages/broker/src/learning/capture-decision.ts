// v1.2 learning loop B4: a plan send-back becomes a correction, automatically (design 2.2, 2.4, test I1b).
//
// The one hook is in `decideTaskWorkflow` (aws/developer-tasks.ts), which every surface reaches: the task page, the developer API, Slack and MCP. It calls `captureSendBackQuietly` after a
// REQUEST_CHANGES decision on a requirements, design or plan document has committed.
//
// A CODE send-back (the owner sends failed checks, review findings or finished code back to coding) is captured the same way by a second call in `sendTaskWorkflowBackToCoding`:
// `stage` is then the coding step the work goes back to (`codeSendBackStage`), and there are no included comments (that request carries none).
//
// Standing is the DECIDER's, read live from the company and project records (standing.ts), never the task role: an owner who took a task over as a viewer, as a commenter or with no
// grant can send a plan back (review Critical 1), and that person's reason is stored as `outsider` and never grouped. Each included comment keeps its own author's standing. Nothing the
// request says about standing, author or stage is read.
//
// What is written:
//   - one correction from the note (source `send_back`, source key `decision#<task>#<request>`), unless the note is the page's default text, generic, or under 20 characters;
//   - one correction per included comment (same source, source key `comment#<task>#<comment>` as Remember uses, so a comment is one correction however it got here), `linkedTo` the
//     note's correction when that one was created now. They are all of one task, so grouping counts them as one task.
// Automatic captures carry no `rememberedBy`; Forget then allows the author or a maintainer. A forgotten send-back keeps its source record, so a retry does not bring it back.
// Then `groupCorrections` runs once if anything was created.
//
// Capture never fails the send-back: `captureSendBackQuietly` catches everything and logs fixed words (never the text).
import { createHash } from "node:crypto";
import { LEARNING_PROJECT_WIDE, LearningStageSchema, type LearningStage, type LearningStanding, type OrgId, type TaskComment } from "@rovara-code/contracts";
import { type WorkflowSnapshot } from "@agentx/cloud-contracts";
import { stepForOperation } from "../agents/dispatch.js";
import { readTaskRecipe } from "../agents/runs.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { COMMENT_STAGE, commentSourceKey } from "./capture-comment.js";
import { groupCorrections } from "./grouping.js";
import { signatureOf } from "./similarity.js";
import { learningSalt, learningScopeChecked, readStandingChecked, type StandingCheck } from "./standing.js";
import { captureCorrection, type CaptureInput, type LearningDeps, type LearningScope } from "./store.js";
import { prepareCorrection } from "./text.js";

type CaptureDeps = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "now" | "log" | "learningAudit">;

export interface SendBackInput {
  /** The person who decided: their standing is read here. */
  caller: DeveloperCaller;
  taskId: string;
  project: string;
  requestId: string;
  /** The note the person wrote (the page's note, or the reason Slack and MCP send). The page's default text is recognised as generic. */
  reason: string;
  /** The comments the decision sent along, as the decision locked them. */
  included: readonly TaskComment[];
  /** The step the correction is for. Absent: the plan (a plan send-back). A code send-back names the coding step the work goes back to (`codeSendBackStage`). */
  stage?: LearningStage;
  /**
   * Team lessons (LS-1): what to tell the lessons side once for THIS send-back. `captureSendBackQuietly` is the one place a send-back is captured, and it is the only caller of this: the
   * send-back's call sites no longer announce beside it. Only the code send-back passes one (a plan send-back never told the record, and still does not). It runs once per call, before the
   * capture, and never fails or holds up the send-back.
   */
  alsoRecord?: () => Promise<void>;
}
export interface SendBackOutcome {
  /** Ids of the corrections created by this call (empty on a repeat). */
  created: string[];
}

/**
 * The stage of a correction from a CODE send-back: the id of the coding step that will run the work, so the lesson lands on the step that runs. With the task's frozen agent snapshot it is
 * the step `stepForOperation` picks for a coding run (the program's step the work returned to, else the recipe's FIRST build step: what dispatch uses); never a hard-coded id. Without a
 * snapshot, a program's own build step; with neither, or when the recipe has no build step (an agent-steps recipe reads only `*`), `LEARNING_PROJECT_WIDE`.
 * Reading the snapshot can fail: that too gives `LEARNING_PROJECT_WIDE`, never a failed send-back.
 */
export async function codeSendBackStage(deps: CaptureDeps, orgId: OrgId, taskId: string, returned: Pick<WorkflowSnapshot, "program" | "programStepId">): Promise<LearningStage> {
  const valid = (id: string | undefined): LearningStage => {
    const stage = id === undefined ? undefined : LearningStageSchema.safeParse(id);
    return stage?.success === true ? stage.data : LEARNING_PROJECT_WIDE;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The send-back never waits on this read longer than the capture itself may.
    const limit = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), SEND_BACK_CAPTURE_BUDGET_MS); });
    const snapshot = await Promise.race([readTaskRecipe(deps, taskId, orgId), limit]);
    if (snapshot === "timeout") return LEARNING_PROJECT_WIDE;
    if (snapshot !== undefined) return valid(stepForOperation(snapshot.recipe, "IMPLEMENT", returned.programStepId)?.id);
  } catch {
    return LEARNING_PROJECT_WIDE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const step = returned.program?.steps.find((candidate) => candidate.id === returned.programStepId);
  return step?.kind === "build" ? valid(step.id) : LEARNING_PROJECT_WIDE;
}

/** The source key of a send-back: one correction per (task, decision request). */
export const sendBackSourceKey = (taskId: string, requestId: string): string => `decision#${taskId}#${requestId}`;
const correctionIdOf = (sourceKey: string): string => createHash("sha256").update(`learning-correction\0${sourceKey}`, "utf8").digest("hex").slice(0, 32);
// The Audit Ledger goes along (when the install has one), so the grouping a send-back runs emits `rule.suggested` in the transaction that opens a suggestion.
const learningDepsOf = (deps: CaptureDeps): LearningDeps => ({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, ...(deps.learningAudit === undefined ? {} : { audit: deps.learningAudit }) });

// ---- capture

const COMMENTS_MAX = 25;

interface Checked { standing: LearningStanding; checks: StandingCheck[] }

/** A person's standing and the conditions that hold the write to it (standing.ts), read once per person per call. */
async function standingOf(deps: CaptureDeps, cache: Map<string, Checked>, orgId: OrgId, developerId: string, project: string): Promise<Checked> {
  const known = cache.get(developerId);
  if (known !== undefined) return known;
  const read = await readStandingChecked(deps, orgId, developerId, project);
  cache.set(developerId, read);
  return read;
}

/** Writes one correction, holding the write to the author's standing and to the project as they were read: a change in between stores nothing (`stale`). Returns the new correction's id. */
async function write(deps: CaptureDeps, scope: LearningScope, projectChecks: StandingCheck[], input: CaptureInput, who: Checked): Promise<string | undefined> {
  const result = await captureCorrection(learningDepsOf(deps), scope, input, { conditions: [...who.checks, ...projectChecks] });
  if (!result.ok) logRefusal(deps, input, result.reason);
  return result.ok && result.created ? result.correction.id : undefined;
}

/**
 * Captures a send-back: the note, then each included comment. Throws when the standing or the store cannot be read (callers log and carry on, see `captureSendBackQuietly`). A repeat of
 * the same decision creates nothing.
 */
export async function captureSendBack(deps: CaptureDeps, input: SendBackInput): Promise<SendBackOutcome> {
  const { caller, taskId, project, requestId } = input;
  const stage = input.stage ?? COMMENT_STAGE;
  const outcome: SendBackOutcome = { created: [] };
  const note = prepareCorrection(input.reason);
  const comments = input.included.slice(0, COMMENTS_MAX).flatMap((comment) => {
    if (comment.author.kind !== "person" || comment.deletedAt !== undefined) return [];
    const prepared = prepareCorrection(comment.text);
    return prepared.ok ? [{ comment, authorId: comment.author.developerId, text: prepared.text }] : [];
  });
  if (!note.ok && comments.length === 0) return outcome;

  const checkedScope = await learningScopeChecked(deps, caller.orgId, project);
  if (checkedScope === undefined) return outcome;
  const { scope, checks: projectChecks } = checkedScope;
  const salt = learningSalt(scope);
  const cache = new Map<string, Checked>();

  let mainId: string | undefined;
  if (note.ok) {
    const sourceKey = sendBackSourceKey(taskId, requestId);
    const decider = await standingOf(deps, cache, caller.orgId, caller.developerId, project);
    const created = await write(deps, scope, projectChecks, {
      id: correctionIdOf(sourceKey), stage, source: "send_back", sourceKey, sourceRef: { taskId, decisionRequestId: requestId }, taskId, text: note.text,
      signature: [...signatureOf(note.text, salt)], author: caller.developerId, standing: decider.standing, limit: "automatic",
    }, decider);
    if (created !== undefined) {
      mainId = created;
      outcome.created.push(created);
    }
  }

  for (const entry of comments) {
    try {
      const sourceKey = commentSourceKey(taskId, entry.comment.commentId);
      const author = await standingOf(deps, cache, caller.orgId, entry.authorId, project);
      const created = await write(deps, scope, projectChecks, {
        id: correctionIdOf(sourceKey), stage, source: "send_back", sourceKey, sourceRef: { taskId, commentId: entry.comment.commentId, decisionRequestId: requestId }, taskId, text: entry.text,
        signature: [...signatureOf(entry.text, salt)], author: entry.authorId, standing: author.standing, ...(mainId === undefined ? {} : { linkedTo: mainId }), limit: "automatic",
      }, author);
      if (created !== undefined) outcome.created.push(created);
    } catch (error) {
      // One comment that cannot be captured does not stop the others.
      logFailure(deps, taskId, "comment", error);
    }
  }

  if (outcome.created.length > 0) {
    try {
      await groupCorrections(learningDepsOf(deps), scope);
    } catch (error) {
      logFailure(deps, taskId, "grouping", error);
    }
  }
  return outcome;
}

function logFailure(deps: CaptureDeps, taskId: string, step: string, error: unknown): void {
  const entry = { event: "learning.send_back_capture_failed", taskId, step, errorName: error instanceof Error ? error.name : "unknown" };
  try {
    (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
  } catch {
    // Logging must not fail the send-back either.
  }
}

/** A correction the store refused (`stale` after a demotion, removal or archive in the gap, a cap, a full store) leaves a trace: ids and the fixed reason, never the text. */
function logRefusal(deps: CaptureDeps, input: CaptureInput, reason: string): void {
  const requestId = input.sourceRef.decisionRequestId;
  const entry = { event: "learning.send_back_capture_refused", taskId: input.taskId, ...(requestId === undefined ? {} : { requestId }), correctionId: input.id, reason };
  try {
    (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
  } catch {
    // Logging must not fail the send-back either.
  }
}

/** How long the hook waits for a capture. The send-back never waits longer: the decision and the index are already done by then. */
export const SEND_BACK_CAPTURE_BUDGET_MS = 1500;

/**
 * The hook's entry point: capture, and never fail or hold up the send-back. Call it after the decision has committed and the task index is synced. A failure is logged with fixed words
 * (no text, no ids but the task's). A capture that runs past `SEND_BACK_CAPTURE_BUDGET_MS` is left to finish on its own (its writes are idempotent per request) and logged as `timeout`.
 */
export async function captureSendBackQuietly(deps: CaptureDeps, input: SendBackInput): Promise<void> {
  // The lessons side is fed from this one entry point (LS-1): one send-back, one announcement, one capture. A failure here is the lessons side's own and changes nothing else.
  // It has the same time limit as the capture: a lessons write that hangs is left to finish on its own and the send-back goes on (a failure or a timeout here changes nothing else).
  if (input.alsoRecord !== undefined) {
    let alsoTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => input.alsoRecord!()).catch(() => undefined),
        new Promise<void>((resolve) => { alsoTimer = setTimeout(resolve, SEND_BACK_CAPTURE_BUDGET_MS); }),
      ]);
    } finally {
      if (alsoTimer !== undefined) clearTimeout(alsoTimer);
    }
  }
  // Once the budget runs out the abandoned capture's late result is ignored: its writes are atomic and conditional, and only the timeout line is logged.
  let abandoned = false;
  const log = (line: Record<string, unknown>): void => { if (!abandoned) (deps.log ?? ((entry) => console.log(JSON.stringify({ component: "broker", ...entry }))))(line); };
  const quiet: CaptureDeps = { ...deps, log };
  const work = captureSendBack(quiet, input).then(() => "done" as const, (error: unknown) => {
    logFailure(quiet, input.taskId, "capture", error);
    return "failed" as const;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), SEND_BACK_CAPTURE_BUDGET_MS); });
  try {
    if (await Promise.race([work, limit]) === "timeout") {
      logFailure(deps, input.taskId, "timeout", undefined);
      abandoned = true;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
