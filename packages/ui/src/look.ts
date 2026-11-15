import { LOOK_DENSITY, type Density } from "@agentx/design-tokens";
/**
 * The density preference of the look (decision 125: the v2 look is the only look; ThemeProvider always puts `data-look="v2"` on the root). Density is a per-device choice (`rovara.density`), Comfortable by default.
 */
export interface LookStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
export const DENSITY_STORAGE_KEY = "rovara.density";
export const DEFAULT_DENSITY: Density = "comfortable";
export function readDensity(host: LookStorageHost): Density {
 try { const stored = host.storage.get(DENSITY_STORAGE_KEY);return stored !== undefined && Object.hasOwn(LOOK_DENSITY, stored) ? stored as Density : DEFAULT_DENSITY; } catch { return DEFAULT_DENSITY; }
}
export type { Density };
