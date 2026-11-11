import { TaskStatusReaderSchema, budgetRaisers, taskStatusFromSession } from "@agentx/contracts/web";
import { mayApproveHere, type ReadDecision } from "../../api/decisions.js";
import type { ReadSession } from "./SessionHeader.js";
import type { ReadTask } from "./workspace-types.js";

/**
 * Experience lane, task page: the plain-state vocabulary (experience spec 3) and the "next step, who, why" summary, from data the page already has: the session's status
 * model (`display`), the task view (`workflow`, `merge`, `mergeTracking`, `failure`), the viewer's pending decision cards and what the viewer may do. Pure: nothing here reads
 * the network. Where the data cannot say who or why, the answer is `undefined` and the page says so plainly; nothing is invented.
 */

export type PlainTone = "info" | "attention" | "success" | "danger" | "neutral";
export interface PlainState { label: string; tone: PlainTone }

/** Today's state of the one status model -> the spec's plain state. A state this build does not know reads "Status unavailable". */
const BASE: Record<string, PlainState> = {
 understanding: { label: "Understanding", tone: "info" },
 planning: { label: "Planning", tone: "info" },
 reviewing_design: { label: "Planning", tone: "info" },
 building: { label: "Building", tone: "info" },
 checking: { label: "Checking", tone: "info" },
 needs_you: { label: "Needs a decision", tone: "attention" },
 paused_budget: { label: "Paused: needs budget", tone: "attention" },
 ready_to_merge: { label: "Ready to merge", tone: "success" },
 merged: { label: "Merged", tone: "success" },
 closed: { label: "Closed", tone: "neutral" },
 failed: { label: "Failed", tone: "danger" },
 finished_run: { label: "Finished", tone: "neutral" },
};
export const PLAIN_STATE_UNKNOWN: PlainState = { label: "Status unavailable", tone: "neutral" };
/** The table behind the report: raw state -> plain label. */
export const PLAIN_STATE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(BASE).map(([state, plain]) => [state, plain.label]));

/** Where the work stands in the one status model, for this reader: the session's own `display`, else what its plain status says (a server from before the model). */
export interface LeadStatus { state: string; reason?: string | undefined; next?: string | undefined; nextOthers?: string | undefined; retryable?: boolean | undefined }
export function leadStatus(session: ReadSession): LeadStatus {
 const parsed = TaskStatusReaderSchema.safeParse((session as { display?: unknown }).display);
 if (parsed.success) { const data = parsed.data as LeadStatus; return { state: data.state, reason: data.reason, next: data.next, nextOthers: data.nextOthers, retryable: data.retryable === true }; }
 const closed = session.body.kind === "task" && (session.body.task as { status?: unknown }).status === "CLOSED";
 return taskStatusFromSession({ status: session.status, ...(session.lastRunFailed === true ? { lastRunFailed: true as const } : {}) }, closed);
}

type MergeItem = NonNullable<ReadTask["mergeTracking"]>[number];
const items = (task: ReadTask | undefined): readonly MergeItem[] => (task?.mergeTracking ?? []).filter(item => item.state === "open");

/** The plain state for a status and, where the task view can tell more, the more exact one (changes requested, ready for review, finished with no code). */
export function plainState(status: LeadStatus, task: ReadTask | undefined): PlainState {
 const base = BASE[status.state] ?? PLAIN_STATE_UNKNOWN;
 if (status.state === "closed") {
  if (task?.workflow?.outcome === "ANSWERED") return { label: "Finished (no code)", tone: "success" };
  if (status.retryable === true) return { label: "Stopped", tone: "neutral" };
  return base;
 }
 if (status.state !== "ready_to_merge" || task?.merge === undefined) return base;
 const open = items(task);
 if (task.merge.ready === true) return base;
 if (open.some(item => item.review === "changes_requested")) return { label: "Changes requested", tone: "attention" };
 if (open.some(item => item.ci === "failing")) return { label: "Checks failed", tone: "danger" };
 if (open.some(item => item.ci === "pending")) return { label: "Checking", tone: "info" };
 if (open.length > 0 && open.every(item => item.review !== "approved" && item.ci !== "failing")) return { label: "Ready for review", tone: "attention" };
 // The merge read says it is not ready and none of the specific reasons above is the one (a conflicted branch, no tracking yet): never the green "Ready to merge" (Merge says "Not ready to merge" here).
 return { label: "Not ready to merge", tone: "attention" };
}

/** The pending decision cards for this task, in the order the server gave them. */
export const cardsFor = (decisions: readonly ReadDecision[] | undefined, taskId: string | undefined): ReadDecision[] => taskId === undefined ? [] : (decisions ?? []).filter(decision => decision.card.status === "pending" && decision.card.taskId === taskId);
/** The element id a decision card has on the page (DecisionCard sets it; MergeSection and PlanTab build it the same way). */
export const cardElementId = (cardId: string): string => "decision-" + cardId.replace(/[^A-Za-z0-9_-]/gu, "-");
export const MERGE_SECTION_ID = "task-merge";

