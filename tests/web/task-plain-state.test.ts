// Experience lane, task page: the plain-state mapping, the next step / who / why summary, the can-I-approve line, the worker-word rewrite and the flag function. All pure.
import { afterEach, expect, it } from "vitest";
import { PLAIN_STATE_LABELS, approveLine, cardsFor, leadStatus, plainEventText, plainState, taskLead } from "../../packages/ui/src/screens/session/task-plain-state.js";
import { TASK_PAGE_DEFAULTS, forceTaskPageFlags, taskPageFlags } from "../../packages/ui/src/screens/session/task-page-flags.js";
import { collapseFallbacks } from "../../packages/ui/src/screens/session/model-fallbacks.js";
import { sessionFixture } from "./support/session-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import type { ReadDecision } from "../../packages/ui/src/api/decisions.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const decision = (over: Record<string, unknown> = {}, actions: string[] = ["approve", "open"]): ReadDecision => ({ digest: "d", tabs: undefined, details: [], card: { id: "approve_plan:" + TASK_ID, kind: "approve_plan", taskId: TASK_ID, project: "payments", title: "Approve the plan", question: "Approve this plan?", recommended: { action: "approve", why: "the plan matches the request" }, next: { text: "Builds it" }, evidence: [], risk: "medium", riskReasons: [], friction: { expandEvidenceFirst: true, freshSignIn: false, secondPerson: false }, actions: actions.map(kind => ({ kind, label: kind, href: "/v1/app/decisions/x", method: kind === "open" ? "GET" : "POST" })), rejectReasons: [], status: "pending", createdAt: "2026-10-23T12:00:00.000Z", ...over } as never });
const taskSession = (display: unknown, extra: Record<string, unknown> = {}, you: Record<string, unknown> = {}) => { const base = workspaceFixture({ display } as never); return { ...base, ...extra, you: { ...base.you, ...you } } as typeof base; };

afterEach(() => forceTaskPageFlags(undefined));

