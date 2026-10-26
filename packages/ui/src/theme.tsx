import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { getNonce } from "get-nonce";
import { tokensCss } from "@agentx/design-tokens";
export type ThemePreference = "system" | "light" | "dark";
interface ThemeStorageHost { storage: { get(key: string): string | undefined; set(key: string, value: string): void } }
const Context = createContext<{ preference: ThemePreference; setPreference: (value: ThemePreference) => void }>({ preference: "system", setPreference: () => undefined });
export function ThemeProvider({ host, children }: { host: ThemeStorageHost; children: ReactNode }) {
 const [preference, setState] = useState<ThemePreference>(() => { try { const stored = host.storage.get("rovara.theme");return stored === "light" || stored === "dark" ? stored : "system"; } catch { return "system"; } });
 useEffect(() => { if (preference === "system") document.documentElement.removeAttribute("data-theme");else document.documentElement.setAttribute("data-theme", preference); }, [preference]);
 function setPreference(value: ThemePreference) { setState(value);try { host.storage.set("rovara.theme", value); } catch { /* A blocked store does not prevent changing appearance. */ } }
 return <Context.Provider value={{ preference, setPreference }}><style nonce={getNonce()}>{tokensCss()}</style>{children}</Context.Provider>;
}
export function useTheme() { return useContext(Context); }
