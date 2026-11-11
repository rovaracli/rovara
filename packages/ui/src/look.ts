import { LOOK_DENSITY, type Density } from "@agentx/design-tokens";
import { uiFlagOn } from "./ui-flags.js";
/**
 * The v2 look switch and the density preference. This file is the ONLY place that decides whether the new look is on.
 * Today the switch is a per-device storage key (`rovara.look` = "v2"), the cheapest existing switch: no contract change, no broker change.
 * Runtime per-company flag (lane U5): this function calls `uiFlagOn` (ui-flags.ts): the company's value from the navigation answer wins when it is on or off, and this device's key only decides when the company allows previews or the server sends no answer:
 * ThemeProvider only calls this function, and nothing under `design/` or the screens knows which look is on.
 */
export interface LookStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const LOOK_STORAGE_KEY = "rovara.look";
export const DENSITY_STORAGE_KEY = "rovara.density";
export function isNewLookOn(host: LookStorageHost): boolean {
 return uiFlagOn(host, "look", LOOK_STORAGE_KEY);
}
export const DEFAULT_DENSITY: Density = "comfortable";
export function readDensity(host: LookStorageHost): Density {
 try { const stored = host.storage.get(DENSITY_STORAGE_KEY);return stored !== undefined && Object.hasOwn(LOOK_DENSITY, stored) ? stored as Density : DEFAULT_DENSITY; } catch { return DEFAULT_DENSITY; }
}
export type { Density };
