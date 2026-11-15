import type { ReactNode } from "react";
export function EmptyState({ title, description, action, testId }: { title: string; description?: string; action?: ReactNode; testId?: string }) { return <section className="rv-empty" data-testid={testId}><h2>{title}</h2>{description && <p className="rv-muted">{description}</p>}{action}</section>; }
