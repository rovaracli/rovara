import { DeveloperTaskViewSchema, mergeTaskMoney, parseTaskMoneyV1, type TaskMoneyV1 } from "@agentx/contracts/web";
import type { SessionIdentity } from "./session-safety.js";
// The Work page's read layer (Hybrid 1, the split inbox, DEC 223): contract v0 shapes (code-contract-v0.ts) turned into what the list, the step rail,
// the spec, the build activity and the proof table draw. Nothing here is invented: a field Code did not send is absent, and what the page says about a
// task is worked out from the workflow's stage and state, the pending decision card and the proof index, in fixed words.
import { useMemo } from "react";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProofItem, TaskView, WorkflowStage } from "@agentx/contracts/code-contract-v0";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
import { sessionWriteHost } from "./session-safety.js";
import type { ReadDecision } from "./decisions.js";

export type Tone = "wait" | "run" | "ok" | "bad" | "idle";
export type Group = "you" | "run" | "others" | "stopped" | "done" | "involved";
/** `closed`: the task was closed before it reached a pull request, and nothing says how far it got, so no step is marked. */
export type Step = "request" | "spec" | "build" | "proof" | "pull_request" | "merged" | "closed";
/** The stage of the task the pane shows (the five steps; a merged task shows its pull request, a closed one its request). */
export type Stage = "request" | "spec" | "build" | "proof" | "pull_request";
export const STEPS: ReadonlyArray<{ step: Exclude<Step, "merged">; label: string }> = [
 { step: "request", label: "Request" }, { step: "spec", label: "Spec" }, { step: "build", label: "Build" }, { step: "proof", label: "Proof" }, { step: "pull_request", label: "Pull request" },
];
export const GROUPS: ReadonlyArray<{ group: Group; label: string }> = [
 { group: "you", label: "Needs you" }, { group: "run", label: "Rovara is working" }, { group: "others", label: "Waiting on others" }, { group: "stopped", label: "Stopped earlier" }, { group: "done", label: "Finished this week" },
 { group: "involved", label: "Involved" },
];
const DAY_MS = 864e5;
/** A stopped task nobody has picked up for this long leaves "Needs you" for "Stopped earlier" (it no longer claims the person's attention); past the second limit it leaves the list (its address still opens it). */
export const STOPPED_TO_EARLIER_DAYS = 7, STOPPED_DROPPED_DAYS = 30;

// ---- Readers (runtime checks: an answer that is not the shape is "unreadable", never half drawn) ----
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const records = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter(isRecord) : []);

export interface ReadTask {
 /** A failed advisory plan check, kept beside the plan rather than used as the task headline. */
 advisoryPlanFailure?: string | undefined;
 /** L4-U5: the one evidence line when Rovara re-checked the project's setup for this task (Code's fixed words); absent when there was no drift. */
 setupRecheck?: string | undefined;
 money?: TaskMoneyV1 | undefined;
 startupReason?: "own-machine-starting" | "unknown" | undefined;
 /** Served pull request tracking says a required check is failing on an open pull request (Code's `mergeTracking`: `ci: "failing"` or named failing checks). Absent when nothing is served. */
 failedChecks?: true | undefined;
 taskId: string; title: string; project: string; status: TaskView["status"] | undefined;
 workflow: { stage?: string; state?: string; revision?: number; path?: string; outcome?: string; blockReason?: string; round?: number; /** Whether Code's workflow holds a plan document: from `workflow.artifacts` (the task view) or Cloud's `planWritten`. Absent when the answer says nothing (a list row, an older Code). */ planWritten?: boolean; /** A custom program or summary without definition/program evidence cannot confirm the built-in stage order. */ programmed?: true } | undefined;
 pullRequests: Array<{ repository?: string; number?: number; url?: string; state?: string }>;
 spentUsd: number | undefined; runLimitUsd: number | undefined; createdAt: string; updatedAt: string;
 /** Whether the task lives in a Slack thread (Code's `shared` on a list row, or a share with a thread on the task view): Code's sentences about "the thread" are said only for such a task (text/task-words.ts). */
 hasThread: boolean;
 /** Rovara Cloud's session for the task (`ses_...`) when the person started it in Cloud: the steer, stop and comment routes are the session's. */
 sessionId: string | undefined;
 /** The list could not read this task's own view (its stage, pull requests and cost): the row says nothing it cannot know, and never "Finished". */
 detailUnread?: true;
 /** Understand's current round on the list row (Code #1057, through Cloud): its questions, each with whether this round's answers cover it. Absent when Code gave none. */
 round?: ReadRound;
 /** How the workflow ended (Code #1057's `outcome` on the list row), one of OUTCOME_WORDS' keys. */
 outcome?: string;
 /** Ordered agent-run stages from the served task view, when that view includes the run reader. */
 run?: NonNullable<ReturnType<typeof DeveloperTaskViewSchema.parse>["run"]> | undefined;
}
export interface ReadRoundQuestion { id: string; text: string; options?: ReadonlyArray<{ id: string; label: string }>; recommended?: string; answered: boolean }
export interface ReadRound { round: number; questions: readonly ReadRoundQuestion[] }
/** The workflow's outcomes as a short status label (Code's WorkflowSnapshot `outcome`); any other word shows no label. */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = Object.freeze({ PASSED: "Passed", SKIPPED: "Skipped", CHANGES_REQUESTED: "Changes requested", REJECTED: "Rejected", MERGED: "Merged", CLOSED: "Closed", ANSWERED: "Answered" });
const QUESTION_ID = /^q[1-3]$/u, OPTION_ID = /^[a-d]$/u;
/** A round as Cloud passes it on; anything not in that shape is no round (the row then sends the person to the task's page). */
export function readRound(raw: unknown): ReadRound | undefined {
 if (!isRecord(raw) || !Array.isArray(raw["questions"])) return undefined;
 const round = num(raw["round"]), sent = raw["questions"] as unknown[];
 if (round === undefined || !Number.isInteger(round) || round < 1 || sent.length < 1 || sent.length > 3) return undefined;
 const questions: ReadRoundQuestion[] = [];
 for (const question of sent) {
  if (!isRecord(question)) return undefined;
  const id = str(question["id"]), text = str(question["text"]), answered = bool(question["answered"]), recommended = question["recommended"];
  if (id === undefined || !QUESTION_ID.test(id) || text === undefined || text.length === 0 || text.length > 300 || answered === undefined) return undefined;
  let options: Array<{ id: string; label: string }> | undefined;
  if (question["options"] !== undefined) {
   if (!Array.isArray(question["options"]) || question["options"].length < 2 || question["options"].length > 4) return undefined;
   options = [];
   for (const option of question["options"] as unknown[]) { const optionId = isRecord(option) ? str(option["id"]) : undefined, label = isRecord(option) ? str(option["label"]) : undefined;if (optionId === undefined || !OPTION_ID.test(optionId) || label === undefined || label.length === 0 || label.length > 80) return undefined;options.push({ id: optionId, label }); }
  }
  if (recommended !== undefined && (typeof recommended !== "string" || !(options ?? []).some(option => option.id === recommended))) return undefined;
  questions.push({ id, text, ...(options === undefined ? {} : { options }), ...(typeof recommended === "string" ? { recommended } : {}), answered });
 }
 return new Set(questions.map(question => question.id)).size === questions.length ? { round, questions } : undefined;
}
/** Statuses of a task that has ended: nothing on it waits for answers, whatever its row still carries. */
const ENDED: ReadonlySet<string> = new Set(["CLOSED", "CANCELLED", "FAILED", "INTERRUPTED"]);
/**
 * The round a list row can answer inline: Understand waits (stage UNDERSTAND, state WAITING) on a task that has not ended, a question is still unanswered, and the row names the
 * workflow revision it read (the answers route checks it and the round). Undefined otherwise.
 */
