// Work events (U3): which events a change of a task's workflow makes. A pure function of the snapshot before and the snapshot after (and the facts the snapshot does not hold: the company and the project), so the
// same function serves every place that writes a workflow, and a later consumer of the table's change stream.
//
// The events hold ids, closed words and short codes only (`@agentx/contracts` work-event.ts): the workflow's own text (a block reason, a decision's reason, a title) is never read here.
//
// Every event's id comes from the change (its kind, the task and a `source` naming the change inside the task), so a repeat of one change is the same row:
//   step_started / step_ended / waiting_changed / task_failed: the workflow revision the change produced;
//   decision_asked: the revision the task began to wait at; decision_answered / plan_approved: the revision the decision was made at (so a reader joins the pair on `decisionId` `r<revision>`);
//   pr_*: `<repository>#<number>`.
import {
  WorkEventSchema, workEventId,
  type OrgId, type WorkEventInput, type WorkflowSnapshot,
} from "@agentx/contracts";

type Pull = NonNullable<WorkflowSnapshot["pullRequests"]>[number];
type Decision = WorkflowSnapshot["decisions"][number];

interface Waiting { waitingOn: "person" | "agent" | "system" | "none"; personIds?: string[]; reason?: string }

/** Who the work waits for, as the workflow's state says. Compared before and after: a change of it is a `waiting_changed` event. */
export function waitingOf(workflow: WorkflowSnapshot): Waiting {
  switch (workflow.state) {
    case "COMPLETE": return { waitingOn: "none" };
    case "BLOCKED": return { waitingOn: "person", personIds: [workflow.ownerId], reason: "blocked" };
    case "WAITING":
      if (workflow.stage === "PLAN_REVIEW") return { waitingOn: "person", personIds: [workflow.ownerId], reason: `${gateOf(workflow)}_review` };
      // The person who merges is not known to the workflow (the pull request's reviewers are the code host's).
      if (workflow.stage === "WAIT_FOR_MERGE") return { waitingOn: "person", reason: "merge" };
      return { waitingOn: "system", reason: `waiting_${workflow.stage.toLowerCase()}` };
    default: return { waitingOn: "agent" };
  }
}

/** What the document waiting for the owner is: the requirements and the design of a Full task, else the plan. */
function gateOf(workflow: WorkflowSnapshot): "requirements" | "design" | "plan" {
  return workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : workflow.reviewPhase === "DESIGN" ? "design" : "plan";
}

const stepOf = (stage: WorkflowSnapshot["stage"]): string => stage.toLowerCase();
const instant = (at: string): string => new Date(at).toISOString();
const sameWaiting = (a: Waiting, b: Waiting): boolean => a.waitingOn === b.waitingOn && a.reason === b.reason && (a.personIds ?? []).join(",") === (b.personIds ?? []).join(",");
const atGate = (workflow: WorkflowSnapshot | undefined): boolean => workflow?.state === "WAITING" && workflow.stage === "PLAN_REVIEW";
const pullKey = (pull: Pull): string => `${pull.repositoryId}#${String(pull.number)}`;

/** The outcome a decision gives, in the contract's words. */
function outcomeOf(decision: Decision): "approved" | "rejected" | "changes_requested" | "answered" {
  switch (decision.decision) {
    case "APPROVE": return "approved";
    case "REJECT": return "rejected";
    case "REQUEST_CHANGES": return "changes_requested";
    default: return "answered";
  }
}

/** What kind of decision it was: the document at an approval gate, or the way the work was sent back or settled. */
function decisionKind(decision: Decision, before: WorkflowSnapshot): string {
  switch (decision.source) {
    case "SEND_BACK": return "send_back";
    case "FINDINGS": return "findings";
    case "AUTO_FIX": return "auto_fix";
    case "AUTO_RETRY": return "auto_retry";
    default: return atGate(before) ? gateOf(before) : "plan";
  }
}

export interface TransitionFacts {
  orgId: OrgId;
  project: string;
  /** The snapshot the change replaced; absent for the task's first one. */
  before: WorkflowSnapshot | undefined;
  after: WorkflowSnapshot;
  /** Where the task was asked for, as a short code (`web`, `chat`, `ticket`), for the first snapshot only. */
  origin?: string | undefined;
}

