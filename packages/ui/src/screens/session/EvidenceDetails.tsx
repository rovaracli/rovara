import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
/** The work and its evidence behind a disclosure, for the phone order of the task page. Closed, unless the address names a tab (`#evidence`, `#plan`...), which a link from Slack does. */
export function EvidenceDetails({ children }: { children: ReactNode }) {
 const hash = useLocation().hash, [open, setOpen] = useState(() => hash.length > 1);
 return <details className="rv-session-evidence" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>Work details and evidence</summary>{children}</details>;
}