export function openRoundOf(task: Pick<ReadTask, "round" | "workflow" | "status">): { round: number; revision: number; questions: readonly ReadRoundQuestion[] } | undefined {
 const round = task.round, revision = task.workflow?.revision;
 if (round === undefined || revision === undefined || task.workflow?.stage !== "UNDERSTAND" || task.workflow.state !== "WAITING" || (task.status !== undefined && ENDED.has(task.status))) return undefined;
 if (!round.questions.some(question => !question.answered)) return undefined;
 return { round: round.round, revision, questions: round.questions };
}
/** Understand waits on the person but the row carries no round to answer (an older Code, or one that would not show it): the task's own page asks them. */
export const asksOnItsPage = (task: Pick<ReadTask, "round" | "workflow" | "status">): boolean => task.round === undefined && task.workflow?.stage === "UNDERSTAND" && task.workflow.state === "WAITING" && !(task.status !== undefined && ENDED.has(task.status));
// Read existing Code operation fields without adding a task contract or trusting unknown shapes.
const operationsReader = z.array(z.object({ kind: z.string(), status: z.string(), workflowMode: z.string().optional() }));
function advisoryPlanFailure(raw: Record<string, unknown>, state: unknown): string | undefined {
 const operations = operationsReader.safeParse(raw["operations"]);
 const failures = operations.success ? operations.data.filter(operation => operation.status === "FAILED" || operation.status === "INTERRUPTED") : [];
 if (!["FAILED", "RUNNING", "SUCCEEDED"].includes(str(raw["status"]) ?? "") || !["READY", "RUNNING", "WAITING", "BLOCKED"].includes(str(state) ?? "") || failures.length === 0 || !failures.every(operation => operation.kind === "task" && operation.workflowMode === "PLAN_CRITIQUE")) return undefined;
 const failure = isRecord(raw["failure"]) ? raw["failure"] : undefined;
 return str(failure?.["message"]) ?? "No reason was provided.";
}
/** One tracked pull request whose served checks are failing: still open, and CI reads "failing" or names failing checks. */
export function trackedCheckFailing(tracked: Record<string, unknown>): boolean {
 return tracked["state"] === "open" && (tracked["ci"] === "failing" || (Array.isArray(tracked["failingChecks"]) && tracked["failingChecks"].length > 0));
}
/** Whether the workflow holds a plan document: Cloud's `planWritten`, else the served `artifacts` list (a plan artifact exists or not). Undefined when neither is served. */
function planWrittenOf(workflow: Record<string, unknown>): boolean | undefined {
 const served = bool(workflow["planWritten"]);
 if (served !== undefined) return served;
 return Array.isArray(workflow["artifacts"]) ? records(workflow["artifacts"]).some(artifact => artifact["type"] === "plan") : undefined;
}
export function readTask(raw: unknown): ReadTask | undefined {
 if (!isRecord(raw)) return undefined;
 const taskId = str(raw["taskId"]), title = str(raw["title"]), project = str(raw["project"]), updatedAt = str(raw["updatedAt"]);
 if (taskId === undefined || title === undefined || project === undefined || updatedAt === undefined || Number.isNaN(Date.parse(updatedAt))) return undefined;
 const workflow = isRecord(raw["workflow"]) ? raw["workflow"] : undefined;
 const spent = isRecord(raw["spent"]) ? num(raw["spent"]["usd"]) : undefined, limit = isRecord(raw["runLimit"]) ? num(raw["runLimit"]["limitUsd"]) : undefined;
 const runResult = DeveloperTaskViewSchema.shape.run.safeParse(raw["run"]), run = runResult.success ? runResult.data : undefined;
 return {
  ...(raw["detail"] === "unread" ? { detailUnread: true as const } : {}),
  ...opt("setupRecheck", ((line) => (line !== undefined && line.length > 0 && line.length <= 600 && !/[\p{Cc}\p{Cf}]/u.test(line) ? line : undefined))(str(raw["setupRecheck"]))),
  hasThread: bool(raw["shared"]) === true || (isRecord(raw["share"]) && (str(raw["share"]["threadUrl"]) !== undefined || str(raw["share"]["threadTs"]) !== undefined)),
  money: ((money) => money?.taskId === taskId ? money : undefined)(parseTaskMoneyV1(raw["money"])),
  taskId, sessionId: str(raw["sessionId"]), title, project, status: str(raw["status"]) as ReadTask["status"] | undefined,
  ...opt("advisoryPlanFailure", advisoryPlanFailure(raw, workflow?.["state"])),
  startupReason: DeveloperTaskViewSchema.shape.startupReason.safeParse(raw["startupReason"]).data,
  ...(raw["failedChecks"] === true || records(raw["mergeTracking"]).some(trackedCheckFailing) ? { failedChecks: true as const } : {}),
  ...(run === undefined ? {} : { run }),
  workflow: workflow === undefined ? undefined : { ...opt("stage", str(workflow["stage"])), ...opt("state", str(workflow["state"])), ...opt("revision", num(workflow["revision"])), ...opt("path", str(workflow["path"])), ...opt("outcome", str(workflow["outcome"])), ...opt("blockReason", str(workflow["blockReason"])), ...opt("round", num(workflow["round"])), ...opt("planWritten", planWrittenOf(workflow)), ...(workflow["program"] !== undefined || workflow["programmed"] === true ? { programmed: true as const } : {}) },
  pullRequests: records(raw["pullRequests"]).map(pull => ({ ...opt("repository", str(pull["repository"])), ...opt("number", num(pull["number"])), ...opt("url", str(pull["url"])), ...opt("state", str(pull["state"])) })),
  spentUsd: spent, runLimitUsd: limit, createdAt: str(raw["createdAt"]) ?? updatedAt, updatedAt,
  ...opt("round", readRound(raw["round"])),
  ...opt("outcome", ((outcome) => (outcome !== undefined && OUTCOME_WORDS[outcome] !== undefined ? outcome : undefined))(str(raw["outcome"]))),
 };
}
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } { return value === undefined ? {} : { [key]: value } as { [P in K]?: V }; }

