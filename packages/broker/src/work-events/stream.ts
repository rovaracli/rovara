// Work events (U3): the workflow's events, taken from the State table's stream. The DeveloperTaskNotifier already reads every change of a task record (`DEVELOPER_TASK`, before and after images, retries and a dead-
// letter queue), so the events are made there, from the two images, by `workEventsOfTransition`. Nothing is added to any business transaction, every writer of a task's workflow is covered (the reconciler, the
// sweeps, dispatch, the E2E rounds, a failed outbox, a route), and no stream reader is added (the stream has its two).
//
// Idempotent: an event's id comes from the change and its time from the workflow, so a redelivery of a record writes the same rows. At least once, and a lag of seconds.
//
// Never fails the notifier's batch: a write that fails three times is logged (`work_event.write_failed`: the stream record's id and the event's kind and id, no content) and the batch goes on, so a fault here can
// never hold up a notice. Replay: see `briefs/work-events.md` ("Replay").
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { WorkflowSnapshotSchema, type WorkEventInput } from "@agentx/contracts";
import { isEvalRunMark } from "../lessons/eval-run.js";
import type { StreamRecord } from "../developer/notifications.js";
import { workEventsOfTransition } from "./transition.js";
import { putWorkEvent } from "./store.js";

const CODE = /^[a-z][a-z0-9_.-]{0,59}$/u;
/** How many times one event is written before the failure is logged and the batch goes on. */
export const WORK_EVENT_WRITE_ATTEMPTS = 3;

export interface WorkEventsRuntime {
  /** Waits between tries of a failed write (default 50 ms times the try); tests pass none. */
  pause?: ((attempt: number) => Promise<void>) | undefined;
}

export interface WorkEventStreamDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  workEvents?: WorkEventsRuntime | undefined;
  log(entry: Record<string, unknown>): void;
}

/**
 * The events one stream batch makes, each with the id of the stream record it came from. Only task records; a replay copy of a past task (`evalRun`) is not work and makes none. A record that cannot be read
 * is skipped (the notifier names unreadable records already). A record with no earlier workflow is the task's first.
 */
export function workEventsOfStream(records: readonly StreamRecord[]): Array<{ eventID: string; event: WorkEventInput }> {
  const made: Array<{ eventID: string; event: WorkEventInput }> = [];
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    try {
      const next = unmarshall(image) as Record<string, unknown>;
      if (next["entityType"] !== "DEVELOPER_TASK" || isEvalRunMark(next["evalRun"])) continue;
      const orgId = next["orgId"];
      const project = next["project"];
      if (typeof orgId !== "string" || typeof project !== "string") continue;
      const after = WorkflowSnapshotSchema.safeParse(next["workflow"]);
      if (!after.success) continue;
      const previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
      const parsedBefore = previous === undefined ? undefined : WorkflowSnapshotSchema.safeParse(previous["workflow"]);
      const client = next["client"];
      const events = workEventsOfTransition({
        orgId, project, before: parsedBefore?.success === true ? parsedBefore.data : undefined, after: after.data,
        origin: typeof client === "string" && CODE.test(client) ? client : undefined,
      });
      // An old image whose workflow cannot be read is an UNKNOWN before-state, not a task with none: only the one idempotent event that does not depend on it (the task's start, whose id and time are fixed by
      // the task) is made, so no step or wait is invented from a missing baseline.
      const safe = previous !== undefined && parsedBefore?.success !== true ? events.filter((event) => event.kind === "task_started") : events;
      for (const event of safe) made.push({ eventID: entry.eventID ?? "", event });
    } catch {
      // Unreadable: the notifier logs it by event id already.
    }
  }
  return made;
}

/** Writes the events of a stream batch. Never throws: a failure is logged and counted, and the rest are still written. Returns how many were written. */
export async function writeWorkEventsOfStream(deps: WorkEventStreamDeps, records: readonly StreamRecord[]): Promise<{ written: number; failed: number }> {
  if (deps.workEvents === undefined) return { written: 0, failed: 0 };
  let written = 0;
  let failed = 0;
  let made: Array<{ eventID: string; event: WorkEventInput }>;
  try {
    made = workEventsOfStream(records);
  } catch (error) {
    deps.log({ event: "work_event.write_failed", reason: "derive_failed", error: error instanceof Error ? error.name : "unknown" });
    return { written, failed: 1 };
  }
  for (const { eventID, event } of made) {
    let done = false;
    for (let attempt = 1; attempt <= WORK_EVENT_WRITE_ATTEMPTS && !done; attempt += 1) {
      try {
        await putWorkEvent(deps, event);
        done = true;
      } catch (error) {
        if (attempt === WORK_EVENT_WRITE_ATTEMPTS) deps.log({ event: "work_event.write_failed", streamEventId: eventID, kind: event.kind, id: event.id, error: error instanceof Error ? error.name : "unknown" });
        else await (deps.workEvents.pause ?? ((tried: number) => new Promise<void>((resolve) => { setTimeout(resolve, 50 * tried); })))(attempt);
      }
    }
    if (done) written += 1;
    else failed += 1;
  }
  return { written, failed };
}
