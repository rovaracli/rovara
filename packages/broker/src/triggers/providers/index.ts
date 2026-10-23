// The providers of event sources (Plan 4 Tasks 22 to 25): one per source, each saying how its deliveries are verified and read. None is written yet, so none is on: a source with no
// provider can't have a hook created for it, and a delivery to one is refused. Each task adds its providers to this table.
import type { HookSource } from "@agentx/contracts";
import type { HookProvider } from "./types.js";

export function hookProviders(): Partial<Record<HookSource, HookProvider>> {
  return {};
}
