import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { VisibleText } from "./VisibleText.js";
const Context = createContext<(message: string) => void>(() => undefined);
export function Announcer({ children }: { children: ReactNode }) {
 const [message, setMessage] = useState("");const pending = useRef<string[]>([]), last = useRef<number | undefined>(undefined), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
 const announce = useCallback((text: string) => { pending.current = [...pending.current, text].slice(-10);if (timer.current !== undefined) return;const delay = last.current === undefined ? 1000 : Math.max(1000, last.current + 5000 - Date.now());timer.current = setTimeout(() => { setMessage([...new Set(pending.current)].join(". "));pending.current = [];last.current = Date.now();timer.current = undefined; }, delay); }, []);
 useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); }, []);
 return <Context.Provider value={announce}>{children}<div className="rv-visually-hidden" aria-live="polite" aria-atomic="true"><VisibleText text={message} /></div></Context.Provider>;
}
export function useAnnounce() { return useContext(Context); }