export function readTaskList(body: unknown): ReadTask[] {
 if (!isRecord(body) || !Array.isArray(body["tasks"])) throw new Error("not a task list");
 return body["tasks"].flatMap(raw => { const task = readTask(raw); return task === undefined ? [] : [task]; });
}

export interface ReadCriterion { id: string; when: string; then: string; taskIds: string[] }
export interface ReadRequirement { id: string; title: string; criteria: ReadCriterion[] }
export interface ReadSpecTask { id: string; title: string; status: "todo" | "running" | "done" | "blocked"; criterionIds: string[] }
export interface ReadQuestion { questionId: string; text: string; options: Array<{ optionId: string; label: string }>; criterionId: string | undefined; defaultOptionId: string | undefined }
export interface ReadPlan {
 version: number | undefined; approved: boolean | undefined; headline: string | undefined; checks: string[]; estimate: string | undefined; runLimitUsd: number | undefined;
 requirements: ReadRequirement[]; tasks: ReadSpecTask[]; questions: ReadQuestion[];
}
const TASK_STATES = ["todo", "running", "done", "blocked"] as const;
export function readPlan(body: unknown): ReadPlan {
 if (!isRecord(body)) throw new Error("not a plan");
 const summary = isRecord(body["summary"]) ? body["summary"] : {};
 return {
  version: num(body["version"]), approved: bool(body["approved"]), headline: str(summary["headline"]), checks: strings(summary["checks"]), estimate: str(body["estimate"]), runLimitUsd: num(body["runLimitUsd"]),
  requirements: records(body["requirements"]).flatMap(requirement => {
   const id = str(requirement["id"]), title = str(requirement["title"]);
   if (id === undefined || title === undefined) return [];
   return [{ id, title, criteria: records(requirement["criteria"]).flatMap(criterion => { const cid = str(criterion["id"]), when = str(criterion["when"]), then = str(criterion["then"]);return cid === undefined || when === undefined || then === undefined ? [] : [{ id: cid, when, then, taskIds: strings(criterion["taskIds"]) }]; }) }];
  }),
  tasks: records(body["tasks"]).flatMap(task => { const id = str(task["id"]), title = str(task["title"]), status = TASK_STATES.find(state => state === task["status"]);return id === undefined || title === undefined || status === undefined ? [] : [{ id, title, status, criterionIds: strings(task["criterionIds"]) }]; }),
  questions: records(body["questions"]).flatMap(question => {
   const questionId = str(question["questionId"]), text = str(question["text"]);
   if (questionId === undefined || text === undefined) return [];
   return [{ questionId, text, options: records(question["options"]).flatMap(option => { const optionId = str(option["optionId"]), label = str(option["label"]);return optionId === undefined || label === undefined ? [] : [{ optionId, label }]; }), criterionId: str(question["criterionId"]), defaultOptionId: str(question["defaultOptionId"]) }];
  }),
 };
}

