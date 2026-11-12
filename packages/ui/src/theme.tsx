import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { getNonce } from "get-nonce";
import { lookV2Css, tokensCss } from "@agentx/design-tokens";
import { DEFAULT_DENSITY, DENSITY_STORAGE_KEY, readDensity, type Density } from "./look.js";
// Built once when the module loads: the sheet is constant, so it is not rebuilt on every render.
const THEME_CSS = tokensCss() + lookV2Css();
export type ThemePreference = "system" | "light" | "dark";
interface ThemeStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
/** The theme (system, light or dark) and the density. The v2 look is the only look (decision 125). */
const Context = createContext<{ preference: ThemePreference; setPreference: (value: ThemePreference) => void; density: Density; setDensity: (value: Density) => void }>({ preference: "system", setPreference: () => undefined, density: DEFAULT_DENSITY, setDensity: () => undefined });
export function ThemeProvider({ host, children }: { host: ThemeStorageHost; children: ReactNode }) {
 const [preference, setState] = useState<ThemePreference>(() => { try { const stored = host.storage.get("rovara.theme");return stored === "light" || stored === "dark" ? stored : "system"; } catch { return "system"; } });
 const [density, setDensityState] = useState<Density>(() => readDensity(host));
 useEffect(() => { if (preference === "system") document.documentElement.removeAttribute("data-theme");else document.documentElement.setAttribute("data-theme", preference); }, [preference]);
 // Decision 125: the v2 look is the only look. The attribute is set before the first paint of anything below (a layout effect), so no screen is drawn in the base server-page values first.
 useLayoutEffect(() => { const root = document.documentElement;root.setAttribute("data-look", "v2");root.setAttribute("data-density", density); }, [density]);
 function setPreference(value: ThemePreference) { setState(value);try { host.storage.set("rovara.theme", value); } catch { /* A blocked store does not prevent changing appearance. */ } }
 function setDensity(value: Density) { setDensityState(value);try { host.storage.set(DENSITY_STORAGE_KEY, value); } catch { /* A blocked store does not prevent changing density. */ } }
 // The base tokens are shared with the broker's own pages; the v2 sheet (scoped to data-look="v2") goes after them so its rules win at equal specificity.
 return <Context.Provider value={{ preference, setPreference, density, setDensity }}><style nonce={getNonce()}>{THEME_CSS}</style>{children}</Context.Provider>;
}
export function useTheme() { return useContext(Context); }
