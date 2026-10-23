// Where a summary change goes after it commits (Plan 5 Task 7a). Task 8 registers the sink that turns a change into realtime notices and feed entries; until
// then it is a no-op. A sink's failure is logged and never thrown: a notice is never a reason for a refresh to fail.
import type { AgentSessionRecord, OrgId, SessionId, SessionSummary } from "@agentx/contracts";
import type { TableInput } from "../agents/table-writes.js";

/** What changed in one committed refresh. */
export interface SessionChange {
  orgId: OrgId;
  sessionId: SessionId;
  /** The session as the refresh left it. */
  session: AgentSessionRecord;
  previous: SessionSummary;
  summary: SessionSummary;
  summaryRevision: number;
  statusChanged: boolean;
  stepChanged: boolean;
  /** The refresh that ended the session. */
  ended: boolean;
  at: string;
}

export type SessionNoticeSink = (deps: TableInput, change: SessionChange) => Promise<void>;

let registered: SessionNoticeSink | undefined;

/** Registers the one sink (a later call replaces it; `undefined` removes it). */
export function registerSessionNoticeSink(sink: SessionNoticeSink | undefined): void {
  registered = sink;
}

/** Hands a change to the sink, if any. Never throws. */
export async function notifySessionChange(deps: TableInput & { log?: ((entry: Record<string, unknown>) => void) | undefined }, change: SessionChange): Promise<void> {
  if (registered === undefined) return;
  try {
    await registered(deps, change);
  } catch (error) {
    (deps.log ?? ((entry) => console.log(JSON.stringify({ component: "broker", ...entry }))))({
      event: "agent_session.notice_sink_failed", sessionId: change.sessionId, error: error instanceof Error ? error.name : "unknown",
    });
  }
}
