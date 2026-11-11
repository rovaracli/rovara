import type { ReactNode } from "react";
import { Link } from "react-router";
import { paths } from "../paths.js";
/** `backTo` (optional): a way back to the page this one belongs to, shown above "Go to Home". Not passed, the block page is exactly what it was. */
export interface LargerScreenBack { href: string; label: string }
export function LargerScreen({ children, backTo }: { children: ReactNode; backTo?: LargerScreenBack | undefined }) { return <><div className="rv-large-screen-content">{children}</div><section className="rv-large-screen-message"><h1 tabIndex={-1}>Open on a larger screen</h1><p>Open this on a larger screen to use it.</p>{backTo !== undefined && <p className="rv-large-screen-back"><Link to={backTo.href}>{backTo.label}</Link></p>}<Link to={paths.home}>Go to Home</Link></section></>; }
