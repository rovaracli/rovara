import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { StaleLine } from "./parts.js";

/**
 * One page, one "Updated HH:MM · Reconnecting" line, however many of its reads are showing their last good facts.
 * A read under a frame reports its kept-facts time here; the frame draws the one line (oldest facts). Outside a frame a read draws its own.
 * PLACEMENT (the same as G2's company money / AI pages): the line sits directly under the page header, above the page body. A page puts
 * <ReconnectingLine /> right after its header; a frame whose page has no such slot (a section under a live page) draws the line at its top.
 */
type Report = (id: string, at: number | undefined) => void;
interface Frame { report: Report; since: number | undefined; claim: () => () => void }
const ReconnectingContext = createContext<Frame | undefined>(undefined);

export function ReconnectingFrame({ children }: { children: ReactNode }) {
 const [lines, setLines] = useState<Readonly<Record<string, number>>>({}), [slots, setSlots] = useState(0);
 const claim = useCallback(() => { setSlots(count => count + 1); return () => { setSlots(count => count - 1); }; }, []);
 const report = useCallback<Report>((id, at) => setLines(previous => {
  if (at === undefined) {
   if (!(id in previous)) return previous;
   const next = { ...previous }; delete next[id]; return next;
  }
  return previous[id] === at ? previous : { ...previous, [id]: at };
 }), []);
 const times = Object.values(lines), since = times.length === 0 ? undefined : Math.min(...times);
 const frame = useMemo<Frame>(() => ({ report, since, claim }), [report, since, claim]);
 return <ReconnectingContext.Provider value={frame}>{since !== undefined && slots === 0 && <StaleLine at={since} />}{children}</ReconnectingContext.Provider>;
}
/** The one line's place: directly after the page header. Draws nothing unless some read on the page is showing its last good facts. */
export function ReconnectingLine() {
 const frame = useContext(ReconnectingContext), claim = frame?.claim;
 useEffect(() => claim?.(), [claim]);
 return frame?.since === undefined ? null : <StaleLine at={frame.since} />;
}
/** `at` is servedReadState's staleSince. Returns the line to draw in place, or null when a frame draws it. */
export function useReconnectingLine(at: number | undefined): ReactNode {
 const report = useContext(ReconnectingContext)?.report, id = useId();
 useEffect(() => {
  if (report === undefined) return undefined;
  report(id, at);
  return () => { report(id, undefined); };
 }, [report, id, at]);
 return report === undefined && at !== undefined ? <StaleLine at={at} /> : null;
}