/**
 * The events one change of the workflow makes, in a fixed order, each valid under the contract (an event that is not is left out: the change never fails for an event). A snapshot that changes nothing
 * the events name (a comment counter, a candidate digest) makes none.
 */
export function workEventsOfTransition(facts: TransitionFacts): WorkEventInput[] {
  const { before, after, orgId, project } = facts;
  const taskId = after.taskId;
  const at = instant(after.updatedAt);
  const events: WorkEventInput[] = [];
  const add = (kind: WorkEventInput["kind"], source: string, actor: WorkEventInput["actor"], fields: Record<string, unknown>): void => {
    events.push({ version: 1, id: workEventId({ kind, taskId, source }), kind, at, orgId, project, taskId, actor, ...fields } as WorkEventInput);
  };
  const agent = { kind: "agent" } as const;
  const system = { kind: "system" } as const;

  if (before === undefined) add("task_started", "start", { kind: "person", personId: after.ownerId }, { path: after.path, ...(facts.origin === undefined ? {} : { origin: facts.origin }) });

  // Steps: a step is a stage while the engine runs it. It ends when the task leaves RUNNING or moves to another stage, and the next one starts.
  if (before?.state === "RUNNING" && (after.state !== "RUNNING" || after.stage !== before.stage)) {
    const outcome = after.state === "BLOCKED" ? "failed" : after.outcome === "REJECTED" || after.outcome === "CLOSED" ? "stopped" : "done";
    add("step_ended", `r${String(after.revision)}.${stepOf(before.stage)}`, agent, { step: stepOf(before.stage), outcome });
  }
  if (after.state === "RUNNING" && (before?.state !== "RUNNING" || before.stage !== after.stage)) {
    add("step_started", `r${String(after.revision)}.${stepOf(after.stage)}`, agent, { step: stepOf(after.stage) });
  }

  // Decisions: one is asked when the task begins to wait at an approval gate, and one is answered for each record the change adds.
  if (atGate(after) && !atGate(before)) add("decision_asked", `r${String(after.revision)}`, system, { decisionId: `r${String(after.revision)}`, decision: gateOf(after) });
  for (const decision of after.decisions.slice(before?.decisions.length ?? 0)) {
    const automatic = decision.actorRole === "AGENTX";
    add("decision_answered", `d.${decision.requestId}`, automatic ? system : { kind: "person", personId: decision.actorId }, {
      decisionId: `r${String(decision.workflowRevision)}`, decision: decisionKind(decision, before ?? after), outcome: outcomeOf(decision),
      ...(decision.via === "PAGE" ? { place: "web" } : automatic ? { place: "auto" } : {}),
    });
    if (decision.decision === "APPROVE" && (decision.source === undefined || decision.source === "GATE") && atGate(before) && gateOf(before!) === "plan") {
      add("plan_approved", `d.${decision.requestId}`, { kind: "person", personId: decision.actorId }, {});
    }
  }

  // Failure: the task is blocked (it needs the owner), which is what a failed run is in this workflow.
  if (after.state === "BLOCKED" && before?.state !== "BLOCKED") add("task_failed", `r${String(after.revision)}`, system, { reason: `blocked_${stepOf(after.stage)}` });

  // Pull requests: first seen, merged, closed.
  const known = new Map((before?.pullRequests ?? []).map((pull) => [pullKey(pull), pull]));
  for (const pull of after.pullRequests ?? []) {
    const previous = known.get(pullKey(pull));
    const shape = { repository: pull.repositoryId, number: pull.number };
    if (previous === undefined) add("pr_opened", pullKey(pull), agent, shape);
    if (pull.state === "MERGED" && previous?.state !== "MERGED") add("pr_merged", pullKey(pull), system, shape);
    if (pull.state === "CLOSED" && previous?.state !== "CLOSED") add("pr_closed", pullKey(pull), system, shape);
  }

  // Who the work waits for.
  const was = before === undefined ? { waitingOn: "none" as const } : waitingOf(before);
  const now = waitingOf(after);
  if (!sameWaiting(was, now)) add("waiting_changed", `r${String(after.revision)}`, system, { waitingOn: now.waitingOn, ...(now.personIds === undefined ? {} : { personIds: now.personIds }), ...(now.reason === undefined ? {} : { reason: now.reason }) });

  return events.filter((event) => WorkEventSchema.safeParse(event).success);
}
