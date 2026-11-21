import { useEffect, useRef, type ReactNode } from "react";
import { VisibleText } from "./VisibleText.js";
import { StatusChip, type StatusChipProps } from "./StatusChip.js";
import "./parts/shell-gallery.css";
export function PageHeader({ title, description, actions, focusOnMount = false, breadcrumbs, status, meta }: { title: string; description?: string; actions?: ReactNode; focusOnMount?: boolean; breadcrumbs?: readonly { label: string; href?: string }[]; status?: StatusChipProps; meta?: ReactNode }) {
 const heading = useRef<HTMLHeadingElement>(null);
 // Async pages opt in when their real heading replaces a loading screen; refetches never move focus.
 useEffect(() => { if (focusOnMount) heading.current?.focus(); }, [focusOnMount]);
 return <header className="rv-page-header"><div>
  {breadcrumbs && breadcrumbs.length > 0 && <nav aria-label="Breadcrumb" className="rv-page-breadcrumbs"><ol>{breadcrumbs.map((crumb, index) => <li key={index}>{crumb.href ? <a href={crumb.href}><VisibleText text={crumb.label} /></a> : <span aria-current={index === breadcrumbs.length - 1 ? "page" : undefined}><VisibleText text={crumb.label} /></span>}</li>)}</ol></nav>}
  <h1 ref={heading} tabIndex={-1}><VisibleText text={title} /></h1>
  {(status || meta) && <div className="rv-page-meta">{status && <StatusChip {...status} />}{meta && <span>{meta}</span>}</div>}
  {description && <p className="rv-muted"><VisibleText text={description} /></p>}
 </div>{actions && <div className="rv-actions">{actions}</div>}</header>;
}
