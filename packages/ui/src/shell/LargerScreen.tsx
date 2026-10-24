import type { ReactNode } from "react";
import { Link } from "react-router";
import { paths } from "../paths.js";
export function LargerScreen({ children }: { children: ReactNode }) { return <><div className="rv-large-screen-content">{children}</div><section className="rv-large-screen-message"><h1 tabIndex={-1}>Open on a larger screen</h1><p>Open this on a larger screen to use it.</p><Link to={paths.home}>Go to Home</Link></section></>; }
