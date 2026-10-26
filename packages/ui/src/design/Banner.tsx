import type { ReactNode } from "react";
export function Banner({ title, children, tone = "info", action }: { title: string; children?: ReactNode; tone?: "info" | "warning" | "danger" | "success"; action?: ReactNode }) { return <section className={`rv-banner rv-banner-${tone}`} aria-label={title}><div><strong>{title}</strong>{children && <div>{children}</div>}</div>{action}</section>; }
