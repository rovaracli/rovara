import { markerKind, markerWords, type Mark } from "./how-we-work-rows.js";
/** Where a value comes from, in words (never colour alone): inherited, changed here, or locked with a lock icon. */
export function HowWeWorkMarker({ mark }: { mark: Mark }) {
 const kind = markerKind(mark);
 return <span className="rv-hww-marker" data-marker={kind}>{kind === "locked" && <svg aria-hidden="true" focusable="false" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></svg>}{markerWords(mark)}</span>;
}
