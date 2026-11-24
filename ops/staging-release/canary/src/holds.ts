// HOLD (S14): any parameter under `<prefix>/<kind>-hold/` means HOLD, every new merge is MANUAL until the human approver deletes it. The canary, the post-check, the deploy and the
// guard may create holds; nothing here can clear one, and an existing hold is never overwritten.
import { errorText, exec8 } from "./util.ts";
import type { Kind } from "./config.ts";
import type { CanaryPorts } from "./types.ts";

export function pointerName(prefix: string, kind: Kind, which: "installed" | "last-good" | "last-good-execution"): string {
  return `${prefix}/${kind}-${which}`;
}

export function holdDir(prefix: string, kind: Kind): string {
  return `${prefix}/${kind}-hold/`;
}

export type HoldKind = "canary-fail" | "canary-inconclusive" | "rollback-attempt" | "rollback-started" | "rollback-refused" | "rollback-requested";

export function holdName(prefix: string, kind: Kind, hold: HoldKind, executionId: string): string {
  return `${holdDir(prefix, kind)}${hold}-${exec8(executionId)}`;
}

/** Writes the hold (a no-overwrite put). Returns an error text when it could not, null when the hold exists afterwards. */
export async function writeHold(ports: Pick<CanaryPorts, "nowMs" | "putHold">, name: string, reason: string, sha: string, executionId: string): Promise<string | null> {
  try {
    await ports.putHold(name, JSON.stringify({ reason, sha, executionId, at: new Date(ports.nowMs()).toISOString() }));
    return null;
  } catch (error) {
    return errorText(error);
  }
}
