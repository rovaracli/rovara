import type { ReactElement } from "react";
import type { DestinationId } from "./destinations.js";
// The design pass's icons (screens/home.html), drawn once. They are decoration: the label is always beside them.
const SHAPES: Record<DestinationId, ReactElement> = {
 home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></>,
 work: <path d="M4 6h16M4 12h16M4 18h10" />,
 projects: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />,
 agents: <><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13v1.5M15 13v1.5M9.5 17.5h5" /><circle cx="12" cy="3.5" r="1" /></>,
 settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
};
export function NavIcon({ id }: { id: DestinationId }) { return <svg className="rv-nav-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{SHAPES[id]}</svg>; }
