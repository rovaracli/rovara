// The Work page's read layer (Hybrid 1, the split inbox, DEC 223): contract v0 shapes (code-contract-v0.ts) turned into what the list, the step rail,
// the spec, the build activity and the proof table draw. Nothing here is invented: a field Code did not send is absent, and what the page says about a
// task is worked out from the workflow's stage and state, the pending decision card and the proof index, in fixed words.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ProofItem, TaskView } from "@agentx/contracts/code-contract-v0";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { ApiError } from "./errors.js";
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
 taskId: string; title: string; project: string; status: TaskView["status"] | undefined;
 workflow: { stage?: string; state?: string; revision?: number; path?: string; outcome?: string; blockReason?: string } | undefined;
 pullRequests: Array<{ repository?: string; number?: number; url?: string; state?: string }>;
 spentUsd: number | undefined; runLimitUsd: number | undefined; createdAt: string; updatedAt: string;
 /** Rovara Cloud's session for the task (`ses_...`) when the person started it in Cloud: the steer, stop and comment routes are the session's. */
 sessionId: string | undefined;
}
export function readTask(raw: unknown): ReadTask | undefined {
 if (!isRecord(raw)) return undefined;
 const taskId = str(raw["taskId"]), title = str(raw["title"]), project = str(raw["project"]), updatedAt = str(raw["updatedAt"]);
 if (taskId === undefined || title === undefined || project === undefined || updatedAt === undefined || Number.isNaN(Date.parse(updatedAt))) return undefined;
 const workflow = isRecord(raw["workflow"]) ? raw["workflow"] : undefined;
 const spent = isRecord(raw["spent"]) ? num(raw["spent"]["usd"]) : undefined, limit = isRecord(raw["runLimit"]) ? num(raw["runLimit"]["limitUsd"]) : undefined;
 return {
  taskId, sessionId: str(raw["sessionId"]), title, project, status: str(raw["status"]) as ReadTask["status"] | undefined,
  workflow: workflow === undefined ? undefined : { ...opt("stage", str(workflow["stage"])), ...opt("state", str(workflow["state"])), ...opt("revision", num(workflow["revision"])), ...opt("path", str(workflow["path"])), ...opt("outcome", str(workflow["outcome"])), ...opt("blockReason", str(workflow["blockReason"])) },
  pullRequests: records(raw["pullRequests"]).map(pull => ({ ...opt("repository", str(pull["repository"])), ...opt("number", num(pull["number"])), ...opt("url", str(pull["url"])), ...opt("state", str(pull["state"])) })),
  spentUsd: spent, runLimitUsd: limit, createdAt: str(raw["createdAt"]) ?? updatedAt, updatedAt,
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

export interface ReadProofItem { sha256: string; title: string; kind: string; verdict: ProofItem["verdict"]; criterionIds: string[]; commit: string | undefined; stale: boolean; passed: number | undefined; total: number | undefined; bar: number | undefined }
export function readProof(body: unknown): ReadProofItem[] {
 if (!isRecord(body) || !Array.isArray(body["items"])) throw new Error("not a proof index");
 return records(body["items"]).flatMap(item => {
  const sha256 = str(item["sha256"]), title = str(item["title"]), kind = str(item["kind"]);
  const verdict = (["pass", "fail", "unknown"] as const).find(value => value === item["verdict"]);
  return sha256 === undefined || title === undefined || kind === undefined || verdict === undefined ? [] : [{ sha256, title, kind, verdict, criterionIds: strings(item["criterionIds"]), commit: str(item["commit"]), stale: item["stale"] === true, passed: num(item["passed"]), total: num(item["total"]), bar: num(item["bar"]) }];
 });
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
 if (step === "merged" || stage === "MERGED" || task.workflow?.outcome === "MERGED") return { ...base, ...none, group: "done", tone: "ok", line: "Merged" };
 if (task.status === "CLOSED" || task.status === "CANCELLED") return { ...base, ...none, group: "done", tone: "idle", line: task.status === "CLOSED" ? "Closed" : "Stopped" };
 if (task.status === "FAILED" || task.status === "INTERRUPTED" || state === "BLOCKED") {
  const waited = now.getTime() - Date.parse(waitingSince);
  // Stopped for a week with nobody acting on it: it no longer asks for the person's attention. "Stopped earlier" says how long, and Close or Continue are on its page.
  if (waited >= STOPPED_TO_EARLIER_DAYS * DAY_MS) return { ...base, ...none, group: "stopped", tone: "bad", line: "Stopped " + ageLabel(waitingSince, now) + " ago" };
  return { ...base, group: "you", tone: "bad", need: "Stopped", line: "Rovara stopped before it finished", waitingSince, stale: waited >= DAY_MS };
 }
 if (state === "WAITING" && stage === "PLAN_REVIEW") return { ...base, group: "you", tone: "wait", need: "Review spec", line: STAGE_WORDS["PLAN_REVIEW"]!, waitingSince, stale: now.getTime() - Date.parse(waitingSince) >= DAY_MS };
 if (state === "WAITING") return { ...base, ...none, group: "others", tone: "idle", line: stage === undefined ? "Waiting" : STAGE_WORDS[stage] ?? "Waiting" };
 if (state === "COMPLETE" || (task.workflow === undefined && task.status === "SUCCEEDED")) return { ...base, ...none, group: "done", tone: "ok", line: "Finished" };
 if (task.status === "STARTING") return { ...base, ...none, group: "run", tone: "idle", line: "In the queue" };
 return { ...base, ...none, group: "run", tone: isOpen(task) || task.status === "RUNNING" ? "run" : "idle", line: stage === undefined ? "Working" : STAGE_WORDS[stage] ?? "Working" };
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
  if (idle >= STOPPED_DROPPED_DAYS * DAY_MS || (row.group === "done" && idle >= 7 * DAY_MS)) return [];
  return [{ ...row, group: "involved" as const, need: undefined, stale: false, line: row.group === "you" ? row.need ?? row.line : row.line }];
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
  const taskPath = (id: string) => "/v1/app/tasks/" + encodeURIComponent(id);
  return {
   tasks: () => api.get("/v1/app/sessions", { parse: readTaskList }),
   /** The tasks the person was added to (Cloud asks Code; an older Code that does not serve it answers an empty list). */
   involved: async (): Promise<ReadTask[]> => {
    try { return await api.get("/v1/app/involved", { parse: readTaskList }); }
    catch (failure) { if (failure instanceof ApiError && (failure.status === 404 || failure.status === 501)) return [];throw failure; }
   },
   plan: (id: string) => api.get(taskPath(id) + "/documents/plan", { parse: readPlan }),
   proof: (id: string) => api.get(taskPath(id) + "/evidence", { parse: readProof }),
   events: (id: string) => api.get(taskPath(id) + "/events", { parse: readEvents }),
   comments: (id: string) => api.get(taskPath(id) + "/comments", { parse: readComments }),
   /** What is left of the company's budget this month (Cloud's own read, contract v0 `OrgSpendSummaryAddition`); undefined when Cloud does not serve it or the company has no budget. */
   remainingUsd: async (): Promise<number | undefined> => {
    try { return await api.get("/v1/app/org/spend", { parse: (body: unknown) => (isRecord(body) ? num(body["remainingUsd"]) : undefined) }); }
    catch (failure) { if (failure instanceof ApiError && (failure.status === 404 || failure.status === 501)) return undefined;throw failure; }
   },
   /**
    * Answers the understanding questions (contract v0 `tasks.answers`, app route `POST /v1/app/sessions/{id}/answers`). Rovara Code does not serve it yet, so
    * Cloud answers 501 and the card shows "not connected yet". `round` is the round of questions being answered: Code's task view does not send it to this page,
    * so this sends 1, the first round, until Code serves the route and says otherwise.
    */
   /**
    * Pins a comment to a passage of the plan (contract v0 `tasks.comments.create`: `anchor` is a criterion id, `replyTo` the comment it answers). Cloud does not forward
    * it yet, so it answers 501 and the passage says "not connected yet" in Cloud's words; the draft stays.
    */
   comment: (taskId: string, text: string, anchor: string, replyTo: string | undefined) => api.send("POST", taskPath(taskId) + "/comments", { requestId: crypto.randomUUID(), document: "plan", text, anchor, ...(replyTo === undefined ? {} : { replyTo }) }, { parse: (body: unknown) => body }, { retry: "never" }),
   /** "Continue in my tool" (contract v0 `tasks.continue`, `continue/publish-branch`): Code puts the task's branch where the person's own tool can take it. Not served yet: Cloud answers 501. */
   continueInTool: (taskId: string) => api.send("POST", taskPath(taskId) + "/continue/publish-branch", { requestId: crypto.randomUUID() }, { parse: (body: unknown) => body }, { retry: "never" }),
   answer: (taskId: string, questionId: string, optionId: string, revision: number | undefined) => revision === undefined ? Promise.reject(new ApiError(501, "NOT_ON_CODE_YET", "Answering isn't connected to Rovara Code yet.")) : api.send("POST", "/v1/app/sessions/" + encodeURIComponent(taskId) + "/answers", { requestId: crypto.randomUUID(), round: 1, revision, answers: [{ questionId, optionId }] }, { parse: (body: unknown) => body }, { retry: "never" }),
  };
 }, [host]);
}
export function useWorkTasks(enabled = true) { const api = useWorkApi();return useQuery({ queryKey: ["work", "tasks"], retry: false, enabled, queryFn: api.tasks }); }
/** The tasks the person is involved in. Its own read, so a failure here never takes the person's own list with it. */
export function useInvolvedTasks(enabled = true) { const api = useWorkApi();return useQuery({ queryKey: ["work", "involved"], retry: false, enabled, queryFn: api.involved }); }
export function useTaskPlan(id: string | undefined) { const api = useWorkApi();return useQuery({ queryKey: ["work", "plan", id], retry: false, enabled: id !== undefined, queryFn: () => api.plan(id!) }); }
export function useTaskProof(id: string | undefined) { const api = useWorkApi();return useQuery({ queryKey: ["work", "proof", id], retry: false, enabled: id !== undefined, queryFn: () => api.proof(id!) }); }
export function useTaskEvents(id: string | undefined) { const api = useWorkApi();return useQuery({ queryKey: ["work", "events", id], retry: false, enabled: id !== undefined, queryFn: () => api.events(id!) }); }
export function useTaskComments(id: string | undefined) { const api = useWorkApi();return useQuery({ queryKey: ["work", "comments", id], retry: false, enabled: id !== undefined, queryFn: () => api.comments(id!) }); }
export function useOrgSpend() { const api = useWorkApi();return useQuery({ queryKey: ["work", "org-spend"], retry: false, queryFn: api.remainingUsd }); }