/** One item of the proof index. `id` is the item's key: Code's item id, or its stored output's digest when Code sends no id (made unique with `#n` when repeated). `sha256` is there only when Code kept the check's output. */
export interface ReadProofItem { id: string; sha256: string | undefined; title: string; kind: string; verdict: ProofItem["verdict"]; criterionIds: string[]; commit: string | undefined; stale: boolean; passed: number | undefined; total: number | undefined; bar: number | undefined }
export function readProof(body: unknown): ReadProofItem[] {
 if (!isRecord(body) || !Array.isArray(body["items"])) throw new Error("not a proof index");
 const seen = new Map<string, number>();
 return records(body["items"]).flatMap(item => {
  const sha256 = str(item["sha256"]), id = str(item["id"]) ?? sha256, title = str(item["title"]), kind = str(item["kind"]);
  const verdict = (["pass", "fail", "unknown"] as const).find(value => value === item["verdict"]);
  if (id === undefined || title === undefined || kind === undefined || verdict === undefined) return [];
  // Every item is kept (an older Code may send two checks with the same output digest); a repeated key gets a suffix so each still has its own.
  const repeat = seen.get(id) ?? 0;
  seen.set(id, repeat + 1);
  return [{ id: repeat === 0 ? id : `${id}#${String(repeat)}`, sha256, title, kind, verdict, criterionIds: strings(item["criterionIds"]), commit: str(item["commit"]), stale: item["stale"] === true, passed: num(item["passed"]), total: num(item["total"]), bar: num(item["bar"]) }];
 });
}

/** The most failing tests the Proof tab lists (Code's own limit); the rest are counted. */
export const PROOF_FAILURES_SHOWN = 10;
/** One failing test as Code words it: its check, the test, and the change that likely broke it or "unknown (...)". Plain text only. */
export interface ReadProofFailure { check: string; test: string; cause: string }
/** The proof index: its items, and (TE-A6) the failing tests with their likely causes, at most ten, with how many more there are. A Code without the failures sends none. */
export interface ReadProofIndex { items: ReadProofItem[]; failures: ReadProofFailure[]; failuresNotListed: number }
export function readProofIndex(body: unknown): ReadProofIndex {
 const items = readProof(body), raw = isRecord(body) && Array.isArray(body["failures"]) ? records(body["failures"]) : [];
 const failures = raw.flatMap(row => { const check = str(row["check"]), test = str(row["test"]), cause = str(row["cause"]);return check === undefined || test === undefined || cause === undefined ? [] : [{ check: check.slice(0, 200), test: test.slice(0, 300), cause: cause.slice(0, 500) }]; });
 const sent = isRecord(body) ? num(body["failuresNotListed"]) : undefined;
 const shown = failures.slice(0, PROOF_FAILURES_SHOWN);
 // What Code did not list, plus anything past the limit here: the rest is always counted, never dropped silently.
 const notListed = (sent !== undefined && Number.isInteger(sent) && sent > 0 ? Math.min(sent, 100_000) : 0) + (failures.length - shown.length);
 return { items, failures: shown, failuresNotListed: notListed };
}

export interface ReadEvent { seq: number; at: string; kind: string; text: string | undefined; taskItemId: string | undefined; attempt: number | undefined }
export function readEvents(body: unknown): ReadEvent[] {
 if (!isRecord(body) || !Array.isArray(body["events"])) throw new Error("not an event list");
 return records(body["events"]).flatMap((event, index) => { const at = str(event["at"]), kind = str(event["kind"]);return at === undefined || kind === undefined ? [] : [{ seq: num(event["seq"]) ?? index, at, kind, text: str(event["text"]), taskItemId: str(event["taskItemId"]), attempt: num(event["attempt"]) }]; });
}

export interface ReadComment { commentId: string; author: string; text: string; at: string; resolved: boolean; anchor: string | undefined; replyTo: string | undefined }
export function readComments(body: unknown): ReadComment[] {
 if (!isRecord(body) || !Array.isArray(body["comments"])) throw new Error("not a comment list");
 return records(body["comments"]).flatMap(comment => {
  const commentId = str(comment["commentId"]), text = str(comment["text"]), at = str(comment["at"]), author = isRecord(comment["author"]) ? str(comment["author"]["name"]) : undefined;
  return commentId === undefined || text === undefined || at === undefined ? [] : [{ commentId, author: author ?? "Someone", text, at, resolved: comment["resolved"] === true, anchor: str(comment["anchor"]), replyTo: str(comment["replyTo"]) }];
 });
}

