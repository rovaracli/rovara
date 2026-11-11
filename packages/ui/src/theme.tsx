import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { getNonce } from "get-nonce";
import { lookV2Css, tokensCss } from "@agentx/design-tokens";
import { uiFlagsStoreOf } from "./ui-flags.js";
import { DEFAULT_DENSITY, DENSITY_STORAGE_KEY, isNewLookOn, readDensity, type Density } from "./look.js";
// Built once when the module loads: the sheet is constant, so it is not rebuilt on every render.
const THEME_CSS = tokensCss() + lookV2Css();
export type ThemePreference = "system" | "light" | "dark";
interface ThemeStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
/** `newLook` is true while the v2 look is on (see look.ts); `density` and `setDensity` only change anything then. */
const Context = createContext<{ preference: ThemePreference; setPreference: (value: ThemePreference) => void; newLook: boolean; density: Density; setDensity: (value: Density) => void }>({ preference: "system", setPreference: () => undefined, newLook: false, density: DEFAULT_DENSITY, setDensity: () => undefined });
export function ThemeProvider({ host, children }: { host: ThemeStorageHost; children: ReactNode }) {
 const [preference, setState] = useState<ThemePreference>(() => { try { const stored = host.storage.get("rovara.theme");return stored === "light" || stored === "dark" ? stored : "system"; } catch { return "system"; } });
 // The look follows the server flag as soon as the navigation answer arrives (and a later change), unlike the layout flags, which are read once when a screen mounts.
 const newLook = useSyncExternalStore(uiFlagsStoreOf(host).subscribe, () => isNewLookOn(host)), [density, setDensityState] = useState<Density>(() => readDensity(host));
 useEffect(() => { if (preference === "system") document.documentElement.removeAttribute("data-theme");else document.documentElement.setAttribute("data-theme", preference); }, [preference]);
 useEffect(() => {
 const root = document.documentElement;
 if (newLook) { root.setAttribute("data-look", "v2");root.setAttribute("data-density", density); } else { root.removeAttribute("data-look");root.removeAttribute("data-density"); }
 }, [newLook, density]);
 function setPreference(value: ThemePreference) { setState(value);try { host.storage.set("rovara.theme", value); } catch { /* A blocked store does not prevent changing appearance. */ } }
 function setDensity(value: Density) { setDensityState(value);try { host.storage.set(DENSITY_STORAGE_KEY, value); } catch { /* A blocked store does not prevent changing density. */ } }
 // The v2 sheet is inert until data-look="v2" is on the root; it goes after the base tokens so its rules win at equal specificity.
 return <Context.Provider value={{ preference, setPreference, newLook, density, setDensity }}><style nonce={getNonce()}>{THEME_CSS}</style>{children}</Context.Provider>;
}
export function useTheme() { return useContext(Context); }
