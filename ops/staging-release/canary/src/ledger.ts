// The rolling cap ledger: ONE ledger for both pipelines, one object per canary started under `canary-ledger/`, written only by the Canary role (the boundary denies everyone else
// and the bucket is versioned with no deletes). The count is the number of objects younger than 24 h.
//
// Race rule. Two pipelines can claim at the same moment, so the slot is decided AFTER the claim is written: list again, and the claim runs only when the number of window entries
// whose last-modified is at or before its own is within the cap (ties count each other, so a tie at the cap skips both, never runs both). An entry written later never sorts before
// an earlier claim's last-modified, so the first CAP claims run and no more. The cost of the rule is that a losing claim stays in the ledger (no delete), which can only make the
// cap stricter for the rest of its 24 h, never looser.
import { CANARY_CAP, LEDGER_PREFIX, LIST_SLACK_MS, ROLLBACK_LEDGER_NAME_PREFIX, WINDOW_MS, type Kind } from "./config.ts";
import { compactIso } from "./util.ts";
import type { CanaryPorts, LedgerEntry } from "./types.ts";

export type Claim = { state: "granted"; key: string; n: number } | { state: "cap"; n: number };

export function ledgerKey(nowMs: number, kind: Kind, executionId: string, rollback: boolean): string {
  return `${LEDGER_PREFIX}${rollback ? ROLLBACK_LEDGER_NAME_PREFIX : ""}${compactIso(nowMs)}-${kind}-${executionId}`;
}

function isCounted(entry: LedgerEntry): boolean {
  return entry.key.startsWith(LEDGER_PREFIX) && !entry.key.slice(LEDGER_PREFIX.length).startsWith(ROLLBACK_LEDGER_NAME_PREFIX);
}

function inWindow(entry: LedgerEntry, nowMs: number): boolean {
  return entry.lastModifiedMs > nowMs - WINDOW_MS;
}

/** Keys begin with the claim time, so the listing can start an hour before the window. */
function startAfter(nowMs: number): string {
  return `${LEDGER_PREFIX}${compactIso(nowMs - WINDOW_MS - LIST_SLACK_MS)}`;
}

/** How many canaries are counted in the window right now. */
export function countWindow(entries: readonly LedgerEntry[], nowMs: number): number {
  return entries.filter((e) => isCounted(e) && inWindow(e, nowMs)).length;
}

/** A rollback canary is recorded in the ledger (so the spend is auditable) but never counted and never refused. */
export async function recordRollbackCanary(ports: CanaryPorts, kind: Kind, executionId: string): Promise<void> {
  await ports.putLedger(ledgerKey(ports.nowMs(), kind, executionId, true), JSON.stringify({ kind, executionId, rollback: true }));
}

/** Claims a slot for a STANDARD canary. Throws when the ledger cannot be read or written: the caller treats that as "do not spend". */
export async function claimSlot(ports: CanaryPorts, kind: Kind, executionId: string): Promise<Claim> {
  const nowMs = ports.nowMs();
  const before = await ports.listLedger(startAfter(nowMs));
  const mine = before.find((e) => isCounted(e) && e.key.endsWith(`-${kind}-${executionId}`));
  if (mine === undefined) {
    const n = countWindow(before, nowMs);
    if (n >= CANARY_CAP) return { state: "cap", n };
  }
  const key = mine?.key ?? ledgerKey(nowMs, kind, executionId, false);
  if (mine === undefined) await ports.putLedger(key, JSON.stringify({ kind, executionId, at: new Date(nowMs).toISOString() }));
  const after = await ports.listLedger(startAfter(nowMs));
  const own = after.find((e) => e.key === key);
  if (own === undefined || !inWindow(own, nowMs)) throw new Error("the ledger claim was written but is not listed in the window");
  const counted = after.filter((e) => isCounted(e) && inWindow(e, nowMs));
  const rank = counted.filter((e) => e.lastModifiedMs <= own.lastModifiedMs).length;
  if (rank > CANARY_CAP) return { state: "cap", n: counted.length };
  return { state: "granted", key, n: counted.length };
}
