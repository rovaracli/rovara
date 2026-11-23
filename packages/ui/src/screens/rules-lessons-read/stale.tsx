import { createContext, useCallback, useContext, useEffect, useId, useState, type ReactNode } from "react";
type Mark = (key: string, at: number | null) => void;
const StaleContext = createContext<{ mark: Mark; times: readonly number[] } | undefined>(undefined);
/** The viewer's own local time; no zone is pinned. */
const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** One stale line per page, however many sections kept their last data: the oldest kept time wins. */
export function StaleScope({ children }: { children: ReactNode }) {
 const [marks, setMarks] = useState<Readonly<Record<string, number>>>({});
 const mark = useCallback<Mark>((key, at) => setMarks(previous => {
  if (at === null) { if (!(key in previous)) return previous;const next = { ...previous };delete next[key];return next; }
  return previous[key] === at ? previous : { ...previous, [key]: at };
 }), []);
 return <StaleContext.Provider value={{ mark, times: Object.values(marks) }}>{children}</StaleContext.Provider>;
}
/** Drawn by the page under its header. Empty unless a section is showing kept data. */
export function StaleSlot() {
 const times = useContext(StaleContext)?.times ?? [];
 return times.length === 0 ? null : <p className="g4-stale" role="status">Updated {clock(Math.min(...times))} · Reconnecting</p>;
}
/** A section that keeps its last data reports it here; it draws nothing itself. */
export function StaleMark({ at }: { at: number }) {
 const context = useContext(StaleContext), key = useId(), mark = context?.mark;
 useEffect(() => { mark?.(key, at);return () => mark?.(key, null); }, [mark, key, at]);
 return null;
}
