// Meta repo lane F (F3): how an event that ASKS FOR WORK on an issue (a label put on it, an assignment: `INTAKE_EVENT_TYPES`) starts Rovara Code. It is a trigger's event like any other (the loop
// guard, the trigger's requirements, the hour's and the day's allowances and the event's identity are `dispatch.ts`'s), but the start is not an agent's autonomous run: it is the intake
// engine's, where WHO did it decides. The label is only a routing hint:
//   - a member who put it on (a GitHub account the org linked to a member, who may start tasks on the project) starts the work, as themselves and at their own cost;
//   - anyone else, and an automation, makes the ticket wait for a member to say "Start";
//   - Rovara's own account starts nothing.
// The issue's text rides on the event as untrusted data; the engine frames, redacts and cuts it.
import { INTAKE_EVENT_TYPES, isBuiltinAgentId, isIntakeEventSpec, ROVARA_CODE_AGENT_ID, type IntakeTrackerChannel, type OrgId, type TriggerEvent } from "@agentx/contracts";
import type { IntakeCandidate, IntakeOutcome } from "../intake/engine.js";
import type { TriggerRecord } from "./store.js";

/** What dispatch needs of the intake engine: hand it one ticket that asks for work. */
export interface IntakeDispatch {
  /** `admit` is asked just before work would start for a member's act; false makes the ticket wait (it is never dropped). */
  ingest(candidate: IntakeCandidate, options?: { admit?: () => Promise<boolean> }): Promise<IntakeOutcome>;
}

/** What dispatch records for an intake event, in its own words (a code, never the ticket's words). */
export type IntakeDispatchResult =
  | { outcome: "started"; taskId: string }
  | { outcome: "skipped" | "duplicate" | "failed"; reason: string };

/** Whether a trigger starts Rovara Code from an issue that asks for work. */
export function isIntakeTrigger(trigger: Pick<TriggerRecord, "target" | "spec">): boolean {
  return trigger.target.kind === "agent" && isBuiltinAgentId(trigger.target.agentId) && trigger.target.agentId === ROVARA_CODE_AGENT_ID && isIntakeEventSpec(trigger.spec);
}

const CHANNEL_OF_SOURCE: Readonly<Record<string, { channel: IntakeTrackerChannel; system: string }>> = {
  jira: { channel: "jira", system: "jira" },
  github: { channel: "github_issue", system: "github" },
};

/** The ticket an event is about, or undefined for an event that is not one that asks for work (or has no link to the ticket: a ticket is bound by its link). */
export function intakeCandidateOf(orgId: OrgId, event: TriggerEvent): IntakeCandidate | undefined {
  const mapped = Object.hasOwn(CHANNEL_OF_SOURCE, event.source) ? CHANNEL_OF_SOURCE[event.source] : undefined;
  const types = Object.hasOwn(INTAKE_EVENT_TYPES, event.source) ? (INTAKE_EVENT_TYPES[event.source as keyof typeof INTAKE_EVENT_TYPES] as readonly string[]) : [];
  if (mapped === undefined || !types.includes(event.type) || event.subject.url === undefined) return undefined;
  const { actor } = event;
  return {
    orgId, project: event.project, channel: mapped.channel,
    externalRef: { system: mapped.system, id: event.subject.id, url: event.subject.url },
    title: event.subject.title, body: event.subject.body, occurredAt: event.occurredAt, eventId: event.eventKey,
    actor: actor.kind === "rovara" ? { kind: "rovara" }
      : actor.kind === "external" ? { kind: actor.bot === true ? "bot" : "person", ...(actor.accountId === undefined ? {} : { accountId: actor.accountId }), ...(actor.id === undefined || event.source !== "github" ? {} : { display: actor.id }) }
        : { kind: "unknown" },
  };
}

/** The engine's outcome as dispatch records it. */
export function dispatchResultOf(outcome: IntakeOutcome): IntakeDispatchResult {
  switch (outcome.outcome) {
    case "started": return { outcome: "started", taskId: outcome.taskId };
    case "waiting": return { outcome: "skipped", reason: `intake_${outcome.reason}` };
    case "duplicate": return { outcome: "duplicate", reason: `intake_${outcome.state}` };
    case "skipped": return { outcome: "skipped", reason: `intake_${outcome.reason}` };
  }
}

/** Starts Rovara Code for the event through the engine. Throws what the engine throws (a fault that may pass: the vendor sends the event again, and the ticket is one item). */
export async function startIntakeFor(intake: IntakeDispatch | undefined, orgId: OrgId, event: TriggerEvent, admit?: () => Promise<boolean>): Promise<IntakeDispatchResult> {
  // Without the engine nothing starts (fail closed): the trigger is on, the event is recorded as failed.
  if (intake === undefined) return { outcome: "failed", reason: "intake_unavailable" };
  const candidate = intakeCandidateOf(orgId, event);
  if (candidate === undefined) return { outcome: "skipped", reason: "intake_not_a_ticket" };
  return dispatchResultOf(await intake.ingest(candidate, admit === undefined ? {} : { admit }));
}
