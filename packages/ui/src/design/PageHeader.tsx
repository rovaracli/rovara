import { useEffect, useRef, type ReactNode } from "react";
import { VisibleText } from "./VisibleText.js";
export function PageHeader({ title, description, actions, focusOnMount = false }: { title: string; description?: string; actions?: ReactNode; focusOnMount?: boolean }) {
 const heading = useRef<HTMLHeadingElement>(null);
 // Async pages opt in when their real heading replaces a loading screen; refetches never move focus.
 useEffect(() => { if (focusOnMount) heading.current?.focus(); }, [focusOnMount]);
 return <header className="rv-page-header"><div><h1 ref={heading} tabIndex={-1}><VisibleText text={title} /></h1>{description && <p className="rv-muted"><VisibleText text={description} /></p>}</div>{actions && <div className="rv-actions">{actions}</div>}</header>;
}