export interface LeadAction { label: string; targetId: string }
export interface Lead {
 state: PlainState;
 /** What happens next, or what to do. Always present: a state without words from the server reads from the state itself. */
 next: string;
 /** Who acts: "You", "Rovara", a role named by the server's own budget words, or nothing when the page cannot tell. */
 who: string | undefined;
 /** Why: the server's reason sentence, or the card's own recommendation. Nothing when the server gave none. */
 why: string | undefined;
 /** The existing control that does the next step, reached by scrolling to it. Never a new control. */
 action: LeadAction | undefined;
 /** The one "can I approve?" line, only where a pending card of mine tells it. */
 approve: string | undefined;
}

/** A risk word a newer server adds reads as medium (the more careful side, as Merge does). */
const riskWords = (risk: string): string => risk === "low" ? "low risk" : risk === "high" ? "high risk" : "medium risk";
const upperFirst = (value: string): string => value === "" ? value : value[0]!.toUpperCase() + value.slice(1);
const sentence = (value: string): string => upperFirst(value.replace(/[.\s]+$/u, ""));
const WORKING: Readonly<Record<string, string>> = { understanding: "Reading the request, then writing a plan.", planning: "Writing and checking the plan.", reviewing_design: "Reviewing the design.", building: "Writing the change.", checking: "Running the checks." };
const AUTOMATIC = new Set(["understanding", "planning", "reviewing_design", "building", "checking"]);

/** The can-I-approve line (owner decision 40). Only a pending card of mine says it; with none, no line (the named blocker, e.g. a CODEOWNER, needs broker: P-58). */
export function approveLine(cards: readonly ReadDecision[]): string | undefined {
 const card = cards[0]?.card;
 if (card === undefined) return undefined;
 const extra = cards.length > 1 ? " (" + String(cards.length) + " decisions)" : "";
 if (card.risk === "high") return "You can decide this on its card · " + riskWords("high") + ", needs a recent sign-in" + extra;
 if (mayApproveHere(card)) return "✓ You can approve · " + riskWords(card.risk) + extra;
 return "You can decide this on its card · " + riskWords(card.risk) + extra;
}

export interface LeadInput { session: ReadSession; task: ReadTask | undefined; status: LeadStatus; cards: readonly ReadDecision[] }

export function taskLead({ session, task, status, cards }: LeadInput): Lead {
 const state = plainState(status, task), owner = session.you.owner, card = cards[0]?.card;
 const mayAct = session.you.actions;
 let next = (owner ? status.next : status.nextOthers ?? status.next) ?? WORKING[status.state] ?? "";
 let who: string | undefined, why = status.reason === undefined ? undefined : sentence(status.reason), action: LeadAction | undefined;
 if (AUTOMATIC.has(status.state)) who = "Rovara";
 else if (status.state === "paused_budget") who = session.cost.paused?.confirmUrl !== undefined ? "You" : upperFirst(budgetRaisers(session.cost.paused?.scope));
 else if (status.state === "merged" || (status.state === "closed" && status.retryable !== true)) who = undefined;
 else if (BASE[status.state] === undefined) who = undefined;
 else if (card !== undefined) who = "You";
 // Without a card of mine only an action I am offered makes it me: retry or close on a stopped task. An owner is not assumed to be the one a waiting state needs.
 else if ((status.state === "failed" || status.state === "finished_run" || status.retryable === true) && (mayAct.includes("retry") || mayAct.includes("close"))) who = "You";
 if (card !== undefined && (status.state === "needs_you" || status.state === "ready_to_merge" || status.state === "planning" || status.state === "reviewing_design")) {
  next = "Decide: " + card.title + (cards.length > 1 ? " (and " + String(cards.length - 1) + " more)" : "");
  why ??= sentence(card.recommended.why);
  action = { label: "Go to the decision", targetId: cardElementId(card.id) };
  if (who === "Rovara") who = "You";
 } else if (status.state === "ready_to_merge" && task?.merge !== undefined) action = { label: "Go to Merge", targetId: MERGE_SECTION_ID };
 // Nobody named: say so plainly, only where someone has to act. The broker checks who may on every press.
 if (who === undefined && BASE[status.state] !== undefined && (status.state === "needs_you" || status.state === "ready_to_merge" || status.state === "failed")) who = "Someone with permission";
 if (state.label === "Not ready to merge" && why === undefined && task?.merge?.message !== undefined && task.merge.message !== "") why = sentence(task.merge.message);
 if (state.label === "Changes requested" && why === undefined) why = "A reviewer asked for changes.";
 if (state.label === "Checks failed" && why === undefined) why = "Checks on the pull request failed.";
 if (next === "") next = state.label;
 return { state, next: sentence(next), who, why, action, approve: approveLine(cards) };
}

/** A raw worker word read as a plain state (the broker writes "Worker status: SUCCEEDED" into the task's events). Any other line, and a word this build does not know, is returned unchanged. */
const WORKER_WORDS: Readonly<Record<string, string>> = { STARTING: "Starting", RUNNING: "Running", SUCCEEDED: "Run finished", FAILED: "Failed", CANCELLED: "Cancelled", INTERRUPTED: "Interrupted", CLOSED: "Closed", PENDING: "Waiting to start", QUEUED: "Waiting to start" };
export function plainEventText(text: string): string {
 const match = /^Worker status:\s*([A-Za-z_]+)\s*\.?$/u.exec(text.trim());
 if (match === null) return text;
 // A word this build does not know keeps the original line: the raw word may be what a person needs (TIMED_OUT).
 return WORKER_WORDS[match[1]!.toUpperCase()] ?? text;
}