// ---- What a task is (the row) ----
const STAGE_STEP: Record<string, Step> = {
 UNDERSTAND: "request", PLAN: "spec", PLAN_CRITIQUE: "spec", PLAN_REVIEW: "spec", IMPLEMENT: "build", VERIFY: "proof", REVIEW: "proof", PULL_REQUEST: "pull_request", WAIT_FOR_MERGE: "pull_request", MERGED: "merged",
};
/**
 * The fixed order of the built-in workflow ("agentx-task-to-pr"): Code's WorkflowStageSchema (packages/contracts/src/task-workflow.ts:480-492), the order its engine moves a task through. CLOSED is not in it:
 * a closed task keeps no record of how far it got. A workflow that carries its own program (a custom recipe) does not follow this order.
 */
export const STAGE_ORDER = ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "PLAN_REVIEW", "IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED"] as const satisfies readonly WorkflowStage[];
/**
 * Whether the served stage and the fixed order prove a section finished: the task has started, its workflow is the built-in one, its served stage is one the order knows, and every stage of the section lies strictly before
 * that stage. Anything else (never started, unknown or closed stage, a custom program that may skip or reorder stages) proves nothing, so the section reads "Progress not confirmed".
 */
function sectionFinished(task: ReadTask, step: Step): boolean {
 const stage = STAGE_ORDER.findIndex(name => name === task.workflow?.stage);
 if (stage < 0 || task.status === "STARTING" || task.workflow?.programmed === true) return false;
 const own = Object.entries(STAGE_STEP).filter(([, owner]) => owner === step).map(([name]) => STAGE_ORDER.findIndex(candidate => candidate === name));
 return own.length > 0 && own.every(index => index >= 0 && index < stage);
}
export type SectionState = "done" | "attention" | "current" | "blocked" | "waiting" | "todo";
/**
 * The sections whose served results include a failure: a failing check on an open pull request (the served tracking) or a failed, current proof item. Only served data counts; nothing is guessed.
 * A section in this set is not finished even when the stage is past it: it needs attention.
 */
export function failedSections(task: ReadTask | undefined, proof?: ReadonlyArray<{ verdict: string; stale?: boolean | undefined }>): ReadonlySet<Step> {
 return new Set<Step>(task?.failedChecks === true || (proof ?? []).some(item => item.verdict === "fail" && item.stale !== true) ? ["proof"] : []);
}
/**
 * Only the served current workflow marks the current section. A section is finished when the served stage is past it in the fixed order and no served result in it failed; with a served failure it
 * "needs attention" instead. Section position alone proves nothing.
 */
