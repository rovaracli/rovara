import { useId, type ReactElement, type ReactNode } from "react";
import { Dialog as R } from "radix-ui";
import { IconButton } from "./IconButton.js";
export interface DialogProps { title: string; description?: string; children: ReactNode; trigger?: ReactElement; open?: boolean; onOpenChange?: (open: boolean) => void; className?: string }
export function Dialog({ title, description, children, trigger, open, onOpenChange, className = "" }: DialogProps) {
 const descriptionId = useId();return <R.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>{trigger && <R.Trigger asChild>{trigger}</R.Trigger>}<R.Portal><R.Overlay className="rv-overlay" /><R.Content aria-describedby={description ? descriptionId : undefined} className={`rv-dialog ${className}`}><div className="rv-dialog-heading"><R.Title>{title}</R.Title><R.Close asChild><IconButton label="Close dialog" variant="quiet">×</IconButton></R.Close></div>{description && <R.Description id={descriptionId}>{description}</R.Description>}{children}</R.Content></R.Portal></R.Root>;
}
