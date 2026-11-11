import { useState, type ReactNode } from "react";
import { useLocation } from "react-router";
/**
 * The work and its evidence behind a disclosure, for the phone order of the task page. Closed, unless the address names a tab (`#evidence`, `#plan`...), which a link from Slack does.
 * A later change of the address (an in-page link to a tab) opens it too; the reader closing it by hand is respected until the address changes again.
 */
export function EvidenceDetails({ children }: { children: ReactNode }) {
 const hash = useLocation().hash, [open, setOpen] = useState(hash.length > 1), [seen, setSeen] = useState(hash);
 if (hash !== seen) { setSeen(hash);if (hash.length > 1 && !open) setOpen(true); }
 return <details className="rv-session-evidence" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>Work details and evidence</summary>{children}</details>;
}
