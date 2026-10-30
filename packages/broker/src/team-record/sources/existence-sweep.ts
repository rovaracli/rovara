// R7: the weekly existence sweep. An MCP source sends no delete events, so every week a bounded batch of what we recorded from it is asked about
// again through the server's read-only "get one" tool. An item the server clearly says is gone is tombstoned (hidden at once, then deleted
// everywhere by the delete worker). An answer that is an error, a timeout or unclear is never a deletion: a flaky server must not erase history.
import { checkReadOnlyTool, type McpPollAdapter, type McpPollSource, type PollConnection } from "./mcp-poller.js";
import type { RecordSinkPort, TapLog } from "./ports.js";

export const SWEEP_MAX_CHECKS = 2_000;
const SWEEP_BATCH = 100;
const SWEEP_ABORT_AFTER_UNKNOWN = 10;

/** The record's own list of what it holds from a source (R2 store, GSI1). Ids come back in a stable order and resume from `after`. */
export interface SweepRowsPort {
  listSourceIds(input: { workspaceId: string; system: string; after?: string; limit: number }): Promise<{ ids: string[]; next?: string }>;
  loadCursor(workspaceId: string, system: string): Promise<string | undefined>;
  saveCursor(workspaceId: string, system: string, cursor: string | undefined): Promise<void>;
}

export interface SweepDependencies {
  rows: SweepRowsPort;
  sink: RecordSinkPort;
  connect(source: McpPollSource): Promise<PollConnection>;
  adapters: Readonly<Record<string, McpPollAdapter>>;
  maxChecks?: number;
  log?: TapLog;
}

export interface SweepOutcome {
  status: "ok" | "aborted" | "refused";
  reason?: string;
  checked: number;
  tombstoned: number;
}

/** Item ids are `issue:<id>` or `comment:<id>`; the server is asked about the part after the first colon, only for the kinds it can fetch. */
export async function runExistenceSweep(deps: SweepDependencies, source: McpPollSource): Promise<SweepOutcome> {
  const log: TapLog = deps.log ?? (() => undefined);
  const refused = (reason: string): SweepOutcome => ({ status: "refused", reason, checked: 0, tombstoned: 0 });
  const adapter = deps.adapters[source.adapterId];
  if (adapter === undefined || source.existsTool === undefined) return refused("no_exists_tool");
  let connection: PollConnection;
  try {
    connection = await deps.connect(source);
  } catch {
    return refused("connect_failed");
  }
  let checked = 0;
  let tombstoned = 0;
  let unknown = 0;
  try {
    const check = checkReadOnlyTool(source, connection, source.existsTool);
    if (!check.ok) return refused(check.reason);
    const limit = Math.min(deps.maxChecks ?? SWEEP_MAX_CHECKS, SWEEP_MAX_CHECKS);
    let after = await deps.rows.loadCursor(source.workspaceId, source.serverId);
    let missing: string[] = [];
    const flush = async (): Promise<void> => {
      if (missing.length === 0) return;
      await deps.sink.tombstone({ workspaceId: source.workspaceId, system: source.serverId, sourceIds: missing, cause: "source_deleted" });
      tombstoned += missing.length;
      missing = [];
    };
    let finished = false;
    while (checked < limit) {
      const page = await deps.rows.listSourceIds({ workspaceId: source.workspaceId, system: source.serverId, ...(after === undefined ? {} : { after }), limit: Math.min(SWEEP_BATCH, limit - checked) });
      if (page.ids.length === 0) { finished = true; after = undefined; break; }
      for (const id of page.ids) {
        checked += 1;
        const result = await connection.call(source.existsTool, adapter.existsArgs(id.slice(id.indexOf(":") + 1))).catch(() => undefined);
        const verdict = result === undefined ? "unknown" : adapter.classifyExists(result);
        if (verdict === "missing") missing.push(id);
        else if (verdict === "unknown") unknown += 1;
        if (unknown >= SWEEP_ABORT_AFTER_UNKNOWN) {
          // The server is not answering clearly: stop, delete nothing more, and try again next week.
          await flush();
          log("record.sweep_aborted", { source: source.source });
          return { status: "aborted", reason: "server_unclear", checked, tombstoned };
        }
      }
      await flush();
      after = page.next;
      if (after === undefined) { finished = true; break; }
    }
    // Resume where this run stopped; a finished pass starts over from the top next week.
    await deps.rows.saveCursor(source.workspaceId, source.serverId, finished ? undefined : after);
    return { status: "ok", checked, tombstoned };
  } catch {
    log("record.sweep_failed", { source: source.source });
    return { status: "aborted", reason: "failed", checked, tombstoned };
  } finally {
    await connection.close().catch(() => undefined);
  }
}
