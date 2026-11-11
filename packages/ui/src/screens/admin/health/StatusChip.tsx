import { STATUS_WORDS, type RowStatus } from "./readiness.js";
const ICONS: Record<RowStatus, string> = { healthy: "M5 12l5 5 9-10", action: "M12 7v6M12 17h.01", unknown: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01", checking: "M12 6v6l4 2" };
/** Words plus an icon, never colour alone. */
export function StatusChip({ status }: { status: RowStatus }) {
 return <span className={`rv-health-chip rv-health-chip-${status}`}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={ICONS[status]} /></svg>{STATUS_WORDS[status]}</span>;
}
