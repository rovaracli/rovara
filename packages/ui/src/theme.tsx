import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { getNonce } from "get-nonce";
import { lookV2Css, tokensCss } from "@agentx/design-tokens";
import { DEFAULT_DENSITY, DENSITY_STORAGE_KEY, readDensity, type Density } from "./look.js";
// Built once when the module loads: the sheet is constant. The v2 sheet goes after the base tokens so its rules win at equal specificity.
const THEME_CSS = tokensCss() + lookV2Css();
export type ThemePreference = "system" | "light" | "dark";
interface ThemeStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
const Context = createContext<{ preference: ThemePreference; setPreference: (value: ThemePreference) => void; density: Density; setDensity: (value: Density) => void }>({ preference: "system", setPreference: () => undefined, density: DEFAULT_DENSITY, setDensity: () => undefined });
export function ThemeProvider({ host, children }: { host: ThemeStorageHost; children: ReactNode }) {
 const [preference, setState] = useState<ThemePreference>(() => { try { const stored = host.storage.get("rovara.theme");return stored === "light" || stored === "dark" ? stored : "system"; } catch { return "system"; } });
 const [density, setDensityState] = useState<Density>(() => readDensity(host));
 useEffect(() => { if (preference === "system") document.documentElement.removeAttribute("data-theme");else document.documentElement.setAttribute("data-theme", preference); }, [preference]);
 // The v2 look (data-look) and the density (data-density) are set before the first paint of anything below. Density is a per-device choice, Comfortable by default.
 useLayoutEffect(() => { const root = document.documentElement;root.setAttribute("data-look", "v2");root.setAttribute("data-density", density); }, [density]);
 function setPreference(value: ThemePreference) { setState(value);try { host.storage.set("rovara.theme", value); } catch { /* A blocked store does not prevent changing appearance. */ } }
 function setDensity(value: Density) { setDensityState(value);try { host.storage.set(DENSITY_STORAGE_KEY, value); } catch { /* A blocked store does not prevent changing density. */ } }
 return <Context.Provider value={{ preference, setPreference, density, setDensity }}><style nonce={getNonce()}>{THEME_CSS}</style>{children}</Context.Provider>;
}
export function useTheme() { return useContext(Context); }
