// R7: the weekly existence sweep. An MCP source sends no delete events, so every week a bounded batch of what we recorded from it is asked about
// again through the server's read-only "get one" tool. An item the server clearly says is gone is tombstoned (hidden at once, then deleted
// everywhere by the delete worker). A tombstone cannot be undone, so the sweep is built not to be fooled:
//  - an error, a timeout or an unclear answer is never a deletion;
//  - a refusal (401, 403, "no permission") is never "gone": many servers answer "not found" for what a credential may not see, so the first refusal stops the run;
//  - a canary first: one recently recorded item must still be found, or the credential or the server has changed and nothing is deleted;
//  - a page where more than 20% of the items look gone is not believed (a revoked or narrowed credential looks exactly like that);
//  - the server is asked with the source's own id (`nativeId`), never an id cut out of our key, and only for kinds the exists tool can fetch.
import { checkReadOnlyTool, type McpPollAdapter, type McpPollSource, type PollConnection } from "./mcp-poller.js";
import type { RecordSinkPort, TapLog } from "./ports.js";

export const SWEEP_MAX_CHECKS = 2_000;
const SWEEP_BATCH = 100;
const SWEEP_ABORT_AFTER_UNKNOWN = 10;
/** More than this share of a page "gone" at once is a sign of a lost credential, not of deletions. */
export const SWEEP_MAX_MISSING_SHARE = 0.2;
const SWEEP_MIN_PAGE_FOR_SHARE = 5;
export const DEFAULT_EXISTS_KINDS: readonly string[] = ["ticket.created", "ticket.updated"];

export interface SweepRow {
  /** The record's `sourceRef.id`: what a tombstone names. */
  id: string;
  /** The source's own id: what the server is asked about. */
  nativeId: string;
  kind: string;
}

/** The record's own list of what it holds from a source (R2 store, GSI1). Pages resume from an opaque `next`. */
export interface SweepRowsPort {
  listRows(input: { workspaceId: string; system: string; after?: string; limit: number }): Promise<{ rows: SweepRow[]; next?: string }>;
  /** One recently recorded row: the canary. */
  recentRow(workspaceId: string, system: string): Promise<SweepRow | undefined>;
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

export async function runExistenceSweep(deps: SweepDependencies, source: McpPollSource): Promise<SweepOutcome> {
  const log: TapLog = deps.log ?? (() => undefined);
  const refused = (reason: string): SweepOutcome => ({ status: "refused", reason, checked: 0, tombstoned: 0 });
  const adapter = deps.adapters[source.adapterId];
  if (adapter === undefined || source.existsTool === undefined) return refused("no_exists_tool");
  const existsTool = source.existsTool;
  const kinds = source.existsKinds ?? DEFAULT_EXISTS_KINDS;
  let connection: PollConnection;
  try {
    connection = await deps.connect(source);
  } catch {
    return refused("connect_failed");
  }
  let checked = 0;
  let tombstoned = 0;
  let unknown = 0;
  const verdictOf = async (row: SweepRow): Promise<"exists" | "missing" | "forbidden" | "unknown"> => {
    const result = await connection.call(existsTool, adapter.existsArgs(row.nativeId)).catch(() => undefined);
    return result === undefined ? "unknown" : adapter.classifyExists(result);
  };
  try {
    const check = checkReadOnlyTool(source, connection, existsTool);
    if (!check.ok) return refused(check.reason);
    // The canary: a recently recorded item must still be found, or nothing this run hears about "missing" is believed.
    const canary = await deps.rows.recentRow(source.workspaceId, source.serverId);
    if (canary === undefined) return { status: "ok", checked: 0, tombstoned: 0 };
    if (kinds.includes(canary.kind) && await verdictOf(canary) !== "exists") {
      log("record.sweep_aborted", { source: source.source, reason: "canary" });
      return { status: "aborted", reason: "canary_failed", checked: 1, tombstoned: 0 };
    }
    const limit = Math.min(deps.maxChecks ?? SWEEP_MAX_CHECKS, SWEEP_MAX_CHECKS);
    let after = await deps.rows.loadCursor(source.workspaceId, source.serverId);
    let finished = false;
    while (checked < limit) {
      const page = await deps.rows.listRows({ workspaceId: source.workspaceId, system: source.serverId, ...(after === undefined ? {} : { after }), limit: Math.min(SWEEP_BATCH, limit - checked) });
      const missing: string[] = [];
      let pageChecked = 0;
      for (const row of page.rows) {
        // Only kinds the "get one" tool can fetch: a comment is not asked of the ticket tool.
        if (!kinds.includes(row.kind)) continue;
        checked += 1;
        pageChecked += 1;
        const verdict = await verdictOf(row);
        if (verdict === "missing") missing.push(row.id);
        else if (verdict === "forbidden") {
          log("record.sweep_aborted", { source: source.source, reason: "forbidden" });
          return { status: "aborted", reason: "credential_refused", checked, tombstoned };
        } else if (verdict === "unknown") unknown += 1;
        if (unknown >= SWEEP_ABORT_AFTER_UNKNOWN) {
          // The server is not answering clearly: stop, delete nothing from this page, and try again next week.
          log("record.sweep_aborted", { source: source.source, reason: "unclear" });
          return { status: "aborted", reason: "server_unclear", checked, tombstoned };
        }
      }
      if (pageChecked >= SWEEP_MIN_PAGE_FOR_SHARE && missing.length / pageChecked > SWEEP_MAX_MISSING_SHARE) {
        log("record.sweep_aborted", { source: source.source, reason: "mass_missing" });
        return { status: "aborted", reason: "mass_missing", checked, tombstoned };
      }
      if (missing.length > 0) {
        await deps.sink.tombstone({ workspaceId: source.workspaceId, system: source.serverId, sourceIds: missing, cause: "source_deleted" });
        tombstoned += missing.length;
      }
      after = page.next;
      if (after === undefined) { finished = true; break; }
      if (page.rows.length === 0) break;
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