it("maps every state of the status model to one plain state, none of them a raw word", () => {
 const raw = { understanding: "Understanding", planning: "Planning", reviewing_design: "Planning", building: "Building", checking: "Checking", needs_you: "Needs a decision", paused_budget: "Paused: needs budget", ready_to_merge: "Ready to merge", merged: "Merged", closed: "Closed", failed: "Failed", finished_run: "Finished" };
 expect(PLAIN_STATE_LABELS).toEqual(raw);
 for (const [state, label] of Object.entries(raw)) expect(plainState({ state }, undefined).label).toBe(label);
 expect(plainState({ state: "something_new" }, undefined)).toEqual({ label: "Status unavailable", tone: "neutral" });
});
it("reads Finished (no code) for an answered task and Stopped for a run that ended but can be retried", () => {
 const answered = { workflow: { outcome: "ANSWERED", stage: "CLOSED", state: "COMPLETE" } } as never;
 expect(plainState({ state: "closed" }, answered).label).toBe("Finished (no code)");
 expect(plainState({ state: "closed", retryable: true }, undefined).label).toBe("Stopped");
 expect(plainState({ state: "closed" }, undefined).label).toBe("Closed");
});
// Only the merge read is looked at, so the task is a plain object (the strict task view has more fields than these tests are about).
const mergeTask = (item: Record<string, unknown>, ready = false) => ({ merge: { ready, message: ready ? undefined : "Not yet" }, mergeTracking: [{ repositoryId: "acme/payments", number: 42, state: "open", draft: false, ci: "passing", failingChecks: [], review: "requested", branch: "up_to_date", headSha: "a".repeat(40), ...item }] }) as never;
it("tells ready for review, changes requested, checks failed and checking apart where the merge read says so", () => {
 expect(plainState({ state: "ready_to_merge" }, mergeTask({}, true)).label).toBe("Ready to merge");
 expect(plainState({ state: "ready_to_merge" }, mergeTask({})).label).toBe("Ready for review");
 expect(plainState({ state: "ready_to_merge" }, mergeTask({ review: "changes_requested" })).label).toBe("Changes requested");
 expect(plainState({ state: "ready_to_merge" }, mergeTask({ ci: "failing", failingChecks: ["unit"] })).label).toBe("Checks failed");
 expect(plainState({ state: "ready_to_merge" }, mergeTask({ ci: "pending" })).label).toBe("Checking");
 expect(plainState({ state: "ready_to_merge" }, undefined).label).toBe("Ready to merge");
});
it("reads the status model for a session, and the plain session status for a server from before it", () => {
 expect(leadStatus(sessionFixture({ status: "running" })).state).toBe("building");
 expect(leadStatus(sessionFixture({ status: "waiting", lastRunFailed: true })).state).toBe("failed");
 expect(leadStatus(sessionFixture({ display: { state: "needs_you", reason: "r", next: "n", nextOthers: "o" } } as never))).toMatchObject({ state: "needs_you", reason: "r", next: "n", nextOthers: "o" });
});
it("with a pending decision of mine: next step is to decide it, who is You, why is the server's reason, and the action goes to that card", () => {
 const session = taskSession({ state: "needs_you", reason: "the plan is waiting for approval", next: "Approve the plan in Rovara." }, {}, { owner: true });
 const lead = taskLead({ session, task: undefined, status: leadStatus(session), cards: cardsFor([decision()], TASK_ID) });
 expect(lead).toMatchObject({ state: { label: "Needs a decision" }, next: "Decide: Approve the plan", who: "You", why: "The plan is waiting for approval", action: { label: "Go to the decision", targetId: "decision-approve_plan-" + TASK_ID }, approve: "✓ You can approve · medium risk" });
});
it("without a card, an owner gets the owner's words but is not assumed to be the one who must act; anyone else gets the others' words; nobody is named", () => {
 const display = { state: "needs_you", reason: "questions about the request need answers", next: "Answer them on the task page.", nextOthers: "The task owner answers them on the task page." };
 const owner = taskLead({ session: taskSession(display, {}, { owner: true }), task: undefined, status: leadStatus(taskSession(display)), cards: [] });
 expect(owner).toMatchObject({ next: "Answer them on the task page", who: "Someone with permission", why: "Questions about the request need answers", action: undefined, approve: undefined });
 const other = taskSession(display, {}, { owner: false, actions: ["watch"] });
 const lead = taskLead({ session: other, task: undefined, status: leadStatus(other), cards: [] });
 expect(lead).toMatchObject({ next: "The task owner answers them on the task page", who: "Someone with permission" });
});
it("Rovara is who while it works; a budget pause names who can raise the limit from the server's own words, or You when the viewer may", () => {
 const working = taskSession({ state: "building", next: "Checks run after the code is written." });
 expect(taskLead({ session: working, task: undefined, status: leadStatus(working), cards: [] })).toMatchObject({ who: "Rovara", why: undefined, next: "Checks run after the code is written" });
 const paused = taskSession({ state: "paused_budget", reason: "it reached its spending limit", next: "Someone who can raise the limit decides." }, { cost: { spentUsd: 4, payer: { kind: "project", name: "payments" }, paused: { scope: "project" } } });
 expect(taskLead({ session: paused, task: undefined, status: leadStatus(paused), cards: [] })).toMatchObject({ state: { label: "Paused: needs budget" }, who: "A project maintainer or an org admin" });
 const mayRaise = { ...paused, cost: { ...paused.cost, paused: { scope: "project", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" } } } as typeof paused;
 expect(taskLead({ session: mayRaise, task: undefined, status: leadStatus(mayRaise), cards: [] }).who).toBe("You");
});
it("a finished task names nobody and has no action; a ready merge points at the existing Merge section", () => {
 const merged = taskSession({ state: "merged", next: "Nothing; this task is complete." });
 expect(taskLead({ session: merged, task: undefined, status: leadStatus(merged), cards: [] })).toMatchObject({ state: { label: "Merged" }, who: undefined, action: undefined, next: "Nothing; this task is complete" });
 const ready = taskSession({ state: "ready_to_merge", next: "Press Merge." }, {}, { owner: true });
 expect(taskLead({ session: ready, task: mergeTask({}, true), status: leadStatus(ready), cards: [] })).toMatchObject({ action: { label: "Go to Merge", targetId: "task-merge" }, who: "Someone with permission" });
});
it("the can-I-approve line: a medium card with an approve action, a high card on its card, a card without approve, several, and none", () => {
 expect(approveLine([decision({ risk: "medium" })])).toBe("✓ You can approve · medium risk");
 expect(approveLine([decision({ risk: "low" })])).toBe("✓ You can approve · low risk");
 expect(approveLine([decision({ risk: "high" }, ["open"])])).toBe("You can decide this on its card · high risk, needs a recent sign-in");
 expect(approveLine([decision({ risk: "medium" }, ["open"])])).toBe("You can decide this on its card · medium risk");
 expect(approveLine([decision({ risk: "new_tier" }), decision()])).toBe("✓ You can approve · medium risk (2 decisions)");
 expect(approveLine([])).toBeUndefined();
});
it("ignores a card that is answered or belongs to another task", () => {
 expect(cardsFor([decision({ status: "approved" }, []), decision({ taskId: "22222222-2222-4222-8222-222222222222" })], TASK_ID)).toEqual([]);
 expect(cardsFor(undefined, TASK_ID)).toEqual([]);
});
it("rewrites the raw worker word to a plain state and leaves every other line alone", () => {
 expect(plainEventText("Worker status: SUCCEEDED")).toBe("Run finished");
 expect(plainEventText("Worker status: RUNNING")).toBe("Running");
 expect(plainEventText("Worker status: FAILED")).toBe("Failed");
 expect(plainEventText("Worker status: INTERRUPTED")).toBe("Interrupted");
 // A word this build does not know keeps the original line, so TIMED_OUT is never lost.
 expect(plainEventText("Worker status: TIMED_OUT")).toBe("Worker status: TIMED_OUT");
 expect(plainEventText("Worker status: SOMETHING_NEW")).toBe("Worker status: SOMETHING_NEW");
 expect(plainEventText("Started Read")).toBe("Started Read");
 expect(plainEventText("The Worker status: SUCCEEDED line")).toBe("The Worker status: SUCCEEDED line");
});
it("the flag function: plain notices on and the leading header off by default; ?lead=1 turns the header on, ?lead=0 off; tests can force", () => {
 expect(TASK_PAGE_DEFAULTS).toEqual({ plainNotices: true, leadingHeader: false });
 expect(taskPageFlags("")).toEqual({ plainNotices: true, leadingHeader: false });
 expect(taskPageFlags("?lead=1").leadingHeader).toBe(true);
 expect(taskPageFlags("?x=1&lead=0").leadingHeader).toBe(false);
 forceTaskPageFlags({ leadingHeader: true, plainNotices: false });
 expect(taskPageFlags("?lead=0")).toEqual({ plainNotices: false, leadingHeader: true });
});

const opus = "amazon-bedrock/us.anthropic.claude-opus-5-5", haiku = "amazon-bedrock/us.anthropic.claude-haiku-4-5", sonnet = "amazon-bedrock/us.anthropic.claude-sonnet-4-6";
it("collapses three repeated plan-check fallbacks into one plain line with no model id, and keeps the repeat count in the details", () => {
 const note = { stage: "plan_check" as const, used: haiku, wanted: opus };
 const collapsed = collapseFallbacks([note, note, note])!;
 expect(collapsed.line).toBe("Used a different model for plan check: Opus unavailable");
 expect(collapsed.line).not.toMatch(/amazon|bedrock|us\.anthropic|claude/u);
 expect(collapsed.details).toEqual([{ stage: "plan_check", sentence: `Used ${haiku} because ${opus} was unavailable.`, count: 3 }]);
});
it("never claims a size order: Sonnet 5.5 in place of Opus 4.1 is only a different model", () => {
 expect(collapseFallbacks([{ stage: "build", used: "amazon-bedrock/us.anthropic.claude-sonnet-5-5", wanted: "amazon-bedrock/us.anthropic.claude-opus-4-1" }])!.line).toBe("Used a different model for build: Opus unavailable");
 expect(collapseFallbacks([{ stage: "build", used: "m/xgptx", wanted: "m/xgptx-2" }])!.line).toBe("Used a different model for build: the preferred model was unavailable");
});
it("says a different model when the order is unknown or equal, and the preferred model when none is named", () => {
 expect(collapseFallbacks([{ stage: "build", used: "openai/gpt-5.5", wanted: sonnet }])!.line).toBe("Used a different model for build: Sonnet unavailable");
 expect(collapseFallbacks([{ stage: "plan", used: opus, wanted: sonnet }])!.line).toBe("Used a different model for plan: Sonnet unavailable");
 expect(collapseFallbacks([{ stage: "code_review", used: "m/a", wanted: null }])!.line).toBe("Used a different model for code review: the preferred model was unavailable");
 expect(collapseFallbacks([{ stage: "plan_check", used: sonnet, wanted: sonnet }])!.line).toBe("Used a different model for plan check: the preferred model was unavailable");
});
it("one line for several different fallbacks, naming their stages once, and nothing for none", () => {
 const collapsed = collapseFallbacks([{ stage: "plan", used: "m/a", wanted: "m/b" }, { stage: "build", used: "m/c", wanted: null }, { stage: "plan", used: "m/a", wanted: "m/b" }])!;
 expect(collapsed.line).toBe("Used a different model for plan and build: the preferred models were unavailable");
 expect(collapsed.details.map(row => row.count)).toEqual([2, 1]);
 expect(collapseFallbacks([])).toBeUndefined();
});

it("not ready to merge is never the green Ready to merge (a conflicted branch, or no tracking)", () => {
 expect(plainState({ state: "ready_to_merge" }, mergeTask({ review: "approved", branch: "conflicted" }))).toEqual({ label: "Not ready to merge", tone: "attention" });
 const noTracking = { merge: { ready: false, message: "A reviewer must approve first." }, mergeTracking: [] } as never;
 expect(plainState({ state: "ready_to_merge" }, noTracking)).toEqual({ label: "Not ready to merge", tone: "attention" });
 const session = taskSession({ state: "ready_to_merge", next: "Press Merge." }, {}, { owner: true });
 expect(taskLead({ session, task: noTracking, status: leadStatus(session), cards: [] })).toMatchObject({ state: { label: "Not ready to merge" }, why: "A reviewer must approve first" });
});
it("who: an owner with no card is not assumed; a failed task I may retry or close is me; an unknown state names nobody", () => {
 const stopped = taskSession({ state: "failed", reason: "the run stopped with an error", next: "Retry it, or close the task." }, {}, { owner: true, actions: ["watch", "retry", "close"] });
 expect(taskLead({ session: stopped, task: undefined, status: leadStatus(stopped), cards: [] }).who).toBe("You");
 const watcher = taskSession({ state: "failed", reason: "x", next: "Retry it." }, {}, { owner: false, actions: ["watch"] });
 expect(taskLead({ session: watcher, task: undefined, status: leadStatus(watcher), cards: [] }).who).toBe("Someone with permission");
 const second = taskSession({ state: "needs_you", reason: "second approval needed", next: "Ask a second person." }, {}, { owner: true });
 expect(taskLead({ session: second, task: undefined, status: leadStatus(second), cards: [] }).who).toBe("Someone with permission");
 const unknown = { ...taskSession({ state: "needs_you" }, {}, { owner: true }), display: { state: "something_new" } } as never;
 expect(taskLead({ session: unknown, task: undefined, status: leadStatus(unknown), cards: [] })).toMatchObject({ state: { label: "Status unavailable" }, who: undefined });
});