export function sectionState(task: ReadTask | undefined, step: Step, failed?: ReadonlySet<Step>): SectionState {
 if (task === undefined) return "todo";
 if (STAGE_STEP[task.workflow?.stage ?? ""] !== step) return !sectionFinished(task, step) ? "todo" : failed?.has(step) === true ? "attention" : "done";
 const state = task.workflow?.state;
 if (state === "BLOCKED") return "blocked";
 // A task whose last run was only an advisory plan-check failure follows its open workflow (the header already says Running), so it has a current step like any running task.
 if (task.status !== "RUNNING" && task.status !== "SUCCEEDED" && !(task.status === "FAILED" && task.advisoryPlanFailure !== undefined)) return "todo";
 return state === "RUNNING" ? "current" : state === "WAITING" ? "waiting" : "todo";
}
/** The sections the served stage proves finished and clean (in the order of STEPS). */
export function finishedSections(task: ReadTask | undefined, failed?: ReadonlySet<Step>): ReadonlyArray<(typeof STEPS)[number]> { return STEPS.filter(entry => sectionState(task, entry.step, failed) === "done"); }
const STAGE_WORDS: Record<string, string> = {
 UNDERSTAND: "Reading the request", PLAN: "Writing the spec", PLAN_CRITIQUE: "Checking the spec", PLAN_REVIEW: "Spec ready for review", IMPLEMENT: "Building", VERIFY: "Checking the change", REVIEW: "Reviewing the change", PULL_REQUEST: "Opening the pull request", WAIT_FOR_MERGE: "Pull request open",
};
/** The card kinds that approve a spec (the plan, its requirements or its design). */
const SPEC_KINDS: ReadonlySet<string> = new Set(["approve_plan", "approve_requirements", "approve_design"]);
export interface WorkRow {
 id: string; title: string; project: string; path: "Quick spec" | "Full spec" | undefined; step: Step; tone: Tone; group: Group;
 /** What the person is asked ("Approve spec", "Merge"); only on "Needs you" rows. */
 need: string | undefined; line: string; updatedAt: string; age: string; waitingSince: string; stale: boolean; minutes: number | undefined;
 decision: ReadDecision | undefined; task: ReadTask;
}
export function ageLabel(iso: string, now: Date): string {
 const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 6e4));
 return minutes < 60 ? String(minutes) + "m" : minutes < 1440 ? String(Math.round(minutes / 60)) + "h" : String(Math.round(minutes / 1440)) + "d";
}
export function stepOf(task: ReadTask): Step {
 const stage = task.workflow?.stage;
 if (stage !== undefined && STAGE_STEP[stage] !== undefined) return STAGE_STEP[stage];
 if (task.pullRequests.some(pull => pull.state === "merged")) return "merged";
 if (task.pullRequests.length > 0) return "pull_request";
 // A closed task keeps no record of the step it stopped at (its stage reads CLOSED), so no step is marked.
 if (stage === "CLOSED" || task.status === "CLOSED") return "closed";
 return task.status === "SUCCEEDED" ? "proof" : "build";
}
const isOpen = (task: ReadTask): boolean => task.workflow !== undefined && task.workflow.state !== "COMPLETE" && (task.status === "RUNNING" || task.status === "SUCCEEDED" || task.status === undefined);
export function needWords(decision: ReadDecision, path: WorkRow["path"]): string {
 const kind = decision.card.kind;
 if (SPEC_KINDS.has(kind)) return path === "Quick spec" ? "Approve quick spec" : "Approve spec";
 return ({ merge: "Merge", answer_question: "Question", choose_checks: "Check failed twice", approve_spend: "Spend request" } as Record<string, string>)[kind] ?? "Decide";
}
export function workRow(task: ReadTask, decision: ReadDecision | undefined, now: Date): WorkRow {
 const path: WorkRow["path"] = task.workflow?.path === "QUICK" ? "Quick spec" : task.workflow?.path === "STANDARD" ? "Full spec" : undefined, step = stepOf(task), stage = task.workflow?.stage, state = task.workflow?.state;
 const base = { id: task.taskId, title: task.title, project: task.project, path, step, updatedAt: task.updatedAt, age: ageLabel(task.updatedAt, now), task, decision, minutes: decision?.card.next.minutes };
 const waitingSince = decision?.card.createdAt ?? task.updatedAt, stale = now.getTime() - Date.parse(waitingSince) >= DAY_MS;
 if (decision !== undefined) {
  const kind = decision.card.kind;
  return { ...base, group: "you", tone: kind === "merge" ? "ok" : kind === "choose_checks" || kind === "approve_spend" ? "bad" : "wait", need: needWords(decision, path), line: decision.card.next.text, waitingSince, stale };
 }
 const none = { need: undefined, waitingSince, stale: false };
 // Understand asked the person questions (Code #1057's round on the row, one still unanswered): the row asks for them, and the list answers them inline.
 if (openRoundOf(task) !== undefined) return { ...base, group: "you", tone: "wait", need: "Answer questions", line: STAGE_WORDS["UNDERSTAND"]!, waitingSince, stale: now.getTime() - Date.parse(waitingSince) >= DAY_MS };
 if (step === "merged" || stage === "MERGED" || task.workflow?.outcome === "MERGED" || task.outcome === "MERGED") return { ...base, ...none, group: "done", tone: "ok", line: "Merged" };
 if (task.status === "CLOSED" || task.status === "CANCELLED") return { ...base, ...none, group: "done", tone: "idle", line: task.status === "CLOSED" ? "Closed" : "Stopped" };
 if ((task.status === "FAILED" && task.advisoryPlanFailure === undefined) || task.status === "INTERRUPTED" || state === "BLOCKED") {
  const waited = now.getTime() - Date.parse(waitingSince);
  // Stopped for a week with nobody acting on it: it no longer asks for the person's attention. "Stopped earlier" says how long, and Close or Continue are on its page.
  if (waited >= STOPPED_TO_EARLIER_DAYS * DAY_MS) return { ...base, ...none, group: "stopped", tone: "bad", line: "Stopped " + ageLabel(waitingSince, now) + " ago" };
  return { ...base, group: "you", tone: "bad", need: "Stopped", line: "Rovara stopped before it finished", waitingSince, stale: waited >= DAY_MS };
 }
 if (state === "WAITING" && stage === "PLAN_REVIEW") return { ...base, group: "you", tone: "wait", need: "Review spec", line: STAGE_WORDS["PLAN_REVIEW"]!, waitingSince, stale: now.getTime() - Date.parse(waitingSince) >= DAY_MS };
 if (state === "WAITING") return { ...base, ...none, group: "others", tone: "idle", line: stage === undefined ? "Waiting" : STAGE_WORDS[stage] ?? "Waiting" };
 // A task whose own view the list could not read may be waiting between steps: it is not called finished.
 if (task.workflow === undefined && task.status === "SUCCEEDED" && task.detailUnread === true) return { ...base, ...none, group: "run", tone: "idle", line: "Open it to see its step" };
 if (state === "COMPLETE" || (task.workflow === undefined && task.status === "SUCCEEDED")) return { ...base, ...none, group: "done", tone: "ok", line: "Finished" };
 if (task.status === "STARTING") return { ...base, ...none, group: "run", tone: "idle", line: task.startupReason === "own-machine-starting" ? "Starting a machine for this task (about 3 minutes)" : "Starting" };
 return { ...base, ...none, group: "run", tone: isOpen(task) || task.status === "RUNNING" || task.advisoryPlanFailure !== undefined ? "run" : "idle", line: stage === undefined ? "Working" : STAGE_WORDS[stage] ?? "Working" };
}
/** Rows in the order the list shows them: "Needs you" puts anything waiting a day or more first, then the quickest decision (its estimate in minutes; none last), then the newest. */
export function sortRows(rows: readonly WorkRow[]): WorkRow[] {
 const newest = (a: WorkRow, b: WorkRow) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
 return [...rows].sort((a, b) => {
  if (a.group !== b.group) return GROUPS.findIndex(entry => entry.group === a.group) - GROUPS.findIndex(entry => entry.group === b.group);
  if (a.group !== "you") return newest(a, b);
  if (a.stale !== b.stale) return a.stale ? -1 : 1;
  const am = a.minutes ?? Number.POSITIVE_INFINITY, bm = b.minutes ?? Number.POSITIVE_INFINITY;
  return am !== bm ? am - bm : newest(a, b);
 });
}
/** The list: every task as a row, ordered; finished work only from the last week, stopped work only from the last month. */
export function workRows(tasks: readonly ReadTask[], decisions: readonly ReadDecision[], now: Date): WorkRow[] {
 const pending = decisions.filter(decision => decision.card.status === "pending");
 return sortRows(tasks.map(task => workRow(task, pending.find(decision => decision.card.taskId === task.taskId), now)).filter(row => row.group === "stopped" ? now.getTime() - Date.parse(row.waitingSince) < STOPPED_DROPPED_DAYS * DAY_MS : row.group !== "done" || now.getTime() - Date.parse(row.updatedAt) < 7 * DAY_MS));
}
/**
 * The tasks the person was added to, as rows of their own "Involved" group (web task channel K4). They are someone else's tasks, so no decision card is paired with them and none of them
 * asks the person for anything: a stopped or waiting task reads as what it is, in its line. Finished work only from the last week and anything else only from the last month; newest first.
 */
