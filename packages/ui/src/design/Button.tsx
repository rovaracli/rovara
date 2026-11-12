import type { ComponentProps } from "react";
export interface ButtonProps extends ComponentProps<"button"> { busy?: boolean; variant?: "primary" | "secondary" | "quiet" | "danger" }
export function Button({ busy = false, variant = "secondary", disabled, className = "", children, ...props }: ButtonProps) { return <button type="button" {...props} disabled={disabled || busy} aria-busy={busy || props["aria-busy"] || undefined} className={`rv-button rv-button-${variant} ${className}`}>{children}</button>; }
