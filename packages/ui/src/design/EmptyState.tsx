import type { ReactNode } from "react";
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) { return <section className="rv-empty"><h2>{title}</h2>{description && <p className="rv-muted">{description}</p>}{action}</section>; }
