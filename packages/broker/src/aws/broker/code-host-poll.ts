// P6: the broker end of the poller. One pass for every registered host that polls (`events.mode === "poll"`): the same consumer as a webhook's events, the same reservations, and the
// per-install read budget. No production host polls today (GitHub sends webhooks), so a pass is a no-op until an Enterprise adapter registers one; the pass itself is not wired to a schedule
// here (see the report: "Wiring pending").
import type { CodeHostEvent, HostScope, OrgId } from "@agentx/contracts";
import { dynamoPollStore, type PollRegistry } from "../../plugins/events/poll-store.js";
import { runPollPass, type PollPassReport } from "../../plugins/events/poller.js";
import { dynamoEventReservations, type EventReservations } from "../../plugins/events/reservations.js";
import { wakeFromCodeHostEvent } from "../../rovara-code/tracking-events.js";
import type { CodeHostEventsDependencies } from "./code-host-events.js";

export interface CodeHostPollDependencies extends CodeHostEventsDependencies {
  /** The org whose scope the reads run under. */
  scope: HostScope;
  /** Replaces the table-backed store (tests). */
  store?: PollRegistry;
}

export interface CodeHostPollBudget {
  /** Reads one pass may spend on one host. */
  maxRequests: number;
  /** Reads one change request may spend in one pass. */
  maxRequestsPerTarget: number;
  signal?: AbortSignal;
  intervalMs?: number;
  staleAfterMs?: number;
}

/** The default allowance: with about twenty open change requests every 1-2 minutes, inside one install's read budget. */
export const DEFAULT_POLL_BUDGET: CodeHostPollBudget = { maxRequests: 120, maxRequestsPerTarget: 8 };

export async function runCodeHostPollPasses(deps: CodeHostPollDependencies, budget: CodeHostPollBudget = DEFAULT_POLL_BUDGET): Promise<PollPassReport[]> {
  const store = deps.store ?? dynamoPollStore({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now });
  const reservations: EventReservations = deps.reservations ?? dynamoEventReservations({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now });
  const reports: PollPassReport[] = [];
  for (const kind of deps.router.kinds()) {
    const host = deps.router.forKind(kind);
    if (host.events.mode !== "poll") continue;
    reports.push(await runPollPass({
      host, scope: deps.scope, store, reservations, now: deps.now, ...budget,
      consume: async (event: CodeHostEvent) => {
        const orgId: OrgId | undefined = await deps.orgOf(event);
        if (orgId !== undefined) await wakeFromCodeHostEvent(deps, event, orgId);
      },
    }));
  }
  return reports;
}
