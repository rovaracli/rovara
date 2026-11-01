// P6: the broker end of the neutral code host events, for any registered host. A delivery enters through `plugins/events/intake.ts` (host kind refused unless registered, the host's own
// verification, one reservation per event); each new event wakes the tracking row of the task it is about (`wakeFromCodeHostEvent`).
//
// The org an event belongs to is the host's own binding, supplied by the caller (`orgOf`), never read from the event: for GitHub it is the App installation's org, for another host the
// install's own binding. With no `orgOf` nothing is consumed. The HTTP route that would call this is not mounted here (see the report: "Wiring pending").
import type { CodeHostEvent, HostScope, OrgId, RawDelivery } from "@agentx/contracts";
import { receiveCodeHostDelivery } from "../../plugins/events/intake.js";
import { dynamoEventReservations, type EventReservations } from "../../plugins/events/reservations.js";
import type { CodeHostRouter } from "../../plugins/registry.js";
import { wakeFromCodeHostEvent, type CodeHostWakeDependencies } from "../../rovara-code/tracking-events.js";

export interface CodeHostEventsDependencies extends Omit<CodeHostWakeDependencies, "now"> {
  router: Pick<CodeHostRouter, "kinds" | "forKind">;
  now: () => number;
  /** The org the host's binding names for this event; undefined when it names none (the event then changes nothing). */
  orgOf(event: CodeHostEvent): Promise<OrgId | undefined>;
  /** Replaces the table-backed reservations (tests). */
  reservations?: EventReservations;
}

export interface CodeHostWebhookAnswer {
  /** `ACCEPTED`: at least one new event. `DUPLICATE`: every event was seen before. `IGNORED`: the delivery was verified and maps to no event. */
  status: "ACCEPTED" | "DUPLICATE" | "IGNORED";
  events: number;
  duplicates: number;
  /** What each new event did to a task's tracking row. */
  wakes: Array<"woken" | "none" | "unfollowed">;
}

export async function handleCodeHostWebhook(deps: CodeHostEventsDependencies, kind: string, delivery: RawDelivery, scope: HostScope = { system: "webhook" }): Promise<CodeHostWebhookAnswer> {
  const wakes: CodeHostWebhookAnswer["wakes"] = [];
  const result = await receiveCodeHostDelivery({
    router: deps.router, kind, delivery, scope,
    reservations: deps.reservations ?? dynamoEventReservations({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }),
    consume: async (event) => {
      const orgId = await deps.orgOf(event);
      wakes.push(orgId === undefined ? "unfollowed" : await wakeFromCodeHostEvent(deps, event, orgId));
    },
  });
  const status = result.consumed.length > 0 ? "ACCEPTED" : result.duplicates > 0 ? "DUPLICATE" : "IGNORED";
  return { status, events: result.consumed.length, duplicates: result.duplicates, wakes };
}