export function involvedRows(tasks: readonly ReadTask[], now: Date): WorkRow[] {
 return tasks.flatMap(task => {
  const row = workRow(task, undefined, now), idle = now.getTime() - Date.parse(row.updatedAt);
  // A row whose step the list could not read (it may be finished) leaves after a week, like finished work.
  if (idle >= STOPPED_DROPPED_DAYS * DAY_MS || ((row.group === "done" || task.detailUnread === true) && idle >= 7 * DAY_MS)) return [];
  return [{ ...row, group: "involved" as const, need: undefined, stale: false, line: row.group === "you" && row.tone === "bad" ? "Stopped" : row.line }];
 }).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
/** The row to select after a decision: the next one that needs you after this one, else the first, else nothing. */
export function nextNeedsYou(rows: readonly WorkRow[], decidedId: string): string | undefined {
 const need = rows.filter(row => row.group === "you"), at = need.findIndex(row => row.id === decidedId);
 const after = need.slice(at + 1).find(row => row.id !== decidedId) ?? need.find(row => row.id !== decidedId);
 return after?.id;
}
/** The stage a step shows: each step its own, a merged task its pull request, a closed one its request. */
export function stageOf(step: Step): Stage { return step === "merged" ? "pull_request" : step === "closed" ? "request" : step; }

// ---- What a task's proof says (one row per acceptance criterion) ----
export type ProofState = "not_run" | "running" | "partly" | "pass" | "fail" | "stale";
export interface ProofRowModel { criterion: ReadCriterion; items: ReadProofItem[]; state: ProofState }
/** A criterion is proven when every check that speaks to it passed on the current code; "running" when a plan task that builds it is running and nothing has been checked yet. */
export function proofRows(requirements: readonly ReadRequirement[], items: readonly ReadProofItem[], tasks: readonly ReadSpecTask[]): ProofRowModel[] {
 return requirements.flatMap(requirement => requirement.criteria).map(criterion => {
  const mine = items.filter(item => item.criterionIds.includes(criterion.id));
  let state: ProofState;
  if (mine.length === 0) state = tasks.some(task => task.status === "running" && (task.criterionIds.includes(criterion.id) || criterion.taskIds.includes(task.id))) ? "running" : "not_run";
  else if (mine.some(item => item.verdict === "fail")) state = "fail";
  else if (mine.some(item => item.stale)) state = "stale";
  else if (mine.every(item => item.verdict === "pass")) state = "pass";
  else state = "partly";
  return { criterion, items: mine, state };
 });
}
export function provenCount(rows: readonly ProofRowModel[]): [number, number] { return [rows.filter(row => row.state === "pass").length, rows.length]; }

// ---- Hooks ----
export function useWorkApi() {
 const host = useAppHost();
 return useMemo(() => {
  const api = createApiClient(host);
  const finalReplyApi = createApiClient(sessionWriteHost(host));
  const taskPath = (id: string) => "/v1/app/tasks/" + encodeURIComponent(id);
  return {
   tasks: () => api.get("/v1/app/sessions", { parse: readTaskList }),
   /** The tasks the person was added to (Cloud asks Code; an older Code that does not serve it answers an empty list). */
   involved: async (): Promise<ReadTask[]> => {
    try { return await api.get("/v1/app/involved", { parse: readTaskList }); }
    catch (failure) { if (failure instanceof ApiError && (failure.status === 404 || failure.status === 501)) return [];throw failure; }
   },
   plan: (id: string) => api.get(taskPath(id) + "/documents/plan", { parse: readPlan }),
   proof: (id: string) => api.get(taskPath(id) + "/evidence", { parse: readProofIndex }),
   events: (id: string) => api.get(taskPath(id) + "/events", { parse: readEvents }),
   comments: (id: string) => api.get(taskPath(id) + "/comments", { parse: readComments }),
   /** What is left of the company's budget this month (Cloud's own read, contract v0 `OrgSpendSummaryAddition`); undefined when Cloud does not serve it or the company has no budget. */
   remainingUsd: async (): Promise<number | undefined> => {
    try { return await api.get("/v1/app/org/spend", { parse: (body: unknown) => (isRecord(body) ? num(body["remainingUsd"]) : undefined) }); }
    catch (failure) { if (failure instanceof ApiError && (failure.status === 404 || failure.status === 501)) return undefined;throw failure; }
   },
   /**
    * Pins a comment to a passage of the plan (contract v0 `tasks.comments.create`: `anchor` is a criterion id, `replyTo` the comment it answers). Cloud does not forward
    * it yet, so it answers 501 and the passage says "not connected yet" in Cloud's words; the draft stays.
    */
   comment: (taskId: string, text: string, anchor: string, replyTo: string | undefined) => api.send("POST", taskPath(taskId) + "/comments", { requestId: crypto.randomUUID(), document: "plan", text, anchor, ...(replyTo === undefined ? {} : { replyTo }) }, { parse: (body: unknown) => body }, { retry: "never" }),
   /** "Continue in my tool" (contract v0 `tasks.continue`, `continue/publish-branch`): Code puts the task's branch where the person's own tool can take it. Not served yet: Cloud answers 501. */
   continueInTool: (taskId: string, requestId: string = crypto.randomUUID()) => finalReplyApi.send("POST", taskPath(taskId) + "/continue/publish-branch", { requestId }, { parse: (body: unknown) => body }, { retry: "never" }),
   /**
    * Answers the understanding questions on Cloud's session route (`POST /v1/app/sessions/{sessionId}/answers`, which Cloud sends to Code for the session's task). It needs
    * Cloud's session id (`ses_...`) and the round Code says is asked; without either, nothing is sent and the card says to answer on the task's session page.
    */
   /**
    * Answers Understand's questions from the list or Home (`POST /v1/app/tasks/{taskId}/answers`; Cloud sends them to Code's own answers route as the person, and Code decides who may).
    * The body is the session page's answer form's: the request id, the round and the workflow revision the row read, and the answers.
    */
   answerRound: (taskId: string, body: { requestId: string; round: number; revision: number; answers: Array<{ questionId: string; optionId?: string; text?: string }> }) => api.send("POST", taskPath(taskId) + "/answers", body, { parse: (raw: unknown) => raw }),
   answer: (task: Pick<ReadTask, "sessionId" | "workflow">, questionId: string, optionId: string) => task.sessionId === undefined || task.workflow?.round === undefined
    ? Promise.reject(new ApiError(409, "ANSWER_ON_SESSION_PAGE", "Answer this question on the task's session page."))
    : api.send("POST", "/v1/app/sessions/" + encodeURIComponent(task.sessionId) + "/answers", { requestId: crypto.randomUUID(), round: task.workflow.round, ...(task.workflow.revision === undefined ? {} : { revision: task.workflow.revision }), answers: [{ questionId, optionId }] }, { parse: (body: unknown) => body }, { retry: "never" }),
  };
 }, [host]);
}
export function acceptWorkTasks(previous: readonly ReadTask[] | undefined, next: ReadTask[]): ReadTask[] {
 const old = new Map(previous?.map(task => [task.taskId, task]));
 return next.map(task => ({ ...task, money: mergeTaskMoney(old.get(task.taskId)?.money, task.money) }));
}
export function useWorkTasks(enabled = true, identity?: SessionIdentity) {
 const api = useWorkApi(), query = useQueryClient(), key = identity === undefined ? ["work", "tasks"] : ["work", "tasks", identity.companyId, identity.personId];
 return useQuery({ queryKey: key, retry: false, enabled, queryFn: async () => { const next = await api.tasks(); return acceptWorkTasks(query.getQueryData<ReadTask[]>(key), next); } });
}
/** The tasks the person is involved in. Its own read, so a failure here never takes the person's own list with it. */
export function useInvolvedTasks(enabled = true) { const api = useWorkApi();return useQuery({ queryKey: ["work", "involved"], retry: false, enabled, queryFn: api.involved }); }
export function useTaskPlan(id: string | undefined) { const api = useWorkApi();return useQuery({ queryKey: ["work", "plan", id], retry: false, enabled: id !== undefined, queryFn: () => api.plan(id!) }); }
export function useTaskProof(id: string | undefined) { const api = useWorkApi();return useQuery({ queryKey: ["work", "proof", id], retry: false, enabled: id !== undefined, queryFn: () => api.proof(id!) }); }
export function useTaskEvents(id: string | undefined) { const api = useWorkApi();return useQuery({ queryKey: ["work", "events", id], retry: false, enabled: id !== undefined, queryFn: () => api.events(id!) }); }
export function useTaskComments(id: string | undefined) { const api = useWorkApi();return useQuery({ queryKey: ["work", "comments", id], retry: false, enabled: id !== undefined, queryFn: () => api.comments(id!) }); }
export function useOrgSpend() { const api = useWorkApi();return useQuery({ queryKey: ["work", "org-spend"], retry: false, queryFn: api.remainingUsd }); }
