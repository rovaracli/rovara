import type { ReactNode } from "react";
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) { return <header className="rv-page-header"><div><h1 tabIndex={-1}>{title}</h1>{description && <p className="rv-muted">{description}</p>}</div>{actions && <div className="rv-actions">{actions}</div>}</header>; }
