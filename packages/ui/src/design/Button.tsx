import { useId, type ComponentProps } from "react";
import { VisibleText } from "./VisibleText.js";
import "./parts/chips-buttons.css";

export interface ButtonProps extends ComponentProps<"button"> {
 busy?: boolean;
 variant?: "primary" | "secondary" | "quiet" | "danger";
 lockedReason?: string;
}
export function Button({ busy = false, variant = "secondary", lockedReason, disabled, className = "", children, "aria-describedby": describedBy, ...props }: ButtonProps) {
 const reasonId = useId();
 const locked = lockedReason !== undefined;
 const button = <button type="button" {...props} disabled={disabled || busy || locked} aria-busy={busy || undefined} aria-describedby={locked ? [describedBy, reasonId].filter(Boolean).join(" ") : describedBy} data-locked={locked || undefined} className={`rv-button rv-button-${variant} ${className}`}>
  {locked && <svg className="rv-button-lock" aria-hidden="true" focusable="false" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></svg>}{children}
 </button>;
 // Keep the button mounted when its lock changes, preserving focus and refs.
 return <span className="rv-button-with-reason">{button}{locked && <span id={reasonId} className="rv-button-locked-reason">Locked: <VisibleText text={lockedReason} /></span>}</span>;
}
