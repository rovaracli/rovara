import { useCallback, useEffect, useState } from "react";
import type { AppHost } from "../host.js";
import { withActionClaim } from "../safe-action.js";
import { taskActionRecords } from "./task-action.js";
import { assertSessionIdentity, sessionScope, useSessionRequest, type FrozenSessionRequest, type SessionIdentity } from "./session-safety.js";

/** Keep pre-isolation uncertainty, without letting it own Stop/Close's subject. */
function useLegacyRequest(host: AppHost, identity: SessionIdentity | undefined, id: string, source: FrozenSessionRequest | undefined, action: "retry" | "take_over", label: string) {
 const saved = useSessionRequest(host, identity, action + "-legacy:" + id), [migrationError, setMigrationError] = useState<string>();
 const migrate = useCallback(async () => {
  if (identity === undefined || saved.scope === undefined) return;
  const records = taskActionRecords(host), from = sessionScope(identity, id), to = saved.scope;
  const pending = records.readPendingNow(from);
  if (pending.kind !== "pending" || pending.entry.request.action !== action) return;
  // Reuse the reviewed claims for BOTH subjects. No sender can overwrite the
  // original while it is being copied; another mount can only make the same move.
  const origin = await withActionClaim("rovara-task-action:" + from, () => records.readPendingNow(from));
  if (origin.kind !== "done") return;
  try {
   const old = origin.value;if (old.kind !== "pending" || old.entry.request.action !== action) return;
   const target = await withActionClaim("rovara-task-action:" + to, () => {
    assertSessionIdentity(host, identity);
    const moved = { ...old.entry, scope: to };
    if (!records.writePending(moved)) throw new Error(label + " could not be retained");
    const readback = records.readPendingNow(to);
    if (readback.kind !== "pending" || JSON.stringify(readback.entry) !== JSON.stringify(moved)) throw new Error(label + " could not be read back");
    // Never clear uncertainty on a status guess. Clear only the old copy, AFTER
    // the full frozen record (including its original timestamp) is durable.
    records.clearPending(from, old.entry.requestId, old.entry.startedAt);
   });
   if (target.kind === "done") { target.release();setMigrationError(undefined); }
   if (target.kind === "failed") setMigrationError("The previous " + label + " could not be retained safely. Check this task before acting again.");
  } finally { origin.release(); }
 }, [host, identity, id, saved.scope, action, label]);
 const sourceId = source?.action === action ? source.requestId : undefined;
 useEffect(() => { if (sourceId !== undefined) void migrate().catch(() => { setMigrationError("The previous " + label + " could not be retained safely. Check this task before acting again."); }); }, [migrate, sourceId, label]);
 return { ...saved, migrationError, migrate };
}

export function useLegacyRetryRequest(host: AppHost, identity: SessionIdentity | undefined, id: string, source: FrozenSessionRequest | undefined) {
 return useLegacyRequest(host, identity, id, source, "retry", "Retry");
}
export function useLegacyTakeOverRequest(host: AppHost, identity: SessionIdentity | undefined, id: string, source: FrozenSessionRequest | undefined) {
 return useLegacyRequest(host, identity, id, source, "take_over", "Take over");
}
